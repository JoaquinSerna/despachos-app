'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tieneAcceso } from '../lib/permisos'
import { logAuditoria } from '../lib/auditoria'

interface PedidoItem { nombre: string; cantidad: number; unidad: string }

interface Pedido {
  id: string; nv: string; cliente: string; telefono: string | null
  direccion: string; sucursal: string; fecha_entrega: string; vuelta: number
  estado: string; estado_pago: string | null; camion_id: string | null
  confirmado_cliente: boolean; notas: string | null
  confirmacion_estado: 'rechazado_cliente' | 'rechazado_cac' | 'no_contesto' | null
  fecha_confirmacion: string | null
  grupo_confirmacion: string | null
}

type WATipo = 'aviso' | 'confirmado' | 'reprog_cliente' | 'reprog_nuestro' | 'no_contesto' | 'ya_salio'

interface WAModalData {
  pedidos: Pedido[]
  itemsMap: Record<string, PedidoItem[]>
  tipoPresel?: WATipo
  fechaReprog?: string; vueltaReprog?: number; motivoReprog?: 'cliente' | 'nosotros'
}

interface PropuestaGrupo { key: string; pedidoIds: string[] }

// ─── Constantes ───────────────────────────────────────────────────────────────

const VUELTA_LABEL: Record<number, string> = {
  1: 'V1 · 8:00–10:00hs', 2: 'V2 · 10:00–12:00hs',
  3: 'V3 · 13:00–15:00hs', 4: 'V4 · 15:00–17:00hs',
}
const TODAS_VUELTAS = [
  { num: 1, label: 'V1 · 8–10hs' }, { num: 2, label: 'V2 · 10–12hs' },
  { num: 3, label: 'V3 · 13–15hs' }, { num: 4, label: 'V4 · 15–17hs' },
  { num: 5, label: 'Fuera de hora' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hoy() { return new Date().toISOString().split('T')[0] }
function formatFecha(f: string) {
  return new Date(f + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' })
}
function formatFechaCorta(f: string) {
  const d = new Date(f + 'T12:00:00')
  return `${d.toLocaleDateString('es-AR', { weekday: 'long' })} ${d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}`
}
function vueltaAFranja(v: number): string {
  if (v === 1) return 'a la mañana'
  if (v === 2) return 'alrededor del mediodía'
  return 'por la tarde'
}
function formatWANumber(tel: string): string {
  let d = tel.replace(/\D/g, '')
  if (d.startsWith('0')) d = d.slice(1)
  if (!d.startsWith('54')) d = '54' + d
  return d
}

function normalizarGrupo(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?a\.?|s\.?r\.?l\.?|sas|sa|srl|ev)\b/g, '')
    .replace(/\b(av\.?|avenida|calle|bv\.?|boulevard|ruta|camino|cno\.?)\b/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
}
function tokenesSimilares(a: string, b: string): boolean {
  const na = normalizarGrupo(a), nb = normalizarGrupo(b)
  if (na === nb) return true
  if (na.length < 3 || nb.length < 3) return false
  const ta = na.split(/\s+/).filter(t => t.length > 2)
  const tb = nb.split(/\s+/).filter(t => t.length > 2)
  if (!ta.length || !tb.length) return false
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const hits = shorter.filter(t => longer.some(lt => lt === t || lt.startsWith(t) || t.startsWith(lt)))
  return hits.length / shorter.length >= 0.7
}
function detectarPropuestas(pedidos: Pedido[], rechazadas: Set<string>): PropuestaGrupo[] {
  const sinGrupo = pedidos.filter(p => !p.grupo_confirmacion && p.estado !== 'rechazado')
  if (sinGrupo.length < 2) return []
  const parent: Record<string, string> = {}
  sinGrupo.forEach(p => { parent[p.id] = p.id })
  function find(id: string): string { if (parent[id] !== id) parent[id] = find(parent[id]); return parent[id] }
  function union(a: string, b: string) { parent[find(a)] = find(b) }
  for (let i = 0; i < sinGrupo.length; i++) {
    for (let j = i + 1; j < sinGrupo.length; j++) {
      const a = sinGrupo[i], b = sinGrupo[j]
      if (tokenesSimilares(a.cliente, b.cliente) && tokenesSimilares(a.direccion, b.direccion)) union(a.id, b.id)
    }
  }
  const groups: Record<string, string[]> = {}
  sinGrupo.forEach(p => { const r = find(p.id); if (!groups[r]) groups[r] = []; groups[r].push(p.id) })
  return Object.entries(groups)
    .filter(([key, ids]) => ids.length > 1 && !rechazadas.has(key))
    .map(([key, ids]) => ({ key, pedidoIds: ids }))
}

// ─── WA messages ─────────────────────────────────────────────────────────────

function buildWAMessages(tipo: WATipo, pedidos: Pedido[], itemsMap: Record<string, PedidoItem[]>, franja: string, fechaReprogLabel: string): string {
  const nombre = pedidos[0].cliente
  const multi = pedidos.length > 1
  const itemsStr = (p: Pedido) => {
    const items = itemsMap[p.id] ?? []
    if (!items.length) return '- (sin detalle de productos)'
    return items.map(i => `- ${[String(i.cantidad), i.unidad, i.nombre].filter(Boolean).join(' ')}`).join('\n')
  }
  const cuando = (p: Pedido) => {
    const f = multi ? vueltaAFranja(p.vuelta) : franja
    return p.fecha_entrega === hoy() ? `*hoy ${f}*` : `*el ${formatFechaCorta(p.fecha_entrega)} ${f}*`
  }
  const pagoEnObra = pedidos.some(p => p.estado_pago === 'pago_en_obra')
    ? `\n\n💰 Recordá que ${multi ? 'alguno de tus pedidos fue' : 'la venta fue'} realizado con la modalidad *pago en obra*. ¿Contás con el importe justo o vas a necesitar cambio?`
    : ''

  if (!multi) {
    const p = pedidos[0]; const its = itemsStr(p); const c = cuando(p)
    switch (tipo) {
      case 'aviso': return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${p.nv}, que incluye:\n${its}\nestá programado para ${c} 🚛\n¿Confirmás que vas a poder recibirlo?${pagoEnObra}`
      case 'confirmado': return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${p.nv}, que incluye:\n${its}\nestá confirmado para ${c} ✅\nAnte cualquier consulta estamos a disposición.${pagoEnObra}`
      case 'ya_salio': return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${p.nv}, que incluye:\n${its}\nya está en camino y llegará ${c} 🚛\nPor favor asegurate de tener alguien disponible para recibirlo.${pagoEnObra}`
      case 'reprog_cliente': return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${p.nv}, que incluye:\n${its}\nfue reprogramado para el *${fechaReprogLabel}* según lo solicitado 📅\nLuego nos volveremos a comunicar para reconfirmar el horario.${pagoEnObra}`
      case 'reprog_nuestro': return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${p.nv}, que incluye:\n${its}\nfue reprogramado para el *${fechaReprogLabel}* 📅\nDisculpá las molestias. Luego nos volveremos a comunicar para reconfirmar el horario.${pagoEnObra}`
      case 'no_contesto': return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo para confirmar la entrega de tu pedido NV ${p.nv}, que incluye:\n${its}\nPor favor respondé este mensaje para confirmar. En caso de no recibir respuesta, el pedido quedará reprogramado para el día siguiente.\n¡Gracias!`
    }
  }
  const bloques = pedidos.map(p => {
    const its = itemsStr(p); const c = cuando(p)
    switch (tipo) {
      case 'aviso': return `Tu pedido NV ${p.nv}, que incluye:\n${its}\nestá programado para ${c} 🚛`
      case 'confirmado': return `Tu pedido NV ${p.nv}, que incluye:\n${its}\nestá confirmado para ${c} ✅`
      case 'ya_salio': return `Tu pedido NV ${p.nv}, que incluye:\n${its}\nya está en camino y llegará ${c} 🚛`
      case 'reprog_cliente': return `Tu pedido NV ${p.nv}, que incluye:\n${its}\nfue reprogramado para el *${fechaReprogLabel}* según lo solicitado 📅`
      case 'reprog_nuestro': return `Tu pedido NV ${p.nv}, que incluye:\n${its}\nfue reprogramado para el *${fechaReprogLabel}* 📅\nDisculpá las molestias.`
      case 'no_contesto': return `Tu pedido NV ${p.nv}, que incluye:\n${its}`
    }
  })
  const footer = { aviso: '\n¿Confirmás que vas a poder recibirlos?', confirmado: '\nAnte cualquier consulta estamos a disposición.', ya_salio: '\nPor favor asegurate de tener alguien disponible para recibirlos.', reprog_cliente: '\nLuego nos volveremos a comunicar para reconfirmar los horarios.', reprog_nuestro: '\nLuego nos volveremos a comunicar para reconfirmar los horarios.', no_contesto: '\nPor favor respondé este mensaje para confirmar. En caso de no recibir respuesta, los pedidos quedarán reprogramados para el día siguiente.\n¡Gracias!' }[tipo]
  return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\n\n${bloques.join('\n\n')}${footer}${pagoEnObra}`
}

// ─── Badge ────────────────────────────────────────────────────────────────────

function BadgeConfirmacion({ pedido }: { pedido: Pedido }) {
  if (pedido.estado === 'en_camino') return <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: '#dbeafe', color: '#1d4ed8' }}>🚛 En camino</span>
  if (pedido.confirmado_cliente) return <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: '#d1fae5', color: '#065f46' }}>✓ Confirmado</span>
  if (pedido.confirmacion_estado === 'rechazado_cliente') return <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>🚫 Rechazado (cliente)</span>
  if (pedido.confirmacion_estado === 'rechazado_cac') return <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>🚫 Rechazado (CAC)</span>
  if (pedido.confirmacion_estado === 'no_contesto') return <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: '#fef3c7', color: '#b45309' }}>📵 No contestó</span>
  return <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: '#fff8e1', color: '#b45309' }}>Sin confirmar</span>
}

// ─── esPendiente: pedido que aún no fue gestionado ───────────────────────────
function esPendiente(p: Pedido) {
  return !p.confirmado_cliente && !p.confirmacion_estado && p.estado === 'programado'
}

// ─── Modal de grupos propuestos ───────────────────────────────────────────────

function GruposModal({ propuestas, pedidos, itemsCache, loadingItems, agrupando, onAprobar, onRechazar, onClose }: {
  propuestas: PropuestaGrupo[]; pedidos: Pedido[]
  itemsCache: Record<string, PedidoItem[]>; loadingItems: boolean
  agrupando: string | null
  onAprobar: (ids: string[], key: string) => void
  onRechazar: (key: string) => void
  onClose: () => void
}) {
  const [expandidos, setExpandidos] = useState<Set<string>>(new Set())
  const toggle = (id: string) => setExpandidos(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl flex flex-col" style={{ width: '100%', maxWidth: 720, maxHeight: '85vh' }}>
        <div className="px-6 py-4 flex items-center justify-between shrink-0" style={{ borderBottom: '1px solid #f0f0f0' }}>
          <div>
            <p className="font-semibold text-sm" style={{ color: '#1a1a1a' }}>👥 Agrupaciones detectadas</p>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>{propuestas.length} grupo{propuestas.length > 1 ? 's' : ''} con mismo cliente y dirección</p>
          </div>
          <button onClick={onClose} className="text-xl leading-none px-2" style={{ color: '#B9BBB7' }}>×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {propuestas.map(prop => {
            const ps = prop.pedidoIds.map(id => pedidos.find(p => p.id === id)).filter(Boolean) as Pedido[]
            if (!ps.length) return null
            return (
              <div key={prop.key} className="rounded-xl border overflow-hidden" style={{ borderColor: '#e8edf8' }}>
                {/* Header del grupo */}
                <div className="px-4 py-3" style={{ background: '#f0f9ff', borderBottom: '1px solid #e8edf8' }}>
                  <p className="font-semibold text-sm" style={{ color: '#0369a1' }}>{ps[0].cliente}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#0369a1' }}>📍 {ps[0].direccion}</p>
                </div>

                {/* Grid de pedidos */}
                <div className="grid gap-0" style={{ gridTemplateColumns: `repeat(${Math.min(ps.length, 3)}, 1fr)` }}>
                  {ps.map((p, idx) => (
                    <div key={p.id} className="px-4 py-3" style={{ borderRight: idx < ps.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-semibold text-sm" style={{ color: '#254A96' }}>NV {p.nv}</p>
                          <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                            <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: '#e8edf8', color: '#254A96' }}>
                              {VUELTA_LABEL[p.vuelta] ?? `V${p.vuelta}`}
                            </span>
                            {p.camion_id && (
                              <span className="text-xs" style={{ color: '#B9BBB7' }}>🚛 {p.camion_id}</span>
                            )}
                          </div>
                        </div>
                        <BadgeConfirmacion pedido={p} />
                      </div>

                      {/* Items colapsables */}
                      {loadingItems ? (
                        <p className="text-xs" style={{ color: '#B9BBB7' }}>Cargando...</p>
                      ) : (itemsCache[p.id] ?? []).length > 0 ? (
                        <div>
                          <button onClick={() => toggle(p.id)}
                            className="text-xs font-medium"
                            style={{ color: '#254A96' }}>
                            {expandidos.has(p.id) ? '▲ Ocultar' : `▼ ${(itemsCache[p.id] ?? []).length} ítem${(itemsCache[p.id] ?? []).length > 1 ? 's' : ''}`}
                          </button>
                          {expandidos.has(p.id) && (
                            <div className="mt-1.5 space-y-1">
                              {(itemsCache[p.id] ?? []).map((item, i) => (
                                <div key={i} className="text-xs rounded px-2 py-1" style={{ background: '#f4f4f3', color: '#555' }}>
                                  {item.cantidad} {item.unidad} {item.nombre}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs" style={{ color: '#B9BBB7' }}>Sin ítems</p>
                      )}
                    </div>
                  ))}
                </div>

                {/* Acciones */}
                <div className="px-4 py-3 flex gap-2" style={{ borderTop: '1px solid #f0f0f0', background: '#fafafa' }}>
                  <button onClick={() => onAprobar(prop.pedidoIds, prop.key)} disabled={agrupando === prop.key}
                    className="flex-1 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: '#254A96' }}>
                    {agrupando === prop.key ? '...' : `👥 Agrupar ${ps.length} pedidos`}
                  </button>
                  <button onClick={() => onRechazar(prop.key)}
                    className="px-4 py-2 rounded-xl text-sm font-medium"
                    style={{ background: 'white', color: '#666', border: '1px solid #e8edf8' }}>
                    No, son distintos
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function ConfirmacionesPage() {
  const router = useRouter()
  const [usuario, setUsuario] = useState<any>(null)
  const [nombreUsuario, setNombreUsuario] = useState('')
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [cargando, setCargando] = useState(true)
  const [confirmando, setConfirmando] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [editDirecciones, setEditDirecciones] = useState<Record<string, string>>({})

  // Filtros
  const [filtroFecha, setFiltroFecha] = useState(hoy())
  const [filtroSucursal, setFiltroSucursal] = useState('')
  const [filtroConfirmado, setFiltroConfirmado] = useState<'todos' | 'confirmado' | 'sin_confirmar'>('todos')

  // Modal reprogramar — soporta uno o varios pedidos (grupo)
  const [modalReprog, setModalReprog] = useState<{ pedidos: Pedido[] } | null>(null)
  const [reprogFecha, setReprogFecha] = useState('')
  const [reprogVuelta, setReprogVuelta] = useState(1)
  const [reprogMotivo, setReprogMotivo] = useState<'cliente' | 'nosotros'>('cliente')
  const [reprogGuardando, setReprogGuardando] = useState(false)

  // Modal WA
  const [modalWA, setModalWA] = useState<WAModalData | null>(null)
  const [waTipo, setWATipo] = useState<WATipo>('aviso')
  const [waFranja, setWAFranja] = useState('a la mañana')
  const [loadingItems, setLoadingItems] = useState(false)
  const [itemsCache, setItemsCache] = useState<Record<string, PedidoItem[]>>({})

  // En camino
  const [marcandoEnCamino, setMarcandoEnCamino] = useState<string | null>(null)

  // Agrupaciones
  const [propuestas, setPropuestas] = useState<PropuestaGrupo[]>([])
  const [propuestasDesc, setPropuestasDesc] = useState<Set<string>>(new Set())
  const [modalGrupos, setModalGrupos] = useState(false)
  const [agrupando, setAgrupando] = useState<string | null>(null)
  const [loadingGruposItems, setLoadingGruposItems] = useState(false)

  // Selección manual
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set())
  const [modoSeleccion, setModoSeleccion] = useState(false)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data: userData } = await supabase.from('usuarios').select('nombre, rol, permisos, sucursal').eq('id', user.id).single()
      if (!tieneAcceso(userData?.permisos, userData?.rol, 'confirmaciones')) { router.push('/dashboard'); return }
      setUsuario(user); setNombreUsuario(userData?.nombre ?? user.email ?? '')
      if (userData?.sucursal) setFiltroSucursal(userData.sucursal)
      cargarPedidos({ sucursal: userData?.sucursal ?? '' })
    })
  }, [])

  useEffect(() => {
    if (pedidos.length > 1) setPropuestas(detectarPropuestas(pedidos, propuestasDesc))
  }, [pedidos, propuestasDesc])

  // Cargar items de grupos cuando se abre el modal
  useEffect(() => {
    if (!modalGrupos || propuestasActivas.length === 0) return
    const allIds = propuestasActivas.flatMap(p => p.pedidoIds)
    const uncached = allIds.filter(id => !itemsCache[id])
    if (!uncached.length) return
    setLoadingGruposItems(true)
    ;(async () => {
      for (const id of uncached) {
        if (itemsCache[id]) continue
        const { data } = await supabase.from('pedido_items').select('nombre, cantidad, unidad').eq('pedido_id', id)
        const items: PedidoItem[] = (data ?? []).map((i: any) => ({ nombre: i.nombre ?? '', cantidad: i.cantidad ?? 0, unidad: i.unidad ?? '' }))
        setItemsCache(prev => ({ ...prev, [id]: items }))
      }
      setLoadingGruposItems(false)
    })()
  }, [modalGrupos])

  const cargarPedidos = async (params?: { fecha?: string; sucursal?: string; confirmado?: 'todos' | 'confirmado' | 'sin_confirmar' }) => {
    setCargando(true)
    const fecha = params?.fecha ?? filtroFecha
    const sucursal = params?.sucursal ?? filtroSucursal
    const confirmado = params?.confirmado ?? filtroConfirmado
    const campos = 'id,nv,cliente,telefono,direccion,sucursal,fecha_entrega,vuelta,estado,estado_pago,camion_id,confirmado_cliente,notas,confirmacion_estado,fecha_confirmacion,grupo_confirmacion'

    let q1 = supabase.from('pedidos').select(campos).in('estado', ['programado', 'en_camino']).order('vuelta').order('cliente')
    if (fecha) q1 = q1.eq('fecha_entrega', fecha)
    else q1 = q1.gte('fecha_entrega', hoy())
    if (sucursal) q1 = q1.eq('sucursal', sucursal)
    if (confirmado === 'confirmado') q1 = q1.eq('confirmado_cliente', true)
    else if (confirmado === 'sin_confirmar') q1 = q1.eq('confirmado_cliente', false)

    let rechazados: Pedido[] = []
    if (fecha && confirmado !== 'confirmado') {
      let q2 = supabase.from('pedidos').select(campos).eq('fecha_confirmacion', fecha).in('confirmacion_estado', ['rechazado_cliente', 'rechazado_cac']).order('vuelta').order('cliente')
      if (sucursal) q2 = q2.eq('sucursal', sucursal)
      const { data: r } = await q2
      rechazados = (r ?? []) as Pedido[]
    }

    const { data, error } = await q1
    if (error) { showToast('Error al cargar pedidos', 'err'); setCargando(false); return }
    const activos = (data ?? []) as Pedido[]
    const ids = new Set(activos.map(p => p.id))
    const merged = [...activos, ...rechazados.filter(r => !ids.has(r.id))]
    merged.sort((a, b) => (a.vuelta ?? 0) - (b.vuelta ?? 0) || a.cliente.localeCompare(b.cliente))
    setPedidos(merged); setCargando(false)
  }

  const buscar = () => cargarPedidos({ fecha: filtroFecha, sucursal: filtroSucursal, confirmado: filtroConfirmado })

  // ─── Acciones individuales ────────────────────────────────────────────────

  const confirmarCliente = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const pedido = pedidos.find(p => p.id === pedidoId)
    const { error } = await supabase.from('pedidos').update({ confirmado_cliente: true, confirmacion_estado: null, fecha_confirmacion: null }).eq('id', pedidoId)
    if (error) { showToast('Error al confirmar', 'err') }
    else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, confirmado_cliente: true, confirmacion_estado: null } : p))
      showToast('Cliente confirmado ✓')
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Confirmó pedido con cliente', 'Confirmaciones', { nv: pedido.nv, cliente: pedido.cliente })
    }
    setConfirmando(null)
  }

  const desconfirmarCliente = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const { error } = await supabase.from('pedidos').update({ confirmado_cliente: false }).eq('id', pedidoId)
    if (!error) setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, confirmado_cliente: false } : p))
    else showToast('Error', 'err')
    setConfirmando(null)
  }

  const marcarNoContesto = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const pedido = pedidos.find(p => p.id === pedidoId)
    const { error } = await supabase.from('pedidos').update({ confirmacion_estado: 'no_contesto', fecha_confirmacion: hoy() }).eq('id', pedidoId)
    if (!error) {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, confirmacion_estado: 'no_contesto', fecha_confirmacion: hoy() } : p))
      showToast('Marcado como no contestó')
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Marcó no contestó', 'Confirmaciones', { nv: pedido.nv })
    } else showToast('Error', 'err')
    setConfirmando(null)
  }

  const marcarEnCamino = async (pedido: Pedido) => {
    setMarcandoEnCamino(pedido.id)
    const { error } = await supabase.from('pedidos').update({ estado: 'en_camino' }).eq('id', pedido.id)
    if (error) { showToast('Error', 'err'); setMarcandoEnCamino(null); return }
    setPedidos(prev => prev.map(p => p.id === pedido.id ? { ...p, estado: 'en_camino' } : p))
    showToast('Marcado en camino 🚛')
    if (usuario) logAuditoria(usuario.id, nombreUsuario, 'Marcó en camino (manual)', 'Confirmaciones', { nv: pedido.nv })
    setMarcandoEnCamino(null)
    await abrirModalWA([pedido], 'ya_salio')
  }

  const deshacerEstado = async (pedidoId: string) => {
    const pedido = pedidos.find(p => p.id === pedidoId)
    const updates: any = { confirmacion_estado: null, fecha_confirmacion: null, confirmado_cliente: false }
    if (pedido?.estado === 'en_camino') updates.estado = 'programado'
    const { error } = await supabase.from('pedidos').update(updates).eq('id', pedidoId)
    if (!error) {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, ...updates } : p))
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Deshizo estado confirmación', 'Confirmaciones', { nv: pedido.nv })
    }
  }

  const guardarDireccion = async (pedidoId: string, valor: string) => {
    const pedido = pedidos.find(p => p.id === pedidoId)
    if (valor.trim() === (pedido?.direccion ?? '').trim()) return
    const { error } = await supabase.from('pedidos').update({ direccion: valor.trim() }).eq('id', pedidoId)
    if (error) { showToast('Error al guardar dirección', 'err') }
    else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, direccion: valor.trim() } : p))
      setEditDirecciones(prev => { const n = { ...prev }; delete n[pedidoId]; return n })
      showToast('Dirección actualizada ✓')
    }
  }

  // ─── Acciones de grupo ────────────────────────────────────────────────────

  const confirmarGrupo = async (gruPedidos: Pedido[]) => {
    const pendientes = gruPedidos.filter(esPendiente)
    if (!pendientes.length) { showToast('No hay pedidos pendientes en el grupo'); return }
    const ids = pendientes.map(p => p.id)
    const { error } = await supabase.from('pedidos').update({ confirmado_cliente: true, confirmacion_estado: null, fecha_confirmacion: null }).in('id', ids)
    if (error) { showToast('Error al confirmar', 'err'); return }
    setPedidos(prev => prev.map(p => ids.includes(p.id) ? { ...p, confirmado_cliente: true, confirmacion_estado: null } : p))
    showToast(`${pendientes.length} pedido${pendientes.length > 1 ? 's' : ''} confirmado${pendientes.length > 1 ? 's' : ''} ✓`)
    if (usuario) logAuditoria(usuario.id, nombreUsuario, 'Confirmó grupo', 'Confirmaciones', { nvs: pendientes.map(p => p.nv) })
  }

  const noContesoGrupo = async (gruPedidos: Pedido[]) => {
    const pendientes = gruPedidos.filter(esPendiente)
    if (!pendientes.length) { showToast('No hay pedidos pendientes'); return }
    const ids = pendientes.map(p => p.id)
    const { error } = await supabase.from('pedidos').update({ confirmacion_estado: 'no_contesto', fecha_confirmacion: hoy() }).in('id', ids)
    if (!error) {
      setPedidos(prev => prev.map(p => ids.includes(p.id) ? { ...p, confirmacion_estado: 'no_contesto', fecha_confirmacion: hoy() } : p))
      showToast(`${pendientes.length} marcados como no contestó`)
    }
  }

  const marcarEnCaminoGrupo = async (gruPedidos: Pedido[]) => {
    const activos = gruPedidos.filter(p => p.estado === 'programado')
    if (!activos.length) return
    const ids = activos.map(p => p.id)
    const { error } = await supabase.from('pedidos').update({ estado: 'en_camino' }).in('id', ids)
    if (error) { showToast('Error', 'err'); return }
    setPedidos(prev => prev.map(p => ids.includes(p.id) ? { ...p, estado: 'en_camino' } : p))
    showToast('Grupo en camino 🚛')
    await abrirModalWA(gruPedidos, 'ya_salio')
  }

  // ─── Reprogramar ──────────────────────────────────────────────────────────

  const confirmarReprog = async () => {
    if (!modalReprog || !reprogFecha) return
    const peds = modalReprog.pedidos
    setReprogGuardando(true)
    const estadoConf: 'rechazado_cliente' | 'rechazado_cac' = reprogMotivo === 'cliente' ? 'rechazado_cliente' : 'rechazado_cac'
    const motivoLabel = reprogMotivo === 'cliente' ? 'a pedido del cliente' : 'reprogramado por CAC'

    const results = await Promise.all(peds.map(async pedido => {
      const nota = `⚡ Reprog. desde ${pedido.fecha_entrega} V${pedido.vuelta} — ${motivoLabel}`
      const notaFinal = pedido.notas ? `${pedido.notas} | ${nota}` : nota
      const res = await fetch('/api/pedidos', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pedido.id, fecha_entrega: reprogFecha, vuelta: reprogVuelta, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: notaFinal, confirmacion_estado: estadoConf, fecha_confirmacion: hoy() }),
      })
      return { pedido, ok: res.ok }
    }))

    setReprogGuardando(false)
    const errores = results.filter(r => !r.ok)
    if (errores.length) { showToast(`Error al reprogramar ${errores.length} pedido(s)`, 'err'); return }

    const savedFecha = reprogFecha, savedVuelta = reprogVuelta, savedMotivo = reprogMotivo
    setPedidos(prev => prev.map(p => peds.some(rp => rp.id === p.id)
      ? { ...p, confirmacion_estado: estadoConf, fecha_confirmacion: hoy(), fecha_entrega: savedFecha, vuelta: savedVuelta }
      : p
    ))
    if (usuario) logAuditoria(usuario.id, nombreUsuario, 'Rechazó y reprogramó', 'Confirmaciones', { nvs: peds.map(p => p.nv), fecha_nueva: savedFecha, motivo: savedMotivo })
    setModalReprog(null)
    showToast(`${peds.length} pedido${peds.length > 1 ? 's' : ''} reprogramado${peds.length > 1 ? 's' : ''} — recordá enviar el WA`)
    await abrirModalWA(peds, savedMotivo === 'cliente' ? 'reprog_cliente' : 'reprog_nuestro', savedFecha, savedVuelta, savedMotivo)
  }

  // ─── Modal WA ─────────────────────────────────────────────────────────────

  const abrirModalWA = async (pedidosList: Pedido[], tipoPresel?: WATipo, fechaReprog?: string, vueltaReprog?: number, motivoReprog?: 'cliente' | 'nosotros') => {
    const tipo = tipoPresel ?? 'aviso'
    setWATipo(tipo); setWAFranja(vueltaAFranja(pedidosList[0].vuelta))
    const cachedMap: Record<string, PedidoItem[]> = {}
    pedidosList.forEach(p => { if (itemsCache[p.id]) cachedMap[p.id] = itemsCache[p.id] })
    setModalWA({ pedidos: pedidosList, itemsMap: cachedMap, tipoPresel: tipo, fechaReprog, vueltaReprog, motivoReprog })
    const sinCache = pedidosList.filter(p => !itemsCache[p.id])
    if (sinCache.length > 0) {
      setLoadingItems(true)
      const newMap = { ...cachedMap }
      for (const p of sinCache) {
        const { data } = await supabase.from('pedido_items').select('nombre, cantidad, unidad').eq('pedido_id', p.id)
        const items: PedidoItem[] = (data ?? []).map((i: any) => ({ nombre: i.nombre ?? '', cantidad: i.cantidad ?? 0, unidad: i.unidad ?? '' }))
        newMap[p.id] = items; setItemsCache(prev => ({ ...prev, [p.id]: items }))
      }
      setLoadingItems(false)
      setModalWA(prev => prev ? { ...prev, itemsMap: newMap } : null)
    }
  }

  // ─── Agrupaciones ─────────────────────────────────────────────────────────

  const aprobarGrupo = async (pedidoIds: string[], key: string) => {
    setAgrupando(key)
    const grupoId = crypto.randomUUID()
    const { error } = await supabase.from('pedidos').update({ grupo_confirmacion: grupoId }).in('id', pedidoIds)
    if (error) { showToast('Error al agrupar', 'err') }
    else {
      setPedidos(prev => prev.map(p => pedidoIds.includes(p.id) ? { ...p, grupo_confirmacion: grupoId } : p))
      setPropuestasDesc(prev => new Set([...prev, key]))
      showToast(`${pedidoIds.length} pedidos agrupados`)
    }
    setAgrupando(null)
  }

  const desagrupar = async (grupoId: string) => {
    const { error } = await supabase.from('pedidos').update({ grupo_confirmacion: null }).eq('grupo_confirmacion', grupoId)
    if (!error) { setPedidos(prev => prev.map(p => p.grupo_confirmacion === grupoId ? { ...p, grupo_confirmacion: null } : p)); showToast('Grupo separado') }
  }

  // ─── Selección manual ─────────────────────────────────────────────────────

  const toggleSeleccion = (id: string) => {
    setSeleccionados(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }
  const limpiarSeleccion = () => { setSeleccionados(new Set()); setModoSeleccion(false) }

  const agruparSeleccionados = async () => {
    const ids = [...seleccionados]
    if (ids.length < 2) { showToast('Seleccioná al menos 2 pedidos', 'err'); return }
    const grupoId = crypto.randomUUID()
    const { error } = await supabase.from('pedidos').update({ grupo_confirmacion: grupoId }).in('id', ids)
    if (error) { showToast('Error al agrupar', 'err'); return }
    setPedidos(prev => prev.map(p => ids.includes(p.id) ? { ...p, grupo_confirmacion: grupoId } : p))
    showToast(`${ids.length} pedidos agrupados`)
    limpiarSeleccion()
  }

  // ─── Agrupación por fecha ──────────────────────────────────────────────────

  const porFecha: Record<string, Pedido[]> = {}
  pedidos.forEach(p => {
    const fg = (p.confirmacion_estado === 'rechazado_cliente' || p.confirmacion_estado === 'rechazado_cac')
      ? (p.fecha_confirmacion ?? p.fecha_entrega) : p.fecha_entrega
    if (!porFecha[fg]) porFecha[fg] = []
    porFecha[fg].push(p)
  })

  const totalConfirmados = pedidos.filter(p => p.confirmado_cliente).length
  const totalPendientes = pedidos.filter(p => esPendiente(p)).length
  const totalEnCamino = pedidos.filter(p => p.estado === 'en_camino').length
  const totalGestionados = pedidos.filter(p => p.confirmacion_estado).length

  const waPreview = modalWA ? buildWAMessages(waTipo, modalWA.pedidos, modalWA.itemsMap, waFranja, modalWA.fechaReprog ? formatFechaCorta(modalWA.fechaReprog) : '') : ''
  const telefonoGrupo = (peds: Pedido[]) => peds.find(p => p.telefono)?.telefono ?? null
  const propuestasActivas = propuestas.filter(p => !propuestasDesc.has(p.key))

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Barra flotante selección */}
      {seleccionados.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-3 rounded-2xl shadow-2xl"
          style={{ background: '#1a1a1a', color: 'white' }}>
          <span className="text-sm font-medium">☑ {seleccionados.size} pedido{seleccionados.size > 1 ? 's' : ''} seleccionado{seleccionados.size > 1 ? 's' : ''}</span>
          <button onClick={agruparSeleccionados}
            disabled={seleccionados.size < 2}
            className="px-4 py-1.5 rounded-xl text-sm font-semibold disabled:opacity-40"
            style={{ background: '#254A96', color: 'white' }}>
            👥 Agrupar
          </button>
          <button onClick={limpiarSeleccion} className="text-sm px-2" style={{ color: '#B9BBB7' }}>Cancelar</button>
        </div>
      )}

      {/* Modal reprogramar */}
      {modalReprog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="font-semibold text-sm mb-0.5" style={{ color: '#E52322' }}>🚫 Rechazar y reprogramar</h3>
            <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>
              {modalReprog.pedidos.length === 1
                ? `NV ${modalReprog.pedidos[0].nv} · ${modalReprog.pedidos[0].cliente}`
                : `${modalReprog.pedidos.length} pedidos · ${modalReprog.pedidos[0].cliente}`}
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Motivo</label>
                <div className="grid grid-cols-2 gap-2">
                  {([{ key: 'cliente', label: '👤 Lo pidió el cliente' }, { key: 'nosotros', label: '🏭 No podemos entregar' }] as const).map(m => (
                    <button key={m.key} type="button" onClick={() => setReprogMotivo(m.key)}
                      className="px-3 py-2.5 rounded-xl text-xs font-medium border transition-colors text-left"
                      style={{ background: reprogMotivo === m.key ? '#fde8e8' : '#f4f4f3', color: reprogMotivo === m.key ? '#E52322' : '#666', border: `1px solid ${reprogMotivo === m.key ? '#fca5a5' : '#e8edf8'}` }}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva fecha</label>
                <input type="date" value={reprogFecha} min={hoy()} onChange={e => setReprogFecha(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva vuelta</label>
                <select value={reprogVuelta} onChange={e => setReprogVuelta(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                  {TODAS_VUELTAS.map(v => <option key={v.num} value={v.num}>{v.label}</option>)}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={confirmarReprog} disabled={!reprogFecha || reprogGuardando}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: '#E52322' }}>
                {reprogGuardando ? 'Guardando…' : 'Confirmar'}
              </button>
              <button onClick={() => setModalReprog(null)} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal grupos */}
      {modalGrupos && propuestasActivas.length > 0 && (
        <GruposModal
          propuestas={propuestasActivas}
          pedidos={pedidos}
          itemsCache={itemsCache}
          loadingItems={loadingGruposItems}
          agrupando={agrupando}
          onAprobar={aprobarGrupo}
          onRechazar={(key) => setPropuestasDesc(prev => new Set([...prev, key]))}
          onClose={() => setModalGrupos(false)}
        />
      )}

      {/* Modal WA */}
      {modalWA && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full flex flex-col" style={{ maxWidth: 440, maxHeight: '90vh' }}>
            <div className="px-5 py-4 flex items-start justify-between shrink-0" style={{ borderBottom: '1px solid #f0f0f0' }}>
              <div>
                <p className="font-semibold text-sm" style={{ color: '#1a1a1a' }}>💬 WhatsApp{modalWA.pedidos.length > 1 ? ` · ${modalWA.pedidos.length} pedidos` : ''}</p>
                <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                  {modalWA.pedidos[0].cliente}
                  {modalWA.pedidos.length > 1 ? ` · NV ${modalWA.pedidos.map(p => p.nv).join(', ')}` : ` · NV ${modalWA.pedidos[0].nv}`}
                </p>
              </div>
              <div className="text-right ml-4 shrink-0">
                {telefonoGrupo(modalWA.pedidos)
                  ? <p className="text-xs font-medium" style={{ color: '#254A96' }}>📞 {telefonoGrupo(modalWA.pedidos)}</p>
                  : <span className="text-xs px-2 py-1 rounded-lg" style={{ background: '#fff8e1', color: '#b45309' }}>⚠ Sin número</span>}
              </div>
            </div>
            <div className="px-5 py-4 space-y-1.5 shrink-0" style={{ borderBottom: '1px solid #f0f0f0' }}>
              <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: '#B9BBB7' }}>Antes de llamar</p>
              <button onClick={() => setWATipo('aviso')}
                className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors"
                style={{ background: waTipo === 'aviso' ? '#e8edf8' : 'white', color: waTipo === 'aviso' ? '#254A96' : '#666', border: `1px solid ${waTipo === 'aviso' ? '#254A96' : '#e8edf8'}` }}>
                📋 Aviso de programación
              </button>
              <p className="text-xs font-semibold uppercase tracking-wide mt-3 mb-2 pt-2" style={{ color: '#B9BBB7' }}>Después de llamar</p>
              {([
                { key: 'confirmado' as WATipo, label: '✅ Confirmado' },
                { key: 'ya_salio' as WATipo, label: '🚛 Ya salió — en camino' },
                { key: 'reprog_cliente' as WATipo, label: '📅 Reprogramado (lo pidió el cliente)' },
                { key: 'reprog_nuestro' as WATipo, label: '📅 Reprogramado (de nuestra parte)' },
                { key: 'no_contesto' as WATipo, label: '📵 No contestó' },
              ]).map(t => (
                <button key={t.key} onClick={() => setWATipo(t.key)}
                  className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors"
                  style={{ background: waTipo === t.key ? '#e8edf8' : 'white', color: waTipo === t.key ? '#254A96' : '#666', border: `1px solid ${waTipo === t.key ? '#254A96' : '#e8edf8'}` }}>
                  {t.label}
                </button>
              ))}
              {(waTipo === 'aviso' || waTipo === 'confirmado' || waTipo === 'ya_salio') && modalWA.pedidos.length === 1 && (
                <div className="pt-3">
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Franja horaria</label>
                  <div className="flex gap-1.5">
                    {[{ val: 'a la mañana', label: '🌅 Mañana' }, { val: 'alrededor del mediodía', label: '☀️ Mediodía' }, { val: 'por la tarde', label: '🌇 Tarde' }].map(f => (
                      <button key={f.val} onClick={() => setWAFranja(f.val)}
                        className="flex-1 px-1.5 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                        style={{ background: waFranja === f.val ? '#254A96' : '#f4f4f3', color: waFranja === f.val ? 'white' : '#666', border: `1px solid ${waFranja === f.val ? '#254A96' : '#e8edf8'}` }}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="px-5 py-4 flex-1 overflow-y-auto min-h-0">
              <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: '#B9BBB7' }}>Vista previa</p>
              {loadingItems
                ? <div className="flex items-center gap-2 py-4"><div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} /><span className="text-xs" style={{ color: '#B9BBB7' }}>Cargando...</span></div>
                : <pre className="text-xs leading-relaxed whitespace-pre-wrap rounded-xl p-3" style={{ background: '#f4f4f3', color: '#1a1a1a', fontFamily: 'inherit' }}>{waPreview}</pre>
              }
            </div>
            <div className="px-5 py-4 flex gap-2 shrink-0" style={{ borderTop: '1px solid #f0f0f0' }}>
              <button onClick={() => { navigator.clipboard.writeText(waPreview); showToast('Mensaje copiado') }} disabled={loadingItems}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border disabled:opacity-40"
                style={{ borderColor: '#e8edf8', color: '#254A96', background: 'white' }}>📋 Copiar</button>
              {telefonoGrupo(modalWA.pedidos)
                ? <a href={`https://wa.me/${formatWANumber(telefonoGrupo(modalWA.pedidos)!)}?text=${encodeURIComponent(waPreview)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center"
                    style={{ background: '#25D366' }}>💬 Abrir WA</a>
                : <button disabled className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 text-white" style={{ background: '#25D366' }}>Sin número</button>
              }
              <button onClick={() => setModalWA(null)} className="px-3 py-2.5 rounded-xl text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>×</button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-[1400px] mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-xs px-2 py-1.5 rounded-lg font-medium shrink-0" style={{ background: '#e8edf8', color: '#254A96' }}>← Volver</Link>
            <div className="w-px h-5 bg-gray-200 hidden sm:block" />
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Confirmaciones</span>
              <span className="text-xs ml-2 hidden sm:inline" style={{ color: '#B9BBB7' }}>{nombreUsuario}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setModoSeleccion(v => !v); if (modoSeleccion) limpiarSeleccion() }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
              style={{ background: modoSeleccion ? '#e8edf8' : '#f4f4f3', color: modoSeleccion ? '#254A96' : '#666' }}>
              {modoSeleccion ? '✕ Cancelar selección' : '☑ Seleccionar'}
            </button>
            <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>Salir</button>
          </div>
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto px-4 py-5">

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { bg: '#d1fae5', emoji: '✅', value: totalConfirmados, label: 'Confirmados', color: '#065f46' },
            { bg: '#fff8e1', emoji: '📞', value: totalPendientes, label: 'Sin gestionar', color: '#b45309' },
            { bg: '#dbeafe', emoji: '🚛', value: totalEnCamino, label: 'En camino', color: '#1d4ed8' },
            { bg: '#fde8e8', emoji: '🚫', value: totalGestionados, label: 'Rechazados/N.C.', color: '#E52322' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: s.bg }}>{s.emoji}</div>
              <div><p className="text-2xl font-bold leading-none" style={{ color: s.color }}>{s.value}</p><p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>{s.label}</p></div>
            </div>
          ))}
        </div>

        {/* Banner grupos */}
        {propuestasActivas.length > 0 && (
          <div className="mb-4 rounded-xl px-4 py-3 flex items-center justify-between gap-3" style={{ background: '#f0f9ff', border: '1px solid #bae6fd' }}>
            <div className="flex items-center gap-2">
              <span className="text-lg">👥</span>
              <p className="text-sm" style={{ color: '#0369a1' }}>
                <strong>{propuestasActivas.length} posible{propuestasActivas.length > 1 ? 's' : ''} agrupación{propuestasActivas.length > 1 ? 'es' : ''}</strong> detectada{propuestasActivas.length > 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setModalGrupos(true)} className="text-xs px-3 py-1.5 rounded-lg font-semibold" style={{ background: '#0369a1', color: 'white' }}>Ver y gestionar</button>
              <button onClick={() => setPropuestasDesc(prev => new Set([...prev, ...propuestasActivas.map(p => p.key)]))}
                className="text-xs px-2 py-1.5 rounded-lg" style={{ background: 'white', color: '#0369a1', border: '1px solid #bae6fd' }}>Descartar</button>
            </div>
          </div>
        )}

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-5">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha entrega</label>
              <input type="date" value={filtroFecha} onChange={e => setFiltroFecha(e.target.value)} onKeyDown={e => e.key === 'Enter' && buscar()}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Sucursal</label>
              <select value={filtroSucursal} onChange={e => setFiltroSucursal(e.target.value)} className="border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                <option value="">Todas</option>
                {['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Estado</label>
              <select value={filtroConfirmado} onChange={e => setFiltroConfirmado(e.target.value as any)} className="border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                <option value="todos">Todos</option>
                <option value="sin_confirmar">Sin confirmar</option>
                <option value="confirmado">Confirmados</option>
              </select>
            </div>
            <button onClick={buscar} className="px-5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: '#254A96' }}>Buscar</button>
            <button onClick={() => { setFiltroFecha(''); setFiltroSucursal(''); setFiltroConfirmado('todos'); cargarPedidos({ fecha: '', sucursal: '', confirmado: 'todos' }) }}
              className="px-4 py-2 rounded-lg text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>Ver todos</button>
          </div>
        </div>

        {/* Lista */}
        {Object.keys(porFecha).length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <p className="text-4xl mb-3">{filtroConfirmado === 'sin_confirmar' ? '🎉' : '📭'}</p>
            <p className="font-medium text-sm" style={{ color: '#254A96' }}>
              {filtroConfirmado === 'sin_confirmar' ? '¡Todos los clientes están confirmados!' : 'No hay pedidos programados'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(porFecha).sort(([a], [b]) => a.localeCompare(b)).map(([fecha, pedidosDia]) => {
              const gruposMap: Record<string, Pedido[]> = {}
              const sueltos: Pedido[] = []
              pedidosDia.forEach(p => {
                if (p.grupo_confirmacion) { if (!gruposMap[p.grupo_confirmacion]) gruposMap[p.grupo_confirmacion] = []; gruposMap[p.grupo_confirmacion].push(p) }
                else sueltos.push(p)
              })
              return (
                <div key={fecha}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                    <span className="text-xs font-semibold px-3 py-1 rounded-full capitalize" style={{ background: '#e8edf8', color: '#254A96' }}>{formatFecha(fecha)}</span>
                    <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                    {Object.entries(gruposMap).map(([grupoId, gPedidos]) => (
                      <GrupoCard key={grupoId} grupoId={grupoId} pedidos={gPedidos}
                        confirmando={confirmando} marcandoEnCamino={marcandoEnCamino}
                        editDirecciones={editDirecciones} modoSeleccion={modoSeleccion} seleccionados={seleccionados}
                        onConfirmarGrupo={() => confirmarGrupo(gPedidos)}
                        onNoContesoGrupo={() => noContesoGrupo(gPedidos)}
                        onEnCaminoGrupo={() => marcarEnCaminoGrupo(gPedidos)}
                        onRechazarGrupo={() => { setReprogFecha(''); setReprogVuelta(1); setReprogMotivo('cliente'); setModalReprog({ pedidos: gPedidos.filter(esPendiente) }) }}
                        onConfirmar={confirmarCliente} onDesconfirmar={desconfirmarCliente}
                        onNoContesto={marcarNoContesto} onEnCamino={marcarEnCamino}
                        onRechazar={(p) => { setReprogFecha(''); setReprogVuelta(1); setReprogMotivo('cliente'); setModalReprog({ pedidos: [p] }) }}
                        onWA={(peds) => abrirModalWA(peds)} onDesagrupar={() => desagrupar(grupoId)}
                        onDeshacerEstado={deshacerEstado} onToggleSeleccion={toggleSeleccion}
                        onEditDireccion={(id, val) => setEditDirecciones(prev => ({ ...prev, [id]: val }))}
                        onGuardarDireccion={guardarDireccion}
                      />
                    ))}
                    {sueltos.map(pedido => (
                      <PedidoCard key={pedido.id} pedido={pedido}
                        confirmando={confirmando} marcandoEnCamino={marcandoEnCamino}
                        editDireccion={editDirecciones[pedido.id]}
                        modoSeleccion={modoSeleccion} seleccionado={seleccionados.has(pedido.id)}
                        onConfirmar={() => confirmarCliente(pedido.id)} onDesconfirmar={() => desconfirmarCliente(pedido.id)}
                        onNoContesto={() => marcarNoContesto(pedido.id)} onEnCamino={() => marcarEnCamino(pedido)}
                        onRechazar={() => { setReprogFecha(''); setReprogVuelta(1); setReprogMotivo('cliente'); setModalReprog({ pedidos: [pedido] }) }}
                        onWA={() => abrirModalWA([pedido])} onDeshacerEstado={() => deshacerEstado(pedido.id)}
                        onToggleSeleccion={() => toggleSeleccion(pedido.id)}
                        onEditDireccion={(val) => setEditDirecciones(prev => ({ ...prev, [pedido.id]: val }))}
                        onGuardarDireccion={(val) => guardarDireccion(pedido.id, val)}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

// ─── PedidoCard ───────────────────────────────────────────────────────────────

function PedidoCard({ pedido, confirmando, marcandoEnCamino, editDireccion, modoSeleccion, seleccionado, onConfirmar, onDesconfirmar, onNoContesto, onEnCamino, onRechazar, onWA, onDeshacerEstado, onToggleSeleccion, onEditDireccion, onGuardarDireccion }: {
  pedido: Pedido; confirmando: string | null; marcandoEnCamino: string | null
  editDireccion?: string; modoSeleccion: boolean; seleccionado: boolean
  onConfirmar: () => void; onDesconfirmar: () => void; onNoContesto: () => void
  onEnCamino: () => void; onRechazar: () => void; onWA: () => void
  onDeshacerEstado: () => void; onToggleSeleccion: () => void
  onEditDireccion: (val: string) => void; onGuardarDireccion: (val: string) => void
}) {
  const esRechazado = pedido.confirmacion_estado === 'rechazado_cliente' || pedido.confirmacion_estado === 'rechazado_cac'
  const esNoContesto = pedido.confirmacion_estado === 'no_contesto'
  const esEnCamino = pedido.estado === 'en_camino'
  const esGestionado = esRechazado || esNoContesto
  const borderColor = seleccionado ? '#6366f1' : pedido.confirmado_cliente ? '#d1fae5' : esEnCamino ? '#93c5fd' : esRechazado ? '#fca5a5' : esNoContesto ? '#fde68a' : '#f0f0f0'
  const bgHeader = seleccionado ? '#eef2ff' : pedido.confirmado_cliente ? '#f0fdf4' : esEnCamino ? '#eff6ff' : esRechazado ? '#fff5f5' : esNoContesto ? '#fffbeb' : 'white'

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: `2px solid ${borderColor}` }}>
      <div className="px-4 py-3 flex items-center justify-between" style={{ background: bgHeader }}>
        <div className="flex items-center gap-3 min-w-0">
          {/* Checkbox selección */}
          {modoSeleccion && !pedido.grupo_confirmacion && (
            <button onClick={onToggleSeleccion}
              className="w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors"
              style={{ borderColor: seleccionado ? '#6366f1' : '#d1d5db', background: seleccionado ? '#6366f1' : 'white' }}>
              {seleccionado && <span className="text-white" style={{ fontSize: 10 }}>✓</span>}
            </button>
          )}
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 text-white"
            style={{ background: pedido.confirmado_cliente ? '#10b981' : esEnCamino ? '#3b82f6' : esRechazado ? '#E52322' : esNoContesto ? '#f59e0b' : '#254A96' }}>
            {pedido.confirmado_cliente ? '✓' : esEnCamino ? '🚛' : esRechazado ? '✕' : esNoContesto ? '?' : '📞'}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate" style={{ color: '#1a1a1a' }}>{pedido.cliente}</p>
            <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
              <span className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</span>
              <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: '#e8edf8', color: '#254A96' }}>{VUELTA_LABEL[pedido.vuelta] ?? `V${pedido.vuelta}`}</span>
              {pedido.camion_id && !esRechazado && <span className="text-xs" style={{ color: '#B9BBB7' }}>🚛 {pedido.camion_id}</span>}
              {pedido.estado_pago === 'pago_en_obra' && <span className="text-xs px-1.5 py-0.5 rounded font-semibold" style={{ background: '#ffedd5', color: '#9a3412' }}>💰 P.Obra</span>}
            </div>
          </div>
        </div>
        <div className="shrink-0 ml-2"><BadgeConfirmacion pedido={pedido} /></div>
      </div>

      <div className="px-4 py-3 space-y-2.5" style={{ borderTop: '1px solid #f4f4f3' }}>
        {esRechazado && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: '#fde8e8', color: '#991b1b' }}>
            📅 Reprogramado para el <strong>{formatFechaCorta(pedido.fecha_entrega)}</strong> · V{pedido.vuelta}
          </div>
        )}
        <div className="flex items-start gap-2">
          <span className="text-xs mt-1.5">📍</span>
          <input type="text" value={editDireccion ?? pedido.direccion}
            onChange={e => onEditDireccion(e.target.value)} onBlur={e => onGuardarDireccion(e.target.value)}
            className="flex-1 text-sm rounded-lg px-2 py-1 focus:outline-none"
            style={{ color: '#1a1a1a', background: '#f9fafb', border: '1px solid #e8edf8' }} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs">📱</span>
          {pedido.telefono
            ? <a href={`tel:${pedido.telefono}`} className="text-sm font-medium flex-1" style={{ color: '#254A96' }}>{pedido.telefono}</a>
            : <span className="text-xs flex-1" style={{ color: '#B9BBB7' }}>Sin teléfono</span>}
          <button onClick={onWA} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold shrink-0" style={{ background: '#dcfce7', color: '#166534' }}>💬 WA</button>
        </div>

        {pedido.confirmado_cliente ? (
          <button onClick={onDesconfirmar} disabled={confirmando === pedido.id}
            className="w-full py-2 rounded-xl text-xs font-medium disabled:opacity-50"
            style={{ background: '#f4f4f3', color: '#B9BBB7' }}>{confirmando === pedido.id ? '...' : 'Deshacer confirmación'}</button>
        ) : esEnCamino ? (
          <button onClick={onDeshacerEstado} className="w-full py-2 rounded-xl text-xs font-medium"
            style={{ background: '#eff6ff', color: '#3b82f6', border: '1px solid #93c5fd' }}>Revertir a programado</button>
        ) : esGestionado ? (
          <button onClick={onDeshacerEstado} className="w-full py-2 rounded-xl text-xs font-medium" style={{ background: '#f4f4f3', color: '#B9BBB7' }}>Deshacer</button>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={onConfirmar} disabled={confirmando === pedido.id}
                className="py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>{confirmando === pedido.id ? '...' : '✅ Confirmado'}</button>
              <button onClick={onRechazar} disabled={confirmando === pedido.id}
                className="py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#E52322' }}>🚫 Rechazado</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={onNoContesto} disabled={confirmando === pedido.id}
                className="py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: '#fef3c7', color: '#b45309' }}>📵 No contestó</button>
              <button onClick={onEnCamino} disabled={marcandoEnCamino === pedido.id}
                className="py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #93c5fd' }}>
                {marcandoEnCamino === pedido.id ? '...' : '🚛 En camino'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── GrupoCard ────────────────────────────────────────────────────────────────

function GrupoCard({ grupoId, pedidos, confirmando, marcandoEnCamino, editDirecciones, modoSeleccion, seleccionados, onConfirmarGrupo, onNoContesoGrupo, onEnCaminoGrupo, onRechazarGrupo, onConfirmar, onDesconfirmar, onNoContesto, onEnCamino, onRechazar, onWA, onDesagrupar, onDeshacerEstado, onToggleSeleccion, onEditDireccion, onGuardarDireccion }: {
  grupoId: string; pedidos: Pedido[]
  confirmando: string | null; marcandoEnCamino: string | null
  editDirecciones: Record<string, string>; modoSeleccion: boolean; seleccionados: Set<string>
  onConfirmarGrupo: () => void; onNoContesoGrupo: () => void
  onEnCaminoGrupo: () => void; onRechazarGrupo: () => void
  onConfirmar: (id: string) => void; onDesconfirmar: (id: string) => void
  onNoContesto: (id: string) => void; onEnCamino: (p: Pedido) => void
  onRechazar: (p: Pedido) => void; onWA: (peds: Pedido[]) => void
  onDesagrupar: () => void; onDeshacerEstado: (id: string) => void
  onToggleSeleccion: (id: string) => void
  onEditDireccion: (id: string, val: string) => void; onGuardarDireccion: (id: string, val: string) => void
}) {
  const tel = pedidos.find(p => p.telefono)?.telefono ?? null
  const pendientes = pedidos.filter(esPendiente)
  const hayPendientes = pendientes.length > 0

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden col-span-1 md:col-span-2" style={{ border: '2px solid #c7d2fe' }}>
      {/* Header del grupo */}
      <div className="px-4 py-3" style={{ background: '#eef2ff', borderBottom: '1px solid #c7d2fe' }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-base">👥</span>
              <p className="font-semibold text-sm truncate" style={{ color: '#4338ca' }}>{pedidos[0].cliente}</p>
            </div>
            <p className="text-xs mt-0.5 truncate" style={{ color: '#6366f1' }}>📍 {pedidos[0].direccion} · {pedidos.length} pedidos</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {tel && <a href={`tel:${tel}`} className="text-xs font-medium" style={{ color: '#4f46e5' }}>{tel}</a>}
            <button onClick={() => onWA(pedidos)}
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold"
              style={{ background: '#dcfce7', color: '#166634' }}>💬 WA grupo</button>
            <button onClick={onDesagrupar}
              className="text-xs px-2 py-1 rounded-lg"
              style={{ background: 'white', color: '#6366f1', border: '1px solid #c7d2fe' }}>Separar</button>
          </div>
        </div>

        {/* Acciones de grupo — solo si hay pendientes */}
        {hayPendientes && (
          <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2.5" style={{ borderTop: '1px solid #c7d2fe' }}>
            <span className="text-xs self-center" style={{ color: '#6366f1', fontWeight: 600 }}>Aplicar a pendientes:</span>
            <button onClick={onConfirmarGrupo}
              className="text-xs px-2.5 py-1 rounded-lg font-semibold"
              style={{ background: '#254A96', color: 'white' }}>✅ Confirmar</button>
            <button onClick={onEnCaminoGrupo}
              className="text-xs px-2.5 py-1 rounded-lg font-semibold"
              style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #93c5fd' }}>🚛 En camino</button>
            <button onClick={onNoContesoGrupo}
              className="text-xs px-2.5 py-1 rounded-lg font-semibold"
              style={{ background: '#fef3c7', color: '#b45309' }}>📵 No contestó</button>
            <button onClick={onRechazarGrupo}
              className="text-xs px-2.5 py-1 rounded-lg font-semibold"
              style={{ background: '#fde8e8', color: '#E52322' }}>🚫 Rechazar</button>
          </div>
        )}
      </div>

      {/* Sub-cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3">
        {pedidos.map(pedido => (
          <PedidoCard
            key={pedido.id} pedido={pedido}
            confirmando={confirmando} marcandoEnCamino={marcandoEnCamino}
            editDireccion={editDirecciones[pedido.id]}
            modoSeleccion={modoSeleccion} seleccionado={seleccionados.has(pedido.id)}
            onConfirmar={() => onConfirmar(pedido.id)} onDesconfirmar={() => onDesconfirmar(pedido.id)}
            onNoContesto={() => onNoContesto(pedido.id)} onEnCamino={() => onEnCamino(pedido)}
            onRechazar={() => onRechazar(pedido)} onWA={() => onWA([pedido])}
            onDeshacerEstado={() => onDeshacerEstado(pedido.id)} onToggleSeleccion={() => onToggleSeleccion(pedido.id)}
            onEditDireccion={(val) => onEditDireccion(pedido.id, val)}
            onGuardarDireccion={(val) => onGuardarDireccion(pedido.id, val)}
          />
        ))}
      </div>
    </div>
  )
}
