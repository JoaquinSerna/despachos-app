'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/app/supabase'
import { rolesDe, rolSegun } from '@/app/lib/roles'
import { tieneAcceso } from '@/app/lib/permisos'
import type { jsPDF as JsPDFType } from 'jspdf'
import TabConsolidado from './TabConsolidado'
import TabFaltantes from './TabFaltantes'
import ValidacionPrepView from './ValidacionPrep'

// ─── Constantes ────────────────────────────────────────────────────────────────
const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

// Calendario de rutas según procedimiento de logística:
//   LP ↔ Guernica/Cañuelas : lunes(1) y miércoles(3)
//   Guernica/Cañuelas → LP : martes(2) y jueves(4)  [misma ruta, sentido contrario]
//   Pinamar/Costa Atlántica : martes(2) y viernes(5)
//
// DOW: 0=dom, 1=lun, 2=mar, 3=mié, 4=jue, 5=vie, 6=sáb
const ROUTE_DAYS: Record<string, number[]> = {
  'LP139:Guernica':  [1, 3], 'LP520:Guernica':  [1, 3],
  'LP139:Cañuelas':  [1, 3], 'LP520:Cañuelas':  [1, 3],
  'Guernica:LP139':  [2, 4], 'Guernica:LP520':  [2, 4],
  'Cañuelas:LP139':  [2, 4], 'Cañuelas:LP520':  [2, 4],
  'LP139:Pinamar':   [2, 5], 'LP520:Pinamar':   [2, 5],
  'Guernica:Pinamar':[2, 5], 'Cañuelas:Pinamar':[2, 5],
}
const DOW_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']

/** Fecha ISO de hoy */
function hoy() { return new Date().toISOString().split('T')[0] }

/** Formatea fecha ISO → dd/mm/yyyy */
function fmtFecha(iso: string | null | undefined) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

/** Calcula la fecha límite para iniciar la transferencia (último día de ruta disponible) */
function calcDeadline(from: string, to: string, fechaDespacho: string): { date: string; label: string; isRaro: boolean } {
  if (!fechaDespacho) return { date: '', label: '—', isRaro: false }
  const key = `${from}:${to}`
  const days = ROUTE_DAYS[key]

  const despacho = new Date(fechaDespacho)
  // Necesita llegar el día anterior al despacho
  const needsAt = new Date(despacho)
  needsAt.setDate(needsAt.getDate() - 1)

  if (!days) {
    // Ruta especial / no programada → 72h antes
    const d72 = new Date(despacho)
    d72.setDate(d72.getDate() - 3)
    return {
      date: d72.toISOString().split('T')[0],
      label: `${fmtFecha(d72.toISOString().split('T')[0])} (72h, ruta especial)`,
      isRaro: true,
    }
  }

  // Buscar el último día de ruta <= needsAt
  for (let i = 0; i < 14; i++) {
    const d = new Date(needsAt)
    d.setDate(d.getDate() - i)
    if (days.includes(d.getDay())) {
      const iso = d.toISOString().split('T')[0]
      return {
        date: iso,
        label: `${DOW_NAMES[d.getDay()]} ${fmtFecha(iso)}`,
        isRaro: false,
      }
    }
  }

  return { date: needsAt.toISOString().split('T')[0], label: fmtFecha(needsAt.toISOString().split('T')[0]), isRaro: false }
}

// ─── Tipos ─────────────────────────────────────────────────────────────────────
interface ReqItem {
  id: string
  id_producto: number | null
  nombre_producto: string
  cantidad_solicitada: number
  cantidad_aprobada: number | null
  notas: string | null
}
interface Requerimiento {
  id: string
  tipo: string
  nv: string | null
  cliente: string | null
  sucursal_origen: string
  sucursal_destino: string
  estado: string
  fecha_req: string
  fecha_solicitada: string | null
  fecha_recepcion: string | null
  tipo_entrega: string | null
  n_viaje: string | null
  cod_vehiculo: string | null
  notas: string | null
  solicitado_por: string | null
  created_at: string
  requerimiento_items: ReqItem[]
}

const ESTADO_LABEL: Record<string, string> = {
  pendiente:   'Pendiente',
  conf_stock:  'Aprobada',
  preparacion: 'En preparación',
  en_transito: 'En tránsito',
  entregado:   'Entregado',
  rechazado:   'Rechazado',
}
const ESTADO_COLOR: Record<string, { bg: string; text: string }> = {
  pendiente:   { bg: '#fef3c7', text: '#b45309' },
  conf_stock:  { bg: '#e0f2fe', text: '#0369a1' },
  preparacion: { bg: '#ede9fe', text: '#7c3aed' },
  en_transito: { bg: '#dbeafe', text: '#1d4ed8' },
  entregado:   { bg: '#d1fae5', text: '#065f46' },
  rechazado:   { bg: '#fde8e8', text: '#E52322' },
}

// ─── Componentes auxiliares ────────────────────────────────────────────────────
function BadgeEstado({ estado }: { estado: string }) {
  const c = ESTADO_COLOR[estado] ?? { bg: '#f4f4f3', text: '#666' }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}>
      {ESTADO_LABEL[estado] ?? estado}
    </span>
  )
}

function Toast({ msg, tipo }: { msg: string; tipo: 'ok' | 'err' }) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
      style={{ background: tipo === 'ok' ? '#254A96' : '#E52322' }}>
      {tipo === 'ok' ? '✓' : '✕'} {msg}
    </div>
  )
}

// ─── Página principal ──────────────────────────────────────────────────────────
export default function AbastecimientoPage() {
  const router = useRouter()
  const [rol, setRol] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userId, setUserId] = useState('')
  const [userNombre, setUserNombre] = useState('')
  const [miSucursal, setMiSucursal] = useState<string | null>(null)
  const [tab, setTab] = useState<'faltantes' | 'transferencias' | 'transito' | 'historial' | 'importar' | 'preparacion' | 'consolidado'>('preparacion')
  const [highlightNv, setHighlightNv] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol, roles_extra, email, permisos, nombre, sucursal').eq('id', user.id).single()
      const roles = rolesDe(data?.rol, data?.roles_extra)
      // Esta pantalla distingue un solo rol: con roles combinados vale el que más puede hacer acá
      const r = rolSegun(roles, ['gerencia', 'admin_flota', 'deposito', 'ruteador'], data?.rol ?? '')
      if (!tieneAcceso(data?.permisos, roles, 'abastecimiento')) { router.push('/dashboard'); return }
      setRol(r)
      setUserEmail(data?.email ?? user.email ?? '')
      setUserId(user.id); setUserNombre(data?.nombre ?? ''); setMiSucursal(data?.sucursal ?? null)
    })
  }, [])

  const TABS = [
    { key: 'preparacion',    label: '📦 Preparación' },
    { key: 'faltantes',      label: '⚠ Faltantes' },
    { key: 'transferencias', label: 'Transferencias' },
    { key: 'consolidado',    label: '🧮 Consolidado transferencias' },
    { key: 'transito',       label: 'En tránsito' },
    { key: 'historial',      label: 'Historial' },
    { key: 'importar',       label: '⬆ Importar' },
  ]

  return (
    <div className="min-h-screen flex flex-col" style={{ fontFamily: 'Barlow, sans-serif', background: '#f4f4f3' }}>
      {toast && <Toast msg={toast.msg} tipo={toast.tipo} />}

      {/* Navbar */}
      <nav className="bg-white border-b shrink-0" style={{ borderColor: '#e8edf8' }}>
        <div className="px-4 md:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/dashboard"
              className="text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</Link>
            <img src="/logo.png" alt="" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div className="hidden sm:block">
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Abastecimiento</span>
              <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Transferencias entre sucursales</span>
            </div>
          </div>
          <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
            className="px-3 py-1.5 text-sm font-medium rounded-lg"
            style={{ color: '#666', background: '#f4f4f3' }}>
            Salir
          </button>
        </div>
        {/* Tabs */}
        <div className="flex px-4 md:px-6 border-t overflow-x-auto" style={{ borderColor: '#f0f0f0' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key as any)}
              className="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0"
              style={{
                borderBottomColor: tab === t.key ? '#254A96' : 'transparent',
                color: tab === t.key ? '#254A96' : '#B9BBB7',
              }}>
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Contenido */}
      <div className="flex-1 overflow-auto">
        {tab === 'faltantes' && (
          <TabFaltantes rol={rol} userEmail={userEmail} userId={userId} userNombre={userNombre} miSucursal={miSucursal} showToast={showToast}
            onIrATransferencias={() => setTab('transferencias')} />
        )}
        {tab === 'transferencias' && (
          <TabRequerimientos filtroEstados={['pendiente', 'conf_stock', 'preparacion']} rol={rol} showToast={showToast} userEmail={userEmail}
            highlightNv={highlightNv} onHighlightConsumed={() => setHighlightNv(null)} />
        )}
        {tab === 'transito' && (
          <TabRequerimientos filtroEstados={['en_transito']} rol={rol} showToast={showToast} userEmail={userEmail} />
        )}
        {tab === 'historial' && (
          <TabRequerimientos filtroEstados={['entregado', 'rechazado']} rol={rol} showToast={showToast} userEmail={userEmail} />
        )}
        {tab === 'preparacion' && (
          <TabPreparacion rol={rol} userId={userId} userNombre={userNombre} miSucursal={miSucursal} showToast={showToast} />
        )}
        {tab === 'consolidado' && (
          <TabConsolidado rol={rol} showToast={showToast} />
        )}
        {tab === 'importar' && (
          <TabImportar rol={rol} showToast={showToast} />
        )}
      </div>
    </div>
  )
}

// ─── Estados siguientes según rol ─────────────────────────────────────────────
function estadosSiguientes(estado: string, rol: string): string[] {
  if (rol === 'ruteador') return []
  const map: Record<string, string[]> = {
    pendiente:   ['conf_stock', 'rechazado'],
    conf_stock:  ['preparacion', 'rechazado'],
    preparacion: ['en_transito', 'rechazado'],
    en_transito: ['entregado', 'rechazado'],
    entregado:   [],
    rechazado:   [],
  }
  return map[estado] ?? []
}

const TIPO_ENTREGA_OPTS = ['parcial', 'completa', 'no_llego', 'cancelado', 'devuelto']
const TIPO_ENTREGA_LABEL: Record<string, string> = {
  parcial: 'Parcial', completa: 'Completa', no_llego: 'No llegó', cancelado: 'Cancelado', devuelto: 'Devuelto',
}

// ─── Fila expandible de requerimiento ─────────────────────────────────────────
const LABELS_FOTO_REQ = ['Remito', 'Material en puerta', 'Daño / Roto', 'Otro']

function comprimirFotoReq(file: File): Promise<Blob> {
  return new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const MAX = 1200
      const ratio = Math.min(MAX / img.width, MAX / img.height, 1)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * ratio)
      canvas.height = Math.round(img.height * ratio)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      canvas.toBlob(blob => resolve(blob ?? file), 'image/jpeg', 0.82)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}

function ReqRow({ req: initialReq, rol, showToast, userEmail, onUpdated, camionCodigos }: {
  req: Requerimiento; rol: string
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  userEmail: string; onUpdated: () => void
  camionCodigos: string[]
}) {
  const [req, setReq] = useState(initialReq)
  const [expanded, setExpanded] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [editItems, setEditItems] = useState<Record<string, number | null>>({})
  const [editNotas, setEditNotas] = useState(req.notas ?? '')
  const [editNViaje, setEditNViaje] = useState(req.n_viaje ?? '')
  const [editVehiculo, setEditVehiculo] = useState(req.cod_vehiculo ?? '')
  const [editFechaRec, setEditFechaRec] = useState(req.fecha_recepcion ?? '')
  const [editTipoEntrega, setEditTipoEntrega] = useState(req.tipo_entrega ?? '')
  const [fotos, setFotos] = useState<{ file: File; preview: string; label: string }[]>([])
  const [showFotoModal, setShowFotoModal] = useState(false)
  const [errorFoto, setErrorFoto] = useState('')
  const [subiendoFoto, setSubiendoFoto] = useState(false)
  const fileRefReq = useRef<HTMLInputElement>(null)
  const [showParcialModal, setShowParcialModal] = useState(false)
  const [cantRecibidas, setCantRecibidas] = useState<Record<string, number>>({})
  const [showConfStockModal, setShowConfStockModal] = useState(false)
  const [modalCantStk, setModalCantStk] = useState<Record<string, number>>({})
  const [notaParcialReq, setNotaParcialReq] = useState('')
  const [fotosParcial, setFotosParcial] = useState<{ file: File; preview: string; label: string }[]>([])
  const [confirmandoParcial, setConfirmandoParcial] = useState(false)
  const [errorParcial, setErrorParcial] = useState('')
  const fileRefParcial = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setReq(initialReq)
    setEditNotas(initialReq.notas ?? '')
    setEditNViaje(initialReq.n_viaje ?? '')
    setEditVehiculo(initialReq.cod_vehiculo ?? '')
    setEditFechaRec(initialReq.fecha_recepcion ?? '')
    setEditTipoEntrega(initialReq.tipo_entrega ?? '')
  }, [initialReq])

  const handleFotoReq = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = () => setFotos(prev => [...prev, { file, preview: reader.result as string, label: 'Remito' }])
      reader.readAsDataURL(file)
    })
    if (fileRefReq.current) fileRefReq.current.value = ''
  }

  const handleFotoParcialReq = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = () => setFotosParcial(prev => [...prev, { file, preview: reader.result as string, label: 'Material en puerta' }])
      reader.readAsDataURL(file)
    })
    if (fileRefParcial.current) fileRefParcial.current.value = ''
  }

  function abrirParcialModal() {
    const init: Record<string, number> = {}
    for (const item of req.requerimiento_items ?? []) {
      init[item.id] = item.cantidad_aprobada ?? item.cantidad_solicitada ?? 0
    }
    setCantRecibidas(init)
    setNotaParcialReq('')
    setFotosParcial([])
    setErrorParcial('')
    setShowParcialModal(true)
  }

  async function confirmarEntregadoParcial() {
    if (!notaParcialReq.trim()) { setErrorParcial('Ingresá el motivo de la entrega parcial.'); return }
    setErrorParcial('')
    setConfirmandoParcial(true)
    try {
      const items = req.requerimiento_items ?? []
      const breakdown = items.map(item => {
        const total = item.cantidad_aprobada ?? item.cantidad_solicitada ?? 0
        const recibido = cantRecibidas[item.id] ?? total
        return `${item.nombre_producto}: ${recibido}/${total}`
      }).join(', ')
      const notaFinal = `📦 Entrega parcial — ${breakdown}. Motivo: ${notaParcialReq.trim()}`
      const formData = new FormData()
      formData.append('requerimiento_id', req.id)
      formData.append('fecha_recepcion', editFechaRec || hoy())
      formData.append('tipo_entrega', 'parcial')
      formData.append('notas', notaFinal)
      if (editNViaje) formData.append('n_viaje', editNViaje)
      if (editVehiculo) formData.append('cod_vehiculo', editVehiculo)
      for (let i = 0; i < fotosParcial.length; i++) {
        const blob = await comprimirFotoReq(fotosParcial[i].file)
        formData.append(`foto_${i}`, blob, `foto_${i}.jpg`)
        formData.append(`label_${i}`, fotosParcial[i].label)
      }
      const res = await fetch('/api/confirmar-requerimiento', { method: 'POST', body: formData })
      const data = await res.json()
      if (!data.success) { setErrorParcial(`Error: ${data.error}`); setConfirmandoParcial(false); return }
      showToast('Entrega parcial registrada')
      setShowParcialModal(false)
      setFotosParcial([])
      setExpanded(false)
      onUpdated()
    } catch (e: any) {
      setErrorParcial(`Error: ${e.message}`)
    }
    setConfirmandoParcial(false)
  }

  async function confirmarEntregadoConFoto() {
    setErrorFoto('')
    setSubiendoFoto(true)
    try {
      const formData = new FormData()
      formData.append('requerimiento_id', req.id)
      formData.append('fecha_recepcion', editFechaRec || hoy())
      formData.append('tipo_entrega', editTipoEntrega || 'completa')
      if (editNotas) formData.append('notas', editNotas)
      if (editNViaje) formData.append('n_viaje', editNViaje)
      if (editVehiculo) formData.append('cod_vehiculo', editVehiculo)
      for (let i = 0; i < fotos.length; i++) {
        const blob = await comprimirFotoReq(fotos[i].file)
        formData.append(`foto_${i}`, blob, `foto_${i}.jpg`)
        formData.append(`label_${i}`, fotos[i].label)
      }
      const res = await fetch('/api/confirmar-requerimiento', { method: 'POST', body: formData })
      const data = await res.json()
      if (!data.success) { setErrorFoto(`Error: ${data.error}`); setSubiendoFoto(false); return }
      showToast('Transferencia marcada como entregada')
      setShowFotoModal(false)
      setFotos([])
      setExpanded(false)
      onUpdated()
    } catch (e: any) {
      setErrorFoto(`Error: ${e.message}`)
    }
    setSubiendoFoto(false)
  }

  const puedeEditar = rol === 'deposito' || rol === 'gerencia'
  const puedeEditarCantidad = puedeEditar && req.estado === 'pendiente'
  const siguientes = estadosSiguientes(req.estado, rol)
  const deadline = req.fecha_solicitada
    ? calcDeadline(req.sucursal_origen, req.sucursal_destino, req.fecha_solicitada)
    : null
  const totalItems = req.requerimiento_items?.length ?? 0
  const resumen = (req.requerimiento_items ?? []).slice(0, 2).map(it => it.nombre_producto).join(', ')
    + (totalItems > 2 ? ` +${totalItems - 2} más` : '')

  function abrirConfStockModal() {
    const init: Record<string, number> = {}
    for (const item of req.requerimiento_items ?? []) {
      init[item.id] = item.cantidad_aprobada ?? item.cantidad_solicitada ?? 0
    }
    setModalCantStk(init)
    setShowConfStockModal(true)
  }

  async function cambiarEstado(nuevoEstado: string, cantOverride?: Record<string, number>) {
    setGuardando(true)
    const updates: any = { estado: nuevoEstado }
    if (nuevoEstado === 'en_transito') { updates.n_viaje = editNViaje; updates.cod_vehiculo = editVehiculo }
    if (nuevoEstado === 'entregado') { updates.fecha_recepcion = editFechaRec || hoy(); updates.tipo_entrega = editTipoEntrega || 'completa' }
    if (editNotas) updates.notas = editNotas
    const source = cantOverride
      ? Object.entries(cantOverride).map(([id, cantidad_aprobada]) => ({ id, cantidad_aprobada }))
      : Object.entries(editItems).filter(([, v]) => v !== null).map(([id, cantidad_aprobada]) => ({ id, cantidad_aprobada }))
    const items_update = source
    const res = await fetch('/api/requerimientos', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, ...updates, items_update }),
    })
    const data = await res.json()
    setGuardando(false)
    if (!data.success) { showToast(`Error: ${data.error}`, 'err'); return }
    // Recalcular peso/posiciones desde maestro de productos cuando hay items aprobados
    if (items_update.length > 0 || nuevoEstado === 'conf_stock') {
      fetch('/api/recalcular-posiciones', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requerimiento_id: req.id }),
      }).catch(() => {})
    }
    showToast(`Estado actualizado: ${ESTADO_LABEL[nuevoEstado]}`)
    setExpanded(false)
    onUpdated()
  }

  return (
    <div className="bg-white rounded-xl border overflow-hidden transition-shadow hover:shadow-sm"
      style={{ borderColor: expanded ? '#d0daf5' : '#f0f0f0', borderLeft: '4px solid #f59e0b' }}>

      {/* ── Fila colapsada ── */}
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => setExpanded(v => !v)}>
        <span className="text-xs shrink-0 transition-transform"
          style={{ color: '#254A96', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>▶</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <BadgeEstado estado={req.estado} />
            {req.nv && <span className="text-xs font-semibold" style={{ color: '#254A96' }}>NV {req.nv}</span>}
            {req.cliente && <span className="text-xs truncate" style={{ color: '#B9BBB7' }}>{req.cliente}</span>}
            <span className="text-xs font-medium" style={{ color: '#1a1a1a' }}>{req.sucursal_origen} → {req.sucursal_destino}</span>
            {req.n_viaje && <span className="text-xs font-medium" style={{ color: '#0f766e' }}>Viaje #{req.n_viaje}</span>}
          </div>
          {resumen && <p className="text-xs mt-0.5 truncate" style={{ color: '#B9BBB7' }}>{resumen}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {deadline && (
            <span className="text-xs px-2 py-0.5 rounded hidden sm:inline"
              style={{ background: '#fef3c7', color: '#b45309' }}>⏰ {deadline.label}</span>
          )}
          <span className="text-xs" style={{ color: '#B9BBB7' }}>{fmtFecha(req.fecha_solicitada ?? req.fecha_req)}</span>
        </div>
      </div>

      {/* ── Detalle expandido ── */}
      {expanded && (
        <div className="border-t px-4 pb-4 pt-3 space-y-3" style={{ borderColor: '#f0f0f0', background: '#fafbff' }}>

          {/* Fechas + deadline */}
          <div className="flex gap-4 text-xs flex-wrap">
            <span style={{ color: '#B9BBB7' }}>Solicitado: <strong style={{ color: '#1a1a1a' }}>{fmtFecha(req.fecha_req)}</strong></span>
            <span style={{ color: '#B9BBB7' }}>Necesario: <strong style={{ color: '#1a1a1a' }}>{fmtFecha(req.fecha_solicitada)}</strong></span>
            {req.solicitado_por && (
              <span style={{ color: '#B9BBB7' }}>Por: <strong style={{ color: '#1a1a1a' }}>{req.solicitado_por}</strong></span>
            )}
            {deadline && (
              <span className="px-2 py-0.5 rounded font-medium" style={{ background: '#fef3c7', color: '#b45309' }}>
                ⏰ Despachar desde {req.sucursal_origen} antes del: {deadline.label}
              </span>
            )}
          </div>

          {/* Productos */}
          <div>
            <p className="text-xs font-semibold mb-1.5" style={{ color: '#254A96' }}>PRODUCTOS</p>
            <div className="space-y-1">
              {(req.requerimiento_items ?? []).map((item: ReqItem) => {
                const qtyAprobada = editItems[item.id] ?? item.cantidad_aprobada ?? item.cantidad_solicitada
                const isOver = item.cantidad_solicitada != null && Number(qtyAprobada) > item.cantidad_solicitada
                return (
                  <div key={item.id} className="flex items-center gap-3 px-3 py-2 rounded-lg flex-wrap"
                    style={{ background: isOver ? '#fde8e8' : '#f4f4f3', border: `1px solid ${isOver ? '#fca5a5' : 'transparent'}` }}>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium" style={isOver ? { color: '#dc2626' } : { color: '#1a1a1a' }}>
                        {item.nombre_producto}
                      </span>
                      {item.id_producto && (
                        <span className="text-xs font-mono ml-1.5" style={{ color: '#aaa' }}>#{item.id_producto}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span style={{ color: '#B9BBB7' }}>Solicitado: <strong>{item.cantidad_solicitada}</strong></span>
                      {puedeEditarCantidad ? (
                        <label className="flex items-center gap-1" style={{ color: isOver ? '#dc2626' : '#0f766e' }}>
                          Aprobado:
                          <input type="number" min={0} value={qtyAprobada}
                            onChange={e => setEditItems(prev => ({ ...prev, [item.id]: parseInt(e.target.value) || 0 }))}
                            className="w-16 border rounded px-1.5 py-0.5 text-xs font-bold text-center focus:outline-none"
                            style={{ borderColor: isOver ? '#fca5a5' : '#e8edf8', color: isOver ? '#dc2626' : undefined }} />
                          {isOver && <span className="px-1 py-0.5 rounded text-xs font-bold" style={{ background: '#dc2626', color: '#fff' }}>⬆</span>}
                        </label>
                      ) : item.cantidad_aprobada != null ? (
                        <span className="font-semibold" style={{ color: isOver ? '#dc2626' : '#0f766e' }}>
                          Aprobado: {item.cantidad_aprobada}{isOver && ' ⬆'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Edición (depósito / gerencia) */}
          {puedeEditar && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>N° Viaje (ERP)</label>
                  <input value={editNViaje} onChange={e => setEditNViaje(e.target.value)} placeholder="ej: 1360"
                    className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>Vehículo</label>
                  <input value={editVehiculo} onChange={e => setEditVehiculo(e.target.value)}
                    list="camion-codigos-list" placeholder="Código o texto libre"
                    className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                  <datalist id="camion-codigos-list">
                    {camionCodigos.map(c => <option key={c} value={c} />)}
                  </datalist>
                </div>
              </div>
              {(req.estado === 'en_transito' || req.estado === 'entregado') && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>Fecha recepción</label>
                    <input type="date" value={editFechaRec} onChange={e => setEditFechaRec(e.target.value)}
                      className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>Tipo entrega</label>
                    <select value={editTipoEntrega} onChange={e => setEditTipoEntrega(e.target.value)}
                      className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                      <option value="">— seleccionar —</option>
                      {TIPO_ENTREGA_OPTS.map(o => <option key={o} value={o}>{TIPO_ENTREGA_LABEL[o]}</option>)}
                    </select>
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>Observaciones</label>
                <textarea value={editNotas} onChange={e => setEditNotas(e.target.value)} rows={2}
                  className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none resize-none" style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>
          )}
          {!puedeEditar && req.notas && (
            <p className="text-sm rounded-lg px-3 py-2" style={{ background: '#fef3c7', color: '#b45309' }}>{req.notas}</p>
          )}

          {/* Botones de avance */}
          {siguientes.length > 0 && (
            <div className="flex gap-2 flex-wrap pt-1">
              {siguientes.flatMap(sig => {
                const btn = (
                  <button key={sig} disabled={guardando}
                    onClick={() => sig === 'entregado' ? setShowFotoModal(true) : sig === 'conf_stock' ? abrirConfStockModal() : cambiarEstado(sig)}
                    className="flex-1 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: sig === 'rechazado' ? '#E52322' : sig === 'entregado' ? '#10b981' : '#254A96' }}>
                    {guardando ? '…' : sig === 'conf_stock' ? '✅ Aprobar solicitud' : sig === 'rechazado' && req.estado === 'pendiente' ? '✕ Rechazar solicitud' : `→ ${ESTADO_LABEL[sig]}`}
                  </button>
                )
                if (sig === 'entregado') return [btn, (
                  <button key="parcial" disabled={guardando}
                    onClick={abrirParcialModal}
                    className="flex-1 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                    style={{ background: '#f59e0b' }}>
                    📦 Parcial
                  </button>
                )]
                return [btn]
              })}
            </div>
          )}
        </div>
      )}

      {/* Modal confirmar stock */}
      {showConfStockModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#254A96' }}>Aprobar solicitud</h3>
                <p className="text-sm mt-0.5" style={{ color: '#B9BBB7' }}>{req.sucursal_origen} → {req.sucursal_destino}</p>
              </div>
              <button onClick={() => setShowConfStockModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            <div>
              <p className="text-xs font-medium mb-2" style={{ color: '#254A96' }}>Cantidades a despachar</p>
              <div className="space-y-2">
                {(req.requerimiento_items ?? []).map(item => {
                  const solicitado = item.cantidad_solicitada ?? 0
                  const aprobado = modalCantStk[item.id] ?? solicitado
                  const esMenos = aprobado < solicitado
                  return (
                    <div key={item.id} className="rounded-xl p-3 border"
                      style={{ borderColor: esMenos ? '#fbbf24' : '#e8edf8', background: esMenos ? '#fffbeb' : '#f9fafb' }}>
                      <p className="text-xs font-medium mb-2" style={{ color: '#1a1a1a' }}>{item.nombre_producto}</p>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setModalCantStk(prev => ({ ...prev, [item.id]: Math.max(0, (prev[item.id] ?? solicitado) - 1) }))}
                          className="w-8 h-8 rounded-full text-base font-bold flex items-center justify-center shrink-0"
                          style={{ background: '#f4f4f3', color: '#666' }}>−</button>
                        <div className="flex items-center gap-1 flex-1 justify-center">
                          <input type="text" inputMode="numeric" value={aprobado}
                            onChange={e => {
                              const raw = e.target.value.replace(/[^\d]/g, '')
                              const n = raw === '' ? 0 : Math.max(0, parseInt(raw))
                              setModalCantStk(prev => ({ ...prev, [item.id]: n }))
                            }}
                            onFocus={e => e.target.select()}
                            className="w-14 text-sm font-bold text-center rounded-lg border focus:outline-none"
                            style={{ color: '#254A96', borderColor: '#e8edf8', padding: '4px' }} />
                          <span className="text-xs" style={{ color: '#B9BBB7' }}>/ {solicitado} sol.</span>
                        </div>
                        <button onClick={() => setModalCantStk(prev => ({ ...prev, [item.id]: (prev[item.id] ?? solicitado) + 1 }))}
                          className="w-8 h-8 rounded-full text-base font-bold flex items-center justify-center shrink-0"
                          style={{ background: '#f4f4f3', color: '#666' }}>+</button>
                      </div>
                      {esMenos && (
                        <p className="text-xs mt-1.5 text-center" style={{ color: '#b45309' }}>
                          Faltante: {solicitado - aprobado} unidades
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <button disabled={guardando}
              onClick={async () => { await cambiarEstado('conf_stock', modalCantStk); setShowConfStockModal(false) }}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: '#254A96' }}>
              {guardando ? '…' : '✅ Aprobar solicitud'}
            </button>
          </div>
        </div>
      )}

      {/* Modal entrega parcial */}
      {showParcialModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#b45309' }}>📦 Entrega parcial</h3>
                <p className="text-sm mt-0.5" style={{ color: '#B9BBB7' }}>{req.sucursal_origen} → {req.sucursal_destino}</p>
              </div>
              <button onClick={() => setShowParcialModal(false)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            {/* Cantidades por item */}
            <div>
              <p className="text-xs font-medium mb-2" style={{ color: '#254A96' }}>¿Cuánto llegó?</p>
              {(req.requerimiento_items ?? []).length === 0 ? (
                <div className="rounded-xl p-3 border text-xs" style={{ borderColor: '#e8edf8', color: '#B9BBB7', background: '#f9f9f9' }}>
                  Esta transferencia no tiene items registrados. Indicá el motivo y adjuntá foto.
                </div>
              ) : (
                <div className="space-y-2">
                  {(req.requerimiento_items ?? []).map(item => {
                    const total = item.cantidad_aprobada ?? item.cantidad_solicitada ?? 0
                    const recibido = cantRecibidas[item.id] ?? total
                    const pendiente = total - recibido
                    return (
                      <div key={item.id} className="rounded-xl p-3 border"
                        style={{ borderColor: pendiente > 0 ? '#fbbf24' : '#d1fae5', background: pendiente > 0 ? '#fffbeb' : '#f0fdf4' }}>
                        <p className="text-xs font-medium mb-2" style={{ color: '#1a1a1a' }}>{item.nombre_producto}</p>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setCantRecibidas(prev => ({ ...prev, [item.id]: Math.max(0, (prev[item.id] ?? total) - 1) }))}
                            className="w-8 h-8 rounded-full text-base font-bold flex items-center justify-center shrink-0"
                            style={{ background: '#f4f4f3', color: '#666' }}>−</button>
                          <div className="flex items-center gap-1 flex-1 justify-center">
                            <input type="text" inputMode="numeric" value={recibido}
                              onChange={e => {
                                const raw = e.target.value.replace(/[^\d]/g, '')
                                const n = raw === '' ? 0 : Math.min(total, Math.max(0, parseInt(raw)))
                                setCantRecibidas(prev => ({ ...prev, [item.id]: n }))
                              }}
                              onFocus={e => e.target.select()}
                              className="w-12 text-sm font-bold text-center rounded-lg border focus:outline-none"
                              style={{ color: '#254A96', borderColor: '#e8edf8', padding: '4px' }} />
                            <span className="text-xs" style={{ color: '#B9BBB7' }}>/ {total}</span>
                          </div>
                          <button onClick={() => setCantRecibidas(prev => ({ ...prev, [item.id]: Math.min(total, (prev[item.id] ?? total) + 1) }))}
                            className="w-8 h-8 rounded-full text-base font-bold flex items-center justify-center shrink-0"
                            style={{ background: '#f4f4f3', color: '#666' }}>+</button>
                          {pendiente > 0 && <span className="text-xs shrink-0" style={{ color: '#b45309' }}>Saldo: {pendiente}</span>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Motivo obligatorio */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#b45309' }}>
                Motivo <span style={{ color: '#E52322' }}>*</span>
              </label>
              <textarea value={notaParcialReq} onChange={e => setNotaParcialReq(e.target.value)} rows={2}
                className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: '#fbbf24' }}
                placeholder="Ej: Faltaba stock, no había espacio, parte rechazada en destino..." />
            </div>

            {/* Foto opcional */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>
                Foto <span className="font-normal" style={{ color: '#B9BBB7' }}>(opcional)</span>
              </label>
              {fotosParcial.length > 0 && (
                <div className="space-y-2 mb-2">
                  {fotosParcial.map((f, idx) => (
                    <div key={idx} className="flex gap-2 items-center rounded-xl p-2"
                      style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                      <img src={f.preview} alt="" className="w-14 h-14 object-cover rounded-lg flex-shrink-0" />
                      <p className="text-xs flex-1 truncate" style={{ color: '#B9BBB7' }}>{f.file.name}</p>
                      <button onClick={() => setFotosParcial(prev => prev.filter((_, j) => j !== idx))}
                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs"
                        style={{ background: '#E52322' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => fileRefParcial.current?.click()}
                className="w-full border-2 border-dashed rounded-xl py-4 text-center"
                style={{ borderColor: '#e8edf8' }}>
                <p className="text-xl mb-0.5">📷</p>
                <p className="text-xs" style={{ color: '#B9BBB7' }}>
                  {fotosParcial.length === 0 ? 'Agregar foto (opcional)' : '+ Agregar otra'}
                </p>
              </button>
              <input ref={fileRefParcial} type="file" accept="image/*" capture="environment"
                multiple onChange={handleFotoParcialReq} className="hidden" />
            </div>

            {errorParcial && (
              <div className="rounded-xl px-4 py-3 text-sm font-medium"
                style={{ background: '#fde8e8', color: '#E52322', border: '1px solid #fca5a5' }}>
                ⚠️ {errorParcial}
              </div>
            )}

            <button onClick={confirmarEntregadoParcial}
              disabled={confirmandoParcial || !notaParcialReq.trim()}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: '#f59e0b' }}>
              {confirmandoParcial ? 'Guardando...' : '📦 Guardar entrega parcial'}
            </button>
          </div>
        </div>
      )}

      {/* Modal foto comprobante — se activa al marcar como Entregado */}
      {showFotoModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4" style={{ maxHeight: '90vh', overflowY: 'auto' }}>
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#10b981' }}>Registrar entrega</h3>
                <p className="text-sm mt-0.5" style={{ color: '#B9BBB7' }}>{req.sucursal_origen} → {req.sucursal_destino}</p>
              </div>
              <button onClick={() => { setShowFotoModal(false); setFotos([]); setErrorFoto('') }}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>

            {/* Fotos — opcionales */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>
                Foto del comprobante <span className="font-normal" style={{ color: '#B9BBB7' }}>(opcional)</span>
              </label>
              {fotos.length > 0 && (
                <div className="space-y-2 mb-2">
                  {fotos.map((f, idx) => (
                    <div key={idx} className="flex gap-2 items-start rounded-xl p-2"
                      style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                      <img src={f.preview} alt="" className="w-16 h-16 object-cover rounded-lg flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <select value={f.label}
                          onChange={e => setFotos(prev => prev.map((ft, i) => i === idx ? { ...ft, label: e.target.value } : ft))}
                          className="w-full border rounded-lg px-2 py-1.5 text-xs focus:outline-none mb-1"
                          style={{ borderColor: '#e8edf8' }}>
                          {LABELS_FOTO_REQ.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                        <p className="text-xs truncate" style={{ color: '#B9BBB7' }}>{f.file.name}</p>
                      </div>
                      <button onClick={() => setFotos(prev => prev.filter((_, i) => i !== idx))}
                        className="w-6 h-6 flex-shrink-0 rounded-full flex items-center justify-center text-white text-xs mt-1"
                        style={{ background: '#E52322' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => fileRefReq.current?.click()}
                className="w-full border-2 border-dashed rounded-xl py-4 text-center"
                style={{ borderColor: '#e8edf8' }}>
                <p className="text-xl mb-0.5">📷</p>
                <p className="text-xs" style={{ color: '#B9BBB7' }}>
                  {fotos.length === 0 ? 'Agregar foto (opcional)' : '+ Agregar otra foto'}
                </p>
              </button>
              <input ref={fileRefReq} type="file" accept="image/*" capture="environment"
                multiple onChange={handleFotoReq} className="hidden" />
            </div>

            {/* Error inline */}
            {errorFoto && (
              <div className="rounded-xl px-4 py-3 text-sm font-medium flex items-center gap-2"
                style={{ background: '#fde8e8', color: '#E52322', border: '1px solid #fca5a5' }}>
                ⚠️ {errorFoto}
              </div>
            )}

            {/* Botones */}
            <div className="flex gap-2">
              <button onClick={confirmarEntregadoConFoto} disabled={subiendoFoto}
                className="flex-1 py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#10b981' }}>
                {subiendoFoto ? 'Guardando...' : '✓ Confirmar entrega'}
              </button>
              <button onClick={() => { setShowFotoModal(false); setFotos([]); setErrorFoto('') }}
                disabled={subiendoFoto}
                className="flex-1 py-3 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: '#f4f4f3', color: '#B9BBB7' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Hoja de ruteo para depósito ──────────────────────────────────────────────
function HojaRuteo({ reqs, onClose }: { reqs: Requerimiento[]; onClose: () => void }) {
  const [origen, setOrigen] = useState(SUCURSALES[0])
  const ESTADOS_RUTEO = ['conf_stock', 'preparacion', 'en_transito']
  const reqsFiltrados = reqs.filter(r => r.sucursal_origen === origen && ESTADOS_RUTEO.includes(r.estado))

  // Agrupar por destino
  const byDestino: Record<string, Requerimiento[]> = {}
  for (const r of reqsFiltrados) {
    if (!byDestino[r.sucursal_destino]) byDestino[r.sucursal_destino] = []
    byDestino[r.sucursal_destino].push(r)
  }

  const totalItems = reqsFiltrados.reduce((sum, r) => sum + (r.requerimiento_items?.length ?? 0), 0)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" style={{ fontFamily: 'Barlow, sans-serif' }}>
      {/* Controles — se ocultan al imprimir */}
      <div className="print:hidden flex items-center gap-3 px-6 py-3 border-b flex-wrap" style={{ borderColor: '#e8edf8', background: '#fafbff' }}>
        <span className="font-semibold text-sm" style={{ color: '#254A96' }}>📋 Hoja de ruteo — Depósito</span>
        <div className="flex items-center gap-2 ml-4">
          <label className="text-xs font-medium" style={{ color: '#254A96' }}>Sucursal origen:</label>
          <select value={origen} onChange={e => setOrigen(e.target.value)}
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>
          {reqsFiltrados.length} transferencia{reqsFiltrados.length !== 1 ? 's' : ''} · {totalItems} líneas de producto
        </span>
        <div className="ml-auto flex gap-2">
          <button onClick={() => window.print()}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white"
            style={{ background: '#254A96' }}>🖨 Imprimir / PDF</button>
          <button onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-sm font-medium"
            style={{ background: '#f4f4f3', color: '#666' }}>Cerrar</button>
        </div>
      </div>

      {/* Contenido imprimible */}
      <div className="flex-1 overflow-auto px-8 py-6 print:p-0 print:overflow-visible">
        {/* Encabezado del documento */}
        <div className="mb-6 pb-4 border-b-2" style={{ borderColor: '#254A96' }}>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold" style={{ color: '#254A96' }}>HOJA DE RUTEO — DEPÓSITO</h1>
              <p className="text-lg font-semibold mt-0.5">{origen}</p>
            </div>
            <div className="text-right text-sm" style={{ color: '#666' }}>
              <p>Fecha: <strong>{fmtFecha(hoy())}</strong></p>
              <p>{reqsFiltrados.length} transferencias pendientes</p>
            </div>
          </div>
          <div className="flex gap-3 mt-3 flex-wrap">
            {ESTADOS_RUTEO.map(e => {
              const cnt = reqsFiltrados.filter(r => r.estado === e).length
              if (!cnt) return null
              const c = ESTADO_COLOR[e] ?? { bg: '#f4f4f3', text: '#666' }
              return (
                <span key={e} className="text-xs px-2.5 py-1 rounded-full font-semibold"
                  style={{ background: c.bg, color: c.text }}>
                  {ESTADO_LABEL[e]}: {cnt}
                </span>
              )
            })}
          </div>
        </div>

        {reqsFiltrados.length === 0 ? (
          <div className="text-center py-16" style={{ color: '#B9BBB7' }}>
            <p className="text-4xl mb-3">📦</p>
            <p>No hay transferencias en preparación para {origen}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(byDestino).sort(([a], [b]) => a.localeCompare(b)).map(([destino, items]) => (
              <div key={destino}>
                {/* Cabecera destino */}
                <div className="flex items-center gap-3 mb-2 px-3 py-2 rounded-lg"
                  style={{ background: '#e8edf8' }}>
                  <span className="font-bold text-sm" style={{ color: '#254A96' }}>
                    {origen} → {destino}
                  </span>
                  <span className="text-xs" style={{ color: '#254A96' }}>
                    {items.length} transferencia{items.length !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Transferencias hacia ese destino */}
                <div className="space-y-3 ml-3">
                  {items.map(req => (
                    <div key={req.id} className="border rounded-lg overflow-hidden" style={{ borderColor: '#e0e0e0' }}>
                      {/* Cabecera de la transferencia */}
                      <div className="flex items-center gap-3 px-3 py-2 flex-wrap"
                        style={{ background: '#fafafa', borderBottom: '1px solid #e0e0e0' }}>
                        <BadgeEstado estado={req.estado} />
                        {req.nv && <span className="text-xs font-semibold" style={{ color: '#254A96' }}>NV {req.nv}</span>}
                        {req.cliente && <span className="text-xs" style={{ color: '#666' }}>{req.cliente}</span>}
                        {req.n_viaje && <span className="text-xs font-medium" style={{ color: '#0f766e' }}>Viaje #{req.n_viaje}</span>}
                        {req.cod_vehiculo && <span className="text-xs" style={{ color: '#666' }}>🚛 {req.cod_vehiculo}</span>}
                        <span className="text-xs ml-auto" style={{ color: '#999' }}>
                          Necesario: {fmtFecha(req.fecha_solicitada)}
                        </span>
                      </div>

                      {/* Tabla de productos */}
                      <table className="w-full text-sm">
                        <thead>
                          <tr style={{ background: '#f9f9f9' }}>
                            <th className="text-left px-3 py-1.5 text-xs font-semibold" style={{ color: '#666' }}>Producto</th>
                            <th className="text-center px-3 py-1.5 text-xs font-semibold w-24" style={{ color: '#666' }}>Solicitado</th>
                            <th className="text-center px-3 py-1.5 text-xs font-semibold w-24" style={{ color: '#666' }}>Aprobado</th>
                            <th className="text-center px-3 py-1.5 text-xs font-semibold w-20 print:block hidden" style={{ color: '#666' }}>✓ Preparado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(req.requerimiento_items ?? []).map(item => (
                            <tr key={item.id} className="border-t" style={{ borderColor: '#f0f0f0' }}>
                              <td className="px-3 py-1.5">
                                <span className="font-medium">{item.nombre_producto}</span>
                                {item.id_producto && <span className="text-xs ml-1.5" style={{ color: '#aaa' }}>#{item.id_producto}</span>}
                              </td>
                              <td className="px-3 py-1.5 text-center font-semibold">{item.cantidad_solicitada}</td>
                              <td className="px-3 py-1.5 text-center font-bold" style={{ color: '#0f766e' }}>
                                {item.cantidad_aprobada ?? item.cantidad_solicitada}
                              </td>
                              <td className="px-3 py-1.5 text-center print:block hidden">
                                <span style={{ border: '1px solid #999', display: 'inline-block', width: 16, height: 16 }} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {req.notas && (
                        <p className="px-3 py-1.5 text-xs italic" style={{ color: '#b45309', background: '#fffbeb', borderTop: '1px solid #f0f0f0' }}>
                          📝 {req.notas}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Firma al pie */}
        <div className="mt-10 pt-4 border-t grid grid-cols-3 gap-8 text-xs" style={{ borderColor: '#e0e0e0', color: '#666' }}>
          <div><p className="mb-8">Preparado por:</p><div style={{ borderTop: '1px solid #999' }} /></div>
          <div><p className="mb-8">Verificado por:</p><div style={{ borderTop: '1px solid #999' }} /></div>
          <div><p className="mb-8">Despachado por:</p><div style={{ borderTop: '1px solid #999' }} /></div>
        </div>
      </div>
    </div>
  )
}

function TabRequerimientos({ filtroEstados, rol, showToast, userEmail, highlightNv, onHighlightConsumed }: {
  filtroEstados: string[]
  rol: string
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  userEmail: string
  highlightNv?: string | null
  onHighlightConsumed?: () => void
}) {
  const [reqs, setReqs] = useState<Requerimiento[]>([])
  const [cargando, setCargando] = useState(false)
  const [camionCodigos, setCamionCodigos] = useState<string[]>([])
  const [filtroOrigen, setFiltroOrigen] = useState('')
  const [filtroDestino, setFiltroDestino] = useState('')
  // Filtros de búsqueda
  const [filtroNV, setFiltroNV] = useState('')
  const [filtroSD, setFiltroSD] = useState('')
  const [filtroIdProd, setFiltroIdProd] = useState('')
  const [filtroDescProd, setFiltroDescProd] = useState('')
  const [filtroEstadoReq, setFiltroEstadoReq] = useState<string[]>([])
  // Hoja de ruteo
  const [showHojaRuteo, setShowHojaRuteo] = useState(false)

  const [flashNv, setFlashNv] = useState<string | null>(null)

  const tabKey = filtroEstados.join(',')
  useEffect(() => { cargarReqs() }, [tabKey, filtroOrigen, filtroDestino])

  useEffect(() => {
    if (!highlightNv) return
    setFiltroNV(highlightNv)
    setFlashNv(highlightNv)
    onHighlightConsumed?.()
    // Scroll después de que el DOM renderice
    const t = setTimeout(() => {
      const el = document.getElementById(`reqrow-${highlightNv}`)
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }) }
      setTimeout(() => setFlashNv(null), 2000)
    }, 300)
    return () => clearTimeout(t)
  }, [highlightNv])
  useEffect(() => {
    supabase.from('camiones_flota').select('codigo').order('codigo')
      .then(({ data }) => setCamionCodigos((data ?? []).map((c: any) => c.codigo)))
  }, [])

  async function cargarReqs() {
    setCargando(true)
    const tab = filtroEstados.includes('entregado') ? 'historial'
      : filtroEstados.includes('en_transito') ? 'transito'
      : 'pendientes'
    const params = new URLSearchParams({ tab })
    if (filtroOrigen) params.set('sucursal_origen', filtroOrigen)
    if (filtroDestino) params.set('sucursal_destino', filtroDestino)
    const res = await fetch(`/api/requerimientos?${params}`)
    const data = await res.json()
    setReqs(Array.isArray(data) ? data : [])
    setCargando(false)
  }

  // Filtros cliente
  const reqsFiltrados = reqs.filter(req => {
    if (filtroNV && !req.nv?.toLowerCase().includes(filtroNV.toLowerCase())) return false
    if (filtroSD && !req.notas?.includes(`SD #${filtroSD}`)) return false
    if (filtroIdProd) {
      const hasId = req.requerimiento_items?.some(it => String(it.id_producto ?? '').includes(filtroIdProd))
      if (!hasId) return false
    }
    if (filtroDescProd) {
      const hasDesc = req.requerimiento_items?.some(it =>
        it.nombre_producto?.toLowerCase().includes(filtroDescProd.toLowerCase()))
      if (!hasDesc) return false
    }
    if (filtroEstadoReq.length > 0 && !filtroEstadoReq.includes(req.estado)) return false
    return true
  })

  // ── Nueva transferencia manual ───────────────────────────────────────────
  const [modalNueva, setModalNueva] = useState(false)
  const [nfOrigen, setNfOrigen] = useState('')
  const [nfDestino, setNfDestino] = useState('')
  const [nfNV, setNfNV] = useState('')
  const [nfCliente, setNfCliente] = useState('')
  const [nfFecha, setNfFecha] = useState('')
  const [nfNotas, setNfNotas] = useState('')
  const [nfItems, setNfItems] = useState<{ codigo: string; nombre: string; cantidad: number; id_producto: number | null; buscando: boolean; notFound: boolean }[]>([{ codigo: '', nombre: '', cantidad: 1, id_producto: null, buscando: false, notFound: false }])
  const [creando, setCreando] = useState(false)

  function abrirModalNueva() {
    setNfOrigen(''); setNfDestino(''); setNfNV(''); setNfCliente('')
    setNfFecha(''); setNfNotas(''); setNfItems([{ codigo: '', nombre: '', cantidad: 1, id_producto: null, buscando: false, notFound: false }])
    setModalNueva(true)
  }

  // Búsqueda por descripción: sugiere productos del catálogo mientras se escribe el nombre
  const [sugerencias, setSugerencias] = useState<{ idx: number; lista: { id: number; nombre: string; activo: boolean }[] } | null>(null)
  const temporizadorSug = useRef<any>(null)
  function buscarPorNombre(idx: number, texto: string) {
    if (temporizadorSug.current) clearTimeout(temporizadorSug.current)
    if (texto.trim().length < 2) { setSugerencias(null); return }
    temporizadorSug.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/productos-catalogo?q=${encodeURIComponent(texto.trim())}`)
        const data = res.ok ? await res.json() : []
        setSugerencias(Array.isArray(data) && data.length ? { idx, lista: data } : null)
      } catch { setSugerencias(null) }
    }, 250)
  }
  function elegirSugerencia(idx: number, prod: { id: number; nombre: string }) {
    setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, nombre: prod.nombre, codigo: String(prod.id), id_producto: prod.id, notFound: false } : it))
    setSugerencias(null)
  }

  async function buscarPorCodigo(idx: number, codigo: string) {
    if (!codigo.trim()) return
    setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, buscando: true, notFound: false } : it))
    try {
      const res = await fetch(`/api/productos-catalogo?codigo=${encodeURIComponent(codigo.trim())}`)
      const data = res.ok ? await res.json() : null
      if (data?.id) {
        setNfItems(prev => prev.map((it, i) => i === idx
          ? { ...it, buscando: false, nombre: data.nombre, id_producto: data.id, notFound: false }
          : it))
      } else {
        setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, buscando: false, notFound: true } : it))
      }
    } catch {
      setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, buscando: false } : it))
    }
  }

  async function crearNueva() {
    if (!nfOrigen || !nfDestino) { showToast('Seleccioná origen y destino', 'err'); return }
    if (nfOrigen === nfDestino) { showToast('Origen y destino deben ser distintos', 'err'); return }
    const itemsValidos = nfItems.filter(i => i.nombre.trim())
    if (itemsValidos.length === 0) { showToast('Agregá al menos un producto', 'err'); return }
    setCreando(true)
    try {
      const res = await fetch('/api/requerimientos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'abastecimiento',
          nv: nfNV || null,
          cliente: nfCliente || null,
          sucursal_origen: nfOrigen,
          sucursal_destino: nfDestino,
          estado: 'pendiente',
          vuelta: 0,
          fecha_req: hoy(),
          fecha_solicitada: nfFecha || null,
          solicitado_por: userEmail,
          notas: nfNotas || null,
          items: itemsValidos.map(i => ({ id_producto: i.id_producto ?? null, nombre_producto: i.nombre.trim(), cantidad_solicitada: i.cantidad })),
        }),
      })
      if (!res.ok) { const err = await res.json(); throw new Error(err.error ?? 'Error creando transferencia') }
      showToast('✓ Transferencia creada')
      setModalNueva(false)
      cargarReqs()
    } catch (e: any) {
      showToast(`Error: ${e.message}`, 'err')
    }
    setCreando(false)
  }

  return (
    <div className="px-4 md:px-6 py-4">

      {/* Hoja de ruteo overlay */}
      {showHojaRuteo && <HojaRuteo reqs={reqs} onClose={() => setShowHojaRuteo(false)} />}

      {/* ── Barra de filtros ── */}
      <div className="bg-white rounded-xl border px-4 py-3 mb-4 space-y-2" style={{ borderColor: '#f0f0f0' }}>
        {/* Fila 1: acciones + origen/destino */}
        <div className="flex items-center gap-2 flex-wrap">
          {filtroEstados.includes('pendiente') && (
            <button onClick={abrirModalNueva}
              className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg shrink-0"
              style={{ background: '#254A96' }}>
              + Nueva
            </button>
          )}
          {filtroEstados.includes('pendiente') && (
            <button onClick={() => setShowHojaRuteo(true)}
              className="px-3 py-1.5 text-sm font-medium rounded-lg shrink-0"
              style={{ background: '#e8edf8', color: '#254A96' }}>
              📋 Hoja de ruteo
            </button>
          )}
          <select value={filtroOrigen} onChange={e => setFiltroOrigen(e.target.value)}
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
            <option value="">Todos los orígenes</option>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <span style={{ color: '#B9BBB7' }}>→</span>
          <select value={filtroDestino} onChange={e => setFiltroDestino(e.target.value)}
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
            <option value="">Todos los destinos</option>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="text-xs ml-auto" style={{ color: '#B9BBB7' }}>
            {reqsFiltrados.length}/{reqs.length} transferencia{reqs.length !== 1 ? 's' : ''}
          </span>
        </div>
        {/* Fila 2: búsqueda */}
        <div className="flex gap-2 flex-wrap">
          <input value={filtroNV} onChange={e => setFiltroNV(e.target.value)} placeholder="Buscar NV…"
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none w-32" style={{ borderColor: '#e8edf8' }} />
          <input value={filtroSD} onChange={e => setFiltroSD(e.target.value)} placeholder="Buscar SD #…"
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none w-32" style={{ borderColor: '#e8edf8' }} />
          <input value={filtroIdProd} onChange={e => setFiltroIdProd(e.target.value)} placeholder="ID producto…"
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none w-32" style={{ borderColor: '#e8edf8' }} />
          <input value={filtroDescProd} onChange={e => setFiltroDescProd(e.target.value)} placeholder="Descripción producto…"
            className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none flex-1 min-w-40" style={{ borderColor: '#e8edf8' }} />
          {(filtroNV || filtroSD || filtroIdProd || filtroDescProd || filtroEstadoReq.length > 0) && (
            <button onClick={() => { setFiltroNV(''); setFiltroSD(''); setFiltroIdProd(''); setFiltroDescProd(''); setFiltroEstadoReq([]) }}
              className="text-xs px-2.5 py-1.5 rounded-lg" style={{ color: '#B9BBB7', border: '1px solid #e0e0e0' }}>
              ✕ limpiar
            </button>
          )}
        </div>
        {/* Fila 3: chips de estado */}
        {(() => {
          const estadoCounts = reqs.reduce<Record<string, number>>((acc, r) => {
            acc[r.estado] = (acc[r.estado] ?? 0) + 1
            return acc
          }, {})
          const estados = Object.keys(ESTADO_LABEL).filter(e => estadoCounts[e])
          if (estados.length === 0) return null
          return (
            <div className="flex gap-1.5 flex-wrap">
              {estados.map(e => {
                const active = filtroEstadoReq.includes(e)
                const c = ESTADO_COLOR[e] ?? { bg: '#f4f4f3', text: '#666' }
                return (
                  <button key={e}
                    onClick={() => setFiltroEstadoReq(prev =>
                      prev.includes(e) ? prev.filter(x => x !== e) : [...prev, e]
                    )}
                    className="text-xs px-2.5 py-1 rounded-full font-medium transition-opacity"
                    style={{
                      background: active ? c.bg : '#f4f4f3',
                      color: active ? c.text : '#999',
                      border: `1.5px solid ${active ? c.text + '55' : '#e8e8e8'}`,
                      opacity: filtroEstadoReq.length > 0 && !active ? 0.55 : 1,
                    }}>
                    {ESTADO_LABEL[e]} <span className="opacity-70">{estadoCounts[e]}</span>
                  </button>
                )
              })}
            </div>
          )
        })()}
      </div>

      {cargando ? (
        <div className="flex justify-center py-24">
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
        </div>
      ) : reqsFiltrados.length === 0 ? (
        <div className="flex flex-col items-center py-24" style={{ color: '#B9BBB7' }}>
          <div className="text-5xl mb-4">📦</div>
          <p className="font-medium">{reqs.length === 0 ? 'No hay transferencias en esta sección' : 'Sin resultados para los filtros'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reqsFiltrados.map(req => (
            <div key={req.id} id={req.nv ? `reqrow-${req.nv}` : undefined}
              className="rounded-xl transition-all duration-700"
              style={flashNv && req.nv === flashNv ? { outline: '2px solid #ea580c', boxShadow: '0 0 0 4px #fed7aa' } : {}}>
              <ReqRow req={req} rol={rol} showToast={showToast} userEmail={userEmail} onUpdated={cargarReqs} camionCodigos={camionCodigos} />
            </div>
          ))}
        </div>
      )}

      {/* ── Modal nueva transferencia manual ──────────────────────────────── */}
      {modalNueva && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)' }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
            style={{ fontFamily: 'Barlow, sans-serif' }}>
            {/* Header */}
            <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: '#e8edf8' }}>
              <h2 className="font-semibold text-sm" style={{ color: '#254A96' }}>Nueva transferencia manual</h2>
              <button onClick={() => setModalNueva(false)} className="text-lg" style={{ color: '#B9BBB7' }}>×</button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              {/* Origen / Destino */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Sucursal origen</label>
                  <select value={nfOrigen} onChange={e => setNfOrigen(e.target.value)}
                    className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                    <option value="">— Seleccionar —</option>
                    {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Sucursal destino</label>
                  <select value={nfDestino} onChange={e => setNfDestino(e.target.value)}
                    className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                    <option value="">— Seleccionar —</option>
                    {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              {/* NV / Cliente */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>NV (opcional)</label>
                  <input value={nfNV} onChange={e => setNfNV(e.target.value)} placeholder="ej: 1234"
                    className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Cliente (opcional)</label>
                  <input value={nfCliente} onChange={e => setNfCliente(e.target.value)} placeholder="Nombre cliente"
                    className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                </div>
              </div>

              {/* Fecha solicitada */}
              <div>
                <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Fecha solicitada</label>
                <input type="date" value={nfFecha} onChange={e => setNfFecha(e.target.value)}
                  className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>

              {/* Notas */}
              <div>
                <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Notas (opcional)</label>
                <textarea value={nfNotas} onChange={e => setNfNotas(e.target.value)} rows={2}
                  className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none resize-none" style={{ borderColor: '#e8edf8' }} />
              </div>

              {/* Items */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold" style={{ color: '#254A96' }}>Productos</label>
                  <span className="text-xs" style={{ color: '#B9BBB7' }}>Escribí el código ID del ERP o buscá el producto por nombre</span>
                </div>
                <div className="space-y-2">
                  {nfItems.map((item, idx) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center gap-2">
                        {/* Código SKU */}
                        <input
                          value={item.codigo}
                          onChange={e => setNfItems(prev => prev.map((it, i) => i === idx
                            ? { ...it, codigo: e.target.value, id_producto: null, notFound: false }
                            : it))}
                          onBlur={e => { if (e.target.value.trim()) buscarPorCodigo(idx, e.target.value.trim()) }}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (item.codigo.trim()) buscarPorCodigo(idx, item.codigo.trim()) } }}
                          placeholder="Código"
                          className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none font-mono"
                          style={{
                            width: 110,
                            borderColor: item.notFound ? '#fca5a5' : item.id_producto ? '#86efac' : '#e8edf8',
                          }}
                        />
                        {/* Nombre (auto-filled o manual) */}
                        <div className="flex-1 relative">
                          <input
                            value={item.nombre}
                            onChange={e => { setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, nombre: e.target.value, id_producto: null, notFound: false } : it)); buscarPorNombre(idx, e.target.value) }}
                            onBlur={() => setTimeout(() => setSugerencias(s => (s && s.idx === idx ? null : s)), 200)}
                            placeholder={item.buscando ? 'Buscando…' : 'Buscar por nombre o descripción…'}
                            disabled={item.buscando}
                            autoComplete="off"
                            className="w-full border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none"
                            style={{
                              borderColor: '#e8edf8',
                              background: item.id_producto ? '#f0fdf4' : 'white',
                              color: item.id_producto ? '#166534' : undefined,
                            }}
                          />
                          {sugerencias && sugerencias.idx === idx && (
                            <div className="absolute left-0 right-0 z-20 mt-1 rounded-lg border bg-white shadow-lg overflow-y-auto" style={{ borderColor: '#d6d6d6', maxHeight: 220 }}>
                              {sugerencias.lista.map(sg => (
                                <button key={sg.id} type="button" onMouseDown={e => { e.preventDefault(); elegirSugerencia(idx, sg) }}
                                  className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-gray-50" style={{ borderBottom: '1px solid #f3f3f3', opacity: sg.activo ? 1 : 0.55 }}>
                                  <span className="font-mono text-xs shrink-0" style={{ color: '#9ca3af', minWidth: 42 }}>{sg.id}</span>
                                  <span className="flex-1">{sg.nombre}</span>
                                  {!sg.activo && <span className="text-xs" style={{ color: '#b45309' }}>inactivo</span>}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Cantidad */}
                        <input type="number" min={1} value={item.cantidad}
                          onChange={e => setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, cantidad: parseInt(e.target.value) || 1 } : it))}
                          className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none text-center"
                          style={{ width: 72, borderColor: '#e8edf8' }} />
                        {nfItems.length > 1 && (
                          <button onClick={() => setNfItems(prev => prev.filter((_, i) => i !== idx))}
                            className="text-sm px-2 py-1.5 rounded shrink-0" style={{ color: '#B9BBB7' }}>×</button>
                        )}
                      </div>
                      {item.notFound && (
                        <p className="text-xs pl-1" style={{ color: '#dc2626' }}>⚠ Código no encontrado en catálogo — podés escribir el nombre manualmente</p>
                      )}
                      {item.id_producto && (
                        <p className="text-xs pl-1" style={{ color: '#16a34a' }}>✓ ID {item.id_producto}</p>
                      )}
                    </div>
                  ))}
                </div>
                <button onClick={() => setNfItems(prev => [...prev, { codigo: '', nombre: '', cantidad: 1, id_producto: null, buscando: false, notFound: false }])}
                  className="mt-2 text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: '#e8edf8', color: '#254A96' }}>+ Agregar producto</button>
              </div>
            </div>

            {/* Footer */}
            <div className="p-5 border-t flex gap-2" style={{ borderColor: '#e8edf8' }}>
              <button onClick={crearNueva} disabled={creando}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#10b981' }}>
                {creando ? 'Creando…' : 'Crear transferencia'}
              </button>
              <button onClick={() => setModalNueva(false)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}



// ═══════════════════════════════════════════════════════════════════════════════
// TAB: IMPORTAR
// ═══════════════════════════════════════════════════════════════════════════════
function TabImportar({ rol, showToast }: { rol: string; showToast: (msg: string, tipo?: 'ok' | 'err') => void }) {
  const [importandoStock, setImportandoStock] = useState(false)
  const [importandoSols, setImportandoSols] = useState(false)
  const [importandoCatalogo, setImportandoCatalogo] = useState(false)
  const [limpiandoSols, setLimpiandoSols] = useState(false)
  const [ultimoStock, setUltimoStock] = useState<string | null>(null)
  const [ultimoCatalogo, setUltimoCatalogo] = useState<{ importado_en: string | null; total: number; inactivos: number } | null>(null)
  const [resultSols, setResultSols] = useState<any>(null)
  const fileStockRef = useRef<HTMLInputElement>(null)
  const fileSolsRef = useRef<HTMLInputElement>(null)
  const fileCatalogRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/stock-import').then(r => r.json()).then(d => setUltimoStock(d.ultimo_import ?? null))
    fetch('/api/productos-catalogo').then(r => r.json()).then(d => setUltimoCatalogo(d))
  }, [])

  function fmtDate(iso: string | null) {
    if (!iso) return 'Nunca'
    const d = new Date(iso)
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  async function importarStock(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImportandoStock(true)
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch('/api/stock-import', { method: 'POST', body: fd })
    const data = await res.json()
    setImportandoStock(false)
    if (data.error) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`Stock importado: ${data.productos} productos, ${data.registros} registros`)
    setUltimoStock(data.actualizado_en)
    if (fileStockRef.current) fileStockRef.current.value = ''
  }

  async function importarSolicitudes(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImportandoSols(true)
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch('/api/solicitudes-import', { method: 'POST', body: fd })
    const data = await res.json()
    setImportandoSols(false)
    if (data.error) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`${data.total} solicitudes importadas (datos anteriores reemplazados)`)
    setResultSols(data)
    if (fileSolsRef.current) fileSolsRef.current.value = ''
  }

  async function limpiarSolicitudes() {
    if (!confirm('¿Borrar todos los datos de solicitudes importadas? Esta acción no se puede deshacer.')) return
    setLimpiandoSols(true)
    const res = await fetch('/api/solicitudes-import', { method: 'DELETE' })
    const data = await res.json()
    setLimpiandoSols(false)
    if (data.error) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast('Datos de solicitudes borrados')
    setResultSols(null)
  }

  async function importarCatalogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImportandoCatalogo(true)
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch('/api/productos-catalogo', { method: 'POST', body: fd })
    const data = await res.json()
    setImportandoCatalogo(false)
    if (data.error) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`Catálogo importado: ${data.total} productos (${data.inactivos} inactivos)`)
    fetch('/api/productos-catalogo').then(r => r.json()).then(d => setUltimoCatalogo(d))
    if (fileCatalogRef.current) fileCatalogRef.current.value = ''
  }

  return (
    <div className="px-4 md:px-6 py-4 max-w-2xl space-y-4">

      {/* Stock por sucursal */}
      <div className="bg-white rounded-xl p-5 border" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>📦 Stock por sucursal</h3>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Último import: {fmtDate(ultimoStock)}</p>
          </div>
          <button onClick={() => fileStockRef.current?.click()} disabled={importandoStock}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
            style={{ background: '#0f766e' }}>
            {importandoStock ? 'Importando…' : 'Importar Excel'}
          </button>
          <input ref={fileStockRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={importarStock} />
        </div>
        <p className="text-xs" style={{ color: '#B9BBB7' }}>
          Exportá el Excel de stock del ERP (hoja "Stock de Productos"). Se reemplaza el snapshot anterior.
        </p>
      </div>

      {/* Catálogo de productos */}
      <div className="bg-white rounded-xl p-5 border" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>🗂 Catálogo de productos</h3>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
              Último import: {fmtDate(ultimoCatalogo?.importado_en ?? null)}
              {ultimoCatalogo?.total ? ` · ${ultimoCatalogo.total} productos` : ''}
              {ultimoCatalogo?.inactivos ? ` · ` : ''}
              {ultimoCatalogo?.inactivos ? (
                <span style={{ color: '#b45309' }}>{ultimoCatalogo.inactivos} inactivos</span>
              ) : null}
            </p>
          </div>
          <button onClick={() => fileCatalogRef.current?.click()} disabled={importandoCatalogo}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
            style={{ background: '#7c3aed' }}>
            {importandoCatalogo ? 'Importando…' : 'Importar catálogo'}
          </button>
          <input ref={fileCatalogRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={importarCatalogo} />
        </div>
        <p className="text-xs" style={{ color: '#B9BBB7' }}>
          Exportá el Excel de productos del ERP (columnas requeridas: id, nombre, activo).
          Se usa para detectar productos inactivos en las solicitudes de despacho.
        </p>
      </div>

      {/* Solicitudes de despacho */}
      <div className="bg-white rounded-xl p-5 border" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-start justify-between gap-2 mb-3">
          <div>
            <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>📋 Solicitudes de despacho</h3>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Para verificar y cruzar con stock</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={limpiarSolicitudes} disabled={limpiandoSols || importandoSols}
              className="px-3 py-2 text-sm font-medium rounded-lg disabled:opacity-40"
              style={{ background: '#fde8e8', color: '#E52322' }}>
              {limpiandoSols ? 'Borrando…' : '🗑 Limpiar'}
            </button>
            <button onClick={() => fileSolsRef.current?.click()} disabled={importandoSols || limpiandoSols}
              className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
              style={{ background: '#254A96' }}>
              {importandoSols ? 'Procesando…' : 'Importar Excel'}
            </button>
          </div>
          <input ref={fileSolsRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={importarSolicitudes} />
        </div>
        <p className="text-xs" style={{ color: '#B9BBB7' }}>
          Exportá el Excel de solicitudes del ERP (hojas "Solicitudes de Despacho" e "items_solicitudes").
          Cada importación <strong>reemplaza</strong> todos los datos anteriores.
          Usá "🗑 Limpiar" para borrar sin importar.
        </p>
        {resultSols && (
          <div className="mt-4 rounded-lg p-3 flex gap-4 text-sm flex-wrap" style={{ background: '#f4f4f3' }}>
            <span><strong>{resultSols.total}</strong> <span style={{ color: '#666' }}>total</span></span>
            <span style={{ color: '#10b981' }}><strong>{resultSols.cargados_en_app}</strong> en app</span>
            <span style={{ color: resultSols.no_cargados > 0 ? '#E52322' : '#B9BBB7' }}>
              <strong>{resultSols.no_cargados}</strong> sin cargar en app
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: PREPARACIÓN — lista de productos a preparar por fecha/sucursal
// ═══════════════════════════════════════════════════════════════════════════════
type PickingItem = { nombre: string; cantidad: number; unidad: string; codigo_material?: string | null }
type PickingPedido = { id?: string; estado?: string; nv: string | number; cliente: string; direccion: string; sucursal: string; fecha_entrega: string; camion_id: string; vuelta: number; items: PickingItem[] }

function TabPreparacion({ rol, userId, userNombre, miSucursal, showToast }: {
  rol: string; userId: string; userNombre: string; miSucursal: string | null
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [fechaDesde, setFechaDesde] = useState(hoy())
  const [fechaHasta, setFechaHasta] = useState(hoy())
  const [sucursal, setSucursal] = useState(miSucursal && SUCURSALES.includes(miSucursal) && rol === 'deposito' ? miSucursal : '')
  const [productos, setProductos] = useState<PickingItem[]>([])
  const [retiros, setRetiros] = useState<{ id: string; nv: number; cliente: string; direccion: string; sucursal: string; fecha_entrega: string; items: PickingItem[] }[]>([])
  const [pedidosDetalle, setPedidosDetalle] = useState<PickingPedido[]>([])
  const [pedidosCount, setPedidosCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [exportando, setExportando] = useState(false)
  const [error, setError] = useState('')
  const [cargado, setCargado] = useState(false)

  function fmtLabel(iso: string) {
    const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`
  }

  async function buscar() {
    if (!fechaDesde || !fechaHasta) return
    setLoading(true); setError(''); setCargado(false); setProductos([]); setRetiros([]); setPedidosDetalle([])
    try {
      const params = new URLSearchParams({ fecha_desde: fechaDesde, fecha_hasta: fechaHasta })
      if (sucursal) params.set('sucursal', sucursal)
      const res = await fetch(`/api/picking-list?${params}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Error al cargar')
      setProductos(json.productos ?? [])
      setRetiros(json.retiros ?? [])
      setPedidosDetalle(json.pedidos_detalle ?? [])
      setPedidosCount(json.pedidos_count ?? 0)
      setCargado(true)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function exportarExcel() {
    if (!cargado || productos.length === 0) return
    setExportando(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      const fechaLabel = fechaDesde === fechaHasta ? fechaDesde : `${fechaDesde}_${fechaHasta}`

      // Hoja 1: Totales
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        productos.map(p => ({ 'ID Producto': p.codigo_material ?? '', 'Producto': p.nombre, 'Cantidad': p.cantidad, 'Unidad': p.unidad }))
      ), 'Totales')

      // Hoja 2: Por pedido
      const filasPorPedido: Record<string, string | number>[] = []
      for (const ped of pedidosDetalle) {
        for (const item of ped.items) {
          filasPorPedido.push({
            'NV': ped.nv,
            'Cliente': ped.cliente,
            'Dirección': ped.direccion,
            'Sucursal': ped.sucursal,
            'Fecha': ped.fecha_entrega,
            'Camión': ped.camion_id,
            'Vuelta': ped.vuelta === 0 ? 'Sin asignar' : `V${ped.vuelta}`,
            'ID Producto': item.codigo_material ?? '',
            'Producto': item.nombre,
            'Cantidad': item.cantidad,
            'Unidad': item.unidad,
          })
        }
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(filasPorPedido), 'Por pedido')

      const suf = sucursal ? `-${sucursal}` : ''
      XLSX.writeFile(wb, `preparacion-${fechaLabel}${suf}.xlsx`)
    } catch (e: any) {
      setError(`Error al exportar: ${e.message}`)
    }
    setExportando(false)
  }

  async function descargarPDF() {
    if (!cargado || productos.length === 0) return
    const { jsPDF } = await import('jspdf') as { jsPDF: typeof JsPDFType }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const PW = 210; const PH = 297
    const ML = 15; const MR = 15; const MT = 15

    const fechaLabel = fechaDesde === fechaHasta
      ? fmtLabel(fechaDesde)
      : `${fmtLabel(fechaDesde)} al ${fmtLabel(fechaHasta)}`

    // Header azul
    doc.setFillColor(37, 74, 150)
    doc.rect(0, 0, PW, 32, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.text('Lista de Preparación', ML, 13)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.text(`Fecha: ${fechaLabel}  |  Sucursal: ${sucursal || 'Todas'}  |  Pedidos: ${pedidosCount}`, ML, 22)
    doc.text('Construyo al Costo', PW - MR, 22, { align: 'right' })

    // Tabla
    const colX = [ML, ML + 28, ML + 128, ML + 156]
    const colW = [28, 100, 28, 24]
    const ROW_H = 8
    let y = MT + 32 + 6

    // Encabezado tabla
    doc.setFillColor(232, 237, 248)
    doc.rect(ML, y, PW - ML - MR, ROW_H, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(37, 74, 150)
    doc.text('Código', colX[0] + 2, y + 5.5)
    doc.text('Material', colX[1] + 2, y + 5.5)
    doc.text('Cantidad', colX[2] + 2, y + 5.5)
    doc.text('Unidad', colX[3] + 2, y + 5.5)
    y += ROW_H

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8.5)
    productos.forEach((p, i) => {
      if (y > PH - 30) {
        doc.addPage()
        y = MT
        // mini-header en página adicional
        doc.setFillColor(37, 74, 150)
        doc.rect(0, 0, PW, 10, 'F')
        doc.setTextColor(255, 255, 255)
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8)
        doc.text(`Lista de Preparación — ${fechaLabel.replace(' al ', '→')} — ${sucursal || 'Todas'} (cont.)`, ML, 7)
        y = 14
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(8.5)
      }
      const bg = i % 2 === 0 ? [255, 255, 255] : [248, 249, 252]
      doc.setFillColor(bg[0], bg[1], bg[2])
      doc.rect(ML, y, PW - ML - MR, ROW_H, 'F')
      doc.setTextColor(30, 30, 30)
      doc.setTextColor(90, 90, 90)
      doc.text(String(p.codigo_material ?? '—').slice(0, 14), colX[0] + 2, y + 5.5)
      doc.setTextColor(30, 30, 30)
      doc.text(doc.splitTextToSize(p.nombre, colW[1] - 3)[0] as string, colX[1] + 2, y + 5.5)
      doc.setFont('helvetica', 'bold')
      doc.text(String(p.cantidad), colX[2] + 2, y + 5.5)
      doc.setFont('helvetica', 'normal')
      doc.text(p.unidad ?? 'u', colX[3] + 2, y + 5.5)
      y += ROW_H
    })

    // Línea separadora + total productos
    doc.setDrawColor(200, 200, 200)
    doc.line(ML, y, PW - MR, y)
    y += 6
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(37, 74, 150)
    doc.text(`Total líneas: ${productos.length}   |   Total pedidos: ${pedidosCount}`, ML, y)
    y += 10

    // Sección retiros
    if (retiros.length > 0) {
      if (y > PH - 60) { doc.addPage(); y = MT }
      // Título sección
      doc.setFillColor(229, 35, 34)
      doc.rect(ML, y, PW - ML - MR, 8, 'F')
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(9)
      doc.setTextColor(255, 255, 255)
      doc.text(`🔴  RETIRAR DE CLIENTES — ${retiros.length} pedido${retiros.length !== 1 ? 's' : ''}`, ML + 2, y + 5.5)
      y += 10

      retiros.forEach((ret, ri) => {
        if (y > PH - 40) {
          doc.addPage(); y = MT
          doc.setFillColor(37, 74, 150)
          doc.rect(0, 0, PW, 10, 'F')
          doc.setTextColor(255, 255, 255)
          doc.setFont('helvetica', 'bold')
          doc.setFontSize(8)
          doc.text(`Retiros — ${fechaLabel} (cont.)`, ML, 7)
          y = 14
        }
        const bgRet = ri % 2 === 0 ? [255, 245, 245] : [255, 255, 255]
        const retH = 7 + Math.min(ret.items.length, 5) * 5.5
        doc.setFillColor(bgRet[0], bgRet[1], bgRet[2])
        doc.rect(ML, y, PW - ML - MR, retH, 'F')
        doc.setFont('helvetica', 'bold')
        doc.setFontSize(8.5)
        doc.setTextColor(180, 20, 20)
        doc.text(`NV ${ret.nv}  ${ret.cliente}`, ML + 2, y + 5)
        doc.setFont('helvetica', 'normal')
        doc.setFontSize(7.5)
        doc.setTextColor(80, 80, 80)
        doc.text(ret.direccion || 'Sin dirección', ML + 2, y + 10)
        let iy = y + 15
        ret.items.slice(0, 5).forEach(item => {
          doc.setTextColor(40, 40, 40)
          doc.text(`• ${item.codigo_material ? item.codigo_material + '  ' : ''}${item.nombre}  ${item.cantidad} ${item.unidad}`, ML + 4, iy)
          iy += 5.5
        })
        if (ret.items.length > 5) {
          doc.setTextColor(150, 150, 150)
          doc.text(`  …y ${ret.items.length - 5} más`, ML + 4, iy)
        }
        y += retH + 3
      })
    }

    // Footer
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(7)
    doc.setTextColor(150, 150, 150)
    const now = new Date()
    doc.text(
      `Generado el ${now.toLocaleDateString('es-AR')} a las ${now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`,
      PW / 2, PH - 8, { align: 'center' }
    )

    const nombreArchivo = fechaDesde === fechaHasta
      ? `preparacion_${fechaDesde}${sucursal ? '_' + sucursal : ''}.pdf`
      : `preparacion_${fechaDesde}_${fechaHasta}${sucursal ? '_' + sucursal : ''}.pdf`
    doc.save(nombreArchivo)
  }

  const totalUnidades = productos.reduce((s, p) => s + p.cantidad, 0)

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h2 className="text-lg font-semibold mb-1" style={{ color: '#254A96' }}>Lista de preparación</h2>
        <p className="text-sm" style={{ color: '#B9BBB7' }}>
          Total de unidades a despachar por producto en una fecha dada.
        </p>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-xl border p-4 mb-5 flex flex-wrap gap-3 items-end" style={{ borderColor: '#e8edf8' }}>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Desde</label>
          <input type="date" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            style={{ borderColor: '#e8edf8', color: '#254A96', fontWeight: 600 }} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Hasta</label>
          <input type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            style={{ borderColor: '#e8edf8', color: '#254A96', fontWeight: 600 }} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Sucursal</label>
          <select value={sucursal} onChange={e => setSucursal(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm"
            style={{ borderColor: '#e8edf8', color: '#333' }}>
            <option value="">Todas</option>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <button onClick={buscar} disabled={loading || !fechaDesde || !fechaHasta}
          className="px-5 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
          style={{ background: '#254A96' }}>
          {loading ? 'Buscando…' : 'Buscar'}
        </button>
        {cargado && (productos.length > 0 || retiros.length > 0) && (
          <>
            <button onClick={descargarPDF}
              className="px-5 py-2 text-sm font-medium rounded-lg"
              style={{ background: '#e8edf8', color: '#254A96' }}>
              ⬇ Descargar PDF
            </button>
            <button onClick={exportarExcel} disabled={exportando}
              className="px-5 py-2 text-sm font-medium rounded-lg disabled:opacity-40"
              style={{ background: '#d1fae5', color: '#065f46' }}>
              {exportando ? 'Exportando…' : '⬇ Exportar Excel'}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="rounded-lg px-4 py-3 mb-4 text-sm" style={{ background: '#fde8e8', color: '#E52322' }}>{error}</div>
      )}

      {cargado && (
        <>
          <div className="flex items-center gap-4 mb-3">
            <span className="text-sm font-medium" style={{ color: '#254A96' }}>
              {productos.length} producto{productos.length !== 1 ? 's' : ''} — {pedidosCount} pedido{pedidosCount !== 1 ? 's' : ''}
            </span>
            {totalUnidades > 0 && (
              <span className="text-xs" style={{ color: '#B9BBB7' }}>{totalUnidades.toLocaleString('es-AR')} unidades totales</span>
            )}
          </div>

          {sucursal ? (
            <ValidacionPrepView pedidos={pedidosDetalle as any} sucursal={sucursal} desde={fechaDesde} hasta={fechaHasta}
              puedeValidar={['deposito', 'gerencia', 'admin_flota'].includes(rol)} userId={userId} userNombre={userNombre} showToast={showToast} />
          ) : (
            <>
              <p className="text-xs mb-3" style={{ color: '#6b7280' }}>Elegí una sucursal para validar lo que hay físicamente, día por día.</p>
          {productos.length === 0 ? (
              <div className="bg-white rounded-xl border p-8 text-center" style={{ borderColor: '#e8edf8' }}>
                <p className="text-sm" style={{ color: '#B9BBB7' }}>No hay pedidos con ítems para ese período.</p>
              </div>
            ) : (
              <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: '#e8edf8' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: '#e8edf8' }}>
                      <th className="text-left px-4 py-3 font-semibold text-xs" style={{ color: '#254A96' }}>Código</th>
                      <th className="text-left px-4 py-3 font-semibold text-xs" style={{ color: '#254A96' }}>Material</th>
                      <th className="text-right px-4 py-3 font-semibold text-xs" style={{ color: '#254A96' }}>Cantidad</th>
                      <th className="text-left px-4 py-3 font-semibold text-xs" style={{ color: '#254A96' }}>Unidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {productos.map((p, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? '#fff' : '#f9fafc', borderTop: '1px solid #f0f0f0' }}>
                        <td className="px-4 py-2.5 font-mono text-xs whitespace-nowrap" style={{ color: p.codigo_material ? '#4b5563' : '#d1d5db' }}>{p.codigo_material ?? '—'}</td>
                        <td className="px-4 py-2.5" style={{ color: '#1e1e1e' }}>{p.nombre}</td>
                        <td className="px-4 py-2.5 text-right font-semibold" style={{ color: '#254A96' }}>
                          {p.cantidad.toLocaleString('es-AR')}
                        </td>
                        <td className="px-4 py-2.5" style={{ color: '#666' }}>{p.unidad ?? 'u'}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#e8edf8', borderTop: '2px solid #d4dbef' }}>
                      <td className="px-4 py-2.5" />
                      <td className="px-4 py-2.5 font-semibold text-xs" style={{ color: '#254A96' }}>TOTAL</td>
                      <td className="px-4 py-2.5 text-right font-bold" style={{ color: '#254A96' }}>
                        {totalUnidades.toLocaleString('es-AR')}
                      </td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: '#B9BBB7' }}>unidades</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            </>
          )}

          {/* Sección retiros */}
          {retiros.length > 0 && (
            <div className="mt-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1" style={{ background: '#fca5a5' }} />
                <span className="text-xs font-bold px-3 py-1 rounded-full" style={{ background: '#fde8e8', color: '#E52322' }}>
                  🔴 RETIRAR DE CLIENTES — {retiros.length} pedido{retiros.length !== 1 ? 's' : ''}
                </span>
                <div className="h-px flex-1" style={{ background: '#fca5a5' }} />
              </div>
              <div className="space-y-2">
                {retiros.map((ret, i) => (
                  <div key={ret.id} className="bg-white rounded-xl border overflow-hidden"
                    style={{ borderColor: '#fca5a5', borderLeftWidth: 4, borderLeftColor: '#E52322' }}>
                    <div className="px-4 py-2.5 flex items-start justify-between gap-2" style={{ background: '#fff5f5' }}>
                      <div>
                        <span className="font-semibold text-sm" style={{ color: '#E52322' }}>NV {ret.nv}</span>
                        <span className="ml-2 text-sm font-medium" style={{ color: '#1e1e1e' }}>{ret.cliente}</span>
                        {ret.sucursal && <span className="ml-2 text-xs" style={{ color: '#B9BBB7' }}>{ret.sucursal}</span>}
                      </div>
                      {ret.fecha_entrega && (
                        <span className="text-xs shrink-0" style={{ color: '#B9BBB7' }}>{fmtLabel(ret.fecha_entrega)}</span>
                      )}
                    </div>
                    {ret.direccion && (
                      <div className="px-4 py-1.5 text-xs" style={{ color: '#666', borderTop: '1px solid #fee2e2' }}>
                        📍 {ret.direccion}
                      </div>
                    )}
                    {ret.items.length > 0 && (
                      <div className="px-4 py-2 border-t" style={{ borderColor: '#fee2e2' }}>
                        {ret.items.map((item, j) => (
                          <div key={j} className="flex items-center gap-2 py-0.5 text-sm">
                            <span style={{ color: '#999' }}>•</span>
                            {item.codigo_material && <span className="font-mono text-xs" style={{ color: '#9ca3af' }}>{item.codigo_material}</span>}
                            <span className="flex-1" style={{ color: '#333' }}>{item.nombre}</span>
                            <span className="font-semibold" style={{ color: '#E52322' }}>{item.cantidad}</span>
                            <span className="text-xs" style={{ color: '#B9BBB7' }}>{item.unidad}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {!cargado && !loading && (
        <div className="bg-white rounded-xl border p-10 text-center" style={{ borderColor: '#e8edf8' }}>
          <p className="text-sm" style={{ color: '#B9BBB7' }}>Seleccioná una fecha y hacé clic en Buscar.</p>
        </div>
      )}
    </div>
  )
}
