'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { tieneAcceso } from '../lib/permisos'

function hoy() { return new Date().toISOString().split('T')[0] }
function mesActual() { return new Date().toISOString().slice(0, 7) }

function pct(valor: number, max: number) {
  if (!max) return 0
  return Math.min(100, Math.round((valor / max) * 100))
}

function colorSemaforo(p: number) {
  if (p >= 70) return { bg: '#d1fae5', color: '#065f46', label: 'Alto' }
  if (p >= 40) return { bg: '#fef3c7', color: '#b45309', label: 'Medio' }
  return { bg: '#fde8e8', color: '#E52322', label: 'Bajo' }
}

function colorBarra(p: number) {
  return p >= 90 ? '#E52322' : p >= 70 ? '#10b981' : p >= 40 ? '#f59e0b' : '#B9BBB7'
}

function formatHora(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

function duracion(inicio: string | null, fin: string | null): string {
  if (!inicio || !fin) return '—'
  const min = Math.round((new Date(fin).getTime() - new Date(inicio).getTime()) / 60000)
  const hs = Math.floor(min / 60); const m = min % 60
  return hs > 0 ? `${hs}h ${m}min` : `${m}min`
}

function minKm(inicio: string | null, fin: string | null, km: number | null): string {
  if (!inicio || !fin || !km || km === 0) return '—'
  const min = (new Date(fin).getTime() - new Date(inicio).getTime()) / 60000
  return `${(min / km).toFixed(1)}`
}

function distanciaKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const DEPOSITOS: Record<string, { lat: number; lng: number }> = {
  'LP520':    { lat: -34.965403, lng: -58.06488 },
  'LP139':    { lat: -34.914872, lng: -58.023912 },
  'Guernica': { lat: -34.91118,  lng: -58.39945 },
  'Cañuelas': { lat: -35.0001,   lng: -58.44506 },
  'Pinamar':  { lat: -37.207852, lng: -56.972302 },
}

const VUELTA_LABEL: Record<number, string> = {
  1: 'V1 · 8–10hs', 2: 'V2 · 10–12hs', 3: 'V3 · 13–15hs',
  4: 'V4 · 15–17hs', 5: 'V5 · Fuera de hora',
}

function calcularDistanciaRuta(pedidos: { latitud: number | null; longitud: number | null; orden_entrega: number | null }[], depot: { lat: number; lng: number }): number {
  const conUbicacion = pedidos
    .filter(p => p.latitud && p.longitud)
    .sort((a, b) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))
  if (conUbicacion.length === 0) return 0
  let dist = 0
  let latPrev = depot.lat, lngPrev = depot.lng
  for (const p of conUbicacion) {
    dist += distanciaKm(latPrev, lngPrev, p.latitud!, p.longitud!)
    latPrev = p.latitud!; lngPrev = p.longitud!
  }
  // vuelta al depósito
  dist += distanciaKm(latPrev, lngPrev, depot.lat, depot.lng)
  return Math.round(dist)
}

interface PedidoDetalle {
  id: string
  nv: string
  cliente: string
  direccion: string
  sucursal: string
  estado: string
  peso_total_kg: number
  volumen_total_m3: number
  orden_entrega: number | null
}

interface DatosVuelta {
  vuelta: number
  pedidos: number
  posicionesUsadas: number
  kgUsados: number
  pctPos: number
  pctKg: number
  distanciaKm: number
  pedidosConUbicacion: number
  detalle: PedidoDetalle[]
}

interface DatosCamionDia {
  camion_codigo: string
  tipo_unidad: string
  sucursal: string
  posiciones_total: number
  tonelaje_max_kg: number
  chofer_nombre: string
  posicionesUsadas: number
  kgUsados: number
  pedidos: number
  pctPos: number
  pctKg: number
  capacidadKgDia: number
  capacidadPosDia: number
  hora_inicio: string | null
  hora_fin: string | null
  km_ruta: number | null
  vueltas: DatosVuelta[]
  distanciaTotalKm: number
}

interface DatosCamionMes {
  camion_codigo: string
  tipo_unidad: string
  sucursal: string
  posiciones_total: number
  tonelaje_max_kg: number
  diasActivo: number
  avgPctPos: number
  avgPctKg: number
  totalKm: number
  avgMinKm: string
}

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

export default function MetricasPage() {
  const router = useRouter()
  const [vista, setVista] = useState<'diaria' | 'mensual'>('diaria')
  const [fecha, setFecha] = useState(hoy())
  const [mes, setMes] = useState(mesActual())
  const [filtroSucursal, setFiltroSucursal] = useState('')
  const [loading, setLoading] = useState(false)
  const [datosDia, setDatosDia] = useState<DatosCamionDia[]>([])
  const [datosMes, setDatosMes] = useState<DatosCamionMes[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol, permisos, sucursal').eq('id', user.id).single()
      if (!tieneAcceso(data?.permisos, data?.rol, 'metricas')) { router.push('/dashboard'); return }
      if (data?.sucursal) {
        setFiltroSucursal(data.sucursal)
        // Recargar con la sucursal del usuario (el useEffect inicial usó '')
        if (vista === 'diaria') cargarDiaria(data.sucursal)
        else cargarMensual(data.sucursal)
      }
    })
  }, [])

  useEffect(() => { if (vista === 'diaria') cargarDiaria() }, [fecha, vista])
  useEffect(() => { if (vista === 'mensual') cargarMensual() }, [mes, vista])

  const buscar = () => {
    if (vista === 'diaria') cargarDiaria()
    else cargarMensual()
  }

  const cargarDiaria = async (sucursalParam?: string) => {
    setLoading(true)
    const sucursal = sucursalParam !== undefined ? sucursalParam : filtroSucursal

    const [{ data: flotaDia }, { data: pedidosData }, { data: camionesData }] = await Promise.all([
      supabase.from('flota_dia').select('camion_codigo, chofer_id, hora_inicio, hora_fin, km_ruta').eq('fecha', fecha).eq('activo', true),
      supabase.from('pedidos')
        .select('id, nv, cliente, direccion, sucursal, estado, camion_id, peso_total_kg, volumen_total_m3, vuelta, orden_entrega, latitud, longitud')
        .eq('fecha_entrega', fecha).neq('estado', 'cancelado').not('camion_id', 'is', null),
      supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg'),
    ])

    const choferIds = (flotaDia ?? []).filter((f: any) => f.chofer_id).map((f: any) => f.chofer_id)
    const { data: choferes } = choferIds.length > 0
      ? await supabase.from('usuarios').select('id, nombre').in('id', choferIds)
      : { data: [] }

    const choferMap: Record<string, string> = {}
    ;(choferes ?? []).forEach((c: any) => { choferMap[c.id] = c.nombre })

    const camionMap: Record<string, any> = {}
    ;(camionesData ?? []).forEach((c: any) => { camionMap[c.codigo] = c })

    // Index flota_dia by camion_codigo for fast lookup
    const flotaDiaMap: Record<string, any> = {}
    ;(flotaDia ?? []).forEach((f: any) => { flotaDiaMap[f.camion_codigo] = f })

    // Build the set of camion codes to display:
    // union of flota_dia entries AND camion_ids that have pedidos for this date.
    // This ensures a truck with confirmed programming shows even if it has no flota_dia entry.
    const camionCodigosSet = new Set<string>()
    ;(flotaDia ?? []).forEach((f: any) => camionCodigosSet.add(f.camion_codigo))
    ;(pedidosData ?? []).forEach((p: any) => { if (p.camion_id) camionCodigosSet.add(p.camion_id) })

    const buildCamionData = (camionCodigo: string): DatosCamionDia | null => {
      const camion = camionMap[camionCodigo]
      if (!camion) return null
      if (sucursal && camion.sucursal !== sucursal) return null

      const f = flotaDiaMap[camionCodigo] ?? null
      const pedidosCamion = (pedidosData ?? []).filter((p: any) => p.camion_id === camionCodigo)
      const kgUsados = pedidosCamion.reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
      const posicionesUsadas = pedidosCamion.reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
      const depot = DEPOSITOS[camion.sucursal] ?? { lat: -34.9205, lng: -57.9536 }

      const vueltasSet = [...new Set(pedidosCamion.map((p: any) => p.vuelta as number))].sort((a, b) => a - b)
      const vueltas: DatosVuelta[] = vueltasSet.map(v => {
        const pv = pedidosCamion.filter((p: any) => p.vuelta === v)
        const kg = pv.reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
        const pos = pv.reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
        const dist = calcularDistanciaRuta(pv, depot)
        return {
          vuelta: v,
          pedidos: pv.length,
          kgUsados: kg,
          posicionesUsadas: pos,
          pctKg: pct(kg, camion.tonelaje_max_kg),
          pctPos: pct(pos, camion.posiciones_total),
          distanciaKm: dist,
          pedidosConUbicacion: pv.filter((p: any) => p.latitud && p.longitud).length,
          detalle: pv
            .sort((a: any, b: any) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))
            .map((p: any) => ({
              id: p.id, nv: p.nv, cliente: p.cliente, direccion: p.direccion,
              sucursal: p.sucursal, estado: p.estado,
              peso_total_kg: p.peso_total_kg ?? 0, volumen_total_m3: p.volumen_total_m3 ?? 0,
              orden_entrega: p.orden_entrega,
            })),
        }
      })

      const distanciaTotalKm = calcularDistanciaRuta(pedidosCamion, depot)
      const numVueltas = vueltas.length || 1
      const capacidadKgDia = camion.tonelaje_max_kg * numVueltas
      const capacidadPosDia = camion.posiciones_total * numVueltas

      return {
        camion_codigo: camionCodigo,
        tipo_unidad: camion.tipo_unidad,
        sucursal: camion.sucursal,
        posiciones_total: camion.posiciones_total,
        tonelaje_max_kg: camion.tonelaje_max_kg,
        chofer_nombre: f?.chofer_id ? (choferMap[f.chofer_id] ?? 'Sin nombre') : 'Sin chofer',
        posicionesUsadas,
        kgUsados,
        pedidos: pedidosCamion.length,
        pctPos: pct(posicionesUsadas, capacidadPosDia),
        pctKg: pct(kgUsados, capacidadKgDia),
        capacidadKgDia,
        capacidadPosDia,
        hora_inicio: f?.hora_inicio ?? null,
        hora_fin: f?.hora_fin ?? null,
        km_ruta: f?.km_ruta ?? null,
        vueltas,
        distanciaTotalKm,
      }
    }

    let datos: DatosCamionDia[] = [...camionCodigosSet]
      .map(buildCamionData)
      .filter(Boolean) as DatosCamionDia[]

    setDatosDia(datos.sort((a, b) => b.pctKg - a.pctKg))
    setLoading(false)
  }

  const cargarMensual = async (sucursalParam?: string) => {
    setLoading(true)
    const sucursal = sucursalParam !== undefined ? sucursalParam : filtroSucursal
    const fechaInicio = `${mes}-01`
    const fechaFin = `${mes}-31`

    const [{ data: flotaMes }, { data: pedidosMes }, { data: camionesData }] = await Promise.all([
      supabase.from('flota_dia').select('fecha, camion_codigo, hora_inicio, hora_fin, km_ruta').gte('fecha', fechaInicio).lte('fecha', fechaFin).eq('activo', true),
      supabase.from('pedidos').select('camion_id, fecha_entrega, peso_total_kg, volumen_total_m3').gte('fecha_entrega', fechaInicio).lte('fecha_entrega', fechaFin).neq('estado', 'cancelado').not('camion_id', 'is', null),
      supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg'),
    ])

    const camionMap: Record<string, any> = {}
    ;(camionesData ?? []).forEach((c: any) => { camionMap[c.codigo] = c })

    const porCamion: Record<string, { flotaDias: any[]; pedidosDias: any[] }> = {}
    ;(flotaMes ?? []).forEach((f: any) => {
      if (!porCamion[f.camion_codigo]) porCamion[f.camion_codigo] = { flotaDias: [], pedidosDias: [] }
      porCamion[f.camion_codigo].flotaDias.push(f)
    })
    ;(pedidosMes ?? []).forEach((p: any) => {
      if (!p.camion_id || !porCamion[p.camion_id]) return
      porCamion[p.camion_id].pedidosDias.push(p)
    })

    const datos: DatosCamionMes[] = Object.entries(porCamion).map(([codigo, { flotaDias, pedidosDias }]) => {
      const camion = camionMap[codigo]
      if (!camion) return null
      if (sucursal && camion.sucursal !== sucursal) return null
      const diasActivo = flotaDias.length
      const totalKm = flotaDias.reduce((a, f) => a + (f.km_ruta ?? 0), 0)
      let sumPctPos = 0; let sumPctKg = 0; let sumMinKm = 0; let diasConTiempo = 0
      flotaDias.forEach(f => {
        const pedidosDia = pedidosDias.filter(p => p.fecha_entrega === f.fecha)
        const kg = pedidosDia.reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
        const pos = pedidosDia.reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
        sumPctKg += pct(kg, camion.tonelaje_max_kg)
        sumPctPos += pct(pos, camion.posiciones_total)
        if (f.hora_inicio && f.hora_fin && f.km_ruta) {
          const min = (new Date(f.hora_fin).getTime() - new Date(f.hora_inicio).getTime()) / 60000
          sumMinKm += min / f.km_ruta; diasConTiempo++
        }
      })
      return {
        camion_codigo: codigo, tipo_unidad: camion.tipo_unidad, sucursal: camion.sucursal,
        posiciones_total: camion.posiciones_total, tonelaje_max_kg: camion.tonelaje_max_kg,
        diasActivo, avgPctPos: diasActivo > 0 ? Math.round(sumPctPos / diasActivo) : 0,
        avgPctKg: diasActivo > 0 ? Math.round(sumPctKg / diasActivo) : 0,
        totalKm: Math.round(totalKm),
        avgMinKm: diasConTiempo > 0 ? (sumMinKm / diasConTiempo).toFixed(1) : '—',
      }
    }).filter(Boolean) as DatosCamionMes[]

    setDatosMes(datos.sort((a, b) => b.avgPctKg - a.avgPctKg))
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: '#254A96' }}>✓ {toast}</div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push('/dashboard')}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</button>
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Métricas de flota</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setVista('diaria')}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{ background: vista === 'diaria' ? '#254A96' : '#f4f4f3', color: vista === 'diaria' ? 'white' : '#666' }}>
              Diaria
            </button>
            <button onClick={() => setVista('mensual')}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{ background: vista === 'mensual' ? '#254A96' : '#f4f4f3', color: vista === 'mensual' ? 'white' : '#666' }}>
              Mensual
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto px-4 md:px-6 py-6">

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6">
          <div className="flex flex-wrap gap-3 items-end">
            {vista === 'diaria' ? (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha</label>
                <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && buscar()}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Mes</label>
                <input type="month" value={mes} onChange={e => setMes(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Sucursal</label>
              <select value={filtroSucursal} onChange={e => setFiltroSucursal(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="">Todas</option>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <button onClick={buscar}
              className="px-5 py-2 rounded-lg text-sm font-semibold text-white"
              style={{ background: '#254A96' }}>
              Buscar
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : vista === 'diaria' ? (
          <VistaDiaria datos={datosDia} fecha={fecha} />
        ) : (
          <VistaMensual datos={datosMes} mes={mes} />
        )}
      </main>
    </div>
  )
}

// ─── Vista Diaria ────────────────────────────────────────────────────────────────

const ESTADO_COLOR: Record<string, { bg: string; color: string }> = {
  pendiente:    { bg: '#fef3c7', color: '#b45309' },
  conf_stock:   { bg: '#dbeafe', color: '#1d4ed8' },
  preparacion:  { bg: '#ede9fe', color: '#7c3aed' },
  en_transito:  { bg: '#d1fae5', color: '#065f46' },
  entregado:    { bg: '#d1fae5', color: '#065f46' },
  programado:   { bg: '#e8edf8', color: '#254A96' },
  rechazado:    { bg: '#fde8e8', color: '#E52322' },
}

function VistaDiaria({ datos, fecha }: { datos: DatosCamionDia[]; fecha: string }) {
  const [filtroFlota, setFiltroFlota] = useState<'todos' | 'con_pedidos' | 'sin_pedidos'>('todos')
  const [modalVuelta, setModalVuelta] = useState<{ camion: string; vuelta: DatosVuelta } | null>(null)

  if (datos.length === 0) return (
    <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
      <div className="text-5xl mb-4">🚛</div>
      <p className="font-medium">No hay flota configurada para esta fecha</p>
      <p className="text-sm mt-1">Creá la flota del día primero desde el módulo de Flota del día</p>
    </div>
  )

  const datosFiltrados = filtroFlota === 'con_pedidos' ? datos.filter(d => d.pedidos > 0)
    : filtroFlota === 'sin_pedidos' ? datos.filter(d => d.pedidos === 0)
    : datos

  const totalPedidos = datosFiltrados.reduce((a, d) => a + d.pedidos, 0)
  const avgPctKg = datosFiltrados.length > 0 ? Math.round(datosFiltrados.reduce((a, d) => a + d.pctKg, 0) / datosFiltrados.length) : 0
  const avgPctPos = datosFiltrados.length > 0 ? Math.round(datosFiltrados.reduce((a, d) => a + d.pctPos, 0) / datosFiltrados.length) : 0
  const totalDistancia = datosFiltrados.reduce((a, d) => a + d.distanciaTotalKm, 0)

  const conPedidos = datos.filter(d => d.pedidos > 0).length
  const sinPedidos = datos.filter(d => d.pedidos === 0).length

  return (
    <div className="space-y-4">

      {/* Filtro con/sin pedidos */}
      <div className="flex items-center gap-2">
        {([
          { key: 'todos', label: `Todos (${datos.length})` },
          { key: 'con_pedidos', label: `Con pedidos (${conPedidos})` },
          { key: 'sin_pedidos', label: `Sin pedidos (${sinPedidos})` },
        ] as const).map(f => (
          <button key={f.key} onClick={() => setFiltroFlota(f.key)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{
              background: filtroFlota === f.key ? '#254A96' : '#f4f4f3',
              color: filtroFlota === f.key ? 'white' : '#666',
            }}>
            {f.label}
          </button>
        ))}
      </div>

      {/* Resumen */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-2">
        {[
          { label: 'Camiones', value: datosFiltrados.length, emoji: '🚛', bg: '#e8edf8', color: '#254A96' },
          { label: 'Total pedidos', value: totalPedidos, emoji: '📦', bg: '#f3e8ff', color: '#7c3aed' },
          { label: 'Ocup. prom. kg', value: `${avgPctKg}%`, emoji: '⚖️', bg: colorSemaforo(avgPctKg).bg, color: colorSemaforo(avgPctKg).color },
          { label: 'Ocup. prom. pos', value: `${avgPctPos}%`, emoji: '📐', bg: colorSemaforo(avgPctPos).bg, color: colorSemaforo(avgPctPos).color },
          { label: 'Dist. total estimada', value: totalDistancia > 0 ? `${totalDistancia} km` : '—', emoji: '📍', bg: '#f0fdf4', color: '#065f46' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm" style={{ border: '1px solid #f0f0f0' }}>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0" style={{ background: s.bg }}>{s.emoji}</div>
            <div>
              <p className="text-xl font-bold leading-none" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Cards por camión */}
      {datosFiltrados.map(d => {
        const semaforo = colorSemaforo(Math.max(d.pctKg, d.pctPos))
        return (
          <div key={d.camion_codigo} className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f0f0f0' }}>
            {/* Header */}
            <div className="px-4 py-3 flex items-center justify-between" style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold" style={{ background: '#254A96' }}>🚛</div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm" style={{ color: '#1a1a1a' }}>{d.camion_codigo}</span>
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>{d.tipo_unidad}</span>
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>📍 {d.sucursal}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: semaforo.bg, color: semaforo.color }}>
                      {Math.max(d.pctKg, d.pctPos)}% ocupación
                    </span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                    👤 {d.chofer_nombre} · 📦 {d.pedidos} pedidos
                    {d.distanciaTotalKm > 0 && <> · 📍 ~{d.distanciaTotalKm} km estimados</>}
                  </p>
                </div>
              </div>
            </div>

            <div className="p-4 space-y-4">
              {/* Ocupación total */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-medium" style={{ color: '#666' }}>⚖️ Peso total</span>
                    <span className="text-xs font-bold" style={{ color: colorSemaforo(d.pctKg).color }}>{d.pctKg}%</span>
                  </div>
                  <div className="w-full h-3 rounded-full" style={{ background: '#f0f0f0' }}>
                    <div className="h-3 rounded-full transition-all" style={{ width: `${Math.min(d.pctKg, 100)}%`, background: colorBarra(d.pctKg) }} />
                  </div>
                  <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>
                    {Math.round(d.kgUsados).toLocaleString('es-AR')} / {d.capacidadKgDia.toLocaleString('es-AR')} kg
                    {d.vueltas.length > 1 && <span style={{ color: '#254A96' }}> · {d.vueltas.length}×</span>}
                  </p>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-xs font-medium" style={{ color: '#666' }}>📦 Posiciones total</span>
                    <span className="text-xs font-bold" style={{ color: colorSemaforo(d.pctPos).color }}>{d.pctPos}%</span>
                  </div>
                  <div className="w-full h-3 rounded-full" style={{ background: '#f0f0f0' }}>
                    <div className="h-3 rounded-full transition-all" style={{ width: `${Math.min(d.pctPos, 100)}%`, background: colorBarra(d.pctPos) }} />
                  </div>
                  <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>
                    {Math.round(d.posicionesUsadas)} / {d.capacidadPosDia} pos
                    {d.vueltas.length > 1 && <span style={{ color: '#254A96' }}> · {d.vueltas.length}×</span>}
                  </p>
                </div>
              </div>

              {/* Desglose por vuelta */}
              {d.vueltas.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-2" style={{ color: '#B9BBB7' }}>DESGLOSE POR VUELTA</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                    {d.vueltas.map(v => (
                      <div key={v.vuelta} className="rounded-xl p-3 space-y-2" style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold" style={{ color: '#254A96' }}>{VUELTA_LABEL[v.vuelta] ?? `V${v.vuelta}`}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-xs" style={{ color: '#B9BBB7' }}>{v.pedidos} pedido{v.pedidos !== 1 ? 's' : ''}</span>
                            <button
                              onClick={() => setModalVuelta({ camion: d.camion_codigo, vuelta: v })}
                              className="text-xs px-2 py-0.5 rounded-lg font-semibold"
                              style={{ background: '#e8edf8', color: '#254A96' }}
                            >
                              Ver →
                            </button>
                          </div>
                        </div>
                        {/* Barra kg */}
                        <div>
                          <div className="flex justify-between text-xs mb-0.5" style={{ color: '#B9BBB7' }}>
                            <span>⚖️ {Math.round(v.kgUsados).toLocaleString('es-AR')} kg</span>
                            <span style={{ color: colorBarra(v.pctKg), fontWeight: 600 }}>{v.pctKg}%</span>
                          </div>
                          <div className="w-full h-2 rounded-full" style={{ background: '#e8edf8' }}>
                            <div className="h-2 rounded-full" style={{ width: `${Math.min(v.pctKg, 100)}%`, background: colorBarra(v.pctKg) }} />
                          </div>
                        </div>
                        {/* Barra pos */}
                        <div>
                          <div className="flex justify-between text-xs mb-0.5" style={{ color: '#B9BBB7' }}>
                            <span>📦 {Math.round(v.posicionesUsadas)} pos</span>
                            <span style={{ color: colorBarra(v.pctPos), fontWeight: 600 }}>{v.pctPos}%</span>
                          </div>
                          <div className="w-full h-2 rounded-full" style={{ background: '#e8edf8' }}>
                            <div className="h-2 rounded-full" style={{ width: `${Math.min(v.pctPos, 100)}%`, background: colorBarra(v.pctPos) }} />
                          </div>
                        </div>
                        {/* Distancia */}
                        <div className="flex items-center justify-between text-xs pt-1" style={{ borderTop: '1px solid #e8edf8' }}>
                          <span style={{ color: '#B9BBB7' }}>
                            📍 {v.distanciaKm > 0 ? `~${v.distanciaKm} km` : 'Sin coordenadas'}
                          </span>
                          {v.pedidosConUbicacion < v.pedidos && v.distanciaKm > 0 && (
                            <span style={{ color: '#f59e0b' }}>({v.pedidosConUbicacion}/{v.pedidos} con ubic.)</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tiempos de ruta */}
              {(d.hora_inicio || d.km_ruta) && (
                <div className="grid grid-cols-4 gap-2 pt-2" style={{ borderTop: '1px solid #f0f0f0' }}>
                  {[
                    { label: 'Inicio', value: formatHora(d.hora_inicio) },
                    { label: 'Fin', value: formatHora(d.hora_fin) },
                    { label: 'Duración', value: duracion(d.hora_inicio, d.hora_fin) },
                    { label: 'Min/km', value: minKm(d.hora_inicio, d.hora_fin, d.km_ruta) + (minKm(d.hora_inicio, d.hora_fin, d.km_ruta) !== '—' ? ' min/km' : '') },
                  ].map(item => (
                    <div key={item.label} className="rounded-lg p-2 text-center" style={{ background: '#f4f4f3' }}>
                      <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>{item.label}</p>
                      <p className="text-xs font-bold" style={{ color: '#254A96' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {/* Modal pedidos de vuelta */}
      {modalVuelta && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={() => setModalVuelta(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden"
            style={{ maxWidth: 680, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: '#f0f0f0' }}>
              <div>
                <p className="font-bold text-sm" style={{ color: '#254A96' }}>
                  🚛 {modalVuelta.camion} — {VUELTA_LABEL[modalVuelta.vuelta.vuelta] ?? `V${modalVuelta.vuelta.vuelta}`}
                </p>
                <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                  {modalVuelta.vuelta.pedidos} pedido{modalVuelta.vuelta.pedidos !== 1 ? 's' : ''} ·
                  {' '}{Math.round(modalVuelta.vuelta.kgUsados).toLocaleString('es-AR')} kg ·
                  {' '}{Math.round(modalVuelta.vuelta.posicionesUsadas)} pos
                  {modalVuelta.vuelta.distanciaKm > 0 && <> · ~{modalVuelta.vuelta.distanciaKm} km</>}
                </p>
              </div>
              <button
                onClick={() => setModalVuelta(null)}
                className="text-xl leading-none px-2"
                style={{ color: '#B9BBB7' }}
              >×</button>
            </div>

            {/* Table */}
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
                    {['#', 'NV', 'Cliente', 'Destino', 'Kg', 'Pos', 'Estado'].map(h => (
                      <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modalVuelta.vuelta.detalle.map((p, i) => {
                    const sem = ESTADO_COLOR[p.estado] ?? { bg: '#f4f4f3', color: '#666' }
                    return (
                      <tr key={p.id} style={{ borderBottom: '1px solid #f9f9f9', background: i % 2 === 0 ? 'white' : '#fdfdfd' }}>
                        <td className="px-4 py-2.5 text-xs" style={{ color: '#B9BBB7' }}>{p.orden_entrega ?? i + 1}</td>
                        <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap" style={{ color: '#254A96' }}>{p.nv}</td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs font-medium" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
                          <p className="text-xs" style={{ color: '#B9BBB7' }}>{p.direccion}</p>
                        </td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>{p.sucursal}</td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap" style={{ color: '#1a1a1a' }}>
                          {Math.round(p.peso_total_kg).toLocaleString('es-AR')} kg
                        </td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap" style={{ color: '#1a1a1a' }}>
                          {Math.round(p.volumen_total_m3)} pos
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap"
                            style={{ background: sem.bg, color: sem.color }}>
                            {p.estado}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Vista Mensual ───────────────────────────────────────────────────────────────

function VistaMensual({ datos, mes }: { datos: DatosCamionMes[]; mes: string }) {
  const nombreMes = new Date(mes + '-15').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })

  if (datos.length === 0) return (
    <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
      <div className="text-5xl mb-4">📅</div>
      <p className="font-medium">No hay datos para {nombreMes}</p>
    </div>
  )

  const ociosos = datos.filter(d => d.avgPctKg < 40)

  return (
    <div className="space-y-4">
      {ociosos.length > 0 && (
        <div className="bg-white rounded-xl p-4 shadow-sm" style={{ border: '2px solid #fde8e8' }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">⚠️</span>
            <span className="font-semibold text-sm" style={{ color: '#E52322' }}>Flota ociosa detectada ({nombreMes})</span>
          </div>
          <p className="text-xs mb-3" style={{ color: '#B9BBB7' }}>Los siguientes camiones tuvieron menos del 40% de ocupación promedio:</p>
          <div className="flex flex-wrap gap-2">
            {ociosos.map(d => (
              <span key={d.camion_codigo} className="text-xs px-3 py-1.5 rounded-full font-medium"
                style={{ background: '#fde8e8', color: '#E52322' }}>
                🚛 {d.camion_codigo} — {d.avgPctKg}% prom.
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f0f0f0' }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>
            Rendimiento por camión — {nombreMes}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
                {['Camión', 'Sucursal', 'Días activo', 'Ocup. kg', 'Ocup. pos', 'Total km', 'Min/km prom', 'Estado'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datos.map((d, i) => {
                const sem = colorSemaforo(d.avgPctKg)
                return (
                  <tr key={d.camion_codigo} style={{ borderBottom: '1px solid #f9f9f9', background: i % 2 === 0 ? 'white' : '#fdfdfd' }}>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-bold text-sm" style={{ color: '#254A96' }}>{d.camion_codigo}</p>
                        <p className="text-xs" style={{ color: '#B9BBB7' }}>{d.tipo_unidad}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>{d.sucursal}</td>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: '#1a1a1a' }}>{d.diasActivo}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 rounded-full" style={{ background: '#f0f0f0' }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.min(d.avgPctKg, 100)}%`, background: colorBarra(d.avgPctKg) }} />
                        </div>
                        <span className="text-xs font-semibold whitespace-nowrap" style={{ color: colorBarra(d.avgPctKg) }}>{d.avgPctKg}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 rounded-full" style={{ background: '#f0f0f0' }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.min(d.avgPctPos, 100)}%`, background: colorBarra(d.avgPctPos) }} />
                        </div>
                        <span className="text-xs font-semibold whitespace-nowrap" style={{ color: colorBarra(d.avgPctPos) }}>{d.avgPctPos}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium whitespace-nowrap" style={{ color: '#1a1a1a' }}>
                      {d.totalKm > 0 ? `${d.totalKm} km` : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                      {d.avgMinKm !== '—' ? `${d.avgMinKm} min/km` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-1 rounded-full font-semibold whitespace-nowrap" style={{ background: sem.bg, color: sem.color }}>
                        {sem.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
