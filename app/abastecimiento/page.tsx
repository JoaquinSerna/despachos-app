'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/app/supabase'
import { tieneAcceso } from '@/app/lib/permisos'

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
type DecisionTipo = 'aprobado' | 'reasignado' | 'rechazado' | ''
interface ItemDecision { tipo: DecisionTipo; sucursal_asignada: string }

interface SdItem {
  id_producto: number
  nombre_producto: string
  categoria: string
  subcategoria: string
  cantidad_solicitada: number
  cantidad_entregada: number
  hojas_de_ruta: string
}
interface SdSolicitud {
  id: number
  fecha_despacho: string | null
  horario: string
  prioridad: string
  estado: string
  id_venta: number
  cliente: string
  destino: string
  direccion: string
  sucursal: string   // sucursal_origen normalizada
  items: SdItem[]
}

interface CatalogoEntry { id: number; nombre: string; activo: boolean }
// stock[id_producto][sucursal] = cantidad
type StockMap = Record<number, Record<string, number>>
// decisions[solId] = sol-level; decisions[`${solId}|${prodId}`] = item-level override
type DecisionsMap = Record<string, ItemDecision>

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
  created_at: string
  requerimiento_items: ReqItem[]
}

// ─── Helpers de decisión ───────────────────────────────────────────────────────
/** Decide automáticamente basado en stock disponible */
function autoSuggest(item: SdItem, sucursalOrigen: string, stock: StockMap): ItemDecision {
  const stockProd = stock[item.id_producto] ?? {}
  const stockOrigen = stockProd[sucursalOrigen] ?? 0

  if (stockOrigen >= item.cantidad_solicitada) {
    return { tipo: 'aprobado', sucursal_asignada: sucursalOrigen }
  }

  // Buscar otra sucursal con más stock
  const alternatives = Object.entries(stockProd)
    .filter(([s]) => s !== sucursalOrigen)
    .sort(([, a], [, b]) => (b as number) - (a as number))

  if (alternatives.length > 0 && (alternatives[0][1] as number) >= item.cantidad_solicitada) {
    return { tipo: 'reasignado', sucursal_asignada: alternatives[0][0] }
  }

  // Sin stock suficiente en ninguna sucursal → aprobar igual (operador decide)
  return { tipo: 'aprobado', sucursal_asignada: sucursalOrigen }
}

/** Obtiene la decisión efectiva para un item (item-level override > sol-level) */
function getDecision(decisions: DecisionsMap, solId: number, prodId: number): ItemDecision {
  const itemKey = `${solId}|${prodId}`
  if (decisions[itemKey]?.tipo) return decisions[itemKey]
  const solKey = `${solId}`
  if (decisions[solKey]?.tipo) return decisions[solKey]
  return { tipo: '', sucursal_asignada: '' }
}

/** Estado general de una solicitud (para el badge) */
function estadoGeneral(sol: SdSolicitud, decisions: DecisionsMap): 'sinverif' | 'aprobado' | 'reasignado' | 'rechazado' | 'mixto' {
  const tipos = sol.items.map(it => getDecision(decisions, sol.id, it.id_producto).tipo)
  const unique = new Set(tipos)
  if (unique.has('rechazado') && unique.size === 1) return 'rechazado'
  if (unique.has('') ) return 'sinverif'
  if (unique.size === 1) return unique.values().next().value as any
  return 'mixto'
}

// ─── Estilos de estado ─────────────────────────────────────────────────────────
const DECISION_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  aprobado:  { bg: '#d1fae5', color: '#065f46', label: 'Aprobado' },
  reasignado:{ bg: '#fef3c7', color: '#b45309', label: 'Reasignado' },
  rechazado: { bg: '#fde8e8', color: '#E52322', label: 'Rechazado' },
  sinverif:  { bg: '#f4f4f3', color: '#B9BBB7', label: 'Sin verificar' },
  mixto:     { bg: '#e8edf8', color: '#254A96', label: 'Mixto' },
}

const ESTADO_LABEL: Record<string, string> = {
  pendiente:   'Pendiente',
  conf_stock:  'Conf. Stock',
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
function BadgeDecision({ tipo }: { tipo: string }) {
  const s = DECISION_STYLE[tipo] ?? DECISION_STYLE['sinverif']
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium"
      style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

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
  const [tab, setTab] = useState<'verificacion' | 'transferencias' | 'transito' | 'historial' | 'importar'>('verificacion')
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol, email, permisos').eq('id', user.id).single()
      const r = data?.rol ?? ''
      if (!tieneAcceso(data?.permisos, r, 'abastecimiento')) { router.push('/dashboard'); return }
      setRol(r)
      setUserEmail(data?.email ?? user.email ?? '')
    })
  }, [])

  const TABS = [
    { key: 'verificacion',   label: '📋 Verificación SD' },
    { key: 'transferencias', label: 'Transferencias' },
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
            <button onClick={() => router.push('/dashboard')}
              className="text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</button>
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
        {tab === 'verificacion' && (
          <TabVerificacion rol={rol} userEmail={userEmail} showToast={showToast} />
        )}
        {tab === 'transferencias' && (
          <TabRequerimientos filtroEstados={['pendiente', 'conf_stock', 'preparacion']} rol={rol} showToast={showToast} />
        )}
        {tab === 'transito' && (
          <TabRequerimientos filtroEstados={['en_transito']} rol={rol} showToast={showToast} />
        )}
        {tab === 'historial' && (
          <TabRequerimientos filtroEstados={['entregado', 'rechazado']} rol={rol} showToast={showToast} />
        )}
        {tab === 'importar' && (
          <TabImportar rol={rol} showToast={showToast} />
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: VERIFICACIÓN SD
// ═══════════════════════════════════════════════════════════════════════════════
function TabVerificacion({ rol, userEmail, showToast }: {
  rol: string; userEmail: string; showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [fecha, setFecha] = useState(hoy())
  const [solicitudes, setSolicitudes] = useState<SdSolicitud[]>([])
  const [stock, setStock] = useState<StockMap>({})
  const [catalogo, setCatalogo] = useState<Record<number, CatalogoEntry>>({})
  const [decisions, setDecisions] = useState<DecisionsMap>({})
  const [fechasDeadline, setFechasDeadline] = useState<Record<string, string>>({}) // key: `${solId}|${effBranch}` → deadline override
  const [loading, setLoading] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const [expandidos, setExpandidos] = useState<Set<number>>(new Set())
  const [filtroSucursal, setFiltroSucursal] = useState('')
  const [solFechasDisp, setSolFechasDisp] = useState<string[]>([])

  // Cargar fechas disponibles en solicitudes importadas
  useEffect(() => {
    supabase.from('solicitudes_importadas')
      .select('fecha_despacho')
      .order('fecha_despacho', { ascending: false })
      .limit(60)
      .then(({ data }) => {
        const unique = [...new Set((data ?? []).map((r: any) => r.fecha_despacho).filter(Boolean))]
        setSolFechasDisp(unique)
        if (!unique.includes(fecha) && unique.length > 0) setFecha(unique[0])
      })
  }, [])

  // Cargar solicitudes cuando cambia la fecha
  useEffect(() => { if (fecha) cargarSolicitudes() }, [fecha, filtroSucursal])

  async function cargarSolicitudes() {
    setLoading(true)
    try {
      // 1. Solicitudes de la fecha
      let q = supabase
        .from('solicitudes_importadas')
        .select('*')
        .eq('fecha_despacho', fecha)
        .order('id')
      if (filtroSucursal) q = q.eq('sucursal', filtroSucursal)
      const { data: sols } = await q

      if (!sols?.length) {
        setSolicitudes([])
        setLoading(false)
        return
      }

      const solIds = sols.map((s: any) => s.id)

      // 2. Items
      const { data: itemsRaw } = await supabase
        .from('solicitudes_importadas_items')
        .select('*')
        .in('id_solicitud', solIds)

      // 3. Stock
      const prodIds = [...new Set((itemsRaw ?? []).map((it: any) => it.id_producto).filter(Boolean))]
      const stockMap: StockMap = {}
      if (prodIds.length > 0) {
        const { data: stockRaw } = await supabase
          .from('stock_sucursal')
          .select('id_producto, sucursal, cantidad')
          .in('id_producto', prodIds)
        for (const s of stockRaw ?? []) {
          if (!stockMap[s.id_producto]) stockMap[s.id_producto] = {}
          stockMap[s.id_producto][s.sucursal] = s.cantidad
        }
      }
      setStock(stockMap)

      // 4. Catálogo (activo flag)
      if (prodIds.length > 0) {
        const res = await fetch(`/api/productos-catalogo?ids=${prodIds.join(',')}`)
        if (res.ok) {
          const catRaw: CatalogoEntry[] = await res.json()
          const catMap: Record<number, CatalogoEntry> = {}
          for (const c of catRaw) catMap[c.id] = c
          setCatalogo(catMap)
        }
      }

      // 5. Decisiones existentes
      const res = await fetch(`/api/sd-decisiones?fecha=${fecha}`)
      const decRaw: any[] = res.ok ? await res.json() : []
      const decMap: DecisionsMap = {}
      for (const d of decRaw) {
        const key = d.id_producto ? `${d.id_solicitud}|${d.id_producto}` : `${d.id_solicitud}`
        decMap[key] = { tipo: d.tipo, sucursal_asignada: d.sucursal_asignada }
      }

      // 6. Construir solicitudes con items
      const itemsBySol: Record<number, SdItem[]> = {}
      for (const it of (itemsRaw ?? [])) {
        if (!itemsBySol[it.id_solicitud]) itemsBySol[it.id_solicitud] = []
        itemsBySol[it.id_solicitud].push({
          id_producto: it.id_producto,
          nombre_producto: it.nombre_producto ?? '',
          categoria: it.categoria ?? '',
          subcategoria: it.subcategoria ?? '',
          cantidad_solicitada: it.cantidad_solicitada ?? 0,
          cantidad_entregada: it.cantidad_entregada ?? 0,
          hojas_de_ruta: it.hojas_de_ruta ?? '',
        })
      }

      const solsConItems: SdSolicitud[] = sols.map((s: any) => ({
        id: s.id,
        fecha_despacho: s.fecha_despacho,
        horario: s.horario ?? '',
        prioridad: s.prioridad ?? '',
        estado: s.estado ?? '',
        id_venta: s.id_venta,
        cliente: s.cliente ?? '',
        destino: s.destino ?? '',
        direccion: s.direccion ?? '',
        sucursal: s.sucursal ?? '',
        items: itemsBySol[s.id] ?? [],
      }))

      setSolicitudes(solsConItems)

      // 7. Auto-sugerencias para los que no tienen decisión
      const newDec = { ...decMap }
      for (const sol of solsConItems) {
        for (const item of sol.items) {
          if (item.nombre_producto === 'Transporte por km') continue
          const existeKey = `${sol.id}|${item.id_producto}`
          const existeSolKey = `${sol.id}`
          if (!newDec[existeKey] && !newDec[existeSolKey]) {
            const sug = autoSuggest(item, sol.sucursal, stockMap)
            newDec[existeKey] = sug
          }
        }
      }
      setDecisions(newDec)

      // 8. Inicializar fechas de deadline
      const dl: Record<string, string> = {}
      for (const sol of solsConItems) {
        const branches = new Set<string>()
        for (const item of sol.items) {
          const dec = newDec[`${sol.id}|${item.id_producto}`] ?? newDec[`${sol.id}`]
          if (dec?.tipo === 'reasignado' && dec.sucursal_asignada && dec.sucursal_asignada !== sol.sucursal) {
            branches.add(dec.sucursal_asignada)
          }
        }
        for (const branch of branches) {
          const key = `${sol.id}|${branch}`
          if (!dl[key]) {
            dl[key] = calcDeadline(branch, sol.sucursal, sol.fecha_despacho ?? '').date
          }
        }
      }
      setFechasDeadline(dl)

    } catch (e: any) {
      showToast(`Error cargando solicitudes: ${e.message}`, 'err')
    }
    setLoading(false)
  }

  function setDecision(solId: number, prodId: number | null, dec: ItemDecision) {
    const key = prodId ? `${solId}|${prodId}` : `${solId}`
    setDecisions(prev => ({ ...prev, [key]: dec }))

    // Si es reasignado, inicializar deadline
    if (dec.tipo === 'reasignado' && dec.sucursal_asignada) {
      const sol = solicitudes.find(s => s.id === solId)
      if (sol) {
        const dlKey = `${solId}|${dec.sucursal_asignada}`
        setFechasDeadline(prev => {
          if (prev[dlKey]) return prev
          return { ...prev, [dlKey]: calcDeadline(dec.sucursal_asignada, sol.sucursal, sol.fecha_despacho ?? '').date }
        })
      }
    }
  }

  function toggleExpand(solId: number) {
    setExpandidos(prev => {
      const s = new Set(prev)
      if (s.has(solId)) s.delete(solId)
      else s.add(solId)
      return s
    })
  }

  function expandirTodas() {
    setExpandidos(new Set(solicitudes.map(s => s.id)))
  }
  function colapsarTodas() {
    setExpandidos(new Set())
  }

  function aprobarTodas() {
    const newDec = { ...decisions }
    for (const sol of solicitudes) {
      newDec[`${sol.id}`] = { tipo: 'aprobado', sucursal_asignada: sol.sucursal }
    }
    setDecisions(newDec)
  }

  async function confirmar() {
    const sinVerif = solicitudes.filter(sol => estadoGeneral(sol, decisions) === 'sinverif')
    if (sinVerif.length > 0) {
      showToast(`Hay ${sinVerif.length} solicitudes sin verificar`, 'err')
      return
    }

    setConfirmando(true)
    try {
      // 1. Guardar decisiones
      const decToSave: any[] = []
      for (const sol of solicitudes) {
        const solDec = decisions[`${sol.id}`]
        if (solDec) {
          decToSave.push({
            id_solicitud: sol.id,
            id_producto: null,
            tipo: solDec.tipo,
            sucursal_asignada: solDec.sucursal_asignada,
            fecha_sd: sol.fecha_despacho,
            operador: userEmail,
          })
        }
        for (const item of sol.items) {
          const itemDec = decisions[`${sol.id}|${item.id_producto}`]
          if (itemDec) {
            decToSave.push({
              id_solicitud: sol.id,
              id_producto: item.id_producto,
              tipo: itemDec.tipo,
              sucursal_asignada: itemDec.sucursal_asignada,
              fecha_sd: sol.fecha_despacho,
              operador: userEmail,
            })
          }
        }
      }

      const savedRes = await fetch('/api/sd-decisiones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: decToSave }),
      })
      if (!savedRes.ok) throw new Error('Error guardando decisiones')

      // 2. Crear requerimientos para los reasignados
      // Agrupar por (id_solicitud, branch_origen_transfer) → un requerimiento por grupo
      const reqGrupos: Map<string, {
        sol: SdSolicitud; fromBranch: string; items: { nombre: string; id_producto: number; cantidad: number }[]
      }> = new Map()

      for (const sol of solicitudes) {
        for (const item of sol.items) {
          if (item.nombre_producto === 'Transporte por km') continue
          const dec = getDecision(decisions, sol.id, item.id_producto)
          if (dec.tipo !== 'reasignado' || !dec.sucursal_asignada || dec.sucursal_asignada === sol.sucursal) continue

          const key = `${sol.id}|${dec.sucursal_asignada}`
          if (!reqGrupos.has(key)) {
            reqGrupos.set(key, { sol, fromBranch: dec.sucursal_asignada, items: [] })
          }
          reqGrupos.get(key)!.items.push({
            nombre: item.nombre_producto,
            id_producto: item.id_producto,
            cantidad: item.cantidad_solicitada,
          })
        }
      }

      let reqCreados = 0
      for (const [, grupo] of reqGrupos) {
        const { sol, fromBranch } = grupo
        const dlKey = `${sol.id}|${fromBranch}`
        const fechaSolicitada = fechasDeadline[dlKey] || calcDeadline(fromBranch, sol.sucursal, sol.fecha_despacho ?? '').date

        const body = {
          tipo: 'abastecimiento',
          nv: String(sol.id_venta),
          cliente: sol.cliente,
          sucursal_origen: fromBranch,
          sucursal_destino: sol.sucursal,
          estado: 'pendiente',
          fecha_req: hoy(),
          fecha_solicitada: fechaSolicitada || null,
          solicitado_por: userEmail,
          notas: `Generado desde SD #${sol.id} — despacho ${fmtFecha(sol.fecha_despacho)}`,
          items: grupo.items.map(it => ({
            id_producto: it.id_producto,
            nombre_producto: it.nombre,
            cantidad_solicitada: it.cantidad,
          })),
        }

        const res = await fetch('/api/requerimientos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const err = await res.json()
          throw new Error(err.error ?? 'Error creando requerimiento')
        }
        reqCreados++
      }

      showToast(`✓ ${decToSave.length} decisiones guardadas${reqCreados > 0 ? ` · ${reqCreados} transferencias generadas` : ''}`)
    } catch (e: any) {
      showToast(`Error: ${e.message}`, 'err')
    }
    setConfirmando(false)
  }

  // Stats resumen
  const totalSols = solicitudes.length
  const aprobadas = solicitudes.filter(s => estadoGeneral(s, decisions) === 'aprobado').length
  const reasignadas = solicitudes.filter(s => {
    const eg = estadoGeneral(s, decisions)
    return eg === 'reasignado' || eg === 'mixto'
  }).length
  const rechazadas = solicitudes.filter(s => estadoGeneral(s, decisions) === 'rechazado').length
  const sinVerif = solicitudes.filter(s => estadoGeneral(s, decisions) === 'sinverif').length

  const solsFiltradas = filtroSucursal
    ? solicitudes.filter(s => s.sucursal === filtroSucursal)
    : solicitudes

  return (
    <div className="px-4 md:px-6 py-4 max-w-5xl">

      {/* Barra superior: fecha + filtros */}
      <div className="bg-white rounded-xl border px-4 py-3 mb-4 flex items-center gap-3 flex-wrap" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium" style={{ color: '#254A96' }}>Fecha despacho</label>
          {solFechasDisp.length > 0 ? (
            <select value={fecha} onChange={e => setFecha(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
              {solFechasDisp.map(d => (
                <option key={d} value={d}>{fmtFecha(d)}</option>
              ))}
            </select>
          ) : (
            <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
          )}
        </div>
        <select value={filtroSucursal} onChange={e => setFiltroSucursal(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
          <option value="">Todas las sucursales</option>
          {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        {totalSols > 0 && (
          <div className="flex items-center gap-3 ml-auto text-xs flex-wrap">
            <span style={{ color: '#B9BBB7' }}>{totalSols} sol.</span>
            {aprobadas > 0 && <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: '#d1fae5', color: '#065f46' }}>✓ {aprobadas} aprobadas</span>}
            {reasignadas > 0 && <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: '#fef3c7', color: '#b45309' }}>↗ {reasignadas} reasignadas</span>}
            {rechazadas > 0 && <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>✕ {rechazadas} rechazadas</span>}
            {sinVerif > 0 && <span className="px-2 py-0.5 rounded-full font-medium" style={{ background: '#f4f4f3', color: '#B9BBB7' }}>? {sinVerif} sin verifif.</span>}
          </div>
        )}
      </div>

      {/* Acciones masivas */}
      {totalSols > 0 && (
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <button onClick={expandirTodas}
            className="px-3 py-1.5 text-xs rounded-lg border"
            style={{ borderColor: '#e8edf8', color: '#666' }}>
            Expandir todas
          </button>
          <button onClick={colapsarTodas}
            className="px-3 py-1.5 text-xs rounded-lg border"
            style={{ borderColor: '#e8edf8', color: '#666' }}>
            Colapsar todas
          </button>
          <button onClick={aprobarTodas}
            className="px-3 py-1.5 text-xs rounded-lg border font-medium"
            style={{ borderColor: '#bbf7d0', color: '#065f46', background: '#f0fdf4' }}>
            ✓ Aprobar todas
          </button>
          <div className="flex-1" />
          <button
            onClick={confirmar}
            disabled={confirmando || totalSols === 0 || sinVerif > 0}
            className="px-5 py-2 text-sm font-semibold rounded-xl text-white disabled:opacity-40"
            style={{ background: sinVerif > 0 ? '#B9BBB7' : '#254A96' }}>
            {confirmando ? 'Guardando…' : sinVerif > 0 ? `Falta verificar ${sinVerif}` : 'Confirmar verificación'}
          </button>
        </div>
      )}

      {/* Lista de solicitudes */}
      {loading ? (
        <div className="flex justify-center py-24">
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
        </div>
      ) : solsFiltradas.length === 0 ? (
        <div className="flex flex-col items-center py-24" style={{ color: '#B9BBB7' }}>
          <div className="text-5xl mb-4">📋</div>
          <p className="font-medium">No hay solicitudes para esta fecha</p>
          <p className="text-xs mt-1">Importá el Excel de SDs desde la pestaña Importar</p>
        </div>
      ) : (
        <div className="space-y-2">
          {solsFiltradas.map(sol => (
            <SolicitudCard
              key={sol.id}
              sol={sol}
              decisions={decisions}
              stock={stock}
              catalogo={catalogo}
              fechasDeadline={fechasDeadline}
              expandido={expandidos.has(sol.id)}
              onToggleExpand={() => toggleExpand(sol.id)}
              onSetDecision={(prodId, dec) => setDecision(sol.id, prodId, dec)}
              onSetDeadline={(fromBranch, date) => setFechasDeadline(prev => ({ ...prev, [`${sol.id}|${fromBranch}`]: date }))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Tarjeta de solicitud ──────────────────────────────────────────────────────
function SolicitudCard({
  sol, decisions, stock, catalogo, fechasDeadline,
  expandido, onToggleExpand, onSetDecision, onSetDeadline,
}: {
  sol: SdSolicitud
  decisions: DecisionsMap
  stock: StockMap
  catalogo: Record<number, CatalogoEntry>
  fechasDeadline: Record<string, string>
  expandido: boolean
  onToggleExpand: () => void
  onSetDecision: (prodId: number | null, dec: ItemDecision) => void
  onSetDeadline: (fromBranch: string, date: string) => void
}) {
  const eg = estadoGeneral(sol, decisions)
  const egStyle = DECISION_STYLE[eg] ?? DECISION_STYLE['sinverif']

  // Deadlines únicos para esta solicitud (de los reasignados)
  const transferBranches = new Set<string>()
  for (const item of sol.items) {
    const dec = getDecision(decisions, sol.id, item.id_producto)
    if (dec.tipo === 'reasignado' && dec.sucursal_asignada && dec.sucursal_asignada !== sol.sucursal) {
      transferBranches.add(dec.sucursal_asignada)
    }
  }

  const hasInactive = sol.items.some(it => catalogo[it.id_producto]?.activo === false)

  return (
    <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: '#f0f0f0', borderLeft: `4px solid ${egStyle.color}` }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-start justify-between gap-3 cursor-pointer" onClick={onToggleExpand}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
              style={{ background: egStyle.bg, color: egStyle.color }}>
              {egStyle.label}
            </span>
            <span className="text-xs font-medium" style={{ color: '#254A96' }}>#{sol.id}</span>
            {sol.id_venta > 0 && <span className="text-xs" style={{ color: '#B9BBB7' }}>NV {sol.id_venta}</span>}
            {sol.prioridad === 'ALTA' && (
              <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ background: '#fde8e8', color: '#E52322' }}>⚡ ALTA</span>
            )}
            {hasInactive && (
              <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: '#fef3c7', color: '#b45309' }}>⚠ Producto inactivo</span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: '#1a1a1a' }}>{sol.cliente || 'Sin nombre'}</span>
            <span className="text-xs" style={{ color: '#B9BBB7' }}>·</span>
            <span className="text-xs" style={{ color: '#B9BBB7' }}>{sol.destino || sol.direccion}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs" style={{ color: '#B9BBB7' }}>
            <span className="font-medium" style={{ color: '#254A96' }}>{sol.sucursal}</span>
            {sol.horario && <span>🕐 {sol.horario}</span>}
            <span>{sol.items.length} producto{sol.items.length !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {/* Deadlines resumen + expand toggle */}
        <div className="flex items-center gap-2 shrink-0">
          {[...transferBranches].map(branch => {
            const dlKey = `${sol.id}|${branch}`
            const dl = fechasDeadline[dlKey]
              ? calcDeadline(branch, sol.sucursal, sol.fecha_despacho ?? '')
              : calcDeadline(branch, sol.sucursal, sol.fecha_despacho ?? '')
            const customDate = fechasDeadline[dlKey]
            const dlDate = customDate || dl.date
            return (
              <span key={branch} className="text-xs px-2 py-1 rounded-lg font-medium"
                style={{ background: '#fef3c7', color: '#b45309' }}
                title={`Transfer desde ${branch} → límite ${fmtFecha(dlDate)}`}>
                ⏰ {branch}: {fmtFecha(dlDate)}
              </span>
            )
          })}
          <span className="text-sm" style={{ color: '#B9BBB7' }}>{expandido ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Items (expandible) */}
      {expandido && (
        <div className="border-t px-4 pb-4 pt-3 space-y-2" style={{ borderColor: '#f0f0f0' }}>
          {/* Acción rápida por solicitud */}
          <div className="flex items-center gap-2 mb-3 pb-3 border-b" style={{ borderColor: '#f0f0f0' }}>
            <span className="text-xs font-medium" style={{ color: '#B9BBB7' }}>Decisión general:</span>
            <button onClick={() => onSetDecision(null, { tipo: 'aprobado', sucursal_asignada: sol.sucursal })}
              className="text-xs px-2.5 py-1 rounded-lg font-medium"
              style={{ background: decisions[`${sol.id}`]?.tipo === 'aprobado' ? '#d1fae5' : '#f4f4f3', color: decisions[`${sol.id}`]?.tipo === 'aprobado' ? '#065f46' : '#666' }}>
              ✓ Aprobar todo
            </button>
            <button onClick={() => onSetDecision(null, { tipo: 'rechazado', sucursal_asignada: '' })}
              className="text-xs px-2.5 py-1 rounded-lg font-medium"
              style={{ background: decisions[`${sol.id}`]?.tipo === 'rechazado' ? '#fde8e8' : '#f4f4f3', color: decisions[`${sol.id}`]?.tipo === 'rechazado' ? '#E52322' : '#666' }}>
              ✕ Rechazar todo
            </button>
            {[...transferBranches].map(branch => (
              <div key={branch} className="flex items-center gap-1.5 ml-auto text-xs">
                <span style={{ color: '#b45309' }}>⏰ Límite transfer desde {branch}:</span>
                <input type="date"
                  value={fechasDeadline[`${sol.id}|${branch}`] || calcDeadline(branch, sol.sucursal, sol.fecha_despacho ?? '').date}
                  onChange={e => onSetDeadline(branch, e.target.value)}
                  className="border rounded px-2 py-0.5 text-xs focus:outline-none"
                  style={{ borderColor: '#fde68a' }} />
              </div>
            ))}
          </div>

          {sol.items.filter(it => it.nombre_producto !== 'Transporte por km').map(item => (
            <ItemRow
              key={item.id_producto}
              item={item}
              sol={sol}
              decision={getDecision(decisions, sol.id, item.id_producto)}
              stock={stock[item.id_producto] ?? {}}
              catalogoEntry={catalogo[item.id_producto]}
              onSetDecision={(dec) => onSetDecision(item.id_producto, dec)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Fila de item ──────────────────────────────────────────────────────────────
function ItemRow({ item, sol, decision, stock, catalogoEntry, onSetDecision }: {
  item: SdItem
  sol: SdSolicitud
  decision: ItemDecision
  stock: Record<string, number>
  catalogoEntry: CatalogoEntry | undefined
  onSetDecision: (dec: ItemDecision) => void
}) {
  const esInactivo = catalogoEntry?.activo === false
  const stockOrigen = stock[sol.sucursal] ?? 0
  const tieneStock = stockOrigen >= item.cantidad_solicitada
  const decStyle = DECISION_STYLE[decision.tipo || 'sinverif']

  return (
    <div className="rounded-lg px-3 py-2.5 flex items-start gap-3 flex-wrap"
      style={{ background: esInactivo ? '#fef9c3' : '#f9f9f9', border: `1px solid ${esInactivo ? '#fde68a' : '#f0f0f0'}` }}>

      {/* Nombre + indicadores */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium" style={{ color: '#1a1a1a' }}>{item.nombre_producto}</span>
          {esInactivo && (
            <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ background: '#fef3c7', color: '#b45309' }}>
              ⚠ INACTIVO
            </span>
          )}
          <span className="text-xs" style={{ color: '#B9BBB7' }}>#{item.id_producto}</span>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs flex-wrap">
          <span style={{ color: '#B9BBB7' }}>
            Solicitado: <strong style={{ color: '#1a1a1a' }}>{item.cantidad_solicitada}</strong>
          </span>
          {/* Stock por sucursal */}
          {Object.entries(stock).length > 0 ? (
            Object.entries(stock).sort(([, a], [, b]) => (b as number) - (a as number)).map(([suc, qty]) => (
              <span key={suc} className="px-1.5 py-0.5 rounded font-medium"
                style={{
                  background: (qty as number) >= item.cantidad_solicitada ? '#d1fae5' : (qty as number) > 0 ? '#fef3c7' : '#f4f4f3',
                  color: (qty as number) >= item.cantidad_solicitada ? '#065f46' : (qty as number) > 0 ? '#b45309' : '#B9BBB7',
                }}>
                {suc}: {qty as number}
              </span>
            ))
          ) : (
            <span style={{ color: '#B9BBB7' }}>Sin datos de stock</span>
          )}
        </div>
      </div>

      {/* Selector de decisión */}
      <div className="flex items-center gap-2 shrink-0">
        <select
          value={`${decision.tipo}|${decision.sucursal_asignada}`}
          onChange={e => {
            const [tipo, suc] = e.target.value.split('|')
            onSetDecision({ tipo: tipo as DecisionTipo, sucursal_asignada: suc || sol.sucursal })
          }}
          className="border rounded-lg px-2.5 py-1.5 text-xs font-medium focus:outline-none"
          style={{ borderColor: decStyle.color + '60', background: decStyle.bg, color: decStyle.color }}>
          <option value="|">— sin decidir —</option>
          <option value={`aprobado|${sol.sucursal}`}>✓ Aprobar (despacha desde {sol.sucursal})</option>
          <option value="rechazado|">✕ Rechazar</option>
          {SUCURSALES.filter(s => s !== sol.sucursal).map(s => (
            <option key={s} value={`reasignado|${s}`}>↗ Reasignar → {s}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: REQUERIMIENTOS (Transferencias / En tránsito / Historial)
// ═══════════════════════════════════════════════════════════════════════════════
function TabRequerimientos({ filtroEstados, rol, showToast }: {
  filtroEstados: string[]
  rol: string
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [reqs, setReqs] = useState<Requerimiento[]>([])
  const [cargando, setCargando] = useState(false)
  const [detalle, setDetalle] = useState<Requerimiento | null>(null)
  const [guardando, setGuardando] = useState(false)
  const [filtroOrigen, setFiltroOrigen] = useState('')
  const [filtroDestino, setFiltroDestino] = useState('')
  const [editItems, setEditItems] = useState<Record<string, number | null>>({})
  const [editNotas, setEditNotas] = useState('')
  const [editNViaje, setEditNViaje] = useState('')
  const [editVehiculo, setEditVehiculo] = useState('')
  const [editFechaRec, setEditFechaRec] = useState('')
  const [editTipoEntrega, setEditTipoEntrega] = useState('')

  const puedeEditar = rol === 'deposito' || rol === 'gerencia'
  const tabKey = filtroEstados.join(',')

  useEffect(() => { cargarReqs() }, [tabKey, filtroOrigen, filtroDestino])

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

  async function cambiarEstado(req: Requerimiento, nuevoEstado: string) {
    setGuardando(true)
    const updates: any = { estado: nuevoEstado }
    if (nuevoEstado === 'en_transito') {
      updates.n_viaje = editNViaje || req.n_viaje
      updates.cod_vehiculo = editVehiculo || req.cod_vehiculo
    }
    if (nuevoEstado === 'entregado') {
      updates.fecha_recepcion = editFechaRec || hoy()
      updates.tipo_entrega = editTipoEntrega || 'completa'
    }
    if (editNotas) updates.notas = editNotas

    const items_update = Object.entries(editItems)
      .filter(([, v]) => v !== null)
      .map(([id, cantidad_aprobada]) => ({ id, cantidad_aprobada }))

    const res = await fetch('/api/requerimientos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, ...updates, items_update }),
    })
    const data = await res.json()
    setGuardando(false)
    if (!data.success) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`Estado actualizado: ${ESTADO_LABEL[nuevoEstado]}`)
    setDetalle(null)
    cargarReqs()
  }

  function abrirDetalle(req: Requerimiento) {
    setDetalle(req)
    setEditItems({})
    setEditNotas(req.notas ?? '')
    setEditNViaje(req.n_viaje ?? '')
    setEditVehiculo(req.cod_vehiculo ?? '')
    setEditFechaRec(req.fecha_recepcion ?? '')
    setEditTipoEntrega(req.tipo_entrega ?? '')
  }

  return (
    <div className="px-4 md:px-6 py-4">
      {/* Filtros */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <select value={filtroOrigen} onChange={e => setFiltroOrigen(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
          <option value="">Todos los orígenes</option>
          {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ color: '#B9BBB7' }}>→</span>
        <select value={filtroDestino} onChange={e => setFiltroDestino(e.target.value)}
          className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
          <option value="">Todos los destinos</option>
          {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-sm ml-auto" style={{ color: '#B9BBB7' }}>
          {reqs.length} requerimiento{reqs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {cargando ? (
        <div className="flex justify-center py-24">
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
        </div>
      ) : reqs.length === 0 ? (
        <div className="flex flex-col items-center py-24" style={{ color: '#B9BBB7' }}>
          <div className="text-5xl mb-4">📦</div>
          <p className="font-medium">No hay transferencias en esta sección</p>
        </div>
      ) : (
        <div className="space-y-2">
          {reqs.map(req => (
            <ReqCard key={req.id} req={req} onClick={() => abrirDetalle(req)} />
          ))}
        </div>
      )}

      {detalle && (
        <ModalDetalleReq
          req={detalle}
          rol={rol}
          guardando={guardando}
          puedeEditar={puedeEditar}
          editItems={editItems}
          editNotas={editNotas}
          editNViaje={editNViaje}
          editVehiculo={editVehiculo}
          editFechaRec={editFechaRec}
          editTipoEntrega={editTipoEntrega}
          setEditItems={setEditItems}
          setEditNotas={setEditNotas}
          setEditNViaje={setEditNViaje}
          setEditVehiculo={setEditVehiculo}
          setEditFechaRec={setEditFechaRec}
          setEditTipoEntrega={setEditTipoEntrega}
          onCambiarEstado={(est: string) => cambiarEstado(detalle, est)}
          onClose={() => setDetalle(null)}
        />
      )}
    </div>
  )
}

function ReqCard({ req, onClick }: { req: Requerimiento; onClick: () => void }) {
  const totalItems = req.requerimiento_items?.length ?? 0
  const resumen = req.requerimiento_items?.slice(0, 2).map(it => it.nombre_producto).join(', ')
    + (totalItems > 2 ? ` +${totalItems - 2} más` : '')

  const deadline = req.fecha_solicitada
    ? calcDeadline(req.sucursal_origen, req.sucursal_destino, req.fecha_solicitada)
    : null

  return (
    <div onClick={onClick}
      className="bg-white rounded-xl border p-4 cursor-pointer hover:shadow-md transition-shadow"
      style={{ borderColor: '#f0f0f0', borderLeft: '4px solid #f59e0b' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <BadgeEstado estado={req.estado} />
          {req.nv && <span className="text-xs font-medium" style={{ color: '#254A96' }}>NV {req.nv}</span>}
          {req.cliente && <span className="text-xs" style={{ color: '#B9BBB7' }}>{req.cliente}</span>}
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0" style={{ color: '#B9BBB7' }}>
          {req.n_viaje && <span className="font-medium" style={{ color: '#0f766e' }}>Viaje #{req.n_viaje}</span>}
          <span>{fmtFecha(req.fecha_solicitada ?? req.fecha_req)}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className="text-sm font-semibold" style={{ color: '#254A96' }}>{req.sucursal_origen}</span>
        <span className="text-sm" style={{ color: '#B9BBB7' }}>→</span>
        <span className="text-sm font-semibold" style={{ color: '#0f766e' }}>{req.sucursal_destino}</span>
        {deadline && (
          <span className="text-xs px-2 py-0.5 rounded ml-auto" style={{ background: '#fef3c7', color: '#b45309' }}>
            ⏰ Límite: {deadline.label}
          </span>
        )}
      </div>
      {resumen && (
        <p className="text-xs mt-1.5 leading-tight" style={{ color: '#B9BBB7' }}>{resumen}</p>
      )}
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

function ModalDetalleReq({ req, rol, guardando, puedeEditar, editItems, editNotas, editNViaje, editVehiculo, editFechaRec, editTipoEntrega,
  setEditItems, setEditNotas, setEditNViaje, setEditVehiculo, setEditFechaRec, setEditTipoEntrega, onCambiarEstado, onClose }: any) {
  const siguientes = estadosSiguientes(req.estado, rol)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        style={{ fontFamily: 'Barlow, sans-serif' }}>
        <div className="p-5 border-b flex items-start justify-between gap-3" style={{ borderColor: '#f0f0f0' }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <BadgeEstado estado={req.estado} />
            </div>
            <p className="font-semibold text-sm" style={{ color: '#254A96' }}>
              {req.sucursal_origen} → {req.sucursal_destino}
            </p>
            {req.nv && <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>NV {req.nv} {req.cliente ? `· ${req.cliente}` : ''}</p>}
          </div>
          <button onClick={onClose} className="text-lg" style={{ color: '#B9BBB7' }}>×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span style={{ color: '#B9BBB7' }}>Solicitado:</span> <strong>{fmtFecha(req.fecha_req)}</strong></div>
            <div><span style={{ color: '#B9BBB7' }}>Necesario:</span> <strong>{fmtFecha(req.fecha_solicitada)}</strong></div>
          </div>

          {/* Deadline de transfer */}
          {req.fecha_solicitada && (
            <div className="rounded-lg px-3 py-2" style={{ background: '#fef3c7', border: '1px solid #fde68a' }}>
              <p className="text-xs font-medium" style={{ color: '#b45309' }}>
                ⏰ Fecha límite para despachar desde {req.sucursal_origen}:{' '}
                <strong>{calcDeadline(req.sucursal_origen, req.sucursal_destino, req.fecha_solicitada).label}</strong>
              </p>
            </div>
          )}

          {/* Productos */}
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: '#254A96' }}>PRODUCTOS</p>
            <div className="space-y-1.5">
              {req.requerimiento_items?.map((item: ReqItem) => (
                <div key={item.id} className="rounded-lg px-3 py-2" style={{ background: '#f9f9f9', border: '1px solid #f0f0f0' }}>
                  <p className="text-sm font-medium">{item.nombre_producto}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>Solicitado: <strong>{item.cantidad_solicitada}</strong></span>
                    {puedeEditar ? (
                      <label className="text-xs flex items-center gap-1.5" style={{ color: '#0f766e' }}>
                        Aprobado:
                        <input type="number" min={0}
                          value={editItems[item.id] ?? item.cantidad_aprobada ?? item.cantidad_solicitada}
                          onChange={e => setEditItems((prev: any) => ({ ...prev, [item.id]: parseInt(e.target.value) || 0 }))}
                          className="w-16 border rounded px-1.5 py-0.5 text-xs focus:outline-none font-bold text-center"
                          style={{ borderColor: '#e8edf8' }} />
                      </label>
                    ) : item.cantidad_aprobada != null ? (
                      <span className="text-xs font-semibold" style={{ color: '#0f766e' }}>Aprobado: {item.cantidad_aprobada}</span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {puedeEditar && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>N° Viaje (del ERP)</label>
                  <input value={editNViaje} onChange={e => setEditNViaje(e.target.value)} placeholder="ej: 1360"
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Vehículo</label>
                  <input value={editVehiculo} onChange={e => setEditVehiculo(e.target.value)} placeholder="ej: LP142"
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                </div>
              </div>
              {(req.estado === 'en_transito' || req.estado === 'entregado') && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Fecha recepción</label>
                    <input type="date" value={editFechaRec} onChange={e => setEditFechaRec(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Tipo entrega</label>
                    <select value={editTipoEntrega} onChange={e => setEditTipoEntrega(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                      <option value="">— seleccionar —</option>
                      {TIPO_ENTREGA_OPTS.map(o => <option key={o} value={o}>{TIPO_ENTREGA_LABEL[o]}</option>)}
                    </select>
                  </div>
                </div>
              )}
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Observaciones</label>
                <textarea value={editNotas} onChange={e => setEditNotas(e.target.value)} rows={2}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none" style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>
          )}
          {!puedeEditar && req.notas && (
            <p className="text-sm rounded-lg px-3 py-2" style={{ background: '#fef3c7', color: '#b45309' }}>{req.notas}</p>
          )}
        </div>

        {siguientes.length > 0 && (
          <div className="p-5 border-t flex gap-2 flex-wrap" style={{ borderColor: '#f0f0f0' }}>
            {siguientes.map((sig: string) => (
              <button key={sig} disabled={guardando}
                onClick={() => onCambiarEstado(sig)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: sig === 'rechazado' ? '#E52322' : sig === 'entregado' ? '#10b981' : '#254A96' }}>
                {guardando ? '…' : `→ ${ESTADO_LABEL[sig]}`}
              </button>
            ))}
          </div>
        )}
      </div>
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
    showToast(`${data.total} solicitudes procesadas`)
    setResultSols(data)
    if (fileSolsRef.current) fileSolsRef.current.value = ''
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
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>📋 Solicitudes de despacho</h3>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Para verificar y cruzar con stock</p>
          </div>
          <button onClick={() => fileSolsRef.current?.click()} disabled={importandoSols}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
            style={{ background: '#254A96' }}>
            {importandoSols ? 'Procesando…' : 'Importar Excel'}
          </button>
          <input ref={fileSolsRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={importarSolicitudes} />
        </div>
        <p className="text-xs" style={{ color: '#B9BBB7' }}>
          Exportá el Excel de solicitudes del ERP (hojas "Solicitudes de Despacho" e "items_solicitudes").
          Después de importar, usá la pestaña "Verificación SD" para revisar.
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
