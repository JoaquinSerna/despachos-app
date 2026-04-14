'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { puedeEditar } from '../lib/permisos'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']
const ESTADOS = ['pendiente', 'programado', 'en_camino', 'entregado', 'cancelado']

const ESTADO_COLOR: Record<string, string> = {
  pendiente: '#f59e0b', programado: '#3b82f6', en_camino: '#8b5cf6',
  entregado: '#10b981', cancelado: '#ef4444',
}
const ESTADO_LABEL: Record<string, string> = {
  pendiente: 'Pendiente', programado: 'Programado', en_camino: 'En camino',
  entregado: 'Entregado', cancelado: 'Cancelado',
}

const TIPO_COLOR: Record<string, { bg: string; text: string }> = {
  hierro:   { bg: '#e8edf8', text: '#254A96' },
  chapa:    { bg: '#dbeafe', text: '#1d4ed8' },
  bolsa:    { bg: '#fef9c3', text: '#854d0e' },
  granel:   { bg: '#fce7f3', text: '#9d174d' },
  paleta:   { bg: '#d1fae5', text: '#065f46' },
  volumen:  { bg: '#ede9fe', text: '#5b21b6' },
  mamposteria: { bg: '#fde68a', text: '#92400e' },
  ceramica: { bg: '#ffedd5', text: '#9a3412' },
  otros:    { bg: '#f4f4f3', text: '#555' },
}
const TIPO_LABEL: Record<string, string> = {
  hierro: 'Hierro', chapa: 'Chapa', bolsa: 'Bolsa', granel: 'Granel',
  paleta: 'Paleta', volumen: 'Volumen', mamposteria: 'Mampostería',
  ceramica: 'Cerámica', otros: 'Otros',
}
// Devuelve el color para cualquier tipo, incluso los no mapeados
function tipoColor(t: string) { return TIPO_COLOR[t] ?? { bg: '#f4f4f3', text: '#555' } }
function tipoLabel(t: string) { return TIPO_LABEL[t] ?? t }

const normalizar = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2')  // 2,4 → 2.4
    .replace(/\s*x\s*/g, 'x').replace(/(\d)\s*(mt|kg|cm|mm|m)\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim()

interface Pedido {
  id: string; nv: string; id_despacho: string | null; cliente: string; direccion: string
  sucursal: string; fecha_entrega: string; vuelta: number
  estado: string; estado_pago: string | null; peso_total_kg: number | null; volumen_total_m3: number | null
  notas: string | null; camion_id: string | null
}

const PAGO_COLOR: Record<string, { bg: string; text: string }> = {
  cobrado:          { bg: '#dcfce7', text: '#166534' },
  cuenta_corriente: { bg: '#dbeafe', text: '#1e40af' },
  pendiente_cobro:  { bg: '#fef9c3', text: '#854d0e' },
  pago_en_obra:     { bg: '#ffedd5', text: '#9a3412' },
}
const PAGO_LABEL: Record<string, string> = {
  cobrado: 'Cobrado', cuenta_corriente: 'Cta. Cte.',
  pendiente_cobro: 'Pend. cobro', pago_en_obra: 'Pago en obra',
}
const ESTADOS_PAGO = ['cobrado', 'cuenta_corriente', 'pendiente_cobro', 'pago_en_obra']

interface Item {
  nombre: string; cantidad: number; unidad: string
  tipo_carga?: string; categoria?: string; subcategoria?: string; material_id?: number
}

interface Foto {
  url: string; label: string | null; publicUrl: string
}

interface EditState {
  id: string; sucursal: string; peso: string; posiciones: string; estado_pago: string
  fecha_entrega: string; vuelta: number
}

export default function PedidosPage() {
  const router = useRouter()
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [cargando, setCargando] = useState(false)
  const [total, setTotal] = useState(0)

  // Categorías, items y fotos por pedido
  const [categoriasMap, setCategoriasMap] = useState<Record<string, { label: string; tipo: string }[]>>({})
  const [itemsMap, setItemsMap] = useState<Record<string, Item[]>>({})
  const [fotosMap, setFotosMap] = useState<Record<string, Foto[]>>({})

  // Filas expandidas (múltiples a la vez)
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set())
  // Lightbox
  const [lightbox, setLightbox] = useState<string | null>(null)

  // Filtros
  const [filtroFecha, setFiltroFecha] = useState('')
  const [filtroSucursal, setFiltroSucursal] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('')
  const [filtroTexto, setFiltroTexto] = useState('')

  // Edición
  const [editando, setEditando] = useState<EditState | null>(null)
  const [guardando, setGuardando] = useState(false)

  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  const [puedeEditarPedidos, setPuedeEditarPedidos] = useState(false)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      supabase.from('usuarios').select('rol, permisos').eq('id', user.id).single().then(({ data }) => {
        if (!['gerencia', 'ruteador', 'admin_flota'].includes(data?.rol)) {
          router.push('/dashboard'); return
        }
        setPuedeEditarPedidos(puedeEditar(data?.permisos, data?.rol, 'pedidos'))
      })
    })
  }, [])

  async function buscar() {
    setCargando(true)
    setCategoriasMap({})
    setItemsMap({})
    setExpandidos(new Set())
    let q = supabase
      .from('pedidos')
      .select('id, nv, id_despacho, cliente, direccion, sucursal, fecha_entrega, vuelta, estado, estado_pago, peso_total_kg, volumen_total_m3, notas, camion_id', { count: 'exact' })
      .order('fecha_entrega', { ascending: false })
      .order('cliente')
      .limit(200)

    if (filtroFecha) q = q.eq('fecha_entrega', filtroFecha)
    if (filtroSucursal) q = q.eq('sucursal', filtroSucursal)
    if (filtroEstado) q = q.eq('estado', filtroEstado)
    if (filtroTexto) {
      const txt = `%${filtroTexto}%`
      q = q.or(`cliente.ilike.${txt},nv.ilike.${txt},direccion.ilike.${txt}`)
    }

    const { data, count, error } = await q
    if (error) { showToast(error.message, 'err'); setCargando(false); return }

    const pedidosList = data ?? []
    setPedidos(pedidosList)
    setTotal(count ?? 0)
    setCargando(false)

    if (pedidosList.length > 0) cargarDetalle(pedidosList.map(p => p.id))
  }

  async function cargarDetalle(ids: string[]) {
    const [{ data: rawItems }, { data: mats }, { data: rawFotos }] = await Promise.all([
      supabase.from('pedido_items').select('pedido_id, nombre, cantidad, unidad').in('pedido_id', ids),
      supabase.from('materiales').select('id, nombre, tipo_carga, categoria, subcategoria'),
      supabase.from('pedido_fotos').select('pedido_id, url, label').in('pedido_id', ids).order('created_at'),
    ])

    // Items + categorías
    const newItemsMap: Record<string, Item[]> = {}
    // catKey = "tipo_carga|categoria" para deduplicar manteniendo ambos datos
    const newCatMap: Record<string, Map<string, { label: string; tipo: string }>> = {}

    for (const item of rawItems ?? []) {
      const nItem = normalizar(item.nombre)
      const mat = (mats ?? []).find((m: any) => {
        const nMat = normalizar(m.nombre)
        return nMat === nItem || nMat.includes(nItem) || nItem.includes(nMat)
      })
      const tipo = mat?.tipo_carga ?? 'otros'
      const categoria = mat?.categoria ?? null
      const subcategoria = mat?.subcategoria ?? null
      if (!newItemsMap[item.pedido_id]) newItemsMap[item.pedido_id] = []
      newItemsMap[item.pedido_id].push({ nombre: item.nombre, cantidad: item.cantidad, unidad: item.unidad, tipo_carga: tipo, categoria: categoria ?? undefined, subcategoria: subcategoria ?? undefined, material_id: mat?.id ?? undefined })
      if (!newCatMap[item.pedido_id]) newCatMap[item.pedido_id] = new Map()
      // No mostrar badge para categoría Logística
      if (categoria !== 'Logística') {
        const catKey = `${tipo}|${categoria ?? ''}`
        if (!newCatMap[item.pedido_id].has(catKey)) {
          newCatMap[item.pedido_id].set(catKey, { label: categoria ?? tipoLabel(tipo), tipo })
        }
      }
    }
    const newCatResult: Record<string, { label: string; tipo: string }[]> = {}
    for (const [k, v] of Object.entries(newCatMap)) newCatResult[k] = Array.from(v.values())

    // Fotos — obtener URL pública de cada una
    const newFotosMap: Record<string, Foto[]> = {}
    for (const f of rawFotos ?? []) {
      const { data: pub } = supabase.storage.from('solicitudes-despacho').getPublicUrl(f.url)
      if (!newFotosMap[f.pedido_id]) newFotosMap[f.pedido_id] = []
      newFotosMap[f.pedido_id].push({ url: f.url, label: f.label, publicUrl: pub.publicUrl })
    }

    setItemsMap(newItemsMap)
    setCategoriasMap(newCatResult)
    setFotosMap(newFotosMap)
  }

  function toggleExpandir(id: string) {
    setExpandidos(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function iniciarEdicion(p: Pedido) {
    setEditando({
      id: p.id,
      sucursal: p.sucursal,
      peso: p.peso_total_kg != null ? String(p.peso_total_kg) : '',
      posiciones: p.volumen_total_m3 != null ? String(p.volumen_total_m3) : '',
      estado_pago: p.estado_pago ?? '',
      fecha_entrega: p.fecha_entrega ?? '',
      vuelta: p.vuelta ?? 1,
    })
  }

  async function guardar() {
    if (!editando) return
    setGuardando(true)
    const updates: Record<string, any> = { id: editando.id, sucursal: editando.sucursal }
    if (editando.peso !== '') updates.peso_total_kg = Math.round(parseFloat(editando.peso) || 0)
    if (editando.posiciones !== '') updates.volumen_total_m3 = parseFloat(editando.posiciones) || 0
    if (editando.estado_pago !== '') updates.estado_pago = editando.estado_pago
    if (editando.fecha_entrega !== '') updates.fecha_entrega = editando.fecha_entrega
    updates.vuelta = editando.vuelta

    const res = await fetch('/api/pedidos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    const data = await res.json()
    if (data.error) {
      showToast(data.error, 'err')
    } else {
      setPedidos(prev => prev.map(p => p.id === editando.id ? {
        ...p,
        sucursal: editando.sucursal,
        peso_total_kg: updates.peso_total_kg ?? p.peso_total_kg,
        volumen_total_m3: updates.volumen_total_m3 ?? p.volumen_total_m3,
        estado_pago: updates.estado_pago ?? p.estado_pago,
        fecha_entrega: updates.fecha_entrega ?? p.fecha_entrega,
        vuelta: updates.vuelta ?? p.vuelta,
      } : p))
      showToast('Pedido actualizado')
      setEditando(null)
    }
    setGuardando(false)
  }

  const COLS = 12 // número de columnas de la tabla para el colspan del detalle

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="Foto" className="max-w-full max-h-full rounded-xl object-contain" />
          <button className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center text-white text-lg"
            style={{ background: 'rgba(255,255,255,0.2)' }}>✕</button>
        </div>
      )}

      {/* Modal edición */}
      {editando && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <h3 className="font-bold text-sm mb-4" style={{ color: '#254A96' }}>✏️ Editar pedido</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Sucursal</label>
                <select value={editando.sucursal}
                  onChange={e => setEditando(prev => prev ? { ...prev, sucursal: e.target.value } : prev)}
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
                  {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Peso total (kg)</label>
                <input type="number" value={editando.peso}
                  onChange={e => setEditando(prev => prev ? { ...prev, peso: e.target.value } : prev)}
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} placeholder="ej: 3500" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Posiciones</label>
                <input type="number" step="0.1" value={editando.posiciones}
                  onChange={e => setEditando(prev => prev ? { ...prev, posiciones: e.target.value } : prev)}
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} placeholder="ej: 4.5" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha entrega</label>
                  <input type="date" value={editando.fecha_entrega}
                    onChange={e => setEditando(prev => prev ? { ...prev, fecha_entrega: e.target.value } : prev)}
                    className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Vuelta</label>
                  <select value={editando.vuelta}
                    onChange={e => setEditando(prev => prev ? { ...prev, vuelta: parseInt(e.target.value) } : prev)}
                    className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }}>
                    <option value={1}>V1 · 8–10h</option>
                    <option value={2}>V2 · 10–12h</option>
                    <option value={3}>V3 · 13–15h</option>
                    <option value={4}>V4 · 15–17h</option>
                    <option value={5}>Después de hora</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Estado de pago</label>
                <select value={editando.estado_pago}
                  onChange={e => setEditando(prev => prev ? { ...prev, estado_pago: e.target.value } : prev)}
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
                  <option value="">Sin especificar</option>
                  {ESTADOS_PAGO.map(ep => (
                    <option key={ep} value={ep}>{PAGO_LABEL[ep]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={guardar} disabled={guardando}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardando ? 'Guardando...' : 'Guardar'}
              </button>
              <button onClick={() => setEditando(null)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/dashboard')}
              className="text-xs px-2 py-1.5 rounded-lg font-medium"
              style={{ background: '#e8edf8', color: '#254A96' }}>
              ← Volver
            </button>
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-bold text-sm" style={{ color: '#254A96' }}>Pedidos</span>
              {total > 0 && <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>{total} resultado{total !== 1 ? 's' : ''}</span>}
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-5">

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-3">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha entrega</label>
              <input type="date" value={filtroFecha} onChange={e => setFiltroFecha(e.target.value)}
                className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Sucursal</label>
              <select value={filtroSucursal} onChange={e => setFiltroSucursal(e.target.value)}
                className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="">Todas</option>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Estado</label>
              <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
                className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="">Todos</option>
                {ESTADOS.map(s => <option key={s} value={s}>{ESTADO_LABEL[s]}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Cliente / NV / dirección</label>
              <input type="text" value={filtroTexto} onChange={e => setFiltroTexto(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && buscar()}
                placeholder="Buscar..." className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
          </div>
          <button onClick={buscar} disabled={cargando}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: '#254A96' }}>
            {cargando ? 'Buscando...' : 'Buscar'}
          </button>
        </div>

        {/* Tabla */}
        {pedidos.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#f4f4f3', borderBottom: '1px solid #e8edf8' }}>
                  <th className="w-8 px-3 py-3"></th>
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>NV / SD</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Cliente</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Dirección</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>Fecha</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>V.</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Sucursal</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Estado</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>Pago</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>Kg / Pos</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Productos</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {pedidos.map((p, i) => {
                  const cats = categoriasMap[p.id]
                  const items = itemsMap[p.id]
                  const expandido = expandidos.has(p.id)
                  const borderColor = i < pedidos.length - 1 || expandido ? '1px solid #f4f4f3' : 'none'
                  return (
                    <>
                      <tr key={p.id} style={{ borderBottom: expandido ? 'none' : borderColor }}
                        className={expandido ? 'bg-blue-50/30' : ''}>
                        {/* Flecha desplegable */}
                        <td className="px-3 py-2.5">
                          <button onClick={() => toggleExpandir(p.id)}
                            className="w-6 h-6 flex items-center justify-center rounded text-xs transition-transform"
                            style={{ color: '#254A96', transform: expandido ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                            ▶
                          </button>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          <div className="font-medium text-sm" style={{ color: '#1a1a1a' }}>{p.nv}</div>
                          {p.id_despacho && (
                            <div className="text-xs mt-0.5" style={{ color: '#888' }}>SD {p.id_despacho}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 max-w-[150px] truncate" style={{ color: '#1a1a1a' }} title={p.cliente}>{p.cliente}</td>
                        <td className="px-4 py-2.5 max-w-[160px] truncate text-xs" style={{ color: '#666' }} title={p.direccion}>{p.direccion}</td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap" style={{ color: '#666' }}>
                          {p.fecha_entrega ? new Date(p.fecha_entrega + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) : '—'}
                        </td>
                        <td className="px-4 py-2.5 text-xs" style={{ color: '#666' }}>V{p.vuelta}</td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs px-2 py-0.5 rounded-lg font-medium"
                            style={{ background: '#e8edf8', color: '#254A96' }}>
                            {p.sucursal}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium text-white"
                            style={{ background: ESTADO_COLOR[p.estado] ?? '#999' }}>
                            {ESTADO_LABEL[p.estado] ?? p.estado}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          {p.estado_pago ? (() => {
                            const col = PAGO_COLOR[p.estado_pago] ?? { bg: '#f4f4f3', text: '#555' }
                            return (
                              <span className="text-xs px-2 py-0.5 rounded-lg font-medium whitespace-nowrap"
                                style={{ background: col.bg, color: col.text }}>
                                {PAGO_LABEL[p.estado_pago] ?? p.estado_pago}
                              </span>
                            )
                          })() : <span style={{ color: '#ccc' }}>—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap" style={{ color: '#555' }}>
                          <div>{p.peso_total_kg != null ? `${p.peso_total_kg.toLocaleString('es-AR')} kg` : <span style={{ color: '#ccc' }}>—</span>}</div>
                          <div style={{ color: '#888' }}>{p.volumen_total_m3 != null ? `${p.volumen_total_m3} pos` : <span style={{ color: '#ccc' }}>—</span>}</div>
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {cats === undefined
                              ? <span className="text-xs animate-pulse" style={{ color: '#ddd' }}>·</span>
                              : cats.length === 0
                                ? <span className="text-xs" style={{ color: '#ccc' }}>sin items</span>
                                : cats.map(c => {
                                    const col = tipoColor(c.tipo)
                                    return (
                                      <span key={`${c.tipo}|${c.label}`} className="text-xs px-1.5 py-0.5 rounded font-medium"
                                        style={{ background: col.bg, color: col.text }}>
                                        {c.label}
                                      </span>
                                    )
                                  })
                            }
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          {puedeEditarPedidos && (
                            <button onClick={() => iniciarEdicion(p)}
                              className="text-xs px-2.5 py-1 rounded-lg font-medium"
                              style={{ background: '#f4f4f3', color: '#254A96' }}>
                              ✏️
                            </button>
                          )}
                        </td>
                      </tr>

                      {/* Fila de detalle expandible */}
                      {expandido && (() => {
                        const fotos = fotosMap[p.id]
                        return (
                          <tr key={`${p.id}-detalle`} style={{ borderBottom: borderColor }}>
                            <td colSpan={COLS} className="px-8 pb-4 pt-1" style={{ background: '#f8faff' }}>
                              <div className="rounded-xl border overflow-hidden" style={{ borderColor: '#e8edf8' }}>

                                {/* Cabecera detalle */}
                                <div className="px-4 py-2 flex flex-wrap gap-4 text-xs font-medium border-b" style={{ background: '#e8edf8', borderColor: '#dde4f4', color: '#254A96' }}>
                                  <span>📍 {p.direccion}</span>
                                  {p.notas && <span>📝 {p.notas}</span>}
                                  {p.camion_id && <span>🚛 {p.camion_id}</span>}
                                </div>

                                {/* Items */}
                                {!items || items.length === 0 ? (
                                  <p className="px-4 py-3 text-xs" style={{ color: '#B9BBB7' }}>Sin productos registrados</p>
                                ) : (
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr style={{ background: '#f4f4f3', borderBottom: '1px solid #e8edf8' }}>
                                        <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>ID</th>
                                        <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Producto</th>
                                        <th className="text-right px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Cantidad</th>
                                        <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Unidad</th>
                                        <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Categoría</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {items.map((it, j) => {
                                        const c = tipoColor(it.tipo_carga ?? 'otros')
                                        return (
                                          <tr key={j} style={{ borderBottom: j < items.length - 1 ? '1px solid #f4f4f3' : 'none' }}>
                                            <td className="px-4 py-2 font-mono text-xs whitespace-nowrap" style={{ color: it.material_id ? '#B9BBB7' : '#f87171' }}>{it.material_id ?? '—'}</td>
                                            <td className="px-4 py-2" style={{ color: '#1a1a1a' }}>{it.nombre}</td>
                                            <td className="px-4 py-2 text-right font-medium" style={{ color: '#254A96' }}>{it.cantidad.toLocaleString('es-AR')}</td>
                                            <td className="px-4 py-2" style={{ color: '#666' }}>{it.unidad}</td>
                                            <td className="px-4 py-2">
                                              {it.categoria === 'Logística'
                                                ? <span style={{ color: '#ccc' }}>—</span>
                                                : (
                                                  <div>
                                                    <span className="px-1.5 py-0.5 rounded font-medium"
                                                      style={{ background: c.bg, color: c.text }}>
                                                      {it.categoria ?? tipoLabel(it.tipo_carga ?? 'otros')}
                                                    </span>
                                                    {it.subcategoria && (
                                                      <div className="text-xs mt-0.5" style={{ color: '#888' }}>{it.subcategoria}</div>
                                                    )}
                                                  </div>
                                                )
                                              }
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    </tbody>
                                  </table>
                                )}

                                {/* Fotos de entrega */}
                                {fotos && fotos.length > 0 && (
                                  <div className="px-4 py-3 border-t" style={{ borderColor: '#e8edf8' }}>
                                    <p className="text-xs font-semibold mb-2" style={{ color: '#254A96' }}>
                                      📷 Fotos de entrega ({fotos.length})
                                    </p>
                                    <div className="flex flex-wrap gap-3">
                                      {fotos.map((f, fi) => (
                                        <div key={fi} className="flex flex-col items-center gap-1">
                                          <button onClick={() => setLightbox(f.publicUrl)}
                                            className="relative rounded-xl overflow-hidden hover:opacity-90 transition-opacity"
                                            style={{ width: 96, height: 96 }}>
                                            <img src={f.publicUrl} alt={f.label ?? 'Foto'} className="w-full h-full object-cover" />
                                          </button>
                                          {f.label && (
                                            <span className="text-xs px-1.5 py-0.5 rounded font-medium text-center"
                                              style={{ background: '#e8edf8', color: '#254A96', maxWidth: 96 }}>
                                              {f.label}
                                            </span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                              </div>
                            </td>
                          </tr>
                        )
                      })()}
                    </>
                  )
                })}
              </tbody>
            </table>
            {total > 200 && (
              <p className="text-xs text-center py-3" style={{ color: '#B9BBB7' }}>
                Mostrando los primeros 200 de {total} resultados. Refiná los filtros para ver más.
              </p>
            )}
          </div>
        )}

        {!cargando && pedidos.length === 0 && (
          <div className="text-center py-20" style={{ color: '#B9BBB7' }}>
            <p className="text-3xl mb-2">📋</p>
            <p className="text-sm">Aplicá filtros y hacé clic en Buscar</p>
          </div>
        )}
      </main>
    </div>
  )
}
