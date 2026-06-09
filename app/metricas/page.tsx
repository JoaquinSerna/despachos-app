'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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

const VUELTAS_MAX_DEFAULT: Record<string, number> = {
  'LP520': 4, 'Guernica': 4,
  'LP139': 3, 'Cañuelas': 3, 'Pinamar': 3,
}

/** Velocidad promedio de traslado para estimación de fallback (cuando Valhalla no responde).
 *  Pinamar tiene rutas de ruta nacional con poco tráfico; el resto trabaja en ciudad/periferia. */
const VEL_FALLBACK_KMH: Record<string, number> = {
  'Pinamar': 40,
}
const VEL_FALLBACK_DEFAULT = 25
function getVelFallback(sucursal: string): number {
  return VEL_FALLBACK_KMH[sucursal] ?? VEL_FALLBACK_DEFAULT
}

/** Calcula vueltas_max efectivas considerando km por vuelta, límite diario y día de semana */
function calcVueltasMaxEfectivas(sucursal: string, vueltasRealizadas: number, distanciaKmTotal: number, kmMaxDia: number, fecha?: string): number {
  // Sábados: máximo 2 vueltas (trabajo hasta mediodía)
  const esSabadoFecha = fecha ? new Date(fecha + 'T12:00:00').getDay() === 6 : false
  const defaultMax = esSabadoFecha ? 2 : (VUELTAS_MAX_DEFAULT[sucursal] ?? 3)
  if (vueltasRealizadas === 0 || distanciaKmTotal === 0) return defaultMax
  const kmPorVuelta = distanciaKmTotal / vueltasRealizadas
  const maxPorKm = Math.floor(kmMaxDia / kmPorVuelta)
  return Math.max(1, Math.min(defaultMax, maxPorKm))
}

/** Ocupación diaria estimada (0-100) */
function calcOcupDiaria(
  posUsadas: number, kgUsados: number,
  posTotal: number, tonelajeMax: number,
  vueltasRealizadas: number, vueltasMaxEfectivas: number,
): { pctPos: number; pctKg: number } {
  if (vueltasMaxEfectivas === 0) return { pctPos: 0, pctKg: 0 }
  const capPosDia = posTotal * vueltasMaxEfectivas
  const capKgDia  = tonelajeMax * vueltasMaxEfectivas
  return {
    pctPos: pct(posUsadas, capPosDia),
    pctKg:  pct(kgUsados,  capKgDia),
  }
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
  'Cañuelas': { lat: -35.0004012, lng: -58.7474278 },
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

function formatMinutos(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h > 0) return m > 0 ? `${h}h ${m}min` : `${h}h`
  return `${m}min`
}

const TIPOS_CARGA_HIERRO = new Set(['hierro_suelto', 'chapa', 'pretensado'])
const TIPOS_CARGA_GRANEL = new Set(['granel'])

function calcularTiempoDescargaMin(pedidos: PedidoDetalle[], esTrailer: boolean): number {
  if (pedidos.length === 0) return 0
  // Hierros (barras, chapas, pretensado): descarga única 20 min para todos los hierros de la vuelta
  const tieneHierros = pedidos.some(p => p.esHierros)
  const hierrosMin = tieneHierros ? 20 : 0
  // Granel (volcador/bolsonería): 5 min por pedido granel (descarga rápida, sin contar posiciones)
  const granelMin = pedidos.filter(p => p.esGranel).length * 5
  // Pallets/bolsones: 3 min/pos por pedido, con reglas de barrio cerrado
  let palletMin = 0
  for (const p of pedidos.filter(q => !q.esHierros && !q.esGranel)) {
    const pos = p.volumen_total_m3 ?? 0
    if (pos <= 0) continue
    if (p.barrio_cerrado) {
      const nIngresos = Math.ceil(pos / 3)
      const esperaPorIngreso = esTrailer ? 15 : 10   // +5 por desenganche si trailer
      palletMin += nIngresos * esperaPorIngreso + pos * 3
    } else {
      palletMin += pos * 3
    }
  }
  // 5 min por parada única (mismo cliente + misma dirección = misma parada)
  const paradasUnicas = new Set(pedidos.map(p => `${p.cliente}||${p.direccion}`)).size
  const paradasMin = paradasUnicas * 5
  return Math.round(hierrosMin + granelMin + palletMin + paradasMin)
}

interface PedidoDetalle {
  id: string
  nv: string
  cliente: string
  direccion: string
  sucursal: string
  estado: string
  estado_pago: string | null
  notas: string | null
  tipo: string | null
  peso_total_kg: number
  volumen_total_m3: number
  orden_entrega: number | null
  latitud: number | null
  longitud: number | null
  barrio_cerrado: boolean | null
  esHierros: boolean
  esGranel: boolean
  hora_entregado: string | null
}

interface DatosVuelta {
  vuelta: number
  pedidos: number
  posicionesUsadas: number
  kgUsados: number
  pctPos: number
  pctKg: number
  distanciaKm: number
  kmReal: boolean          // true = calculado por Valhalla, false = estimado en línea recta
  tiempoTrasladoMin: number | null  // duración de ruta según Valhalla (null hasta que se calcule)
  horaInicioVuelta: string | null   // desde vueltas_tiempos
  horaFinVuelta: string | null      // desde vueltas_tiempos
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
  km_max_dia: number         // desde camiones_flota
  vueltasMaxEfectivas: number
  ocupDiariaPctPos: number
  ocupDiariaPctKg: number
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

interface DatosRangoDia {
  fecha: string
  diaSemana: string
  camion_codigo: string
  tipo_unidad: string
  sucursal: string
  chofer_nombre: string
  pedidos: number
  kgUsados: number
  posUsadas: number
  pctKg: number
  pctPos: number
  kmReal: number | null
  hora_inicio: string | null
  hora_fin: string | null
  duracionMin: number | null
}

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

export default function MetricasPage() {
  const router = useRouter()
  const [vista, setVista] = useState<'diaria' | 'mensual' | 'rango'>('diaria')
  const [fecha, setFecha] = useState(hoy())
  const [mes, setMes] = useState(mesActual())
  const [filtroSucursal, setFiltroSucursal] = useState('')
  const [loading, setLoading] = useState(false)
  const [datosDia, setDatosDia] = useState<DatosCamionDia[]>([])
  const [datosMes, setDatosMes] = useState<DatosCamionMes[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [chatAbierto, setChatAbierto] = useState(false)
  const [exportando, setExportando] = useState(false)
  const primerDiaMes = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01` }
  const [fechaExportDesde, setFechaExportDesde] = useState(primerDiaMes)
  const [fechaExportHasta, setFechaExportHasta] = useState(hoy)
  const [exportSucursales, setExportSucursales] = useState<string[]>([])
  const [camionesNoActivados, setCamionesNoActivados] = useState<{ camion_codigo: string; sucursal: string }[]>([])
  const [rangoDesde, setRangoDesde] = useState(primerDiaMes)
  const [rangoHasta, setRangoHasta] = useState(hoy)
  const [filtroRangoCamiones, setFiltroRangoCamiones] = useState<string[]>([])
  const [filtroRangoChoferes, setFiltroRangoChoferes] = useState<string[]>([])
  const [filtroFechasExcluidas, setFiltroFechasExcluidas] = useState<string[]>([])
  const [ocultarSinActividad, setOcultarSinActividad] = useState(false)
  const [datosRangoAll, setDatosRangoAll] = useState<DatosRangoDia[]>([]) // datos sin filtrar
  const [datosRango, setDatosRango] = useState<DatosRangoDia[]>([])
  const [loadingRango, setLoadingRango] = useState(false)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol, permisos, sucursal').eq('id', user.id).single()
      if (!tieneAcceso(data?.permisos, data?.rol, 'metricas')) { router.push('/dashboard'); return }
      if (data?.sucursal) {
        setFiltroSucursal(data.sucursal)
        setExportSucursales([data.sucursal])
        // Recargar con la sucursal del usuario (el useEffect inicial usó '')
        if (vista === 'diaria') cargarDiaria(data.sucursal)
        else cargarMensual(data.sucursal)
      }
    })
  }, [])

  useEffect(() => { if (vista === 'diaria') cargarDiaria() }, [fecha, vista])
  useEffect(() => { if (vista === 'mensual') cargarMensual() }, [mes, vista])

  // Aplicar filtros multi-select sobre datos ya cargados (sin re-buscar)
  useEffect(() => {
    let filtered = datosRangoAll
    if (filtroRangoCamiones.length > 0) filtered = filtered.filter(r => filtroRangoCamiones.includes(r.camion_codigo))
    if (filtroRangoChoferes.length > 0) filtered = filtered.filter(r => filtroRangoChoferes.includes(r.chofer_nombre))
    if (filtroFechasExcluidas.length > 0) filtered = filtered.filter(r => !filtroFechasExcluidas.includes(r.fecha))
    if (ocultarSinActividad) {
      const fechasConActividad = new Set(datosRangoAll.filter(r => r.pedidos > 0).map(r => r.fecha))
      filtered = filtered.filter(r => fechasConActividad.has(r.fecha))
    }
    setDatosRango(filtered)
  }, [datosRangoAll, filtroRangoCamiones, filtroRangoChoferes, filtroFechasExcluidas, ocultarSinActividad])

  const buscar = () => {
    if (vista === 'diaria') cargarDiaria()
    else if (vista === 'mensual') cargarMensual()
    else cargarRango()
  }

  async function exportarExcel() {
    if (!fechaExportDesde || !fechaExportHasta) { showToast('Seleccioná el intervalo de fechas'); return }
    if (fechaExportDesde > fechaExportHasta) { showToast('La fecha de inicio debe ser anterior al fin'); return }
    setExportando(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()

      // Queries paralelas: pedidos + flota + camiones + materiales para el intervalo
      let pedQ = supabase.from('pedidos')
        .select('id, nv, id_despacho, cliente, direccion, sucursal, fecha_entrega, vuelta, camion_id, estado, estado_pago, peso_total_kg, volumen_total_m3, notas, tipo, latitud, longitud, barrio_cerrado, orden_entrega, hora_entregado')
        .gte('fecha_entrega', fechaExportDesde).lte('fecha_entrega', fechaExportHasta)
        .neq('estado', 'cancelado').order('fecha_entrega').order('sucursal').order('cliente')
      let flotQ = supabase.from('flota_dia')
        .select('fecha, camion_codigo, sucursal, km_ruta, hora_inicio, hora_fin')
        .gte('fecha', fechaExportDesde).lte('fecha', fechaExportHasta).eq('activo', true)
      if (exportSucursales.length > 0) { pedQ = pedQ.in('sucursal', exportSucursales); flotQ = flotQ.in('sucursal', exportSucursales) }

      const [{ data: pedidosData }, { data: flotaData }, { data: camionesData }, { data: matsExport }, { data: vueltasTiemposExport }] = await Promise.all([
        pedQ, flotQ,
        supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg'),
        supabase.from('materiales').select('nombre, tipo_carga'),
        supabase.from('vueltas_tiempos').select('camion_codigo, fecha, vuelta, hora_inicio, hora_fin')
          .gte('fecha', fechaExportDesde).lte('fecha', fechaExportHasta),
      ])

      // Mapa: "camion|fecha|vuelta" → { hora_inicio, hora_fin }
      const vueltaTimingExMap: Record<string, { hora_inicio: string | null; hora_fin: string | null }> = {}
      for (const t of vueltasTiemposExport ?? []) {
        vueltaTimingExMap[`${t.camion_codigo}|${t.fecha}|${t.vuelta}`] = { hora_inicio: t.hora_inicio ?? null, hora_fin: t.hora_fin ?? null }
      }

      const camionMap: Record<string, any> = {}
      for (const c of camionesData ?? []) camionMap[c.codigo] = c

      // Cargar pedido_items en lotes de 500 (evita truncado de PostgREST a 1000 filas)
      const pedidoIdsExport = (pedidosData ?? []).map((p: any) => p.id)
      const allItemsExport: any[] = []
      for (let i = 0; i < pedidoIdsExport.length; i += 500) {
        const batch = pedidoIdsExport.slice(i, i + 500)
        const { data: batchItems } = await supabase.from('pedido_items')
          .select('pedido_id, nombre').in('pedido_id', batch)
        if (batchItems) allItemsExport.push(...batchItems)
      }
      const itemsExport = allItemsExport

      const matTipoMapEx: Record<string, string> = {}
      for (const m of matsExport ?? []) matTipoMapEx[m.nombre] = m.tipo_carga
      const pedidoEsHierrosEx: Record<string, boolean> = {}
      const pedidoEsGranelEx: Record<string, boolean> = {}
      for (const item of itemsExport ?? []) {
        const tipo = matTipoMapEx[item.nombre] ?? ''
        if (TIPOS_CARGA_HIERRO.has(tipo)) pedidoEsHierrosEx[item.pedido_id] = true
        if (TIPOS_CARGA_GRANEL.has(tipo)) pedidoEsGranelEx[item.pedido_id] = true
      }

      // Mapa flota: "camion|fecha" → { hora_inicio, hora_fin, km_ruta }
      const flotaMapEx: Record<string, any> = {}
      for (const f of flotaData ?? []) flotaMapEx[`${f.camion_codigo}|${f.fecha}`] = f

      // Hoja 1: Pedidos detalle
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        (pedidosData ?? []).map(p => {
          const latPed = (p as any).latitud ?? null
          const lngPed = (p as any).longitud ?? null

          // Depósito asignado (sucursal del pedido)
          const depAsig = DEPOSITOS[p.sucursal] ?? null
          const distAsig = (latPed && lngPed && depAsig)
            ? Math.round(distanciaKm(latPed, lngPed, depAsig.lat, depAsig.lng) * 10) / 10
            : ''

          // Depósito más cercano
          let depCercNombre = ''; let depCercLat: number | '' = ''; let depCercLng: number | '' = ''; let distCerc: number | '' = ''
          if (latPed && lngPed) {
            let minDist = Infinity
            for (const [nombre, coords] of Object.entries(DEPOSITOS)) {
              const d = distanciaKm(latPed, lngPed, coords.lat, coords.lng)
              if (d < minDist) {
                minDist = d; depCercNombre = nombre
                depCercLat = coords.lat; depCercLng = coords.lng
                distCerc = Math.round(d * 10) / 10
              }
            }
          }

          return {
            'NV': p.nv, 'SD': p.id_despacho ?? '', 'Tipo': p.tipo === 'retiro' ? 'Retiro' : 'Entrega',
            'Cliente': p.cliente, 'Dirección': p.direccion, 'Sucursal': p.sucursal,
            'Fecha': p.fecha_entrega,
            'Día': new Date(p.fecha_entrega + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long' }),
            'Vuelta': p.vuelta === 0 ? 'Sin asignar' : `V${p.vuelta}`,
            'Camión': p.camion_id ?? '', 'Estado': p.estado, 'Pago': p.estado_pago ?? '',
            'Kg': p.peso_total_kg ?? 0, 'Posiciones': p.volumen_total_m3 ?? 0, 'Notas': p.notas ?? '',
            'Lat pedido': latPed ?? '',
            'Lng pedido': lngPed ?? '',
            'Lat depósito asignado': depAsig?.lat ?? '',
            'Lng depósito asignado': depAsig?.lng ?? '',
            'Dist km dep. asignado': distAsig,
            'Depósito más cercano': depCercNombre,
            'Lat dep. cercano': depCercLat,
            'Lng dep. cercano': depCercLng,
            'Dist km dep. cercano': distCerc,
          }
        })
      ), 'Pedidos')

      // Hoja 2: Resumen por día
      const byDia: Record<string, { pedidos: number; kg: number; pos: number; completos: number; parciales: number; rechazados: number }> = {}
      for (const p of pedidosData ?? []) {
        if (!byDia[p.fecha_entrega]) byDia[p.fecha_entrega] = { pedidos: 0, kg: 0, pos: 0, completos: 0, parciales: 0, rechazados: 0 }
        byDia[p.fecha_entrega].pedidos++
        byDia[p.fecha_entrega].kg += p.peso_total_kg ?? 0
        byDia[p.fecha_entrega].pos += p.volumen_total_m3 ?? 0
        if (p.estado === 'entregado') byDia[p.fecha_entrega].completos++
        else if (p.estado === 'entregado_parcial') byDia[p.fecha_entrega].parciales++
        else if (p.estado === 'rechazado') byDia[p.fecha_entrega].rechazados++
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        Object.entries(byDia).sort((a, b) => a[0].localeCompare(b[0])).map(([f, d]) => {
          const finalizados = d.completos + d.parciales + d.rechazados
          return {
            'Fecha': f,
            'Día': new Date(f + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long' }),
            'Pedidos total': d.pedidos,
            'Entregados completos': d.completos,
            'Entregados parciales': d.parciales,
            'Rechazados': d.rechazados,
            'Sin finalizar': d.pedidos - finalizados,
            '% Entrega completa': finalizados > 0 ? Math.round(d.completos / finalizados * 100) : 0,
            '% Entrega (incl. parcial)': finalizados > 0 ? Math.round((d.completos + d.parciales) / finalizados * 100) : 0,
            'Kg totales': Math.round(d.kg),
            'Posiciones': Math.round(d.pos),
          }
        })
      ), 'Por día')

      // Hoja 3: Resumen por camión
      // Precalcular vueltas reales por camión/día para capacidad correcta
      const vueltasPorCamionDia: Record<string, Set<number>> = {}
      for (const p of pedidosData ?? []) {
        if (!p.camion_id || !p.vuelta) continue
        const key = `${p.camion_id}|${p.fecha_entrega}`
        if (!vueltasPorCamionDia[key]) vueltasPorCamionDia[key] = new Set()
        vueltasPorCamionDia[key].add(p.vuelta)
      }

      const byTruck: Record<string, { diasActivo: number; pedidos: number; kg: number; pos: number; km: number; capKg: number; capPos: number; totalVueltas: number }> = {}
      for (const f of flotaData ?? []) {
        if (!byTruck[f.camion_codigo]) byTruck[f.camion_codigo] = { diasActivo: 0, pedidos: 0, kg: 0, pos: 0, km: 0, capKg: 0, capPos: 0, totalVueltas: 0 }
        byTruck[f.camion_codigo].diasActivo++
        byTruck[f.camion_codigo].km += f.km_ruta ?? 0
        // Vueltas reales del día (mínimo 1 para no dividir por 0)
        const vueltasEseDia = vueltasPorCamionDia[`${f.camion_codigo}|${f.fecha}`]?.size ?? 1
        byTruck[f.camion_codigo].totalVueltas += vueltasEseDia
        const c = camionMap[f.camion_codigo]
        if (c) {
          byTruck[f.camion_codigo].capKg += c.tonelaje_max_kg * vueltasEseDia
          byTruck[f.camion_codigo].capPos += c.posiciones_total * vueltasEseDia
        }
      }
      for (const p of pedidosData ?? []) {
        if (!p.camion_id) continue
        if (!byTruck[p.camion_id]) byTruck[p.camion_id] = { diasActivo: 0, pedidos: 0, kg: 0, pos: 0, km: 0, capKg: 0, capPos: 0, totalVueltas: 0 }
        byTruck[p.camion_id].pedidos++
        byTruck[p.camion_id].kg += p.peso_total_kg ?? 0
        byTruck[p.camion_id].pos += p.volumen_total_m3 ?? 0
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        Object.entries(byTruck).sort((a, b) => b[1].kg - a[1].kg).map(([cod, d]) => {
          const c = camionMap[cod]
          const avgVueltas = d.diasActivo > 0 ? Math.round(d.totalVueltas / d.diasActivo * 10) / 10 : 0
          return {
            'Camión': cod, 'Tipo': c?.tipo_unidad ?? '', 'Sucursal': c?.sucursal ?? '',
            'Días activo': d.diasActivo,
            'Vueltas totales': d.totalVueltas,
            'Avg vueltas/día': avgVueltas,
            'Pedidos': d.pedidos,
            'Kg totales': Math.round(d.kg),
            'Avg Ocup. Kg %': d.capKg > 0 ? Math.round(d.kg / d.capKg * 100) : 0,
            'Pos totales': Math.round(d.pos),
            'Avg Ocup. Pos %': d.capPos > 0 ? Math.round(d.pos / d.capPos * 100) : 0,
            'Km totales': Math.round(d.km),
          }
        })
      ), 'Por camión')

      // Hoja 4: Por sucursal
      const bySuc: Record<string, { pedidos: number; kg: number; pos: number; completos: number; parciales: number; rechazados: number }> = {}
      for (const p of pedidosData ?? []) {
        if (!bySuc[p.sucursal]) bySuc[p.sucursal] = { pedidos: 0, kg: 0, pos: 0, completos: 0, parciales: 0, rechazados: 0 }
        bySuc[p.sucursal].pedidos++
        bySuc[p.sucursal].kg += p.peso_total_kg ?? 0
        bySuc[p.sucursal].pos += p.volumen_total_m3 ?? 0
        if (p.estado === 'entregado') bySuc[p.sucursal].completos++
        else if (p.estado === 'entregado_parcial') bySuc[p.sucursal].parciales++
        else if (p.estado === 'rechazado') bySuc[p.sucursal].rechazados++
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        Object.entries(bySuc).sort((a, b) => b[1].pedidos - a[1].pedidos).map(([s, d]) => {
          const finalizados = d.completos + d.parciales + d.rechazados
          return {
            'Sucursal': s,
            'Pedidos total': d.pedidos,
            'Entregados completos': d.completos,
            'Entregados parciales': d.parciales,
            'Rechazados': d.rechazados,
            'Sin finalizar': d.pedidos - finalizados,
            '% Entrega completa': finalizados > 0 ? Math.round(d.completos / finalizados * 100) : 0,
            '% Entrega (incl. parcial)': finalizados > 0 ? Math.round((d.completos + d.parciales) / finalizados * 100) : 0,
            'Kg totales': Math.round(d.kg),
            'Posiciones': Math.round(d.pos),
          }
        })
      ), 'Por sucursal')

      // Hoja 5: Por vuelta — estimación de tiempos
      const vueltaGroupsEx: Record<string, { camion: string; fecha: string; vuelta: number; peds: any[] }> = {}
      for (const p of pedidosData ?? []) {
        if (!p.camion_id) continue
        const key = `${p.camion_id}|${p.fecha_entrega}|${p.vuelta ?? 0}`
        if (!vueltaGroupsEx[key]) vueltaGroupsEx[key] = { camion: p.camion_id, fecha: p.fecha_entrega, vuelta: p.vuelta ?? 0, peds: [] }
        vueltaGroupsEx[key].peds.push(p)
      }
      const porVueltaRows = Object.values(vueltaGroupsEx)
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.camion.localeCompare(b.camion) || a.vuelta - b.vuelta)
        .map(g => {
          const cam = camionMap[g.camion]
          const flota = flotaMapEx[`${g.camion}|${g.fecha}`]
          const esTrailerEx = /trailer|semi/i.test(cam?.tipo_unidad ?? '')
          const depot = DEPOSITOS[cam?.sucursal ?? ''] ?? { lat: -34.9205, lng: -57.9536 }

          const kg = g.peds.reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
          const pos = g.peds.reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
          const distKmEx = calcularDistanciaRuta(
            g.peds.map((p: any) => ({ latitud: p.latitud, longitud: p.longitud, orden_entrega: p.orden_entrega })),
            depot
          )

          const detEx: PedidoDetalle[] = g.peds.map((p: any) => ({
            id: p.id, nv: p.nv, cliente: p.cliente, direccion: p.direccion,
            sucursal: p.sucursal, estado: p.estado, estado_pago: p.estado_pago ?? null,
            notas: p.notas ?? null, tipo: p.tipo ?? null,
            peso_total_kg: p.peso_total_kg ?? 0, volumen_total_m3: p.volumen_total_m3 ?? 0,
            orden_entrega: p.orden_entrega ?? null, latitud: p.latitud ?? null, longitud: p.longitud ?? null,
            barrio_cerrado: p.barrio_cerrado ?? null,
            esHierros: pedidoEsHierrosEx[p.id] ?? false,
            esGranel: pedidoEsGranelEx[p.id] ?? false,
            hora_entregado: p.hora_entregado ?? null,
          }))
          const descMin = calcularTiempoDescargaMin(detEx, esTrailerEx)
          const velKmhEx = getVelFallback(cam?.sucursal ?? '')
          const trasMin = distKmEx > 0 ? Math.round(distKmEx * 1.3 / velKmhEx * 60) : 0
          const totalMin = trasMin + descMin

          // Tiempos reales por vuelta (desde vueltas_tiempos)
          const timingV = vueltaTimingExMap[`${g.camion}|${g.fecha}|${g.vuelta}`]
          const hInicioV = timingV?.hora_inicio ? new Date(timingV.hora_inicio).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : ''
          const hFinV = timingV?.hora_fin ? new Date(timingV.hora_fin).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : ''
          const durRealV = timingV?.hora_inicio && timingV?.hora_fin
            ? Math.round((new Date(timingV.hora_fin).getTime() - new Date(timingV.hora_inicio).getTime()) / 60000)
            : null

          // Real a nivel día (para referencia)
          const hInicioDia = flota?.hora_inicio ? new Date(flota.hora_inicio).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : ''
          const hFinDia = flota?.hora_fin ? new Date(flota.hora_fin).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : ''
          const durRealDia = flota?.hora_inicio && flota?.hora_fin
            ? Math.round((new Date(flota.hora_fin).getTime() - new Date(flota.hora_inicio).getTime()) / 60000)
            : null

          return {
            'Camión': g.camion,
            'Tipo': cam?.tipo_unidad ?? '',
            'Sucursal': cam?.sucursal ?? '',
            'Fecha': g.fecha,
            'Día': new Date(g.fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long' }),
            'Vuelta': g.vuelta === 0 ? 'Fuera prog.' : `V${g.vuelta}`,
            'Pedidos': g.peds.length,
            'Kg': Math.round(kg),
            'Posiciones': Math.round(pos),
            'Km est. ruta': distKmEx || '',
            'T. traslado est. (min)': trasMin || '',
            'T. descarga est. (min)': descMin || '',
            'T. total est. (min)': totalMin || '',
            'T. total est.': totalMin > 0 ? formatMinutos(totalMin) : '',
            'Inicio vuelta (real)': hInicioV,
            'Fin vuelta (real)': hFinV,
            'Duración vuelta (min)': durRealV ?? '',
            'Duración vuelta': durRealV ? formatMinutos(durRealV) : '',
            'Inicio día (todas las vueltas)': hInicioDia,
            'Fin día (todas las vueltas)': hFinDia,
            'Duración día total (min)': durRealDia ?? '',
            'Km reales día total': flota?.km_ruta ?? '',
          }
        })
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(porVueltaRows), 'Por vuelta')

      const suf = exportSucursales.length === 1 ? `-${exportSucursales[0]}` : exportSucursales.length > 1 ? `-${exportSucursales.join('+')}` : ''
      const nombre = fechaExportDesde === fechaExportHasta
        ? `despachos-app-${fechaExportDesde}${suf}.xlsx`
        : `despachos-app-${fechaExportDesde}-${fechaExportHasta}${suf}.xlsx`
      XLSX.writeFile(wb, nombre)
      showToast(`Excel descargado (${(pedidosData ?? []).length} pedidos)`)
    } catch (e: any) {
      showToast(`Error: ${e.message}`)
    }
    setExportando(false)
  }

  const cargarDiaria = async (sucursalParam?: string) => {
    setLoading(true)
    const sucursal = sucursalParam !== undefined ? sucursalParam : filtroSucursal

    const [{ data: flotaDia }, { data: pedidosData }, { data: camionesData }, { data: vueltasTiemposData }] = await Promise.all([
      supabase.from('flota_dia').select('camion_codigo, chofer_id, hora_inicio, hora_fin, km_ruta').eq('fecha', fecha).eq('activo', true),
      supabase.from('pedidos')
        .select('id, nv, cliente, direccion, sucursal, estado, estado_pago, notas, tipo, camion_id, peso_total_kg, volumen_total_m3, vuelta, orden_entrega, latitud, longitud, barrio_cerrado, hora_entregado')
        .eq('fecha_entrega', fecha).neq('estado', 'cancelado').not('camion_id', 'is', null),
      supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg, km_max_dia'),
      supabase.from('vueltas_tiempos').select('camion_codigo, vuelta, hora_inicio, hora_fin').eq('fecha', fecha),
    ])

    // Mapa: "camion_codigo|vuelta" → { hora_inicio, hora_fin }
    const vueltaTimingMap: Record<string, { hora_inicio: string | null; hora_fin: string | null }> = {}
    for (const t of vueltasTiemposData ?? []) {
      vueltaTimingMap[`${t.camion_codigo}|${t.vuelta}`] = { hora_inicio: t.hora_inicio ?? null, hora_fin: t.hora_fin ?? null }
    }

    const choferIds = (flotaDia ?? []).filter((f: any) => f.chofer_id).map((f: any) => f.chofer_id)
    const pedidoIds = (pedidosData ?? []).map((p: any) => p.id)

    // Cargar choferes + items de pedidos + catálogo de materiales en paralelo
    const [
      { data: choferes },
      { data: itemsData },
      { data: materialesData },
    ] = await Promise.all([
      choferIds.length > 0 ? supabase.from('usuarios').select('id, nombre').in('id', choferIds) : Promise.resolve({ data: [] as any[] }),
      pedidoIds.length > 0 ? supabase.from('pedido_items').select('pedido_id, nombre').in('pedido_id', pedidoIds) : Promise.resolve({ data: [] as any[] }),
      supabase.from('materiales').select('nombre, tipo_carga'),
    ])

    // Mapa nombre_material → tipo_carga
    const matTipoMap: Record<string, string> = {}
    for (const m of materialesData ?? []) matTipoMap[m.nombre] = m.tipo_carga

    // Determinar si cada pedido es de hierros (hierro_suelto, chapa, pretensado) o granel
    const pedidoEsHierros: Record<string, boolean> = {}
    const pedidoEsGranel: Record<string, boolean> = {}
    for (const item of itemsData ?? []) {
      const tipo = matTipoMap[item.nombre] ?? ''
      if (TIPOS_CARGA_HIERRO.has(tipo)) pedidoEsHierros[item.pedido_id] = true
      if (TIPOS_CARGA_GRANEL.has(tipo)) pedidoEsGranel[item.pedido_id] = true
    }

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
          kmReal: false,
          tiempoTrasladoMin: null,
          horaInicioVuelta: vueltaTimingMap[`${camionCodigo}|${v}`]?.hora_inicio ?? null,
          horaFinVuelta: vueltaTimingMap[`${camionCodigo}|${v}`]?.hora_fin ?? null,
          pedidosConUbicacion: pv.filter((p: any) => p.latitud && p.longitud).length,
          detalle: pv
            .sort((a: any, b: any) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))
            .map((p: any) => ({
              id: p.id, nv: p.nv, cliente: p.cliente, direccion: p.direccion,
              sucursal: p.sucursal, estado: p.estado,
              estado_pago: p.estado_pago ?? null, notas: p.notas ?? null, tipo: p.tipo ?? null,
              peso_total_kg: p.peso_total_kg ?? 0, volumen_total_m3: p.volumen_total_m3 ?? 0,
              orden_entrega: p.orden_entrega,
              latitud: p.latitud ?? null, longitud: p.longitud ?? null,
              barrio_cerrado: p.barrio_cerrado ?? null,
              esHierros: pedidoEsHierros[p.id] ?? false,
              esGranel: pedidoEsGranel[p.id] ?? false,
              hora_entregado: p.hora_entregado ?? null,
            })),
        }
      })

      const distanciaTotalKm = calcularDistanciaRuta(pedidosCamion, depot)
      const numVueltas = vueltas.length || 1
      const capacidadKgDia = camion.tonelaje_max_kg * numVueltas
      const capacidadPosDia = camion.posiciones_total * numVueltas

      const kmMaxDia = camion.km_max_dia ?? 200
      const vueltasMaxEfectivas = calcVueltasMaxEfectivas(camion.sucursal, vueltas.length, distanciaTotalKm, kmMaxDia, fecha)
      const { pctPos: ocupDiariaPctPos, pctKg: ocupDiariaPctKg } = calcOcupDiaria(
        posicionesUsadas, kgUsados,
        camion.posiciones_total, camion.tonelaje_max_kg,
        vueltas.length, vueltasMaxEfectivas,
      )

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
        km_max_dia: kmMaxDia,
        vueltasMaxEfectivas,
        ocupDiariaPctPos,
        ocupDiariaPctKg,
      }
    }

    let datos: DatosCamionDia[] = [...camionCodigosSet]
      .map(buildCamionData)
      .filter(Boolean) as DatosCamionDia[]

    const sorted = datos.sort((a, b) => b.pctKg - a.pctKg)

    // Camiones activos en flota base que no están en flota_dia hoy
    const activadosHoy = new Set([...camionCodigosSet])
    const noActivados = (camionesData ?? [])
      .filter((c: any) => c.activo && !activadosHoy.has(c.codigo))
      .filter((c: any) => !sucursal || c.sucursal === sucursal)
      .map((c: any) => ({ camion_codigo: c.codigo, sucursal: c.sucursal }))
    setCamionesNoActivados(noActivados)

    setDatosDia(sorted)
    setLoading(false)
    calcularKmReales(sorted)   // actualiza km en background con OSRM
  }

  // Calcula km reales de ruta usando OSRM (open source, gratis, sin API key)
  async function calcularKmReales(datos: DatosCamionDia[]) {
    type Req = { camionCodigo: string; vueltaIdx: number; coords: string }
    const reqs: Req[] = []

    for (const d of datos) {
      const depot = DEPOSITOS[d.sucursal] ?? { lat: -34.9205, lng: -57.9536 }
      d.vueltas.forEach((v, vueltaIdx) => {
        const stops = v.detalle
          .filter(p => p.latitud && p.longitud)
          .sort((a, b) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))
        if (stops.length === 0) return
        // OSRM: longitud,latitud (al revés de lo habitual)
        const pts = [
          `${depot.lng},${depot.lat}`,
          ...stops.map(p => `${p.longitud},${p.latitud}`),
          `${depot.lng},${depot.lat}`,
        ].join(';')
        reqs.push({ camionCodigo: d.camion_codigo, vueltaIdx, coords: pts })
      })
    }

    if (reqs.length === 0) return

    // Secuencial para no saturar Valhalla. Cada resultado actualiza la UI en cuanto llega.
    for (const r of reqs) {
      let json: any = null
      // Reintentar una vez si falla (Valhalla puede tener picos de latencia)
      for (let intento = 0; intento < 2 && json === null; intento++) {
        try {
          if (intento > 0) await new Promise(res => setTimeout(res, 3000))
          const res = await fetch(`/api/km-ruta?coords=${encodeURIComponent(r.coords)}`)
          if (res.ok) json = await res.json()
        } catch { /* ignorar, se reintentará */ }
      }
      if (!json) continue

      const distM: number | null = json.distanciaM ?? null
      const durMin: number | null = json.duracionMin ?? null
      if (!distM && durMin === null) continue   // nada útil

      setDatosDia(prev => {
        const next = prev.map(d => ({
          ...d,
          vueltas: d.vueltas.map(v => ({ ...v })),
        }))
        const ci = next.findIndex(d => d.camion_codigo === r.camionCodigo)
        if (ci !== -1 && next[ci].vueltas[r.vueltaIdx]) {
          if (distM) {
            next[ci].vueltas[r.vueltaIdx].distanciaKm = Math.round(distM / 1000)
            next[ci].vueltas[r.vueltaIdx].kmReal = true
          }
          if (durMin !== null) next[ci].vueltas[r.vueltaIdx].tiempoTrasladoMin = durMin
          next[ci].distanciaTotalKm = next[ci].vueltas.reduce((a, v) => a + v.distanciaKm, 0)
        }
        return next
      })
    }
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

  async function cargarRango() {
    if (!rangoDesde || !rangoHasta) return
    setLoadingRango(true)
    setDatosRango([])

    try {
      let flotaQ = supabase.from('flota_dia')
        .select('fecha, camion_codigo, chofer_id, hora_inicio, hora_fin, km_ruta, sucursal')
        .gte('fecha', rangoDesde).lte('fecha', rangoHasta).eq('activo', true)
        .limit(5000)
      if (filtroSucursal) flotaQ = flotaQ.eq('sucursal', filtroSucursal)

      const [flotaRes, pedidosRes, camionesRes, chofRes] = await Promise.all([
        flotaQ,
        // Filtrar por sucursal si está seleccionada para evitar corte por límite en rangos largos
        (() => {
          let q = supabase.from('pedidos').select('camion_id, fecha_entrega, peso_total_kg, volumen_total_m3')
            .gte('fecha_entrega', rangoDesde).lte('fecha_entrega', rangoHasta)
            .neq('estado', 'cancelado').not('camion_id', 'is', null)
            .limit(50000)
          if (filtroSucursal) q = q.eq('sucursal', filtroSucursal)
          return q
        })(),
        supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg'),
        supabase.from('usuarios').select('id, nombre'),
      ])

      if (flotaRes.error) {
        console.error('flota_dia error:', flotaRes.error)
        showToast(`Error cargando flota: ${flotaRes.error.message}`)
        return
      }
      if (pedidosRes.error) console.error('pedidos rango error:', pedidosRes.error)
      if (camionesRes.error) console.error('camiones error:', camionesRes.error)
      if (chofRes.error) console.error('choferes error:', chofRes.error)

      const flotaData = flotaRes.data ?? []
      const pedidosData = pedidosRes.data ?? []
      const camionesData = camionesRes.data ?? []
      const chofData = chofRes.data ?? []

      const camionMap: Record<string, any> = {}
      for (const c of camionesData) camionMap[c.codigo] = c
      const choferMap: Record<string, string> = {}
      for (const u of chofData) choferMap[u.id] = u.nombre

      const pedGroupMap: Record<string, { pedidos: number; kg: number; pos: number }> = {}
      for (const p of pedidosData) {
        const k = `${p.camion_id}|${p.fecha_entrega}`
        if (!pedGroupMap[k]) pedGroupMap[k] = { pedidos: 0, kg: 0, pos: 0 }
        pedGroupMap[k].pedidos++
        pedGroupMap[k].kg += p.peso_total_kg ?? 0
        pedGroupMap[k].pos += p.volumen_total_m3 ?? 0
      }

      let rows: DatosRangoDia[] = flotaData.map((f: any) => {
        const cam = camionMap[f.camion_codigo]
        const pg = pedGroupMap[`${f.camion_codigo}|${f.fecha}`] ?? { pedidos: 0, kg: 0, pos: 0 }
        const durMin = f.hora_inicio && f.hora_fin
          ? Math.round((new Date(f.hora_fin).getTime() - new Date(f.hora_inicio).getTime()) / 60000)
          : null
        const chofer = f.chofer_id ? (choferMap[f.chofer_id] ?? 'Sin nombre') : 'Sin chofer'
        return {
          fecha: f.fecha,
          diaSemana: new Date(f.fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'short' }),
          camion_codigo: f.camion_codigo,
          tipo_unidad: cam?.tipo_unidad ?? '',
          sucursal: cam?.sucursal ?? f.sucursal ?? '',
          chofer_nombre: chofer,
          pedidos: pg.pedidos,
          kgUsados: Math.round(pg.kg),
          posUsadas: Math.round(pg.pos),
          pctKg: cam?.tonelaje_max_kg ? pct(pg.kg, cam.tonelaje_max_kg) : 0,
          pctPos: cam?.posiciones_total ? pct(pg.pos, cam.posiciones_total) : 0,
          kmReal: f.km_ruta ?? null,
          hora_inicio: f.hora_inicio ?? null,
          hora_fin: f.hora_fin ?? null,
          duracionMin: durMin,
        }
      })

      rows.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.camion_codigo.localeCompare(b.camion_codigo))

      setDatosRangoAll(rows)
      setFiltroRangoCamiones([])
      setFiltroRangoChoferes([])
      setFiltroFechasExcluidas([])
      setOcultarSinActividad(false)
      setDatosRango(rows)
    } catch (e: any) {
      console.error('cargarRango exception:', e)
      showToast(`Error al cargar período: ${e.message ?? 'error desconocido'}`)
    } finally {
      setLoadingRango(false)
    }
  }

  async function exportarRango() {
    if (datosRango.length === 0) { showToast('Primero buscá datos para exportar'); return }
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
        datosRango.map(r => ({
          'Fecha': r.fecha,
          'Día': r.diaSemana,
          'Camión': r.camion_codigo,
          'Tipo': r.tipo_unidad,
          'Sucursal': r.sucursal,
          'Chofer': r.chofer_nombre,
          'Pedidos': r.pedidos,
          'Kg': r.kgUsados,
          'Pos': r.posUsadas,
          'Ocup.Kg%': r.pctKg,
          'Ocup.Pos%': r.pctPos,
          'Km reales': r.kmReal ?? '',
          'Inicio': r.hora_inicio ? formatHora(r.hora_inicio) : '',
          'Fin': r.hora_fin ? formatHora(r.hora_fin) : '',
          'Duración (min)': r.duracionMin ?? '',
          'Duración': r.duracionMin !== null ? formatMinutos(r.duracionMin) : '',
        }))
      ), 'Período')
      const suf = filtroSucursal ? `-${filtroSucursal}` : ''
      XLSX.writeFile(wb, `metricas-periodo-${rangoDesde}-${rangoHasta}${suf}.xlsx`)
      showToast(`Excel descargado (${datosRango.length} filas)`)
    } catch (e: any) {
      showToast(`Error: ${e.message}`)
    }
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
            <Link href="/dashboard"
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</Link>
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
            <button onClick={() => setVista('rango')}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{ background: vista === 'rango' ? '#254A96' : '#f4f4f3', color: vista === 'rango' ? 'white' : '#666' }}>
              Período
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto px-4 md:px-6 py-6">

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 mb-6 space-y-3">
          {/* Fila 1: vista */}
          <div className="flex flex-wrap gap-3 items-end">
            {vista === 'diaria' ? (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha</label>
                <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && buscar()}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
            ) : vista === 'mensual' ? (
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Mes</label>
                <input type="month" value={mes} onChange={e => setMes(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Desde</label>
                  <input type="date" value={rangoDesde} onChange={e => setRangoDesde(e.target.value)}
                    className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Hasta</label>
                  <input type="date" value={rangoHasta} onChange={e => setRangoHasta(e.target.value)}
                    className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
                {/* Chips multi-select camiones — aparecen después de buscar */}
                {datosRangoAll.length > 0 && (() => {
                  const camiones = [...new Set(datosRangoAll.map(r => r.camion_codigo))].sort()
                  return (
                    <div>
                      <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>
                        Camiones {filtroRangoCamiones.length > 0 && <span style={{ color: '#E52322' }}>({filtroRangoCamiones.length})</span>}
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {camiones.map(c => {
                          const sel = filtroRangoCamiones.includes(c)
                          return (
                            <button key={c} type="button"
                              onClick={() => setFiltroRangoCamiones(prev => sel ? prev.filter(x => x !== c) : [...prev, c])}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                              style={{ borderColor: sel ? '#254A96' : '#e8edf8', background: sel ? '#e8edf8' : 'white', color: sel ? '#254A96' : '#999' }}>
                              {c}
                            </button>
                          )
                        })}
                        {filtroRangoCamiones.length > 0 && (
                          <button type="button" onClick={() => setFiltroRangoCamiones([])}
                            className="px-2 py-1.5 rounded-lg text-xs border"
                            style={{ borderColor: '#e8edf8', color: '#B9BBB7' }}>✕</button>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Chips multi-select choferes */}
                {datosRangoAll.length > 0 && (() => {
                  const choferes = [...new Set(datosRangoAll.map(r => r.chofer_nombre).filter(n => n && n !== 'Sin chofer'))].sort()
                  return (
                    <div>
                      <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>
                        Choferes {filtroRangoChoferes.length > 0 && <span style={{ color: '#E52322' }}>({filtroRangoChoferes.length})</span>}
                      </label>
                      <div className="flex flex-wrap gap-1.5">
                        {choferes.map(c => {
                          const sel = filtroRangoChoferes.includes(c)
                          return (
                            <button key={c} type="button"
                              onClick={() => setFiltroRangoChoferes(prev => sel ? prev.filter(x => x !== c) : [...prev, c])}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                              style={{ borderColor: sel ? '#254A96' : '#e8edf8', background: sel ? '#e8edf8' : 'white', color: sel ? '#254A96' : '#999' }}>
                              {c}
                            </button>
                          )
                        })}
                        {filtroRangoChoferes.length > 0 && (
                          <button type="button" onClick={() => setFiltroRangoChoferes([])}
                            className="px-2 py-1.5 rounded-lg text-xs border"
                            style={{ borderColor: '#e8edf8', color: '#B9BBB7' }}>✕</button>
                        )}
                      </div>
                    </div>
                  )
                })()}

                {/* Chips de fechas — deseleccioná feriados o días sin operar */}
                {datosRangoAll.length > 0 && (() => {
                  const fechas = [...new Set(datosRangoAll.map(r => r.fecha))].sort()
                  const excl = filtroFechasExcluidas
                  return (
                    <div>
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <label className="text-xs font-medium" style={{ color: '#254A96' }}>
                          Días {excl.length > 0 && <span style={{ color: '#E52322' }}>({excl.length} excluidos)</span>}
                        </label>
                        <button type="button"
                          onClick={() => setOcultarSinActividad(v => !v)}
                          className="px-2 py-0.5 rounded text-xs font-medium border transition-colors"
                          style={{ borderColor: ocultarSinActividad ? '#254A96' : '#e8edf8', background: ocultarSinActividad ? '#e8edf8' : 'white', color: ocultarSinActividad ? '#254A96' : '#B9BBB7' }}>
                          {ocultarSinActividad ? '✓' : ''} Ocultar sin actividad
                        </button>
                        {excl.length > 0 && (
                          <button type="button" onClick={() => setFiltroFechasExcluidas([])}
                            className="px-2 py-0.5 rounded text-xs border"
                            style={{ borderColor: '#e8edf8', color: '#B9BBB7' }}>Restaurar todos</button>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {fechas.map(f => {
                          const excluida = excl.includes(f)
                          const d = new Date(f + 'T12:00:00')
                          const label = d.toLocaleDateString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit' })
                          const esFinde = [0, 6].includes(d.getDay())
                          return (
                            <button key={f} type="button"
                              onClick={() => setFiltroFechasExcluidas(prev => excluida ? prev.filter(x => x !== f) : [...prev, f])}
                              className="px-2 py-1 rounded text-xs border transition-colors"
                              title={excluida ? 'Click para incluir' : 'Click para excluir'}
                              style={{
                                borderColor: excluida ? '#fca5a5' : '#e8edf8',
                                background: excluida ? '#fde8e8' : 'white',
                                color: excluida ? '#E52322' : esFinde ? '#b45309' : '#666',
                                textDecoration: excluida ? 'line-through' : 'none',
                                opacity: excluida ? 0.7 : 1,
                              }}>
                              {label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })()}

              </>
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

          {/* Fila 2: exportar por rango */}
          <div className="flex flex-wrap gap-3 items-end pt-3" style={{ borderTop: '1px solid #f0f0f0' }}>
            <span className="text-xs font-semibold self-center" style={{ color: '#B9BBB7' }}>📊 EXPORTAR</span>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Desde</label>
              <input type="date" value={fechaExportDesde} onChange={e => setFechaExportDesde(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Hasta</label>
              <input type="date" value={fechaExportHasta} onChange={e => setFechaExportHasta(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>
                Sucursales {exportSucursales.length === 0 && <span style={{ color: '#B9BBB7', fontWeight: 400 }}>(todas)</span>}
              </label>
              <div className="flex gap-1.5 flex-wrap">
                {SUCURSALES.map(s => {
                  const sel = exportSucursales.includes(s)
                  return (
                    <button key={s} type="button"
                      onClick={() => setExportSucursales(prev => sel ? prev.filter(x => x !== s) : [...prev, s])}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors"
                      style={{
                        borderColor: sel ? '#254A96' : '#e8edf8',
                        background: sel ? '#e8edf8' : 'white',
                        color: sel ? '#254A96' : '#999',
                      }}>
                      {s}
                    </button>
                  )
                })}
                {exportSucursales.length > 0 && (
                  <button type="button" onClick={() => setExportSucursales([])}
                    className="px-2 py-1.5 rounded-lg text-xs border transition-colors"
                    style={{ borderColor: '#e8edf8', color: '#B9BBB7', background: 'white' }}
                    title="Limpiar filtro (exportar todas)">
                    ✕
                  </button>
                )}
              </div>
            </div>
            <button onClick={exportarExcel} disabled={exportando}
              className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: '#f4f4f3', color: '#254A96', border: '1px solid #e8edf8' }}>
              {exportando ? 'Exportando...' : '⬇️ Excel'}
            </button>
            {fechaExportDesde && fechaExportHasta && (
              <span className="text-xs self-center" style={{ color: '#B9BBB7' }}>
                {fechaExportDesde === fechaExportHasta
                  ? `1 día${filtroSucursal ? ` · ${filtroSucursal}` : ''}`
                  : `${fechaExportDesde} → ${fechaExportHasta}${filtroSucursal ? ` · ${filtroSucursal}` : ''}`
                }
              </span>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : vista === 'diaria' ? (
          <VistaDiaria datos={datosDia} fecha={fecha} camionesNoActivados={camionesNoActivados} />
        ) : vista === 'rango' ? (
          <VistaRango datos={datosRango} loading={loadingRango} onExport={exportarRango} />
        ) : (
          <VistaMensual datos={datosMes} mes={mes} />
        )}
      </main>

      {/* Botón flotante chat IA */}
      <button
        onClick={() => setChatAbierto(v => !v)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-3 rounded-2xl text-sm font-semibold text-white shadow-xl"
        style={{ background: chatAbierto ? '#1a3a7a' : '#254A96' }}>
        🤖 {chatAbierto ? 'Cerrar IA' : 'Analizar con IA'}
      </button>

      {/* Panel chat IA */}
      {chatAbierto && (
        <div className="fixed top-0 right-0 bottom-0 z-50 flex flex-col bg-white shadow-2xl" style={{ width: 400 }}>
          <div className="px-4 py-3 flex items-center justify-between shrink-0" style={{ background: '#254A96' }}>
            <div>
              <p className="font-bold text-sm text-white">🤖 Análisis IA</p>
              <p className="text-xs" style={{ color: 'rgba(255,255,255,0.7)' }}>
                Últimos 30 días · {filtroSucursal || 'Todas las sucursales'}
              </p>
            </div>
            <button onClick={() => setChatAbierto(false)} className="text-white text-2xl leading-none opacity-70 hover:opacity-100 px-1">×</button>
          </div>
          <ChatBot sucursal={filtroSucursal} />
        </div>
      )}
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

type SortDir = 'asc' | 'desc'
function SortTh({ label, sortKey, active, dir, onClick, numeric = true }: {
  label: string; sortKey: string; active: boolean; dir: SortDir; onClick: () => void; numeric?: boolean
}) {
  const arrow = active ? (dir === 'desc' ? (numeric ? ' ↓' : ' Z→A') : (numeric ? ' ↑' : ' A→Z')) : ''
  return (
    <th onClick={onClick} className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap cursor-pointer select-none hover:opacity-70 transition-opacity"
      style={{ color: active ? '#254A96' : '#B9BBB7' }}>
      {label}{arrow}
    </th>
  )
}

function VistaDiaria({ datos, fecha, camionesNoActivados }: {
  datos: DatosCamionDia[]
  fecha: string
  camionesNoActivados: { camion_codigo: string; sucursal: string }[]
}) {
  const router = useRouter()
  const [filtroFlota, setFiltroFlota] = useState<'todos' | 'con_pedidos' | 'sin_pedidos'>('todos')
  const [filtroCamion, setFiltroCamion] = useState('')
  const [filtroChofer, setFiltroChofer] = useState('')
  const [modalVuelta, setModalVuelta] = useState<{ camion: string; vuelta: DatosVuelta } | null>(null)
  type SortKeyDia = 'kg' | 'pos' | 'dist' | 'ocup' | 'camion' | 'chofer'
  const [sortKey, setSortKey] = useState<SortKeyDia>('ocup')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  function toggleSortDia(k: SortKeyDia) {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }

  if (datos.length === 0) return (
    <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
      <div className="text-5xl mb-4">🚛</div>
      <p className="font-medium">No hay flota configurada para esta fecha</p>
      <p className="text-sm mt-1">Creá la flota del día primero desde el módulo de Flota del día</p>
    </div>
  )

  const camionesUnicos = [...new Set(datos.map(d => d.camion_codigo))].sort()
  const choferesUnicos = [...new Set(datos.map(d => d.chofer_nombre).filter(n => n && n !== 'Sin chofer'))].sort()

  const datosFiltrados = datos
    .filter(d => filtroFlota === 'con_pedidos' ? d.pedidos > 0 : filtroFlota === 'sin_pedidos' ? d.pedidos === 0 : true)
    .filter(d => !filtroCamion || d.camion_codigo === filtroCamion)
    .filter(d => !filtroChofer || d.chofer_nombre === filtroChofer)

  const datosSorted = [...datosFiltrados].sort((a, b) => {
    let v = 0
    if (sortKey === 'kg') v = a.kgUsados - b.kgUsados
    else if (sortKey === 'pos') v = a.posicionesUsadas - b.posicionesUsadas
    else if (sortKey === 'dist') v = a.distanciaTotalKm - b.distanciaTotalKm
    else if (sortKey === 'ocup') v = Math.max(a.ocupDiariaPctKg, a.ocupDiariaPctPos) - Math.max(b.ocupDiariaPctKg, b.ocupDiariaPctPos)
    else if (sortKey === 'camion') v = a.camion_codigo.localeCompare(b.camion_codigo)
    else if (sortKey === 'chofer') v = a.chofer_nombre.localeCompare(b.chofer_nombre)
    return sortDir === 'desc' ? -v : v
  })

  const totalPedidos = datosFiltrados.reduce((a, d) => a + d.pedidos, 0)
  const avgPctKg = datosFiltrados.length > 0 ? Math.round(datosFiltrados.reduce((a, d) => a + d.pctKg, 0) / datosFiltrados.length) : 0
  const avgPctPos = datosFiltrados.length > 0 ? Math.round(datosFiltrados.reduce((a, d) => a + d.pctPos, 0) / datosFiltrados.length) : 0
  const totalDistancia = datosFiltrados.reduce((a, d) => a + d.distanciaTotalKm, 0)

  const conPedidos = datos.filter(d => d.pedidos > 0).length
  const sinPedidos = datos.filter(d => d.pedidos === 0).length

  return (
    <div className="space-y-4">

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
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
        <div className="w-px h-4 bg-gray-200 mx-1" />
        <select value={filtroCamion} onChange={e => setFiltroCamion(e.target.value)}
          className="border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
          style={{ borderColor: '#e8edf8', color: filtroCamion ? '#254A96' : '#999' }}>
          <option value="">🚛 Todos los camiones</option>
          {camionesUnicos.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filtroChofer} onChange={e => setFiltroChofer(e.target.value)}
          className="border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none"
          style={{ borderColor: '#e8edf8', color: filtroChofer ? '#254A96' : '#999' }}>
          <option value="">👤 Todos los choferes</option>
          {choferesUnicos.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {(filtroCamion || filtroChofer) && (
          <button onClick={() => { setFiltroCamion(''); setFiltroChofer('') }}
            className="text-xs px-2 py-1.5 rounded-lg"
            style={{ color: '#B9BBB7', background: '#f4f4f3' }}>✕ Limpiar</button>
        )}
      </div>

      {/* Ordenamiento */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold" style={{ color: '#B9BBB7' }}>Ordenar:</span>
        {([
          { key: 'ocup', label: 'Ocupación', numeric: true },
          { key: 'kg', label: 'Kg', numeric: true },
          { key: 'pos', label: 'Posiciones', numeric: true },
          { key: 'dist', label: 'Distancia', numeric: true },
          { key: 'camion', label: 'Camión', numeric: false },
          { key: 'chofer', label: 'Chofer', numeric: false },
        ] as const).map(s => {
          const active = sortKey === s.key
          const arrow = active ? (sortDir === 'desc' ? (s.numeric ? ' ↓' : ' Z→A') : (s.numeric ? ' ↑' : ' A→Z')) : ''
          return (
            <button key={s.key} onClick={() => toggleSortDia(s.key)}
              className="px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
              style={{
                background: active ? '#254A96' : '#f4f4f3',
                color: active ? 'white' : '#666',
                border: active ? 'none' : '1px solid #e8edf8',
              }}>
              {s.label}{arrow}
            </button>
          )
        })}
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

      {/* Panel flota ociosa */}
      {(() => {
        const ociosos = datosFiltrados.filter(d => d.vueltas.length > 0 && Math.max(d.ocupDiariaPctKg, d.ocupDiariaPctPos) < 40)
        if (ociosos.length === 0) return null
        return (
          <div className="rounded-xl p-4" style={{ background: '#fef3c7', border: '1px solid #fde68a' }}>
            <p className="text-sm font-semibold mb-2" style={{ color: '#b45309' }}>
              ⚠ {ociosos.length} camión{ociosos.length !== 1 ? 'es' : ''} con baja ocupación diaria
            </p>
            <div className="flex flex-wrap gap-2">
              {ociosos.map(d => (
                <span key={d.camion_codigo} className="text-xs px-2.5 py-1 rounded-full font-medium"
                  style={{ background: '#fef9c3', color: '#92400e', border: '1px solid #fde68a' }}>
                  {d.camion_codigo} · {Math.max(d.ocupDiariaPctKg, d.ocupDiariaPctPos)}% · {d.vueltas.length}/{d.vueltasMaxEfectivas}V
                </span>
              ))}
            </div>
          </div>
        )
      })()}

      {/* Cards por camión */}
      {datosSorted.map(d => {
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
                    {d.vueltas.length > 0 && (
                      <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                        style={{ background: colorSemaforo(Math.max(d.ocupDiariaPctKg, d.ocupDiariaPctPos)).bg, color: colorSemaforo(Math.max(d.ocupDiariaPctKg, d.ocupDiariaPctPos)).color }}>
                        {Math.max(d.ocupDiariaPctKg, d.ocupDiariaPctPos)}% día est.
                      </span>
                    )}
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>
                      {d.vueltas.length}/{d.vueltasMaxEfectivas}V
                    </span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                    👤 {d.chofer_nombre} · 📦 {d.pedidos} pedidos
                    {d.distanciaTotalKm > 0 && <> · 📍 {d.vueltas.every(v => v.kmReal) ? `${d.distanciaTotalKm} km` : `~${d.distanciaTotalKm} km`}</>}
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
                            📍 {v.distanciaKm > 0 ? (v.kmReal ? `${v.distanciaKm} km` : `~${v.distanciaKm} km`) : 'Sin coordenadas'}
                          </span>
                          {v.pedidosConUbicacion < v.pedidos && v.distanciaKm > 0 && (
                            <span style={{ color: '#f59e0b' }}>({v.pedidosConUbicacion}/{v.pedidos} con ubic.)</span>
                          )}
                        </div>
                        {/* Tiempos reales de la vuelta */}
                        {(v.horaInicioVuelta || v.horaFinVuelta) && (
                          <div className="flex items-center justify-between text-xs pt-1" style={{ borderTop: '1px solid #e8edf8' }}>
                            <span style={{ color: '#065f46', fontWeight: 600 }}>
                              {v.horaInicioVuelta ? `▶ ${formatHora(v.horaInicioVuelta)}` : ''}
                              {v.horaInicioVuelta && v.horaFinVuelta ? ' → ' : ''}
                              {v.horaFinVuelta ? `⏹ ${formatHora(v.horaFinVuelta)}` : ''}
                            </span>
                            {v.horaInicioVuelta && v.horaFinVuelta && (
                              <span style={{ color: '#065f46', fontWeight: 600 }}>
                                {duracion(v.horaInicioVuelta, v.horaFinVuelta)}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Horas de entrega por pedido */}
                        {(() => {
                          const entregas = v.detalle
                            .filter(p => p.hora_entregado)
                            .sort((a, b) => new Date(a.hora_entregado!).getTime() - new Date(b.hora_entregado!).getTime())
                          if (entregas.length === 0) return null
                          return (
                            <div className="text-xs pt-1" style={{ borderTop: '1px solid #e8edf8' }}>
                              <div className="flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: '#B9BBB7' }}>
                                <span style={{ color: '#254A96', fontWeight: 600 }}>📦</span>
                                {entregas.map((p, i) => (
                                  <span key={p.id}>
                                    <span style={{ color: '#1a1a1a', fontWeight: 500 }}>{formatHora(p.hora_entregado)}</span>
                                    <span style={{ color: '#B9BBB7' }}> {p.estado === 'rechazado' ? '✕' : p.estado === 'entregado_parcial' ? '½' : '✓'}</span>
                                    {i < entregas.length - 1 && <span style={{ color: '#d1d5db' }}> ·</span>}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )
                        })()}

                        {/* Tiempo estimado */}
                        {(() => {
                          const esTrailer = /trailer|semi/i.test(d.tipo_unidad ?? '')
                          const descMin = calcularTiempoDescargaMin(v.detalle, esTrailer)
                          const trasMin = v.tiempoTrasladoMin
                          // Fallback: estimación de traslado desde km en línea recta
                          // (factor 1.3 de desvío de ruta × vel promedio según sucursal)
                          const velKmh = getVelFallback(d.sucursal)
                          const trasEst = trasMin === null && v.distanciaKm > 0
                            ? Math.round(v.distanciaKm * 1.3 / velKmh * 60)
                            : null
                          const trasUsado = trasMin ?? trasEst
                          if (descMin === 0 && trasUsado === null) return null
                          const totalMin = (trasUsado ?? 0) + descMin
                          return (
                            <div className="text-xs pt-1" style={{ borderTop: '1px solid #e8edf8' }}>
                              <div className="flex items-center justify-between">
                                <span style={{ color: '#7c3aed', fontWeight: 600 }}>⏱ Est: {formatMinutos(totalMin)}</span>
                                <span style={{ color: '#B9BBB7', fontSize: 10 }}>
                                  {trasUsado !== null
                                    ? `${trasMin === null ? '~' : ''}${formatMinutos(trasUsado)} traslado + `
                                    : ''
                                  }{formatMinutos(descMin)} descarga
                                </span>
                              </div>
                            </div>
                          )
                        })()}
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
                    { label: 'Min/km', value: (() => { const km = d.km_ruta ?? (d.distanciaTotalKm > 0 ? d.distanciaTotalKm : null); const v = minKm(d.hora_inicio, d.hora_fin, km); return v !== '—' ? `${v} min/km${!d.km_ruta ? ' ~' : ''}` : '—' })() },
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

      {/* Unidades no activadas — informativo */}
      {camionesNoActivados.length > 0 && (
        <div className="rounded-xl p-4" style={{ background: '#f4f4f3', border: '1px solid #e8edf8' }}>
          <p className="text-sm font-medium mb-2" style={{ color: '#666' }}>
            ℹ {camionesNoActivados.length} unidad{camionesNoActivados.length !== 1 ? 'es' : ''} disponible{camionesNoActivados.length !== 1 ? 's' : ''} no activada{camionesNoActivados.length !== 1 ? 's' : ''} hoy
          </p>
          <div className="flex flex-wrap gap-2">
            {camionesNoActivados.map(c => (
              <span key={c.camion_codigo} className="text-xs px-2.5 py-1 rounded-full"
                style={{ background: 'white', color: '#888', border: '1px solid #e8edf8' }}>
                {c.camion_codigo} · {c.sucursal}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Modal pedidos de vuelta */}
      {modalVuelta && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={() => setModalVuelta(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden"
            style={{ maxWidth: 820, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
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
                  {modalVuelta.vuelta.distanciaKm > 0 && <>
                    {' '}· {modalVuelta.vuelta.kmReal ? `${modalVuelta.vuelta.distanciaKm} km` : `~${modalVuelta.vuelta.distanciaKm} km est.`}
                  </>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {(() => {
                  const paradas = modalVuelta.vuelta.detalle
                    .filter(p => p.latitud && p.longitud)
                    .sort((a, b) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))
                  if (paradas.length === 0) return null
                  const camionData = datos.find(d => d.camion_codigo === modalVuelta.camion)
                  const depot = camionData ? (DEPOSITOS[camionData.sucursal] ?? null) : null
                  const depotStr = depot ? `${depot.lat},${depot.lng}` : ''
                  // Ruta: depósito → paradas en orden → vuelta al depósito
                  const wps = paradas.map(p => `${p.latitud},${p.longitud}`).join('|')
                  const mapsUrl = depotStr
                    ? `https://www.google.com/maps/dir/?api=1&origin=${depotStr}&destination=${depotStr}&travelmode=driving&waypoints=${wps}`
                    : `https://www.google.com/maps/dir/?api=1&destination=${paradas[paradas.length-1].latitud},${paradas[paradas.length-1].longitud}&travelmode=driving${paradas.length > 1 ? `&waypoints=${paradas.slice(0,-1).map(p=>`${p.latitud},${p.longitud}`).join('|')}` : ''}`
                  return (
                    <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                      className="text-xs px-3 py-1.5 rounded-lg font-semibold whitespace-nowrap"
                      style={{ background: '#254A96', color: 'white' }}>
                      🗺️ Ver en Maps
                    </a>
                  )
                })()}
                <button
                  onClick={() => setModalVuelta(null)}
                  className="text-xl leading-none px-2"
                  style={{ color: '#B9BBB7' }}
                >×</button>
              </div>
            </div>

            {/* Table */}
            <div style={{ overflowY: 'auto', overflowX: 'auto', flex: 1 }}>
              <table className="w-full text-sm" style={{ minWidth: 700 }}>
                <thead>
                  <tr style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
                    {['#', 'NV', 'Cliente', 'Kg', 'Pos', 'Estado', 'Pago', 'Hora entrega', ''].map(h => (
                      <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {modalVuelta.vuelta.detalle.map((p, i) => {
                    const sem = ESTADO_COLOR[p.estado] ?? { bg: '#f4f4f3', color: '#666' }
                    const pagoLabel: Record<string, string> = {
                      cobrado: 'Cobrado', cuenta_corriente: 'Cta. Cte.',
                      pendiente_cobro: 'Pend.', pago_en_obra: 'En obra',
                    }
                    const pagoBg: Record<string, { bg: string; color: string }> = {
                      cobrado: { bg: '#dcfce7', color: '#166534' },
                      cuenta_corriente: { bg: '#dbeafe', color: '#1e40af' },
                      pendiente_cobro: { bg: '#fef9c3', color: '#854d0e' },
                      pago_en_obra: { bg: '#ffedd5', color: '#9a3412' },
                    }
                    const pagoStyle = p.estado_pago ? (pagoBg[p.estado_pago] ?? { bg: '#f4f4f3', color: '#555' }) : null
                    return (
                      <tr key={p.id} style={{ borderBottom: '1px solid #f9f9f9', background: i % 2 === 0 ? 'white' : '#fdfdfd' }}>
                        <td className="px-4 py-2.5 text-xs" style={{ color: '#B9BBB7' }}>{p.orden_entrega ?? i + 1}</td>
                        <td className="px-4 py-2.5 text-xs font-medium whitespace-nowrap" style={{ color: '#254A96' }}>
                          {p.tipo === 'retiro'
                            ? <span className="text-xs px-1.5 py-0.5 rounded font-semibold" style={{ background: '#ccfbf1', color: '#0f766e' }}>🔄 RETIRO</span>
                            : p.nv
                          }
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs font-medium" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
                          <p className="text-xs" style={{ color: '#B9BBB7' }}>{p.direccion}</p>
                          {p.notas && <p className="text-xs mt-0.5 italic" style={{ color: '#94a3b8' }}>📝 {p.notas}</p>}
                        </td>
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
                        <td className="px-4 py-2.5">
                          {pagoStyle
                            ? <span className="text-xs px-2 py-0.5 rounded-lg font-medium whitespace-nowrap" style={{ background: pagoStyle.bg, color: pagoStyle.color }}>
                                {pagoLabel[p.estado_pago!] ?? p.estado_pago}
                              </span>
                            : <span style={{ color: '#ddd' }}>—</span>
                          }
                        </td>
                        <td className="px-4 py-2.5 text-xs whitespace-nowrap" style={{ color: p.hora_entregado ? '#065f46' : '#ddd', fontWeight: p.hora_entregado ? 600 : 400 }}>
                          {p.hora_entregado ? formatHora(p.hora_entregado) : '—'}
                        </td>
                        <td className="px-3 py-2.5">
                          <a
                            href={`/pedidos?nv=${encodeURIComponent(p.nv)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs px-2 py-1 rounded-lg font-semibold whitespace-nowrap inline-block"
                            style={{ background: '#e8edf8', color: '#254A96' }}
                            title="Ver detalle completo (nueva pestaña)"
                          >→</a>
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
  type SortKeyMes = 'camion' | 'ocup_kg' | 'ocup_pos' | 'dist'
  const [sortKey, setSortKey] = useState<SortKeyMes>('ocup_kg')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  function toggleSort(k: SortKeyMes) {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir('desc') }
  }
  const datosSorted = [...datos].sort((a, b) => {
    let v = 0
    if (sortKey === 'camion') v = a.camion_codigo.localeCompare(b.camion_codigo)
    else if (sortKey === 'ocup_kg') v = a.avgPctKg - b.avgPctKg
    else if (sortKey === 'ocup_pos') v = a.avgPctPos - b.avgPctPos
    else if (sortKey === 'dist') v = a.totalKm - b.totalKm
    return sortDir === 'desc' ? -v : v
  })

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
                <SortTh label="Camión" sortKey="camion" active={sortKey === 'camion'} dir={sortDir} onClick={() => toggleSort('camion')} numeric={false} />
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Sucursal</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Días activo</th>
                <SortTh label="Ocup. kg" sortKey="ocup_kg" active={sortKey === 'ocup_kg'} dir={sortDir} onClick={() => toggleSort('ocup_kg')} />
                <SortTh label="Ocup. pos" sortKey="ocup_pos" active={sortKey === 'ocup_pos'} dir={sortDir} onClick={() => toggleSort('ocup_pos')} />
                <SortTh label="Total km" sortKey="dist" active={sortKey === 'dist'} dir={sortDir} onClick={() => toggleSort('dist')} />
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Min/km prom</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {datosSorted.map((d, i) => {
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

// ─── Vista Rango ─────────────────────────────────────────────────────────────────

function VistaRango({ datos, loading, onExport }: { datos: DatosRangoDia[]; loading: boolean; onExport: () => void }) {
  type SortKeyRango = 'fecha' | 'camion' | 'chofer' | 'kg' | 'pos' | 'dist' | 'ocup_kg' | 'ocup_pos'
  const [sortKey, setSortKey] = useState<SortKeyRango>('fecha')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  function toggleSort(k: SortKeyRango) {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc')
    else { setSortKey(k); setSortDir(k === 'fecha' || k === 'camion' || k === 'chofer' ? 'asc' : 'desc') }
  }
  const datosSorted = [...datos].sort((a, b) => {
    let v = 0
    if (sortKey === 'fecha') v = a.fecha.localeCompare(b.fecha) || a.camion_codigo.localeCompare(b.camion_codigo)
    else if (sortKey === 'camion') v = a.camion_codigo.localeCompare(b.camion_codigo)
    else if (sortKey === 'chofer') v = a.chofer_nombre.localeCompare(b.chofer_nombre)
    else if (sortKey === 'kg') v = a.kgUsados - b.kgUsados
    else if (sortKey === 'pos') v = a.posUsadas - b.posUsadas
    else if (sortKey === 'dist') v = (a.kmReal ?? -1) - (b.kmReal ?? -1)
    else if (sortKey === 'ocup_kg') v = a.pctKg - b.pctKg
    else if (sortKey === 'ocup_pos') v = a.pctPos - b.pctPos
    return sortDir === 'desc' ? -v : v
  })

  if (loading) return (
    <div className="flex justify-center py-24">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  if (datos.length === 0) return (
    <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
      <div className="text-5xl mb-4">📅</div>
      <p className="font-medium">Aplicá filtros y hacé clic en Buscar</p>
      <p className="text-sm mt-1">Se mostrarán los datos día a día para el rango seleccionado</p>
    </div>
  )

  const totalPedidos = datos.reduce((a, r) => a + r.pedidos, 0)
  const diasUnicos = new Set(datos.map(r => r.fecha)).size
  const avgPctKg = datos.length > 0 ? Math.round(datos.reduce((a, r) => a + r.pctKg, 0) / datos.length) : 0
  const avgPctPos = datos.length > 0 ? Math.round(datos.reduce((a, r) => a + r.pctPos, 0) / datos.length) : 0

  const DIAS_FIN_SEMANA = new Set(['sáb', 'dom', 'sab'])

  return (
    <div className="space-y-4">
      {/* Resumen */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Días con datos', value: diasUnicos, emoji: '📅', bg: '#e8edf8', color: '#254A96' },
          { label: 'Total pedidos', value: totalPedidos, emoji: '📦', bg: '#f3e8ff', color: '#7c3aed' },
          { label: 'Ocup. prom. kg', value: `${avgPctKg}%`, emoji: '⚖️', bg: colorSemaforo(avgPctKg).bg, color: colorSemaforo(avgPctKg).color },
          { label: 'Ocup. prom. pos', value: `${avgPctPos}%`, emoji: '📐', bg: colorSemaforo(avgPctPos).bg, color: colorSemaforo(avgPctPos).color },
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

      {/* Tabla */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f0f0f0' }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>
            {datos.length} registros
          </p>
          <button onClick={onExport}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold"
            style={{ background: '#f4f4f3', color: '#254A96', border: '1px solid #e8edf8' }}>
            ⬇️ Exportar Excel
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 900 }}>
            <thead>
              <tr style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
                <SortTh label="Fecha" sortKey="fecha" active={sortKey === 'fecha'} dir={sortDir} onClick={() => toggleSort('fecha')} numeric={false} />
                <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Día</th>
                <SortTh label="Camión" sortKey="camion" active={sortKey === 'camion'} dir={sortDir} onClick={() => toggleSort('camion')} numeric={false} />
                <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Sucursal</th>
                <SortTh label="Chofer" sortKey="chofer" active={sortKey === 'chofer'} dir={sortDir} onClick={() => toggleSort('chofer')} numeric={false} />
                <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Pedidos</th>
                <SortTh label="Kg" sortKey="kg" active={sortKey === 'kg'} dir={sortDir} onClick={() => toggleSort('kg')} />
                <SortTh label="Pos" sortKey="pos" active={sortKey === 'pos'} dir={sortDir} onClick={() => toggleSort('pos')} />
                <SortTh label="Ocup.Kg%" sortKey="ocup_kg" active={sortKey === 'ocup_kg'} dir={sortDir} onClick={() => toggleSort('ocup_kg')} />
                <SortTh label="Ocup.Pos%" sortKey="ocup_pos" active={sortKey === 'ocup_pos'} dir={sortDir} onClick={() => toggleSort('ocup_pos')} />
                <SortTh label="Km" sortKey="dist" active={sortKey === 'dist'} dir={sortDir} onClick={() => toggleSort('dist')} />
                <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Inicio</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Fin</th>
                <th className="text-left px-3 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>Duración</th>
              </tr>
            </thead>
            <tbody>
              {datosSorted.map((r, i) => {
                const esFinde = DIAS_FIN_SEMANA.has(r.diaSemana.toLowerCase())
                return (
                  <tr key={`${r.fecha}|${r.camion_codigo}`} style={{ borderBottom: '1px solid #f9f9f9', background: i % 2 === 0 ? 'white' : '#fdfdfd' }}>
                    <td className="px-3 py-2.5 text-xs font-medium whitespace-nowrap" style={{ color: '#1a1a1a' }}>{r.fecha}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold whitespace-nowrap"
                      style={{ color: esFinde ? '#b45309' : '#254A96' }}>
                      {r.diaSemana}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-bold whitespace-nowrap" style={{ color: '#254A96' }}>{r.camion_codigo}</td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>{r.sucursal}</td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#666' }}>{r.chofer_nombre}</td>
                    <td className="px-3 py-2.5 text-xs font-medium" style={{ color: '#1a1a1a' }}>{r.pedidos}</td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#1a1a1a' }}>
                      {r.kgUsados.toLocaleString('es-AR')}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#1a1a1a' }}>{r.posUsadas}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-2 rounded-full" style={{ background: '#f0f0f0' }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.min(r.pctKg, 100)}%`, background: colorBarra(r.pctKg) }} />
                        </div>
                        <span className="text-xs font-semibold whitespace-nowrap" style={{ color: colorBarra(r.pctKg) }}>{r.pctKg}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-2 rounded-full" style={{ background: '#f0f0f0' }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.min(r.pctPos, 100)}%`, background: colorBarra(r.pctPos) }} />
                        </div>
                        <span className="text-xs font-semibold whitespace-nowrap" style={{ color: colorBarra(r.pctPos) }}>{r.pctPos}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                      {r.kmReal !== null ? `${r.kmReal} km` : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                      {formatHora(r.hora_inicio)}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                      {formatHora(r.hora_fin)}
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                      {r.duracionMin !== null ? formatMinutos(r.duracionMin) : '—'}
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

// ─── Chat Bot ────────────────────────────────────────────────────────────────────

function ChatBot({ sucursal }: { sucursal: string }) {
  const [mensajes, setMensajes] = useState<{ rol: 'user' | 'assistant'; texto: string }[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    enviar('Dame un resumen ejecutivo de la operación: ocupación promedio de flota, sucursal más activa, tendencias clave y las 2-3 oportunidades de mejora más importantes.', true)
  }, [])

  async function enviar(texto: string, silencioso = false) {
    if (loading) return
    const prevMensajes = silencioso ? [] : [...mensajes, { rol: 'user' as const, texto }]
    if (!silencioso) setMensajes(prevMensajes)
    setLoading(true)

    const msgsApi = [...prevMensajes.map(m => ({ role: m.rol, content: m.texto })),
      ...(silencioso ? [{ role: 'user' as const, content: texto }] : [])
    ]

    try {
      const res = await fetch('/api/metricas-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgsApi, sucursal }),
      })
      const data = await res.json()
      const resp = data.respuesta ?? (data.error ? `Error: ${data.error}` : 'Sin respuesta')
      setMensajes(prev => [...(silencioso ? [] : prev), { rol: 'assistant', texto: resp }])
    } catch {
      setMensajes(prev => [...(silencioso ? [] : prev), { rol: 'assistant', texto: 'Error de conexión. Intentá de nuevo.' }])
    }
    setLoading(false)
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 100)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const txt = input.trim()
    if (!txt || loading) return
    enviar(txt)
    setInput('')
  }

  function renderMarkdown(text: string) {
    return text.split('\n').map((line, i) => {
      const html = line
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- /, '• ')
      const isItem = line.startsWith('- ') || line.startsWith('• ')
      return (
        <p key={i}
          className="leading-relaxed"
          style={{ fontSize: 13, color: '#1a1a1a', paddingLeft: isItem ? 8 : 0, marginBottom: 2 }}
          dangerouslySetInnerHTML={{ __html: html }} />
      )
    })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3" style={{ fontFamily: 'Barlow, sans-serif' }}>
        {mensajes.length === 0 && loading && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
            <p className="text-xs" style={{ color: '#B9BBB7' }}>Analizando los últimos 30 días...</p>
          </div>
        )}
        {mensajes.map((m, i) => (
          <div key={i} className={`flex ${m.rol === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className="rounded-2xl px-3 py-2.5" style={{
              maxWidth: '88%',
              background: m.rol === 'user' ? '#254A96' : '#f4f4f3',
            }}>
              {m.rol === 'user'
                ? <p style={{ fontSize: 13, color: 'white' }}>{m.texto}</p>
                : <div>{renderMarkdown(m.texto)}</div>
              }
            </div>
          </div>
        ))}
        {loading && mensajes.length > 0 && (
          <div className="flex justify-start">
            <div className="px-3 py-2.5 rounded-2xl" style={{ background: '#f4f4f3' }}>
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map(j => (
                  <div key={j} className="w-1.5 h-1.5 rounded-full animate-bounce"
                    style={{ background: '#B9BBB7', animationDelay: `${j * 0.15}s` }} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Suggested questions */}
      {mensajes.length === 1 && !loading && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {[
            '¿Qué camiones están ociosos?',
            '¿Cuál es el día más cargado?',
            '¿Cómo mejorar la ocupación?',
            '¿Qué sucursal tiene más rechazos?',
          ].map(q => (
            <button key={q} onClick={() => { enviar(q); }}
              className="text-xs px-2.5 py-1.5 rounded-xl"
              style={{ background: '#e8edf8', color: '#254A96' }}>
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-3 border-t shrink-0" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Preguntá sobre tus datos..."
            disabled={loading}
            className="flex-1 border rounded-xl px-3 py-2 focus:outline-none"
            style={{ fontSize: 13, borderColor: '#e8edf8' }}
          />
          <button type="submit" disabled={loading || !input.trim()}
            className="px-3 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-40"
            style={{ background: '#254A96' }}>
            →
          </button>
        </div>
      </form>
    </div>
  )
}
