import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleAuth } from 'google-auth-library'

const client = new Anthropic()

// Obtiene un Bearer token usando el Service Account JSON
async function getGoogleBearerToken(): Promise<string> {
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!serviceAccountJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no está configurada')
  // Limpiar posibles caracteres extra (comillas envolventes, espacios, BOM)
  const cleaned = serviceAccountJson
    .trim()
    .replace(/^["']/, '')   // quitar comilla inicial si hay
    .replace(/["']$/, '')   // quitar comilla final si hay
  let credentials: any
  try {
    credentials = JSON.parse(cleaned)
  } catch (e: any) {
    throw new Error(`JSON inválido en GOOGLE_SERVICE_ACCOUNT_JSON: ${e.message}. Primeros 30 chars: ${cleaned.slice(0, 30)}`)
  }
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  const token = await auth.getAccessToken()
  if (!token) throw new Error('No se pudo obtener el Bearer token de Google')
  return token
}

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

interface PedidoInput {
  id: string
  nv: string
  cliente: string
  direccion: string
  localidad?: string
  latitud?: number | null
  longitud?: number | null
  peso_total_kg: number | null
  volumen_total_m3: number | null
  requiere_volcador?: boolean
  barrio_cerrado?: boolean
  camion_id?: string | null
  vuelta?: number
  items?: { nombre: string }[]
}

interface CamionInput {
  codigo: string
  tipo_unidad: string
  tonelaje_max_kg: number
  posiciones_total: number
  grua_hidraulica: boolean
  volcador: boolean
}

// Coordenadas de depósitos por sucursal
const DEPOSITOS: Record<string, { lat: number; lng: number }> = {
  'LP520':    { lat: -34.965403, lng: -58.06488 },
  'LP139':    { lat: -34.914872, lng: -58.023912 },
  'Guernica': { lat: -34.91118,  lng: -58.39945 },
  'Cañuelas': { lat: -35.0004012, lng: -58.7474278 },
  'Pinamar':  { lat: -37.207852, lng: -56.972302 },
}

// Ventanas horarias por vuelta (UTC, Argentina = UTC-3)
function getTimeWindow(vuelta: number, dateStr: string) {
  const windows: Record<number, { start: string; end: string }> = {
    1: { start: `${dateStr}T11:00:00Z`, end: `${dateStr}T13:00:00Z` },  // 08-10 ART
    2: { start: `${dateStr}T13:00:00Z`, end: `${dateStr}T15:00:00Z` },  // 10-12 ART
    3: { start: `${dateStr}T16:00:00Z`, end: `${dateStr}T18:00:00Z` },  // 13-15 ART
    4: { start: `${dateStr}T18:00:00Z`, end: `${dateStr}T20:00:00Z` },  // 15-17 ART
    5: { start: `${dateStr}T20:00:00Z`, end: `${dateStr}T23:00:00Z` },  // 17-20 ART
  }
  const w = windows[vuelta]
  if (!w) return null
  return { startTime: w.start, endTime: w.end }
}

// Tipo de shipment según items del pedido
function getShipmentType(p: PedidoInput): string {
  if (p.requiere_volcador) return 'granel'
  const LARGO = ['chapa', 'perfil', 'caño', 'tubo', 'canal', 'angulo', 'zingueria']
  if ((p.items ?? []).some(it => LARGO.some(k => it.nombre.toLowerCase().includes(k)))) return 'hierro_largo'
  const HIERRO = ['hierro', 'barra', 'varilla', 'malla', 'vigueta', 'alambre', 'pretensado']
  if ((p.items ?? []).some(it => HIERRO.some(k => it.nombre.toLowerCase().includes(k)))) return 'hierro_normal'
  return 'general'
}

// ─── Route Optimization API (Google) ─────────────────────────────────────────

async function sugerirConRouteOptimization(
  pedidos: PedidoInput[],
  camiones: CamionInput[],
  ya_asignados: PedidoInput[],
  sugerencia: Record<string, string | null>,
  sucursal: string,
): Promise<{ asignacion: Record<string, string | null>; cambios: any[]; engine: string }> {

  const projectId = process.env.GOOGLE_CLOUD_PROJECT!
  const bearerToken = await getGoogleBearerToken()
  const depot = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }

  // Separar pedidos con y sin coordenadas
  const conCoords = pedidos.filter(p => p.latitud != null && p.longitud != null)
  const sinCoords = pedidos.filter(p => p.latitud == null || p.longitud == null)

  // Si no hay pedidos con coordenadas, no vale la pena llamar a la API
  if (conCoords.length === 0) {
    return { asignacion: sugerencia, cambios: [], engine: 'algorithm-fallback-no-coords' }
  }

  // Calcular carga actual de cada camión (ya_asignados)
  const cargaActual: Record<string, { kg: number; pos: number }> = {}
  camiones.forEach(c => { cargaActual[c.codigo] = { kg: 0, pos: 0 } })
  ya_asignados.forEach(p => {
    if (p.camion_id && cargaActual[p.camion_id]) {
      cargaActual[p.camion_id].kg += p.peso_total_kg ?? 0
      cargaActual[p.camion_id].pos += p.volumen_total_m3 ?? 0
    }
  })

  // Fecha de hoy para ventanas horarias
  const dateStr = new Date().toISOString().split('T')[0]
  const vuelta = conCoords[0]?.vuelta ?? 1

  // Construir shipments (pedidos con coordenadas)
  const shipments = conCoords.map(p => {
    const tw = getTimeWindow(vuelta, dateStr)
    const delivery: any = {
      arrivalLocation: { latitude: p.latitud!, longitude: p.longitud! },
      duration: '600s', // 10 min de descarga por defecto
    }
    if (tw) delivery.timeWindows = [tw]

    return {
      label: p.id,
      deliveries: [delivery],
      loadDemands: {
        weight_kg: { amount: String(Math.round(p.peso_total_kg ?? 0)) },
        // positions × 10 para evitar decimales (el API requiere int)
        positions_x10: { amount: String(Math.round((p.volumen_total_m3 ?? 0) * 10)) },
      },
      shipmentType: getShipmentType(p),
      // Restricción de vehículo si requiere volcador (solo si hay al menos 1 camión con volcador)
      ...(p.requiere_volcador ? (() => {
        const indices = camiones
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.volcador)
          .map(({ i }) => i)
        return indices.length > 0 ? { allowedVehicleIndices: indices } : {}
      })() : {}),
    }
  })

  // Construir vehicles (camiones con capacidad residual)
  const vehicles = camiones.map(c => ({
    label: c.codigo,
    startLocation: { latitude: depot.lat, longitude: depot.lng },
    endLocation: { latitude: depot.lat, longitude: depot.lng },
    loadLimits: {
      weight_kg: {
        maxLoad: String(Math.max(0, Math.round(c.tonelaje_max_kg - (cargaActual[c.codigo]?.kg ?? 0)))),
      },
      positions_x10: {
        maxLoad: String(Math.max(0, Math.round((c.posiciones_total - (cargaActual[c.codigo]?.pos ?? 0)) * 10))),
      },
    },
    costPerKilometer: 1.0,
    costPerHour: 30.0,
  }))

  // Incompatibilidades de tipos de carga
  const shipmentTypeIncompatibilities = [
    {
      types: ['hierro_largo', 'general'],
      incompatibilityMode: 'NOT_PERFORMED_BY_SAME_VEHICLE',
    },
    {
      types: ['hierro_largo', 'granel'],
      incompatibilityMode: 'NOT_PERFORMED_BY_SAME_VEHICLE',
    },
  ]

  const requestBody = {
    model: {
      globalStartTime: `${dateStr}T08:00:00Z`,
      globalEndTime: `${dateStr}T23:59:00Z`,
      shipments,
      vehicles,
      shipmentTypeIncompatibilities,
    },
    searchMode: 'RETURN_FAST',
    considerRoadTraffic: false,
  }

  // Probar múltiples URLs — Maps Platform puede requerir formato diferente
  const URLS_TO_TRY = [
    `https://routeoptimization.googleapis.com/v1/projects/${projectId}/locations/global:optimizeTours`,
    `https://routeoptimization.googleapis.com/v1/projects/${projectId}/locations/us-central1:optimizeTours`,
    `https://routeoptimization.googleapis.com/v1/projects/${projectId}/locations/europe-west1:optimizeTours`,
    `https://routeoptimization.googleapis.com/v1/projects/${projectId}:optimizeTours`,
  ]
  let response: Response | null = null
  let lastErr = ''
  for (const url of URLS_TO_TRY) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${bearerToken}` },
      body: JSON.stringify(requestBody),
    })
    if (r.ok) { response = r; break }
    const errText = await r.text()
    lastErr = `${r.status}/${url.split('/locations/')[1] ?? 'no-loc'}: ${errText.slice(0, 120)}`
    if (!errText.includes('Unsupported location') && !errText.includes('NOT_FOUND') && r.status !== 404) {
      throw new Error(`Route Optimization API error ${lastErr}`)
    }
  }
  if (!response) throw new Error(`Route Optimization API falló en todas las regiones. Último error: ${lastErr}`)

  const result = await response.json()

  // Mapear respuesta → { pedido_id: camion_codigo }
  const asignacion: Record<string, string | null> = { ...sugerencia }

  // Pedidos que la API asignó a camiones
  if (result.routes) {
    for (const route of result.routes) {
      const camionCodigo = route.vehicleLabel as string
      for (const visit of (route.visits ?? [])) {
        const pedidoId = visit.shipmentLabel as string
        if (pedidoId) asignacion[pedidoId] = camionCodigo
      }
    }
  }

  // Pedidos que la API no pudo asignar (skippedShipments)
  if (result.skippedShipments) {
    for (const skipped of result.skippedShipments) {
      const pedidoId = skipped.label as string
      if (pedidoId) asignacion[pedidoId] = null
    }
  }

  // Pedidos sin coordenadas → usar la sugerencia del algoritmo original
  for (const p of sinCoords) {
    asignacion[p.id] = sugerencia[p.id] ?? null
  }

  // Calcular cambios respecto a la sugerencia original
  const cambios: any[] = []
  for (const p of conCoords) {
    const antes = sugerencia[p.id]
    const despues = asignacion[p.id]
    if (antes !== despues) {
      cambios.push({
        nv: p.nv,
        de: antes ?? 'sin asignar',
        a: despues ?? 'sin asignar',
        motivo: 'Route Optimization API',
      })
    }
  }

  return { asignacion, cambios, engine: 'google-route-optimization' }
}

// ─── Claude Haiku (motor original) ───────────────────────────────────────────

async function sugerirConClaude(
  pedidos: PedidoInput[],
  camiones: CamionInput[],
  ya_asignados: PedidoInput[],
  sugerencia: Record<string, string | null>,
  sucursal: string,
): Promise<{ asignacion: Record<string, string | null>; cambios: any[]; tokens?: any; engine: string }> {

  const pedidosPorCamion: Record<string, PedidoInput[]> = {}
  camiones.forEach(c => { pedidosPorCamion[c.codigo] = [] })

  ya_asignados.forEach(p => {
    if (p.camion_id && pedidosPorCamion[p.camion_id]) pedidosPorCamion[p.camion_id].push(p)
  })
  pedidos.forEach(p => {
    const cam = sugerencia[p.id]
    if (cam && pedidosPorCamion[cam]) pedidosPorCamion[cam].push(p)
  })

  const sinAsignar = pedidos.filter(p => sugerencia[p.id] === null || sugerencia[p.id] === undefined)

  function descPedido(p: PedidoInput) {
    const loc = p.localidad ? `[${p.localidad}]` : ''
    return `NV${p.nv} | ${p.cliente} | "${p.direccion}" ${loc} | ${p.volumen_total_m3 ?? 0}pos ${p.peso_total_kg ?? 0}kg`
  }

  const camionesStr = camiones.map(c => {
    const ps = pedidosPorCamion[c.codigo]
    const kgUsado = ps.reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
    const posUsado = ps.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
    const listaStr = ps.length ? ps.map(p => `    - ${descPedido(p)}`).join('\n') : '    (vacío)'
    return `${c.codigo} [${c.tipo_unidad}, grua=${c.grua_hidraulica ? 'SÍ' : 'NO'}, volcador=${c.volcador ? 'SÍ' : 'NO'}] Máx:${c.tonelaje_max_kg}kg/${c.posiciones_total}pos — Libre:${c.tonelaje_max_kg - kgUsado}kg/${c.posiciones_total - posUsado}pos\n${listaStr}`
  }).join('\n\n')

  const sinAsignarStr = sinAsignar.length
    ? sinAsignar.map(p => `  - ${descPedido(p)}`).join('\n')
    : '  (ninguno)'

  function computarClusters(ps: PedidoInput[]): PedidoInput[][] {
    const n = ps.length
    const parent = Array.from({ length: n }, (_, i) => i)
    function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])) }
    function union(i: number, j: number) { parent[find(i)] = find(j) }
    const normStr = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.,\-#°]/g, ' ').replace(/\s+/g, ' ').trim()
    const normCliente = (c: string) => c.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\./g, '').replace(/[,\-#°]/g, ' ').replace(/\s+/g, ' ').trim()
    function nombreBarrio(dir: string): string {
      if (!dir) return ''
      const SKIP = /^(buenos aires|córdoba|cordoba|santa fe|mendoza|prov\.|pcia\.|argentina|bs\.? ?as?\.?)$/i
      const parts = dir.split(',').map(s => s.trim()).filter(Boolean)
      const candidates = parts.filter(p => !/\d/.test(p) && !SKIP.test(p) && p.length > 2 && p.length < 50)
      const raw = candidates.length >= 2 ? candidates[candidates.length - 2] : candidates[candidates.length - 1]
      if (!raw) return ''
      return raw.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim()
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = ps[i], b = ps[j]
        if (a.barrio_cerrado && b.barrio_cerrado) {
          const ba = nombreBarrio(a.direccion), bb = nombreBarrio(b.direccion)
          if (ba && bb && ba === bb) { union(i, j); continue }
        }
        if (a.direccion && b.direccion && normStr(a.direccion) === normStr(b.direccion)) { union(i, j); continue }
        const tienenCoords = a.latitud != null && a.longitud != null && b.latitud != null && b.longitud != null
        if (a.cliente && b.cliente && normCliente(a.cliente) === normCliente(b.cliente)) {
          if (tienenCoords && distKm(a.latitud!, a.longitud!, b.latitud!, b.longitud!) < 2) union(i, j)
          continue
        }
        if (tienenCoords && distKm(a.latitud!, a.longitud!, b.latitud!, b.longitud!) < 15) union(i, j)
      }
    }
    const groups = new Map<number, PedidoInput[]>()
    for (let i = 0; i < n; i++) {
      const r = find(i)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r)!.push(ps[i])
    }
    return Array.from(groups.values()).filter(g => g.length > 1)
  }

  const clusters = computarClusters(pedidos)
  const clustersStr = clusters.length > 0
    ? clusters.map((g, i) => {
        const dist = g.length === 2 && g[0].latitud && g[1].latitud
          ? ` (${distKm(g[0].latitud!, g[0].longitud!, g[1].latitud!, g[1].longitud!).toFixed(1)} km entre sí)`
          : ''
        return `  Grupo ${i + 1}: ${g.map(p => `NV${p.nv} (${p.cliente})`).join(' + ')}${dist}`
      }).join('\n')
    : '  (ninguno — todos a distancias distintas)'

  const pedidosIds = pedidos.map(p => `"${p.id}": NV${p.nv}`).join(', ')

  const prompt = `Sos un asistente de logística para ${sucursal}, empresa de materiales de construcción en Argentina.

CAMIONES Y ASIGNACIÓN ACTUAL DEL ALGORITMO:
${camionesStr}

SIN ASIGNAR:
${sinAsignarStr}

IDs de los pedidos a incluir en la respuesta: ${pedidosIds}

GRUPOS GEOGRÁFICOS PRE-COMPUTADOS (pedidos a < 6 km o mismo cliente/dirección — DEBEN ir en el mismo camión):
${clustersStr}

REGLAS QUE NO PODÉS VIOLAR:
- Nunca superes kg ni posiciones máximas de un camión
- requiere grua → solo camiones con grua=SÍ
- requiere volcador → solo camiones con volcador=SÍ
- Los pedidos de cada GRUPO GEOGRÁFICO deben quedar en el MISMO camión (prioridad máxima)

TU TAREA:
1. Para cada Grupo Geográfico: si sus pedidos están en camiones distintos → unificálos al camión que tenga más capacidad libre, siempre que entren juntos
2. Misma dirección o mismo cliente en camiones distintos → moverlos al mismo camión
3. Si para unificar A y B necesitás mover C a otro lado, hacelo — verificá que C entre en el nuevo camión
4. Pedidos sin asignar: asignarlos si hay camión con capacidad

Respondé ÚNICAMENTE con JSON válido, sin texto antes ni después:
{
  "asignacion": { "<id_pedido>": "<codigo_camion_o_null>" },
  "cambios": [{ "nv": "<nv>", "de": "<anterior>", "a": "<nuevo>", "motivo": "<motivo breve>" }]
}

La "asignacion" debe incluir TODOS los ids de la lista.`

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = (response.content[0] as { type: string; text: string }).text.trim()
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { asignacion: sugerencia, cambios: [], engine: 'claude-haiku-fallback' }

  const result = JSON.parse(jsonMatch[0])

  const asignacionFinal: Record<string, string | null> = { ...sugerencia }
  const cambiosValidos: any[] = []

  if (result.asignacion && typeof result.asignacion === 'object') {
    const kgProp: Record<string, number> = {}
    const posProp: Record<string, number> = {}
    camiones.forEach(c => {
      kgProp[c.codigo] = ya_asignados.filter(p => p.camion_id === c.codigo).reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
      posProp[c.codigo] = ya_asignados.filter(p => p.camion_id === c.codigo).reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
    })
    for (const [pedidoId, camCod] of Object.entries(result.asignacion as Record<string, string | null>)) {
      const p = pedidos.find(x => x.id === pedidoId)
      if (!p || !camCod) continue
      const c = camiones.find(x => x.codigo === camCod)
      if (!c) continue
      kgProp[camCod] = (kgProp[camCod] ?? 0) + (p.peso_total_kg ?? 0)
      posProp[camCod] = (posProp[camCod] ?? 0) + (p.volumen_total_m3 ?? 0)
    }
    let valido = true
    for (const c of camiones) {
      if ((kgProp[c.codigo] ?? 0) > c.tonelaje_max_kg || (posProp[c.codigo] ?? 0) > c.posiciones_total) { valido = false; break }
    }
    if (valido) {
      Object.assign(asignacionFinal, result.asignacion)
      cambiosValidos.push(...(result.cambios ?? []))
    }
  }

  return { asignacion: asignacionFinal, cambios: cambiosValidos, tokens: response.usage, engine: 'claude-haiku' }
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { pedidos, camiones, ya_asignados, sugerencia, sucursal } = body as {
      pedidos: PedidoInput[]
      camiones: CamionInput[]
      ya_asignados: PedidoInput[]
      sugerencia: Record<string, string | null>
      sucursal: string
    }

    // Elegir motor según env vars
    const useGoogleApi = !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CLOUD_PROJECT)

    let result: { asignacion: Record<string, string | null>; cambios: any[]; tokens?: any; engine: string }

    if (useGoogleApi) {
      try {
        result = await sugerirConRouteOptimization(pedidos, camiones, ya_asignados, sugerencia, sucursal)
      } catch (googleError: any) {
        // Si Google falla, caer a Claude con la sugerencia que tengamos
        // Si la sugerencia llegó vacía (Layer 1 fue salteado), Claude igual puede intentar
        // con lo que tiene — los pedidos y camiones siguen disponibles
        console.error('[sugerir-asignacion] Google API error, fallback to Claude:', googleError.message)
        result = await sugerirConClaude(pedidos, camiones, ya_asignados, sugerencia, sucursal)
        result.engine = `claude-haiku-fallback (google-error: ${googleError.message.slice(0, 150)})`
      }
    } else {
      result = await sugerirConClaude(pedidos, camiones, ya_asignados, sugerencia, sucursal)
    }

    return NextResponse.json({
      asignacion: result.asignacion,
      cambios: result.cambios,
      engine: result.engine,
      ...(result.tokens ? { tokens: result.tokens } : {}),
    })
  } catch (error: any) {
    console.error('[sugerir-asignacion] error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
