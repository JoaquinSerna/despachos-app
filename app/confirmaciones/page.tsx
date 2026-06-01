'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tieneAcceso } from '../lib/permisos'
import { logAuditoria } from '../lib/auditoria'

interface PedidoItem {
  nombre: string
  cantidad: number
  unidad: string
}

interface Pedido {
  id: string
  nv: string
  cliente: string
  telefono: string | null
  direccion: string
  sucursal: string
  fecha_entrega: string
  vuelta: number
  estado: string
  estado_pago: string | null
  camion_id: string | null
  confirmado_cliente: boolean
  notas: string | null
  confirmacion_estado: 'rechazado_cliente' | 'rechazado_cac' | 'no_contesto' | null
  fecha_confirmacion: string | null
  // fecha original antes de reprogramar (guardada localmente para mostrar en badge)
  _fecha_original?: string
  _vuelta_original?: number
}

type WATipo = 'aviso' | 'confirmado' | 'reprog_cliente' | 'reprog_nuestro' | 'no_contesto'

const VUELTA_LABEL: Record<number, string> = {
  1: 'V1 · 8:00–10:00hs',
  2: 'V2 · 10:00–12:00hs',
  3: 'V3 · 13:00–15:00hs',
  4: 'V4 · 15:00–17:00hs',
}

const TODAS_VUELTAS = [
  { num: 1, label: 'V1 · 8–10hs' },
  { num: 2, label: 'V2 · 10–12hs' },
  { num: 3, label: 'V3 · 13–15hs' },
  { num: 4, label: 'V4 · 15–17hs' },
  { num: 5, label: 'Fuera de hora' },
]

function hoy() { return new Date().toISOString().split('T')[0] }

function formatFecha(f: string) {
  return new Date(f + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' })
}

function formatFechaCorta(f: string) {
  const d = new Date(f + 'T12:00:00')
  const dia = d.toLocaleDateString('es-AR', { weekday: 'long' })
  const num = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })
  return `${dia} ${num}`
}

function vueltaAFranja(vuelta: number): string {
  if (vuelta === 1) return 'a la mañana'
  if (vuelta === 2) return 'alrededor del mediodía'
  return 'por la tarde'
}

function formatWANumber(tel: string): string {
  let d = tel.replace(/\D/g, '')
  if (d.startsWith('0')) d = d.slice(1)
  if (!d.startsWith('54')) d = '54' + d
  return d
}

function buildWAMessage(
  tipo: WATipo,
  pedido: Pedido,
  items: PedidoItem[],
  franja: string,
  fechaReprogLabel: string,
): string {
  const nombre = pedido.cliente
  const nv = pedido.nv
  const itemsStr = items.length > 0
    ? items.map(i => {
        const parts = [String(i.cantidad), i.unidad, i.nombre].filter(Boolean)
        return `- ${parts.join(' ')}`
      }).join('\n')
    : '- (sin detalle de productos)'

  const pagoEnObra = pedido.estado_pago === 'pago_en_obra'
    ? '\n\n💰 Recordá que la venta fue realizada con la modalidad *pago en obra*. ¿Contás con el importe justo o vas a necesitar cambio?'
    : ''

  const esHoy = pedido.fecha_entrega === hoy()
  const cuandoEntrega = esHoy
    ? `*hoy ${franja}*`
    : `*el ${formatFechaCorta(pedido.fecha_entrega)} ${franja}*`

  switch (tipo) {
    case 'aviso':
      return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${nv}, que incluye:\n${itemsStr}\nestá programado para ${cuandoEntrega} 🚛\n¿Confirmás que vas a poder recibirlo?${pagoEnObra}`
    case 'confirmado':
      return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${nv}, que incluye:\n${itemsStr}\nestá confirmado para ${cuandoEntrega} ✅\nAnte cualquier consulta estamos a disposición.${pagoEnObra}`
    case 'reprog_cliente':
      return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${nv}, que incluye:\n${itemsStr}\nfue reprogramado para el *${fechaReprogLabel}* según lo solicitado 📅\nLuego nos volveremos a comunicar para reconfirmar el horario.${pagoEnObra}`
    case 'reprog_nuestro':
      return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo.\nTu pedido NV ${nv}, que incluye:\n${itemsStr}\nfue reprogramado para el *${fechaReprogLabel}* 📅\nDisculpá las molestias. Luego nos volveremos a comunicar para reconfirmar el horario.${pagoEnObra}`
    case 'no_contesto':
      return `Hola ${nombre}! 👋 Nos comunicamos de Construyo al Costo para confirmar la entrega de tu pedido NV ${nv}, que incluye:\n${itemsStr}\nPor favor respondé este mensaje para confirmar. En caso de no recibir respuesta, el pedido quedará reprogramado para el día siguiente.\n¡Gracias!`
  }
}

// Badge de estado de confirmación
function BadgeConfirmacion({ pedido }: { pedido: Pedido }) {
  if (pedido.confirmado_cliente) {
    return (
      <span className="text-xs px-2 py-1 rounded-full font-medium"
        style={{ background: '#d1fae5', color: '#065f46' }}>✓ Confirmado</span>
    )
  }
  if (pedido.confirmacion_estado === 'rechazado_cliente') {
    return (
      <span className="text-xs px-2 py-1 rounded-full font-medium"
        style={{ background: '#fde8e8', color: '#E52322' }}>🚫 Rechazado (cliente)</span>
    )
  }
  if (pedido.confirmacion_estado === 'rechazado_cac') {
    return (
      <span className="text-xs px-2 py-1 rounded-full font-medium"
        style={{ background: '#fde8e8', color: '#E52322' }}>🚫 Rechazado (CAC)</span>
    )
  }
  if (pedido.confirmacion_estado === 'no_contesto') {
    return (
      <span className="text-xs px-2 py-1 rounded-full font-medium"
        style={{ background: '#fef3c7', color: '#b45309' }}>📵 No contestó</span>
    )
  }
  return (
    <span className="text-xs px-2 py-1 rounded-full font-medium"
      style={{ background: '#fff8e1', color: '#b45309' }}>Sin confirmar</span>
  )
}

interface WAModalData {
  pedido: Pedido
  items: PedidoItem[]
  fechaReprog?: string
  vueltaReprog?: number
  motivoReprog?: 'cliente' | 'nosotros'
}

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

  // Modal reprogramar
  const [modalReprog, setModalReprog] = useState<{ pedido: Pedido } | null>(null)
  const [reprogFecha, setReprogFecha] = useState('')
  const [reprogVuelta, setReprogVuelta] = useState(1)
  const [reprogMotivo, setReprogMotivo] = useState<'cliente' | 'nosotros'>('cliente')
  const [reprogGuardando, setReprogGuardando] = useState(false)

  // Modal WhatsApp
  const [modalWA, setModalWA] = useState<WAModalData | null>(null)
  const [waTipo, setWATipo] = useState<WATipo>('aviso')
  const [waFranja, setWAFranja] = useState('a la mañana')
  const [loadingItems, setLoadingItems] = useState(false)
  const [itemsCache, setItemsCache] = useState<Record<string, PedidoItem[]>>({})

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data: userData } = await supabase
        .from('usuarios').select('nombre, rol, permisos, sucursal').eq('id', user.id).single()
      if (!tieneAcceso(userData?.permisos, userData?.rol, 'confirmaciones')) {
        router.push('/dashboard'); return
      }
      setUsuario(user)
      setNombreUsuario(userData?.nombre ?? user.email ?? '')
      if (userData?.sucursal) setFiltroSucursal(userData.sucursal)
      cargarPedidos({ sucursal: userData?.sucursal ?? '' })
    })
  }, [])

  const cargarPedidos = async (params?: {
    fecha?: string
    sucursal?: string
    confirmado?: 'todos' | 'confirmado' | 'sin_confirmar'
  }) => {
    setCargando(true)
    const fecha = params?.fecha ?? filtroFecha
    const sucursal = params?.sucursal ?? filtroSucursal
    const confirmado = params?.confirmado ?? filtroConfirmado

    const campos = 'id,nv,cliente,telefono,direccion,sucursal,fecha_entrega,vuelta,estado,estado_pago,camion_id,confirmado_cliente,notas,confirmacion_estado,fecha_confirmacion'

    // Query 1: pedidos activos (programado, fecha de entrega = seleccionada)
    let q1 = supabase
      .from('pedidos')
      .select(campos)
      .eq('estado', 'programado')
      .order('vuelta').order('cliente')

    if (fecha) q1 = q1.eq('fecha_entrega', fecha)
    else q1 = q1.gte('fecha_entrega', hoy())
    if (sucursal) q1 = q1.eq('sucursal', sucursal)
    if (confirmado === 'confirmado') q1 = q1.eq('confirmado_cliente', true)
    else if (confirmado === 'sin_confirmar') q1 = q1.eq('confirmado_cliente', false)

    // Query 2: pedidos rechazados este día (ya fueron reprogramados, fecha_entrega cambió)
    // Solo cuando hay fecha seleccionada y no estamos filtrando por "confirmado"
    let rechazados: Pedido[] = []
    if (fecha && confirmado !== 'confirmado') {
      let q2 = supabase
        .from('pedidos')
        .select(campos)
        .eq('fecha_confirmacion', fecha)
        .in('confirmacion_estado', ['rechazado_cliente', 'rechazado_cac'])
        .order('vuelta').order('cliente')
      if (sucursal) q2 = q2.eq('sucursal', sucursal)
      const { data: r } = await q2
      rechazados = (r ?? []) as Pedido[]
    }

    const { data, error } = await q1
    if (error) { showToast('Error al cargar pedidos', 'err'); setCargando(false); return }

    // Merge: activos + rechazados (sin duplicados por id)
    const activos = (data ?? []) as Pedido[]
    const ids = new Set(activos.map(p => p.id))
    const merged = [...activos, ...rechazados.filter(r => !ids.has(r.id))]

    // Ordenar por vuelta luego cliente
    merged.sort((a, b) => {
      if (a.vuelta !== b.vuelta) return (a.vuelta ?? 0) - (b.vuelta ?? 0)
      return a.cliente.localeCompare(b.cliente)
    })

    setPedidos(merged)
    setCargando(false)
  }

  const buscar = () => cargarPedidos({ fecha: filtroFecha, sucursal: filtroSucursal, confirmado: filtroConfirmado })

  const confirmarCliente = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const pedido = pedidos.find(p => p.id === pedidoId)
    const { error } = await supabase
      .from('pedidos')
      .update({ confirmado_cliente: true, confirmacion_estado: null, fecha_confirmacion: null })
      .eq('id', pedidoId)
    if (error) {
      showToast('Error al confirmar', 'err')
    } else {
      setPedidos(prev => prev.map(p =>
        p.id === pedidoId ? { ...p, confirmado_cliente: true, confirmacion_estado: null } : p
      ))
      showToast('Cliente confirmado ✓')
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Confirmó pedido con cliente', 'Confirmaciones', { nv: pedido.nv, cliente: pedido.cliente, sucursal: pedido.sucursal })
    }
    setConfirmando(null)
  }

  const desconfirmarCliente = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const pedido = pedidos.find(p => p.id === pedidoId)
    const { error } = await supabase
      .from('pedidos')
      .update({ confirmado_cliente: false })
      .eq('id', pedidoId)
    if (error) {
      showToast('Error', 'err')
    } else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, confirmado_cliente: false } : p))
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Desconfirmó pedido con cliente', 'Confirmaciones', { nv: pedido.nv, cliente: pedido.cliente })
    }
    setConfirmando(null)
  }

  const marcarNoContesto = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const pedido = pedidos.find(p => p.id === pedidoId)
    const { error } = await supabase
      .from('pedidos')
      .update({ confirmacion_estado: 'no_contesto', fecha_confirmacion: hoy() })
      .eq('id', pedidoId)
    if (error) {
      showToast('Error', 'err')
    } else {
      setPedidos(prev => prev.map(p =>
        p.id === pedidoId ? { ...p, confirmacion_estado: 'no_contesto', fecha_confirmacion: hoy() } : p
      ))
      showToast('Marcado como no contestó')
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Marcó no contestó', 'Confirmaciones', { nv: pedido.nv, cliente: pedido.cliente })
    }
    setConfirmando(null)
  }

  const deshacerEstado = async (pedidoId: string) => {
    const pedido = pedidos.find(p => p.id === pedidoId)
    const { error } = await supabase
      .from('pedidos')
      .update({ confirmacion_estado: null, fecha_confirmacion: null, confirmado_cliente: false })
      .eq('id', pedidoId)
    if (!error) {
      setPedidos(prev => prev.map(p =>
        p.id === pedidoId ? { ...p, confirmacion_estado: null, fecha_confirmacion: null, confirmado_cliente: false } : p
      ))
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Deshizo estado confirmación', 'Confirmaciones', { nv: pedido.nv, cliente: pedido.cliente })
    }
  }

  const guardarDireccion = async (pedidoId: string, valor: string) => {
    const pedido = pedidos.find(p => p.id === pedidoId)
    const original = pedido?.direccion ?? ''
    if (valor.trim() === original.trim()) return
    const { error } = await supabase.from('pedidos').update({ direccion: valor.trim() }).eq('id', pedidoId)
    if (error) {
      showToast('Error al guardar dirección', 'err')
    } else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, direccion: valor.trim() } : p))
      setEditDirecciones(prev => { const n = { ...prev }; delete n[pedidoId]; return n })
      showToast('Dirección actualizada ✓')
      if (usuario && pedido) logAuditoria(usuario.id, nombreUsuario, 'Actualizó dirección', 'Confirmaciones', { nv: pedido.nv, cliente: pedido.cliente, direccion_nueva: valor.trim() })
    }
  }

  const confirmarReprog = async () => {
    if (!modalReprog || !reprogFecha) return
    const pedido = modalReprog.pedido
    setReprogGuardando(true)

    const estadoConf: 'rechazado_cliente' | 'rechazado_cac' =
      reprogMotivo === 'cliente' ? 'rechazado_cliente' : 'rechazado_cac'
    const motivoLabel = reprogMotivo === 'cliente' ? 'a pedido del cliente' : 'reprogramado por CAC'
    const nota = `⚡ Reprog. desde ${pedido.fecha_entrega} V${pedido.vuelta} — ${motivoLabel}`
    const notaFinal = pedido.notas ? `${pedido.notas} | ${nota}` : nota

    const res = await fetch('/api/pedidos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pedido.id,
        fecha_entrega: reprogFecha,
        vuelta: reprogVuelta,
        camion_id: null,
        orden_entrega: null,
        estado: 'pendiente',
        notas: notaFinal,
        confirmacion_estado: estadoConf,
        fecha_confirmacion: hoy(),
      }),
    })
    const data = await res.json()
    setReprogGuardando(false)

    if (!res.ok) {
      showToast(`Error: ${data.error ?? 'desconocido'}`, 'err'); return
    }

    // Actualizar en local: mantener el pedido visible con el nuevo estado
    setPedidos(prev => prev.map(p =>
      p.id === pedido.id
        ? {
            ...p,
            confirmacion_estado: estadoConf,
            fecha_confirmacion: hoy(),
            fecha_entrega: savedFecha,   // nueva fecha de entrega
            vuelta: savedVuelta,          // nueva vuelta
          }
        : p
    ))

    if (usuario) logAuditoria(usuario.id, nombreUsuario, 'Rechazó y reprogramó pedido', 'Confirmaciones', {
      nv: pedido.nv, cliente: pedido.cliente,
      fecha_anterior: pedido.fecha_entrega, vuelta_anterior: pedido.vuelta,
      fecha_nueva: reprogFecha, vuelta_nueva: reprogVuelta, motivo: reprogMotivo,
    })

    const savedFecha = reprogFecha
    const savedVuelta = reprogVuelta
    const savedMotivo = reprogMotivo
    setModalReprog(null)
    showToast('Pedido reprogramado — recordá enviar el WA')

    // Abrir WA con tipo preseleccionado
    abrirModalWA(
      { ...pedido, confirmacion_estado: estadoConf },
      savedMotivo === 'cliente' ? 'reprog_cliente' : 'reprog_nuestro',
      savedFecha,
      savedVuelta,
      savedMotivo,
    )
  }

  const abrirModalWA = async (
    pedido: Pedido,
    tipoPresel?: WATipo,
    fechaReprog?: string,
    vueltaReprog?: number,
    motivoReprog?: 'cliente' | 'nosotros',
  ) => {
    const tipo = tipoPresel ?? 'aviso'
    setWATipo(tipo)
    setWAFranja(vueltaAFranja(pedido.vuelta))

    const cachedItems = itemsCache[pedido.id] ?? []
    setModalWA({ pedido, items: cachedItems, fechaReprog, vueltaReprog, motivoReprog })

    if (!itemsCache[pedido.id]) {
      setLoadingItems(true)
      const { data } = await supabase
        .from('pedido_items').select('nombre, cantidad, unidad').eq('pedido_id', pedido.id)
      const items: PedidoItem[] = (data ?? []).map((i: any) => ({
        nombre: i.nombre ?? '', cantidad: i.cantidad ?? 0, unidad: i.unidad ?? '',
      }))
      setItemsCache(prev => ({ ...prev, [pedido.id]: items }))
      setLoadingItems(false)
      setModalWA(prev => prev ? { ...prev, items } : null)
    }
  }

  // Agrupar por fecha de entrega original (fecha_confirmacion para rechazados)
  const porFecha: Record<string, Pedido[]> = {}
  pedidos.forEach(p => {
    // Los rechazados se agrupan bajo la fecha en que fueron procesados
    const fechaGrupo = (p.confirmacion_estado === 'rechazado_cliente' || p.confirmacion_estado === 'rechazado_cac')
      ? (p.fecha_confirmacion ?? p.fecha_entrega)
      : p.fecha_entrega
    if (!porFecha[fechaGrupo]) porFecha[fechaGrupo] = []
    porFecha[fechaGrupo].push(p)
  })

  const totalConfirmados = pedidos.filter(p => p.confirmado_cliente).length
  const totalPendientes = pedidos.filter(p => !p.confirmado_cliente && !p.confirmacion_estado).length
  const totalGestionados = pedidos.filter(p => p.confirmacion_estado).length

  const waPreview = modalWA
    ? buildWAMessage(waTipo, modalWA.pedido, modalWA.items, waFranja,
        modalWA.fechaReprog ? formatFechaCorta(modalWA.fechaReprog) : '')
    : ''

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* ─── Modal Reprogramar ──────────────────────────────────── */}
      {modalReprog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm">
            <h3 className="font-semibold text-sm mb-0.5" style={{ color: '#E52322' }}>🚫 Rechazar y reprogramar</h3>
            <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>
              NV {modalReprog.pedido.nv} · {modalReprog.pedido.cliente}
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Motivo</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { key: 'cliente', label: '👤 Lo pidió el cliente' },
                    { key: 'nosotros', label: '🏭 No podemos entregar' },
                  ] as const).map(m => (
                    <button key={m.key} type="button" onClick={() => setReprogMotivo(m.key)}
                      className="px-3 py-2.5 rounded-xl text-xs font-medium border transition-colors text-left"
                      style={{
                        background: reprogMotivo === m.key ? '#fde8e8' : '#f4f4f3',
                        color: reprogMotivo === m.key ? '#E52322' : '#666',
                        border: `1px solid ${reprogMotivo === m.key ? '#fca5a5' : '#e8edf8'}`,
                      }}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva fecha</label>
                <input type="date" value={reprogFecha} min={hoy()}
                  onChange={e => setReprogFecha(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva vuelta</label>
                <select value={reprogVuelta} onChange={e => setReprogVuelta(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
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
              <button onClick={() => setModalReprog(null)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Modal WhatsApp ─────────────────────────────────────── */}
      {modalWA && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full flex flex-col"
            style={{ maxWidth: 440, maxHeight: '90vh' }}>
            <div className="px-5 py-4 flex items-start justify-between shrink-0"
              style={{ borderBottom: '1px solid #f0f0f0' }}>
              <div>
                <p className="font-semibold text-sm" style={{ color: '#1a1a1a' }}>💬 WhatsApp</p>
                <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                  {modalWA.pedido.cliente} · NV {modalWA.pedido.nv}
                </p>
              </div>
              <div className="text-right ml-4 shrink-0">
                {modalWA.pedido.telefono
                  ? <p className="text-xs font-medium" style={{ color: '#254A96' }}>📞 {modalWA.pedido.telefono}</p>
                  : <span className="text-xs px-2 py-1 rounded-lg" style={{ background: '#fff8e1', color: '#b45309' }}>⚠ Sin número</span>
                }
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
                { key: 'confirmado'     as WATipo, label: '✅ Confirmado' },
                { key: 'reprog_cliente' as WATipo, label: '📅 Reprogramado (lo pidió el cliente)' },
                { key: 'reprog_nuestro' as WATipo, label: '📅 Reprogramado (de nuestra parte)' },
                { key: 'no_contesto'   as WATipo, label: '📵 No contestó' },
              ]).map(t => (
                <button key={t.key} onClick={() => setWATipo(t.key)}
                  className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium border transition-colors"
                  style={{ background: waTipo === t.key ? '#e8edf8' : 'white', color: waTipo === t.key ? '#254A96' : '#666', border: `1px solid ${waTipo === t.key ? '#254A96' : '#e8edf8'}` }}>
                  {t.label}
                </button>
              ))}
              {(waTipo === 'aviso' || waTipo === 'confirmado') && (
                <div className="pt-3">
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Franja horaria</label>
                  <div className="flex gap-1.5">
                    {([
                      { val: 'a la mañana', label: '🌅 Mañana' },
                      { val: 'alrededor del mediodía', label: '☀️ Mediodía' },
                      { val: 'por la tarde', label: '🌇 Tarde' },
                    ]).map(f => (
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
              {loadingItems ? (
                <div className="flex items-center gap-2 py-4">
                  <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin"
                    style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
                  <span className="text-xs" style={{ color: '#B9BBB7' }}>Cargando productos...</span>
                </div>
              ) : (
                <pre className="text-xs leading-relaxed whitespace-pre-wrap rounded-xl p-3"
                  style={{ background: '#f4f4f3', color: '#1a1a1a', fontFamily: 'inherit' }}>
                  {waPreview}
                </pre>
              )}
            </div>

            <div className="px-5 py-4 flex gap-2 shrink-0" style={{ borderTop: '1px solid #f0f0f0' }}>
              <button onClick={() => { navigator.clipboard.writeText(waPreview); showToast('Mensaje copiado') }}
                disabled={loadingItems}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border disabled:opacity-40"
                style={{ borderColor: '#e8edf8', color: '#254A96', background: 'white' }}>
                📋 Copiar
              </button>
              {modalWA.pedido.telefono ? (
                <a href={`https://wa.me/${formatWANumber(modalWA.pedido.telefono)}?text=${encodeURIComponent(waPreview)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-1.5"
                  style={{ background: '#25D366' }}>
                  💬 Abrir WA
                </a>
              ) : (
                <button disabled className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 text-white"
                  style={{ background: '#25D366' }}>Sin número</button>
              )}
              <button onClick={() => setModalWA(null)}
                className="px-3 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>×</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Navbar ─────────────────────────────────────────────── */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-[1400px] mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard"
              className="text-xs px-2 py-1.5 rounded-lg font-medium shrink-0"
              style={{ background: '#e8edf8', color: '#254A96' }}>← Volver</Link>
            <div className="w-px h-5 bg-gray-200 hidden sm:block" />
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Confirmaciones</span>
              <span className="text-xs ml-2 hidden sm:inline" style={{ color: '#B9BBB7' }}>{nombreUsuario}</span>
            </div>
          </div>
          <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
            className="text-xs px-3 py-1.5 rounded-lg font-medium"
            style={{ background: '#fde8e8', color: '#E52322' }}>Salir</button>
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto px-4 py-5">

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-5">
          <div className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: '#d1fae5' }}>✅</div>
            <div>
              <p className="text-2xl font-bold leading-none" style={{ color: '#065f46' }}>{totalConfirmados}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Confirmados</p>
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: '#fff8e1' }}>📞</div>
            <div>
              <p className="text-2xl font-bold leading-none" style={{ color: '#b45309' }}>{totalPendientes}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Sin gestionar</p>
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: '#fde8e8' }}>🚫</div>
            <div>
              <p className="text-2xl font-bold leading-none" style={{ color: '#E52322' }}>{totalGestionados}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Rechazados / No contestó</p>
            </div>
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-5">
          <div className="flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha entrega</label>
              <input type="date" value={filtroFecha}
                onChange={e => setFiltroFecha(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && buscar()}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Sucursal</label>
              <select value={filtroSucursal} onChange={e => setFiltroSucursal(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="">Todas</option>
                {['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Estado</label>
              <select value={filtroConfirmado} onChange={e => setFiltroConfirmado(e.target.value as any)}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="todos">Todos</option>
                <option value="sin_confirmar">Sin confirmar</option>
                <option value="confirmado">Confirmados</option>
              </select>
            </div>
            <button onClick={buscar}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white"
              style={{ background: '#254A96' }}>Buscar</button>
            <button onClick={() => {
              setFiltroFecha(''); setFiltroSucursal(''); setFiltroConfirmado('todos')
              cargarPedidos({ fecha: '', sucursal: '', confirmado: 'todos' })
            }}
              className="px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: '#f4f4f3', color: '#666' }}>Ver todos</button>
          </div>
        </div>

        {/* Lista por fecha */}
        {Object.keys(porFecha).length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <p className="text-4xl mb-3">{filtroConfirmado === 'sin_confirmar' ? '🎉' : '📭'}</p>
            <p className="font-medium text-sm" style={{ color: '#254A96' }}>
              {filtroConfirmado === 'sin_confirmar' ? '¡Todos los clientes están confirmados!' : 'No hay pedidos programados'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(porFecha).sort(([a], [b]) => a.localeCompare(b)).map(([fecha, pedidosDia]) => (
              <div key={fecha}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                  <span className="text-xs font-semibold px-3 py-1 rounded-full capitalize"
                    style={{ background: '#e8edf8', color: '#254A96' }}>
                    {formatFecha(fecha)}
                  </span>
                  <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {pedidosDia.map(pedido => {
                    const esRechazado = pedido.confirmacion_estado === 'rechazado_cliente' || pedido.confirmacion_estado === 'rechazado_cac'
                    const esNoContesto = pedido.confirmacion_estado === 'no_contesto'
                    const esGestionado = esRechazado || esNoContesto
                    const borderColor = pedido.confirmado_cliente ? '#d1fae5' : esRechazado ? '#fca5a5' : esNoContesto ? '#fde68a' : '#f0f0f0'
                    const bgHeader = pedido.confirmado_cliente ? '#f0fdf4' : esRechazado ? '#fff5f5' : esNoContesto ? '#fffbeb' : 'white'

                    return (
                      <div key={pedido.id} className="bg-white rounded-xl shadow-sm overflow-hidden"
                        style={{ border: `2px solid ${borderColor}` }}>

                        {/* Header */}
                        <div className="px-4 py-3 flex items-center justify-between" style={{ background: bgHeader }}>
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 text-white"
                              style={{ background: pedido.confirmado_cliente ? '#10b981' : esRechazado ? '#E52322' : esNoContesto ? '#f59e0b' : '#254A96' }}>
                              {pedido.confirmado_cliente ? '✓' : esRechazado ? '✕' : esNoContesto ? '?' : '📞'}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-sm truncate" style={{ color: '#1a1a1a' }}>{pedido.cliente}</p>
                              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                                <span className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</span>
                                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                                  style={{ background: '#e8edf8', color: '#254A96' }}>
                                  {VUELTA_LABEL[pedido._vuelta_original ?? pedido.vuelta] ?? `V${pedido._vuelta_original ?? pedido.vuelta}`}
                                </span>
                                {pedido.camion_id && !esRechazado && (
                                  <span className="text-xs" style={{ color: '#B9BBB7' }}>🚛 {pedido.camion_id}</span>
                                )}
                                {pedido.estado_pago === 'pago_en_obra' && (
                                  <span className="text-xs px-1.5 py-0.5 rounded font-semibold"
                                    style={{ background: '#ffedd5', color: '#9a3412' }}>💰 P.Obra</span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 ml-2">
                            <BadgeConfirmacion pedido={pedido} />
                          </div>
                        </div>

                        {/* Body */}
                        <div className="px-4 py-3 space-y-2.5" style={{ borderTop: '1px solid #f4f4f3' }}>

                          {/* Info de reprogramación si fue rechazado */}
                          {esRechazado && (
                            <div className="rounded-lg px-3 py-2 text-xs" style={{ background: '#fde8e8', color: '#991b1b' }}>
                              📅 Reprogramado para el <strong>{formatFechaCorta(pedido.fecha_entrega)}</strong> · V{pedido.vuelta}
                            </div>
                          )}

                          {/* Dirección */}
                          <div className="flex items-start gap-2">
                            <span className="text-xs mt-1.5">📍</span>
                            <input
                              type="text"
                              value={editDirecciones[pedido.id] ?? pedido.direccion}
                              onChange={e => setEditDirecciones(prev => ({ ...prev, [pedido.id]: e.target.value }))}
                              onBlur={e => guardarDireccion(pedido.id, e.target.value)}
                              className="flex-1 text-sm rounded-lg px-2 py-1 focus:outline-none"
                              style={{ color: '#1a1a1a', background: '#f9fafb', border: '1px solid #e8edf8' }}
                            />
                          </div>

                          {/* Teléfono + WA */}
                          <div className="flex items-center gap-2">
                            <span className="text-xs">📱</span>
                            {pedido.telefono
                              ? <a href={`tel:${pedido.telefono}`} className="text-sm font-medium flex-1"
                                  style={{ color: '#254A96' }}>{pedido.telefono}</a>
                              : <span className="text-xs flex-1" style={{ color: '#B9BBB7' }}>Sin teléfono</span>
                            }
                            <button onClick={() => abrirModalWA(pedido)}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold shrink-0"
                              style={{ background: '#dcfce7', color: '#166534' }}>
                              💬 WA
                            </button>
                          </div>

                          {/* Botones de acción */}
                          {pedido.confirmado_cliente ? (
                            // Confirmado → deshacer
                            <button onClick={() => desconfirmarCliente(pedido.id)} disabled={confirmando === pedido.id}
                              className="w-full py-2 rounded-xl text-xs font-medium disabled:opacity-50"
                              style={{ background: '#f4f4f3', color: '#B9BBB7' }}>
                              {confirmando === pedido.id ? '...' : 'Deshacer confirmación'}
                            </button>
                          ) : esGestionado ? (
                            // Rechazado o no contestó → botón para deshacer el estado
                            <button onClick={() => deshacerEstado(pedido.id)}
                              className="w-full py-2 rounded-xl text-xs font-medium"
                              style={{ background: '#f4f4f3', color: '#B9BBB7' }}>
                              Deshacer
                            </button>
                          ) : (
                            // Sin gestionar → 3 botones
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <button onClick={() => confirmarCliente(pedido.id)} disabled={confirmando === pedido.id}
                                  className="py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                                  style={{ background: '#254A96' }}>
                                  {confirmando === pedido.id ? '...' : '✅ Confirmado'}
                                </button>
                                <button
                                  onClick={() => {
                                    setReprogFecha(''); setReprogVuelta(1); setReprogMotivo('cliente')
                                    setModalReprog({ pedido })
                                  }}
                                  disabled={confirmando === pedido.id}
                                  className="py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                                  style={{ background: '#E52322' }}>
                                  🚫 Rechazado
                                </button>
                              </div>
                              <button onClick={() => marcarNoContesto(pedido.id)} disabled={confirmando === pedido.id}
                                className="w-full py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                                style={{ background: '#fef3c7', color: '#b45309' }}>
                                {confirmando === pedido.id ? '...' : '📵 No contestó'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
