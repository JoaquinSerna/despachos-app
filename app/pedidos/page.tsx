'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

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
  hierro:  { bg: '#e8edf8', text: '#254A96' },
  chapa:   { bg: '#dbeafe', text: '#1d4ed8' },
  bolsa:   { bg: '#fef9c3', text: '#854d0e' },
  granel:  { bg: '#fce7f3', text: '#9d174d' },
  paleta:  { bg: '#d1fae5', text: '#065f46' },
  otros:   { bg: '#f4f4f3', text: '#555' },
}
const TIPO_LABEL: Record<string, string> = {
  hierro: 'Hierro', chapa: 'Chapa', bolsa: 'Bolsa', granel: 'Granel',
  paleta: 'Paleta', otros: 'Otros',
}

const normalizar = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*x\s*/g, 'x').replace(/(\d)\s*(mt|kg|cm|mm|m)\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim()

interface Pedido {
  id: string; nv: string; cliente: string; direccion: string
  sucursal: string; fecha_entrega: string; vuelta: number
  estado: string; peso_total_kg: number | null; volumen_total_m3: number | null
  notas: string | null; camion_id: string | null
}

interface Item {
  nombre: string; cantidad: number; unidad: string; tipo_carga?: string
}

interface EditState {
  id: string; sucursal: string; peso: string; posiciones: string
}

export default function PedidosPage() {
  const router = useRouter()
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [cargando, setCargando] = useState(false)
  const [total, setTotal] = useState(0)

  // Categorías y items por pedido
  const [categoriasMap, setCategoriasMap] = useState<Record<string, string[]>>({})
  const [itemsMap, setItemsMap] = useState<Record<string, Item[]>>({})

  // Fila expandida
  const [expandidoId, setExpandidoId] = useState<string | null>(null)

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

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      supabase.from('usuarios').select('rol').eq('id', user.id).single().then(({ data }) => {
        if (!['gerencia', 'ruteador', 'admin_flota'].includes(data?.rol)) {
          router.push('/dashboard'); return
        }
      })
    })
  }, [])

  async function buscar() {
    setCargando(true)
    setCategoriasMap({})
    setItemsMap({})
    setExpandidoId(null)
    let q = supabase
      .from('pedidos')
      .select('id, nv, cliente, direccion, sucursal, fecha_entrega, vuelta, estado, peso_total_kg, volumen_total_m3, notas, camion_id', { count: 'exact' })
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
    const [{ data: rawItems }, { data: mats }] = await Promise.all([
      supabase.from('pedido_items').select('pedido_id, nombre, cantidad, unidad').in('pedido_id', ids),
      supabase.from('materiales').select('nombre, tipo_carga'),
    ])
    if (!rawItems || !mats) return

    const newItemsMap: Record<string, Item[]> = {}
    const newCatMap: Record<string, Set<string>> = {}

    for (const item of rawItems) {
      const nItem = normalizar(item.nombre)
      const mat = mats.find((m: any) => {
        const nMat = normalizar(m.nombre)
        return nMat === nItem || nMat.includes(nItem) || nItem.includes(nMat)
      })
      const tipo = mat?.tipo_carga ?? 'otros'

      if (!newItemsMap[item.pedido_id]) newItemsMap[item.pedido_id] = []
      newItemsMap[item.pedido_id].push({ nombre: item.nombre, cantidad: item.cantidad, unidad: item.unidad, tipo_carga: tipo })

      if (!newCatMap[item.pedido_id]) newCatMap[item.pedido_id] = new Set()
      newCatMap[item.pedido_id].add(tipo)
    }

    const newCatResult: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(newCatMap)) newCatResult[k] = Array.from(v)

    setItemsMap(newItemsMap)
    setCategoriasMap(newCatResult)
  }

  function toggleExpandir(id: string) {
    setExpandidoId(prev => prev === id ? null : id)
  }

  function iniciarEdicion(p: Pedido) {
    setEditando({
      id: p.id,
      sucursal: p.sucursal,
      peso: p.peso_total_kg != null ? String(p.peso_total_kg) : '',
      posiciones: p.volumen_total_m3 != null ? String(p.volumen_total_m3) : '',
    })
  }

  async function guardar() {
    if (!editando) return
    setGuardando(true)
    const updates: Record<string, any> = { id: editando.id, sucursal: editando.sucursal }
    if (editando.peso !== '') updates.peso_total_kg = Math.round(parseFloat(editando.peso) || 0)
    if (editando.posiciones !== '') updates.volumen_total_m3 = parseFloat(editando.posiciones) || 0

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
      } : p))
      showToast('Pedido actualizado')
      setEditando(null)
    }
    setGuardando(false)
  }

  const COLS = 11 // número de columnas de la tabla para el colspan del detalle

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
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
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>NV</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Cliente</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Dirección</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>Fecha</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>V.</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Sucursal</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Estado</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>Kg / Pos</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Productos</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {pedidos.map((p, i) => {
                  const cats = categoriasMap[p.id]
                  const items = itemsMap[p.id]
                  const expandido = expandidoId === p.id
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
                        <td className="px-4 py-2.5 font-medium whitespace-nowrap" style={{ color: '#1a1a1a' }}>{p.nv}</td>
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
                                : cats.map(t => {
                                    const c = TIPO_COLOR[t] ?? TIPO_COLOR.otros
                                    return (
                                      <span key={t} className="text-xs px-1.5 py-0.5 rounded font-medium"
                                        style={{ background: c.bg, color: c.text }}>
                                        {TIPO_LABEL[t] ?? t}
                                      </span>
                                    )
                                  })
                            }
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          <button onClick={() => iniciarEdicion(p)}
                            className="text-xs px-2.5 py-1 rounded-lg font-medium"
                            style={{ background: '#f4f4f3', color: '#254A96' }}>
                            ✏️
                          </button>
                        </td>
                      </tr>

                      {/* Fila de detalle expandible */}
                      {expandido && (
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
                                      <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Producto</th>
                                      <th className="text-right px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Cantidad</th>
                                      <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Unidad</th>
                                      <th className="text-left px-4 py-2 font-semibold" style={{ color: '#254A96' }}>Categoría</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {items.map((it, j) => {
                                      const c = TIPO_COLOR[it.tipo_carga ?? 'otros'] ?? TIPO_COLOR.otros
                                      return (
                                        <tr key={j} style={{ borderBottom: j < items.length - 1 ? '1px solid #f4f4f3' : 'none' }}>
                                          <td className="px-4 py-2" style={{ color: '#1a1a1a' }}>{it.nombre}</td>
                                          <td className="px-4 py-2 text-right font-medium" style={{ color: '#254A96' }}>{it.cantidad.toLocaleString('es-AR')}</td>
                                          <td className="px-4 py-2" style={{ color: '#666' }}>{it.unidad}</td>
                                          <td className="px-4 py-2">
                                            <span className="px-1.5 py-0.5 rounded font-medium"
                                              style={{ background: c.bg, color: c.text }}>
                                              {TIPO_LABEL[it.tipo_carga ?? 'otros'] ?? it.tipo_carga}
                                            </span>
                                          </td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
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
