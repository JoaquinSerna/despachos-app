'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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
// stock[String(id_producto)][sucursal] = cantidad — siempre string para evitar type mismatch
type StockMap = Record<string, Record<string, number>>
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

// ─── Tipo para vista agregada (Sugerencias) ───────────────────────────────────
interface SugerenciaRow {
  id_producto: number
  nombre_producto: string
  categoria: string
  sucursal: string
  demandado: number
  stock_local: number
  deficit: number
  disponible_otros: number
  sucursal_mejor: string
  cobertura: 'cubierto' | 'parcial' | 'sin_stock'
  activo: boolean
  sol_ids: number[]
}

/** Agrega demanda por (sucursal, producto) y calcula cobertura vs stock */
function buildSugerencias(
  solicitudes: SdSolicitud[],
  stock: StockMap,
  catalogo: Record<number, CatalogoEntry>,
): SugerenciaRow[] {
  // Clave única por producto: id_producto si es válido, sino "name:<nombre>"
  // Esto evita que todos los ítems sin ID colapsen en una sola fila por sucursal
  function prodKey(item: SdItem): string {
    return (item.id_producto && item.id_producto > 0 && !isNaN(item.id_producto))
      ? String(item.id_producto)
      : `name:${item.nombre_producto.trim().toLowerCase()}`
  }

  const demand: Record<string, Record<string, SugerenciaRow>> = {}
  for (const sol of solicitudes) {
    for (const item of sol.items) {
      if (!item.nombre_producto || item.nombre_producto === 'Transporte por km') continue
      if (!demand[sol.sucursal]) demand[sol.sucursal] = {}
      const key = prodKey(item)
      if (!demand[sol.sucursal][key]) {
        demand[sol.sucursal][key] = {
          id_producto: item.id_producto, nombre_producto: item.nombre_producto,
          categoria: item.categoria, sucursal: sol.sucursal,
          demandado: 0, stock_local: 0, deficit: 0, disponible_otros: 0,
          sucursal_mejor: '', cobertura: 'sin_stock',
          activo: catalogo[item.id_producto]?.activo !== false, sol_ids: [],
        }
      }
      demand[sol.sucursal][key].demandado += item.cantidad_solicitada
      if (!demand[sol.sucursal][key].sol_ids.includes(sol.id))
        demand[sol.sucursal][key].sol_ids.push(sol.id)
    }
  }
  const rows: SugerenciaRow[] = []
  for (const [suc, prods] of Object.entries(demand)) {
    for (const [, row] of Object.entries(prods)) {
      const pid = String(row.id_producto)
      row.stock_local = stock[pid]?.[suc] ?? 0
      row.deficit = Math.max(0, row.demandado - row.stock_local)
      const others = Object.entries(stock[pid] ?? {})
        .filter(([s]) => s !== suc)
        .sort(([, a], [, b]) => (b as number) - (a as number))
      if (others.length > 0) { row.disponible_otros = others[0][1] as number; row.sucursal_mejor = others[0][0] }
      row.cobertura = row.stock_local >= row.demandado ? 'cubierto' : row.stock_local > 0 ? 'parcial' : 'sin_stock'
      rows.push(row)
    }
  }
  return rows
}

// ─── Helpers de decisión ───────────────────────────────────────────────────────
/** Decide automáticamente basado en stock disponible */
function autoSuggest(item: SdItem, sucursalOrigen: string, stock: StockMap): ItemDecision {
  const stockProd = stock[String(item.id_producto)] ?? {}
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
        {tab === 'verificacion' && (
          <TabVerificacion rol={rol} userEmail={userEmail} showToast={showToast} />
        )}
        {tab === 'transferencias' && (
          <TabRequerimientos filtroEstados={['pendiente', 'conf_stock', 'preparacion']} rol={rol} showToast={showToast} userEmail={userEmail} />
        )}
        {tab === 'transito' && (
          <TabRequerimientos filtroEstados={['en_transito']} rol={rol} showToast={showToast} userEmail={userEmail} />
        )}
        {tab === 'historial' && (
          <TabRequerimientos filtroEstados={['entregado', 'rechazado']} rol={rol} showToast={showToast} userEmail={userEmail} />
        )}
        {tab === 'importar' && (
          <TabImportar rol={rol} showToast={showToast} />
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: VERIFICACIÓN SD — vista Sugerencias de Transferencias
// ═══════════════════════════════════════════════════════════════════════════════
function TabVerificacion({ rol, userEmail, showToast }: {
  rol: string; userEmail: string; showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [fechaDesde, setFechaDesde] = useState('')
  const [fechaHasta, setFechaHasta] = useState('')
  const [filtrosSucursal, setFiltrosSucursal] = useState<string[]>([])
  const [filtrosCategorias, setFiltrosCategorias] = useState<string[]>([])
  const [filtrosCoberturas, setFiltrosCoberturas] = useState<string[]>([])
  const [filtrosEstado, setFiltrosEstado] = useState<string[]>([])
  const [filtroActivo, setFiltroActivo] = useState('')

  function togFiltro(arr: string[], val: string) {
    return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]
  }
  const [solicitudes, setSolicitudes] = useState<SdSolicitud[]>([])
  const [stock, setStock] = useState<StockMap>({})
  const [catalogo, setCatalogo] = useState<Record<number, CatalogoEntry>>({})
  const [decisions, setDecisions] = useState<DecisionsMap>({})
  const [fechasDeadline, setFechasDeadline] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [confirmando, setConfirmando] = useState(false)
  const [stockFecha, setStockFecha] = useState<string | null>(null)
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set(SUCURSALES))

  useEffect(() => {
    supabase.from('stock_sucursal')
      .select('actualizado_en').order('actualizado_en', { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data?.[0]?.actualizado_en) setStockFecha(data[0].actualizado_en.split('T')[0])
      })
  }, [])

  async function cargarSolicitudes() {
    setLoading(true)
    try {
      let q = supabase.from('solicitudes_importadas').select('*').order('id').limit(5000)
      if (fechaDesde) q = q.gte('fecha_despacho', fechaDesde)
      if (fechaHasta) q = q.lte('fecha_despacho', fechaHasta)
      const { data: sols } = await q

      if (!sols?.length) { setSolicitudes([]); setLoading(false); return }

      const solIds = sols.map((s: any) => s.id)
      // Batch the IN query to avoid URL length limits (Supabase/PostgREST
      // sends IDs as a comma-separated URL param; 2000+ IDs can exceed limits)
      let allItemsRaw: any[] = []
      const IN_BATCH = 500
      for (let i = 0; i < solIds.length; i += IN_BATCH) {
        const { data: batchData } = await supabase
          .from('solicitudes_importadas_items')
          .select('*')
          .in('id_solicitud', solIds.slice(i, i + IN_BATCH))
          .limit(10000)
        if (batchData) allItemsRaw = allItemsRaw.concat(batchData)
      }
      const itemsRaw = allItemsRaw

      const prodIds = [...new Set((itemsRaw ?? []).map((it: any) => it.id_producto).filter(Boolean))]
      const stockMap: StockMap = {}
      if (prodIds.length > 0) {
        const { data: stockRaw } = await supabase
          .from('stock_sucursal').select('id_producto, sucursal, cantidad').in('id_producto', prodIds).limit(20000)
        for (const s of stockRaw ?? []) {
          const key = String(s.id_producto)
          if (!stockMap[key]) stockMap[key] = {}
          stockMap[key][s.sucursal] = Number(s.cantidad)
        }
      }
      setStock(stockMap)

      if (prodIds.length > 0) {
        const res = await fetch(`/api/productos-catalogo?ids=${prodIds.join(',')}`)
        if (res.ok) {
          const catRaw: CatalogoEntry[] = await res.json()
          const catMap: Record<number, CatalogoEntry> = {}
          for (const c of catRaw) catMap[c.id] = c
          setCatalogo(catMap)
        }
      }

      const fechas = [...new Set(sols.map((s: any) => s.fecha_despacho).filter(Boolean))]
      const decMap: DecisionsMap = {}
      for (const f of fechas) {
        const res = await fetch(`/api/sd-decisiones?fecha=${f}`)
        const decRaw: any[] = res.ok ? await res.json() : []
        for (const d of decRaw) {
          const key = d.id_producto ? `${d.id_solicitud}|${d.id_producto}` : `${d.id_solicitud}`
          decMap[key] = { tipo: d.tipo, sucursal_asignada: d.sucursal_asignada }
        }
      }

      const itemsBySol: Record<number, SdItem[]> = {}
      for (const it of (itemsRaw ?? [])) {
        if (!itemsBySol[it.id_solicitud]) itemsBySol[it.id_solicitud] = []
        itemsBySol[it.id_solicitud].push({
          id_producto: it.id_producto, nombre_producto: it.nombre_producto ?? '',
          categoria: it.categoria ?? '', subcategoria: it.subcategoria ?? '',
          cantidad_solicitada: it.cantidad_solicitada ?? 0, cantidad_entregada: it.cantidad_entregada ?? 0,
          hojas_de_ruta: it.hojas_de_ruta ?? '',
        })
      }

      const solsConItems: SdSolicitud[] = sols.map((s: any) => ({
        id: s.id, fecha_despacho: s.fecha_despacho, horario: s.horario ?? '',
        prioridad: s.prioridad ?? '', estado: s.estado ?? '', id_venta: s.id_venta,
        cliente: s.cliente ?? '', destino: s.destino ?? '', direccion: s.direccion ?? '',
        sucursal: s.sucursal ?? '', items: itemsBySol[s.id] ?? [],
      }))
      setSolicitudes(solsConItems)

      const newDec = { ...decMap }
      for (const sol of solsConItems) {
        for (const item of sol.items) {
          if (item.nombre_producto === 'Transporte por km') continue
          const itemKey = `${sol.id}|${item.id_producto}`
          const solKey = `${sol.id}`
          if (!newDec[itemKey] && !newDec[solKey])
            newDec[itemKey] = autoSuggest(item, sol.sucursal, stockMap)
        }
      }
      setDecisions(newDec)

      const dl: Record<string, string> = {}
      for (const sol of solsConItems) {
        const branches = new Set<string>()
        for (const item of sol.items) {
          const dec = newDec[`${sol.id}|${item.id_producto}`] ?? newDec[`${sol.id}`]
          if (dec?.tipo === 'reasignado' && dec.sucursal_asignada && dec.sucursal_asignada !== sol.sucursal)
            branches.add(dec.sucursal_asignada)
        }
        for (const branch of branches) {
          const key = `${sol.id}|${branch}`
          if (!dl[key]) dl[key] = calcDeadline(branch, sol.sucursal, sol.fecha_despacho ?? '').date
        }
      }
      setFechasDeadline(dl)
    } catch (e: any) {
      showToast(`Error: ${e.message}`, 'err')
    }
    setLoading(false)
  }

  async function confirmar() {
    setConfirmando(true)
    try {
      const decToSave: any[] = []
      for (const sol of solicitudes) {
        const solDec = decisions[`${sol.id}`]
        if (solDec) decToSave.push({ id_solicitud: sol.id, id_producto: null, tipo: solDec.tipo, sucursal_asignada: solDec.sucursal_asignada, fecha_sd: sol.fecha_despacho, operador: userEmail })
        for (const item of sol.items) {
          const itemDec = decisions[`${sol.id}|${item.id_producto}`]
          if (itemDec) decToSave.push({ id_solicitud: sol.id, id_producto: item.id_producto, tipo: itemDec.tipo, sucursal_asignada: itemDec.sucursal_asignada, fecha_sd: sol.fecha_despacho, operador: userEmail })
        }
      }
      const savedRes = await fetch('/api/sd-decisiones', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decisions: decToSave }),
      })
      if (!savedRes.ok) throw new Error('Error guardando decisiones')

      const reqGrupos: Map<string, { sol: SdSolicitud; fromBranch: string; items: { nombre: string; id_producto: number; cantidad: number }[] }> = new Map()
      for (const sol of solicitudes) {
        for (const item of sol.items) {
          if (item.nombre_producto === 'Transporte por km') continue
          const dec = getDecision(decisions, sol.id, item.id_producto)
          if (dec.tipo !== 'reasignado' || !dec.sucursal_asignada || dec.sucursal_asignada === sol.sucursal) continue
          const key = `${sol.id}|${dec.sucursal_asignada}`
          if (!reqGrupos.has(key)) reqGrupos.set(key, { sol, fromBranch: dec.sucursal_asignada, items: [] })
          reqGrupos.get(key)!.items.push({ nombre: item.nombre_producto, id_producto: item.id_producto, cantidad: item.cantidad_solicitada })
        }
      }

      let reqCreados = 0
      for (const [, grupo] of reqGrupos) {
        const { sol, fromBranch } = grupo
        const dlKey = `${sol.id}|${fromBranch}`
        const fechaSolicitada = fechasDeadline[dlKey] || calcDeadline(fromBranch, sol.sucursal, sol.fecha_despacho ?? '').date
        const res = await fetch('/api/requerimientos', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo: 'abastecimiento', nv: String(sol.id_venta), cliente: sol.cliente,
            sucursal_origen: fromBranch, sucursal_destino: sol.sucursal,
            estado: 'pendiente', fecha_req: hoy(), fecha_solicitada: fechaSolicitada || null,
            solicitado_por: userEmail, notas: `Generado desde SD #${sol.id} — despacho ${fmtFecha(sol.fecha_despacho)}`,
            items: grupo.items.map(it => ({ id_producto: it.id_producto, nombre_producto: it.nombre, cantidad_solicitada: it.cantidad })),
          }),
        })
        if (!res.ok) { const err = await res.json(); throw new Error(err.error ?? 'Error creando requerimiento') }
        reqCreados++
      }
      showToast(`✓ ${decToSave.length} decisiones guardadas${reqCreados > 0 ? ` · ${reqCreados} transferencias generadas` : ''}`)
    } catch (e: any) {
      showToast(`Error: ${e.message}`, 'err')
    }
    setConfirmando(false)
  }

  // ── Datos derivados ────────────────────────────────────────────────────────
  const estadosDisp = [...new Set(solicitudes.map(s => s.estado).filter(Boolean))].sort()

  // Aplicar filtros de sucursal y estado ANTES de buildSugerencias
  // para que demanda y sol_ids reflejen solo el subconjunto seleccionado
  const solicitudesParaSugerencias = solicitudes
    .filter(s => filtrosSucursal.length === 0 || filtrosSucursal.includes(s.sucursal))
    .filter(s => filtrosEstado.length === 0 || filtrosEstado.includes(s.estado))

  // ── Debug info (para diagnosticar el pipeline) ─────────────────────────
  const dbgSolsConItems = solicitudesParaSugerencias.filter(s => s.items.length > 0).length
  const dbgTotalItems   = solicitudesParaSugerencias.reduce((sum, s) => sum + s.items.length, 0)

  const todasSugerencias = buildSugerencias(solicitudesParaSugerencias, stock, catalogo)
  const categorias = [...new Set(todasSugerencias.map(r => r.categoria).filter(Boolean))].sort()

  const sugerenciasFiltradas = todasSugerencias
    .filter(r => filtrosCategorias.length === 0 || filtrosCategorias.includes(r.categoria))
    .filter(r => filtrosCoberturas.length === 0 || filtrosCoberturas.includes(r.cobertura))
    .filter(r => !filtroActivo || Object.keys(catalogo).length === 0 || String(r.activo) === filtroActivo)

  const sinStock    = sugerenciasFiltradas.filter(r => r.cobertura === 'sin_stock').length
  const parcial     = sugerenciasFiltradas.filter(r => r.cobertura === 'parcial').length
  const cubiertos   = sugerenciasFiltradas.filter(r => r.cobertura === 'cubierto').length
  const sucConDef   = new Set(sugerenciasFiltradas.filter(r => r.cobertura !== 'cubierto').map(r => r.sucursal)).size

  const bySucursal: Record<string, SugerenciaRow[]> = {}
  for (const r of sugerenciasFiltradas) {
    if (!bySucursal[r.sucursal]) bySucursal[r.sucursal] = []
    bySucursal[r.sucursal].push(r)
  }

  const STAT_CARDS = [
    { value: sinStock,   label: 'Sin stock en red',       color: sinStock   > 0 ? '#E52322' : '#B9BBB7', key: 'sin_stock' },
    { value: parcial,    label: 'Cobertura parcial',      color: parcial    > 0 ? '#d97706' : '#B9BBB7', key: 'parcial'   },
    { value: cubiertos,  label: 'Cubiertos',              color: '#10b981',                               key: 'cubierto'  },
    { value: sucConDef,  label: 'Sucursales con déficit', color: sucConDef  > 0 ? '#254A96' : '#B9BBB7', key: ''          },
  ]

  return (
    <div className="px-4 md:px-6 py-4">

      {/* ── Barra de filtros ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border px-4 pt-4 pb-3 mb-4 space-y-3" style={{ borderColor: '#f0f0f0' }}>

        {/* Fila 1: Fechas + botones */}
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Desde</label>
            <input type="date" value={fechaDesde} onChange={e => setFechaDesde(e.target.value)}
              className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Hasta</label>
            <input type="date" value={fechaHasta} onChange={e => setFechaHasta(e.target.value)}
              className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
          </div>
          {Object.keys(catalogo).length > 0 && (
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: '#254A96' }}>Producto</label>
              <select value={filtroActivo} onChange={e => setFiltroActivo(e.target.value)}
                className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                <option value="">Todos</option>
                <option value="true">Solo activos</option>
                <option value="false">Solo inactivos</option>
              </select>
            </div>
          )}
          <button onClick={cargarSolicitudes} disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: '#254A96' }}>
            {loading ? '…' : '🔄 Actualizar'}
          </button>
          {solicitudes.length > 0 && (
            <>
              <span className="text-xs" style={{ color: '#B9BBB7' }}>{solicitudes.length} SDs cargadas</span>
              <button onClick={confirmar} disabled={confirmando}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 ml-auto"
                style={{ background: '#10b981' }}>
                {confirmando ? 'Guardando…' : '✓ Confirmar verificación'}
              </button>
            </>
          )}
        </div>

        {solicitudes.length > 0 && (<>
          {/* Fila 2: Sucursal chips */}
          <div>
            <label className="text-xs font-semibold block mb-1.5" style={{ color: '#B9BBB7' }}>SUCURSAL</label>
            <div className="flex flex-wrap gap-1.5">
              {SUCURSALES.map(s => (
                <button key={s} onClick={() => setFiltrosSucursal(prev => togFiltro(prev, s))}
                  className="text-xs px-2.5 py-1 rounded-full font-medium transition-colors"
                  style={{
                    background: filtrosSucursal.includes(s) ? '#254A96' : '#f0f4ff',
                    color: filtrosSucursal.includes(s) ? '#fff' : '#254A96',
                    border: `1px solid ${filtrosSucursal.includes(s) ? '#254A96' : '#d0daf5'}`,
                  }}>
                  {s}
                </button>
              ))}
              {filtrosSucursal.length > 0 && (
                <button onClick={() => setFiltrosSucursal([])} className="text-xs px-2 py-1 rounded-full"
                  style={{ color: '#B9BBB7', border: '1px solid #e0e0e0' }}>✕ limpiar</button>
              )}
            </div>
          </div>

          {/* Fila 3: Cobertura chips */}
          <div>
            <label className="text-xs font-semibold block mb-1.5" style={{ color: '#B9BBB7' }}>COBERTURA</label>
            <div className="flex flex-wrap gap-1.5">
              {[
                { v: 'sin_stock', label: 'Sin stock',  activeBg: '#E52322', activeFg: '#fff', idleBg: '#fde8e8', idleFg: '#E52322' },
                { v: 'parcial',   label: 'Parcial',    activeBg: '#d97706', activeFg: '#fff', idleBg: '#fef3c7', idleFg: '#b45309' },
                { v: 'cubierto',  label: 'Cubierto',   activeBg: '#10b981', activeFg: '#fff', idleBg: '#d1fae5', idleFg: '#065f46' },
              ].map(opt => {
                const on = filtrosCoberturas.includes(opt.v)
                return (
                  <button key={opt.v} onClick={() => setFiltrosCoberturas(prev => togFiltro(prev, opt.v))}
                    className="text-xs px-2.5 py-1 rounded-full font-semibold transition-colors"
                    style={{ background: on ? opt.activeBg : opt.idleBg, color: on ? opt.activeFg : opt.idleFg }}>
                    {opt.label}
                  </button>
                )
              })}
              {filtrosCoberturas.length > 0 && (
                <button onClick={() => setFiltrosCoberturas([])} className="text-xs px-2 py-1 rounded-full"
                  style={{ color: '#B9BBB7', border: '1px solid #e0e0e0' }}>✕ limpiar</button>
              )}
            </div>
          </div>

          {/* Fila 4: Estado de Entrega chips */}
          {estadosDisp.length > 0 && (
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: '#B9BBB7' }}>ESTADO DE ENTREGA</label>
              <div className="flex flex-wrap gap-1.5">
                {estadosDisp.map(e => {
                  const on = filtrosEstado.includes(e)
                  const cnt = solicitudes.filter(s => s.estado === e).length
                  return (
                    <button key={e} onClick={() => setFiltrosEstado(prev => togFiltro(prev, e))}
                      className="text-xs px-2.5 py-1 rounded-full font-medium transition-colors"
                      style={{
                        background: on ? '#254A96' : '#f4f4f3',
                        color: on ? '#fff' : '#444',
                        border: `1px solid ${on ? '#254A96' : '#e0e0e0'}`,
                      }}>
                      {e} <span style={{ opacity: 0.7 }}>({cnt})</span>
                    </button>
                  )
                })}
                {filtrosEstado.length > 0 && (
                  <button onClick={() => setFiltrosEstado([])} className="text-xs px-2 py-1 rounded-full"
                    style={{ color: '#B9BBB7', border: '1px solid #e0e0e0' }}>✕ limpiar</button>
                )}
              </div>
            </div>
          )}

          {/* Fila 5: Categoría */}
          {categorias.length > 0 && (
            <div>
              <label className="text-xs font-semibold block mb-1.5" style={{ color: '#B9BBB7' }}>CATEGORÍA</label>
              <div className="flex flex-wrap gap-1.5">
                {categorias.map(c => {
                  const on = filtrosCategorias.includes(c)
                  return (
                    <button key={c} onClick={() => setFiltrosCategorias(prev => togFiltro(prev, c))}
                      className="text-xs px-2.5 py-1 rounded-full font-medium transition-colors"
                      style={{
                        background: on ? '#7c3aed' : '#f3f0ff',
                        color: on ? '#fff' : '#7c3aed',
                        border: `1px solid ${on ? '#7c3aed' : '#ddd6fe'}`,
                      }}>
                      {c}
                    </button>
                  )
                })}
                {filtrosCategorias.length > 0 && (
                  <button onClick={() => setFiltrosCategorias([])} className="text-xs px-2 py-1 rounded-full"
                    style={{ color: '#B9BBB7', border: '1px solid #e0e0e0' }}>✕ limpiar</button>
                )}
              </div>
            </div>
          )}
        </>)}
      </div>

      {/* Stock fecha */}
      {stockFecha && (
        <p className="text-xs mb-3" style={{ color: '#B9BBB7' }}>
          ⏱ Stock evaluado al: <strong style={{ color: '#1a1a1a' }}>{fmtFecha(stockFecha)}</strong>
        </p>
      )}

      {/* ── Debug pipeline info ──────────────────────────────────────────── */}
      {solicitudes.length > 0 && (
        <details className="mb-3 text-xs rounded-lg px-3 py-2 cursor-pointer"
          style={{ background: '#f9f9f9', border: '1px solid #e8e8e8', color: '#888' }}>
          <summary className="font-medium select-none" style={{ color: '#aaa' }}>🔍 Info de pipeline (debug)</summary>
          <div className="mt-2 space-y-0.5 font-mono">
            <p>SDs cargadas total: <strong>{solicitudes.length}</strong> · estados: {estadosDisp.map(e => `${e}(${solicitudes.filter(s=>s.estado===e).length})`).join(', ')}</p>
            <p>SDs en filtro actual: <strong>{solicitudesParaSugerencias.length}</strong> · con items: <strong>{dbgSolsConItems}</strong> · items totales: <strong>{dbgTotalItems}</strong></p>
            <p>buildSugerencias → <strong>{todasSugerencias.length}</strong> filas · filtradas final: <strong>{sugerenciasFiltradas.length}</strong></p>
          </div>
        </details>
      )}

      {/* ── Stats ────────────────────────────────────────────────────────── */}
      {solicitudes.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {STAT_CARDS.map(stat => (
            <button key={stat.label}
              onClick={() => stat.key && setFiltrosCoberturas(prev => togFiltro(prev, stat.key))}
              className="bg-white rounded-xl border p-4 text-center transition-shadow hover:shadow-md"
              style={{ borderColor: filtrosCoberturas.includes(stat.key) ? stat.color : '#f0f0f0', borderWidth: filtrosCoberturas.includes(stat.key) ? 2 : 1, cursor: stat.key ? 'pointer' : 'default' }}>
              <div className="text-3xl font-bold" style={{ color: stat.color }}>{stat.value}</div>
              <div className="text-xs mt-1" style={{ color: '#B9BBB7' }}>{stat.label}</div>
            </button>
          ))}
        </div>
      )}

      {/* ── Lista ────────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex justify-center py-24">
          <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
            style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
        </div>
      ) : sugerenciasFiltradas.length === 0 ? (
        <div className="flex flex-col items-center py-24" style={{ color: '#B9BBB7' }}>
          <div className="text-5xl mb-4">📋</div>
          <p className="font-medium">{solicitudes.length === 0 ? 'No hay solicitudes cargadas' : 'Sin resultados para los filtros'}</p>
          {solicitudes.length === 0 && <p className="text-xs mt-1">Importá el Excel de SDs e ingresá hacé click en Actualizar</p>}
        </div>
      ) : (
        <div className="space-y-3">
          {Object.entries(bySucursal)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([suc, rows]) => (
              <SucursalGroup key={suc} sucursal={suc} rows={rows}
                expanded={expandedBranches.has(suc)}
                onToggle={() => setExpandedBranches(prev => {
                  const s = new Set(prev); s.has(suc) ? s.delete(suc) : s.add(suc); return s
                })}
                showToast={showToast}
                userEmail={userEmail}
                solicitudes={solicitudes}
              />
            ))}
        </div>
      )}
    </div>
  )
}

// ─── Grupo por sucursal ────────────────────────────────────────────────────────
function SucursalGroup({ sucursal, rows, expanded, onToggle, showToast, userEmail, solicitudes }: {
  sucursal: string; rows: SugerenciaRow[]; expanded: boolean; onToggle: () => void
  showToast: (msg: string, tipo?: 'ok' | 'err') => void; userEmail: string; solicitudes: SdSolicitud[]
}) {
  const sinStock = rows.filter(r => r.cobertura === 'sin_stock').length
  const parcial  = rows.filter(r => r.cobertura === 'parcial').length
  const cubierto = rows.filter(r => r.cobertura === 'cubierto').length

  return (
    <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: '#f0f0f0' }}>
      <div className="px-4 py-3 flex items-center gap-3 cursor-pointer select-none"
        style={{ background: '#fafbff' }} onClick={onToggle}>
        <span className="font-semibold text-sm" style={{ color: '#254A96' }}>🏬 {sucursal}</span>
        <div className="flex items-center gap-2 flex-wrap">
          {sinStock > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#fde8e8', color: '#E52322' }}>✕ {sinStock} sin stock</span>
          )}
          {parcial > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#fef3c7', color: '#b45309' }}>△ {parcial} parcial</span>
          )}
          {cubierto > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#d1fae5', color: '#065f46' }}>✓ {cubierto} cubierto</span>
          )}
        </div>
        <span className="ml-auto text-xs" style={{ color: '#B9BBB7' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div className="border-t divide-y" style={{ borderColor: '#f0f0f0' }}>
          {rows
            .sort((a, b) => {
              const o: Record<string, number> = { sin_stock: 0, parcial: 1, cubierto: 2 }
              return (o[a.cobertura] ?? 0) - (o[b.cobertura] ?? 0) || a.nombre_producto.localeCompare(b.nombre_producto)
            })
            .map(row => <ProductoRow key={row.id_producto} row={row} showToast={showToast} userEmail={userEmail} solicitudes={solicitudes} />)
          }
        </div>
      )}
    </div>
  )
}

// ─── Fila de producto (vista agregada) ────────────────────────────────────────
function ProductoRow({ row, showToast, userEmail, solicitudes }: {
  row: SugerenciaRow
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  userEmail: string
  solicitudes: SdSolicitud[]
}) {
  const [formTransfer, setFormTransfer] = useState<null | { abierto: true }>(null)
  const [tfCantidad, setTfCantidad] = useState(row.deficit)
  const [tfOrigen, setTfOrigen] = useState(row.sucursal_mejor)
  const [tfFecha, setTfFecha] = useState('')
  const [enviando, setEnviando] = useState(false)

  const cob = {
    cubierto:  { bg: '#d1fae5', color: '#065f46', label: 'Cubierto' },
    parcial:   { bg: '#fef3c7', color: '#b45309', label: 'Cobertura parcial' },
    sin_stock: { bg: '#fde8e8', color: '#E52322', label: 'Sin stock disponible' },
  }[row.cobertura]

  async function crearTransferencia() {
    setEnviando(true)
    try {
      const res = await fetch('/api/requerimientos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'abastecimiento',
          sucursal_origen: tfOrigen,
          sucursal_destino: row.sucursal,
          estado: 'pendiente',
          fecha_req: hoy(),
          fecha_solicitada: tfFecha || null,
          solicitado_por: userEmail,
          items: [{ id_producto: row.id_producto, nombre_producto: row.nombre_producto, cantidad_solicitada: tfCantidad }],
        }),
      })
      if (!res.ok) { const err = await res.json(); throw new Error(err.error ?? 'Error creando transferencia') }
      showToast('✓ Transferencia creada')
      setFormTransfer(null)
    } catch (e: any) {
      showToast(`Error: ${e.message}`, 'err')
    }
    setEnviando(false)
  }

  return (
    <div>
      <div className="flex items-center gap-4 px-4 py-3 flex-wrap"
        style={{ background: row.cobertura === 'sin_stock' ? '#fefafa' : '#fff' }}>

        {/* Nombre + badges */}
        <div className="flex-1 min-w-48">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm"
              style={{ color: row.cobertura === 'sin_stock' ? '#dc2626' : '#1a1a1a',
                       fontWeight: row.cobertura === 'sin_stock' ? 600 : 500 }}>
              {row.nombre_producto}
            </span>
            {row.categoria && (
              <span className="text-xs px-1.5 py-0.5 rounded font-medium"
                style={{ background: '#e8edf8', color: '#254A96' }}>{row.categoria}</span>
            )}
            {!row.activo && (
              <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                style={{ background: '#fef3c7', color: '#b45309' }}>⚠ INACTIVO</span>
            )}
          </div>
          {/* NV + SD IDs */}
          {row.sol_ids.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {row.sol_ids.map(solId => {
                const sol = solicitudes.find(s => s.id === solId)
                if (!sol) return null
                return (
                  <span key={solId} className="text-xs font-mono px-1.5 py-0.5 rounded"
                    style={{ background: '#f0f4ff', color: '#4b6cb7', border: '1px solid #d0daf5' }}>
                    NV&nbsp;{sol.id_venta} · SD&nbsp;{sol.id}
                  </span>
                )
              })}
            </div>
          )}
        </div>

        {/* Cobertura badge */}
        <span className="text-xs px-2.5 py-1 rounded-full font-semibold whitespace-nowrap"
          style={{ background: cob.bg, color: cob.color }}>{cob.label}</span>

        {/* Stats numéricos */}
        <div className="flex items-center gap-5 text-center text-xs shrink-0">
          <div>
            <div className="text-xl font-bold leading-none" style={{ color: '#254A96' }}>{row.demandado}</div>
            <div className="mt-0.5" style={{ color: '#B9BBB7' }}>Demandado</div>
          </div>
          <div>
            <div className="text-xl font-bold leading-none"
              style={{ color: row.stock_local === 0 ? '#E52322' : row.stock_local >= row.demandado ? '#10b981' : '#d97706' }}>
              {row.stock_local}
            </div>
            <div className="mt-0.5" style={{ color: '#B9BBB7' }}>Stock local</div>
          </div>
          {row.deficit > 0 && (
            <div>
              <div className="text-xl font-bold leading-none" style={{ color: '#E52322' }}>{row.deficit}</div>
              <div className="mt-0.5" style={{ color: '#B9BBB7' }}>Déficit</div>
            </div>
          )}
          {row.disponible_otros > 0 && (
            <div>
              <div className="text-xl font-bold leading-none" style={{ color: '#f97316' }}>{row.disponible_otros}</div>
              <div className="mt-0.5" style={{ color: '#B9BBB7' }}>Disp. en {row.sucursal_mejor}</div>
            </div>
          )}
        </div>

        {/* Botón Transferir */}
        {row.cobertura !== 'cubierto' && (
          <button
            onClick={() => {
              if (formTransfer) {
                setFormTransfer(null)
              } else {
                setTfCantidad(row.deficit)
                setTfOrigen(row.sucursal_mejor)
                setTfFecha('')
                setFormTransfer({ abierto: true })
              }
            }}
            className="text-xs px-2.5 py-1 rounded-lg font-semibold shrink-0"
            style={{ background: '#fff7ed', color: '#ea580c', border: '1px solid #fed7aa' }}>
            🔄 Transferir
          </button>
        )}
      </div>

      {/* Formulario inline de transferencia */}
      {formTransfer && (
        <div className="px-4 pb-4 pt-2 border-t" style={{ background: '#fffbf5', borderColor: '#fed7aa' }}>
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: '#ea580c' }}>Cantidad</label>
              <input type="number" min={1} value={tfCantidad}
                onChange={e => setTfCantidad(parseInt(e.target.value) || 1)}
                className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none w-24"
                style={{ borderColor: '#fed7aa' }} />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: '#ea580c' }}>Sucursal origen</label>
              <select value={tfOrigen} onChange={e => setTfOrigen(e.target.value)}
                className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none"
                style={{ borderColor: '#fed7aa' }}>
                <option value="">— Seleccionar —</option>
                {SUCURSALES.filter(s => s !== row.sucursal).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1" style={{ color: '#ea580c' }}>Fecha solicitada</label>
              <input type="date" value={tfFecha} onChange={e => setTfFecha(e.target.value)}
                className="border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none"
                style={{ borderColor: '#fed7aa' }} />
            </div>
            <button
              onClick={crearTransferencia}
              disabled={enviando || !tfOrigen}
              className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: '#10b981' }}>
              {enviando ? 'Creando…' : 'Crear transferencia'}
            </button>
            <button
              onClick={() => setFormTransfer(null)}
              className="px-3 py-1.5 rounded-lg text-sm font-medium"
              style={{ background: '#f4f4f3', color: '#666' }}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB: REQUERIMIENTOS (Transferencias / En tránsito / Historial)
// ═══════════════════════════════════════════════════════════════════════════════
function TabRequerimientos({ filtroEstados, rol, showToast, userEmail }: {
  filtroEstados: string[]
  rol: string
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  userEmail: string
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

  const puedeEditar = rol === 'deposito' || rol === 'gerencia'
  // Cantidad aprobada solo editable en estado pendiente — después se bloquea
  const puedeEditarCantidad = puedeEditar && detalle?.estado === 'pendiente'
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
        {filtroEstados.includes('pendiente') && (
          <button onClick={abrirModalNueva}
            className="px-3 py-1.5 text-sm font-semibold text-white rounded-lg shrink-0"
            style={{ background: '#254A96' }}>
            + Nueva
          </button>
        )}
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
          puedeEditarCantidad={puedeEditarCantidad}
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
                  <span className="text-xs" style={{ color: '#B9BBB7' }}>Código ID del producto (del ERP) → nombre se completa solo</span>
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
                        <input
                          value={item.nombre}
                          onChange={e => setNfItems(prev => prev.map((it, i) => i === idx ? { ...it, nombre: e.target.value } : it))}
                          placeholder={item.buscando ? 'Buscando…' : 'Nombre del producto'}
                          disabled={item.buscando}
                          className="flex-1 border rounded-lg px-2.5 py-1.5 text-sm focus:outline-none"
                          style={{
                            borderColor: '#e8edf8',
                            background: item.id_producto ? '#f0fdf4' : 'white',
                            color: item.id_producto ? '#166534' : undefined,
                          }}
                        />
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

function ModalDetalleReq({ req, rol, guardando, puedeEditar, puedeEditarCantidad, editItems, editNotas, editNViaje, editVehiculo, editFechaRec, editTipoEntrega,
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
              {req.requerimiento_items?.map((item: ReqItem) => {
                const qtyAprobada = editItems[item.id] ?? item.cantidad_aprobada ?? item.cantidad_solicitada
                const isOver = item.cantidad_solicitada != null && Number(qtyAprobada) > item.cantidad_solicitada
                return (
                  <div key={item.id} className="rounded-lg px-3 py-2"
                    style={{ background: isOver ? '#fde8e8' : '#f9f9f9', border: `1px solid ${isOver ? '#fca5a5' : '#f0f0f0'}` }}>
                    <p className="text-sm font-medium" style={isOver ? { color: '#dc2626', fontWeight: 600 } : {}}>
                      {item.nombre_producto}
                    </p>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-xs" style={{ color: '#B9BBB7' }}>Solicitado: <strong>{item.cantidad_solicitada}</strong></span>
                      {puedeEditarCantidad ? (
                        <label className="text-xs flex items-center gap-1.5" style={{ color: isOver ? '#dc2626' : '#0f766e' }}>
                          Aprobado:
                          <input type="number" min={0}
                            value={qtyAprobada}
                            onChange={e => setEditItems((prev: any) => ({ ...prev, [item.id]: parseInt(e.target.value) || 0 }))}
                            className="w-16 border rounded px-1.5 py-0.5 text-xs focus:outline-none font-bold text-center"
                            style={{ borderColor: isOver ? '#fca5a5' : '#e8edf8', color: isOver ? '#dc2626' : undefined }} />
                          {isOver && <span className="px-1.5 py-0.5 rounded text-xs font-bold" style={{ background: '#dc2626', color: '#fff' }}>⬆</span>}
                        </label>
                      ) : item.cantidad_aprobada != null ? (
                        <span className="text-xs font-semibold flex items-center gap-1" style={{ color: isOver ? '#dc2626' : '#0f766e' }}>
                          Aprobado: {item.cantidad_aprobada}
                          {isOver && <span className="px-1.5 py-0.5 rounded text-xs font-bold" style={{ background: '#dc2626', color: '#fff' }}>⬆</span>}
                        </span>
                      ) : null}
                    </div>
                  </div>
                )
              })}
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
