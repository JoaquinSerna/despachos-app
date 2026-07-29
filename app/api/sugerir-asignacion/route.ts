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

// ¿El pedido necesita grúa hidráulica para la descarga?
// Los volcador no la necesitan (descargan solos). El hierro se puede bajar sin grúa.
// Todo lo demás (bolsas, bloques, pallets, etc.) requiere grúa.
const HIERRO_KW_GRUA = ['hierro', 'barra', 'varilla', 'malla', 'vigueta', 'alambre', 'pretensado', 'armadura', 'chapa', 'perfil', 'caño', 'tubo', 'canal', 'angulo', 'zingueria', 'upn', 'ipn']
function requiereGrua(p: PedidoInput): boolean {
  if (p.requiere_volcador) return false
  const items = p.items ?? []
  if (items.length === 0) return true // sin items → asumir que necesita grúa
  const esPuroHierro = items.every(it => HIERRO_KW_GRUA.some(kw => it.nombre.toLowerCase().includes(kw)))
  return !esPuroHierro
}

function traducirMotivo(code: string, p?: PedidoInput): string {
  const kg = p?.peso_total_kg ?? 0
  const pos = p?.volumen_total_m3 ?? 0
  switch (code) {
    case 'DEMAND_EXCEEDS_VEHICLE_CAPACITY':
      return `Supera capacidad de todos los camiones (${kg}kg / ${pos}pos)`
    case 'INFEASIBLE_AFTER_FILTERING':
      return 'Sin camión elegible (restricciones de volcador o grúa)'
    case 'NO_VEHICLE_AVAILABLE':
      return 'Sin camiones disponibles en esta vuelta'
    case 'SKIPPED_SHIPMENT':
      return 'Google decidió no asignarlo (costo de desvío demasiado alto)'
    default:
      return `Sin asignar (código: ${code}, ${kg}kg / ${pos}pos)`
  }
}

// ─── Route Optimization API (Google) ─────────────────────────────────────────

async function sugerirConRouteOptimization(
  pedidos: PedidoInput[],
  camiones: CamionInput[],
  ya_asignados: PedidoInput[],
  sugerencia: Record<string, string | null>,
  sucursal: string,
): Promise<{ asignacion: Record<string, string | null>; ordenEntrega: Record<string, number>; cambios: any[]; engine: string; pedidosSinAsignar: Record<string, string>; payloadResumen?: any }> {

  const projectId = process.env.GOOGLE_CLOUD_PROJECT!
  const bearerToken = await getGoogleBearerToken()
  const depot = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }

  // Separar pedidos con y sin coordenadas
  const conCoords = pedidos.filter(p => p.latitud != null && p.longitud != null)
  const sinCoords = pedidos.filter(p => p.latitud == null || p.longitud == null)

  // Si no hay pedidos con coordenadas, no vale la pena llamar a la API
  if (conCoords.length === 0) {
    return { asignacion: sugerencia, ordenEntrega: {}, cambios: [], engine: 'algorithm-fallback-no-coords', pedidosSinAsignar: {} }
  }

  // Camiones con límite de posiciones para carga no-granel
  const PALLET_MAX: Record<string, number> = { 'CA-68': 1 }

  // Calcular carga actual de cada camión (ya_asignados)
  const cargaActual: Record<string, { kg: number; pos: number; posGranel: number }> = {}
  camiones.forEach(c => { cargaActual[c.codigo] = { kg: 0, pos: 0, posGranel: 0 } })
  ya_asignados.forEach(p => {
    if (p.camion_id && cargaActual[p.camion_id]) {
      cargaActual[p.camion_id].kg += p.peso_total_kg ?? 0
      cargaActual[p.camion_id].pos += p.volumen_total_m3 ?? 0
      if (p.requiere_volcador) cargaActual[p.camion_id].posGranel += p.volumen_total_m3 ?? 0
    }
  })

  // Fecha de hoy para ventanas horarias
  const dateStr = new Date().toISOString().split('T')[0]
  const vuelta = conCoords[0]?.vuelta ?? 1

  // ── Detectar grupos de mismo cliente (fuzzy) dentro de 2km ───────────────
  const normCliente = (s: string) => s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(s\.?a\.?|s\.?r\.?l\.?|sas|sa|srl)\b/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()

  const parentG: Record<string, string> = {}
  conCoords.forEach(p => { parentG[p.id] = p.id })
  const findG = (id: string): string => parentG[id] === id ? id : (parentG[id] = findG(parentG[id]))
  const unionG = (a: string, b: string) => { parentG[findG(a)] = findG(b) }

  for (let i = 0; i < conCoords.length; i++) {
    for (let j = i + 1; j < conCoords.length; j++) {
      const a = conCoords[i], b = conCoords[j]
      const mismoCli = normCliente(a.cliente) === normCliente(b.cliente)
      const dist = distKm(a.latitud!, a.longitud!, b.latitud!, b.longitud!)
      // Mismo cliente a menos de 2km → mismo camión (hard)
      if (mismoCli && dist <= 2) unionG(a.id, b.id)
      // Distinto cliente pero a menos de 1km → mismo camión (soft: solo si mismo tipo de carga)
      else if (!mismoCli && dist <= 1) {
        const tipoA = getShipmentType(a), tipoB = getShipmentType(b)
        if (tipoA === tipoB && tipoA !== 'granel') unionG(a.id, b.id)
      }
    }
  }
  // Grupos con >1 pedido
  const gruposCliente = new Map<string, PedidoInput[]>()
  conCoords.forEach(p => {
    const root = findG(p.id)
    if (!gruposCliente.has(root)) gruposCliente.set(root, [])
    gruposCliente.get(root)!.push(p)
  })
  // Para cada grupo, calcular qué camiones tienen capacidad combinada suficiente
  const allowedByPedido: Record<string, number[]> = {}
  for (const [, grupoPedidos] of gruposCliente) {
    if (grupoPedidos.length <= 1) continue
    const totalKg = grupoPedidos.reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
    const totalPos = grupoPedidos.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
    const eligibles = camiones
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        const libreKg = c.tonelaje_max_kg - (cargaActual[c.codigo]?.kg ?? 0)
        const librePos = c.posiciones_total - (cargaActual[c.codigo]?.pos ?? 0)
        return libreKg >= totalKg && (c.posiciones_total === 0 || librePos >= totalPos)
      })
      .map(({ i }) => i)
    // Si hay camiones que aguantan el grupo completo → forzar (restricción dura)
    // Si ningún camión aguanta el grupo → al menos forzar que cada pedido vaya
    // a alguno de los camiones con más capacidad libre (soft: top 3 por capacidad)
    if (eligibles.length > 0) {
      grupoPedidos.forEach(p => { allowedByPedido[p.id] = eligibles })
    } else {
      const top3 = camiones
        .map((c, i) => ({ c, i, libre: c.tonelaje_max_kg - (cargaActual[c.codigo]?.kg ?? 0) }))
        .sort((a, b) => b.libre - a.libre)
        .slice(0, 3)
        .map(({ i }) => i)
      if (top3.length > 0) grupoPedidos.forEach(p => { allowedByPedido[p.id] = top3 })
    }
  }

  // ── Construir shipments ordenados: grandes primero (FFD) ────────────────────
  // Pedidos que caben sólo en UN camión (por capacidad de posiciones) → forzar ese camión
  const buildShipment = (p: PedidoInput) => {
    const tw = getTimeWindow(vuelta, dateStr)
    const delivery: any = {
      arrivalLocation: { latitude: p.latitud!, longitude: p.longitud! },
      duration: '600s',
    }
    if (tw) delivery.timeWindows = [tw]

    // Camiones elegibles por capacidad individual
    const elegiblesPorCapacidad = camiones
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => {
        const carga = cargaActual[c.codigo] ?? { kg: 0, pos: 0, posGranel: 0 }
        const libreKg = c.tonelaje_max_kg - carga.kg
        let librePos = c.posiciones_total - carga.pos
        // Regla especial: camiones con límite pallet — solo si tienen granel ya cargado
        const palletMaxC = PALLET_MAX[c.codigo]
        if (!p.requiere_volcador && palletMaxC !== undefined && carga.posGranel > 0) {
          const posNonGranel = carga.pos - carga.posGranel
          librePos = Math.max(0, palletMaxC - posNonGranel)
        }
        return libreKg >= (p.peso_total_kg ?? 0) &&
          (c.posiciones_total === 0 || librePos >= (p.volumen_total_m3 ?? 0))
      })
      .map(({ i }) => i)

    // Calcular allowedVehicleIndices combinando: volcador + mismo cliente + único elegible
    let finalAllowed: number[] | null = null

    // 1. Volcador
    if (p.requiere_volcador) {
      const vi = camiones.map((c, i) => ({ c, i })).filter(({ c }) => c.volcador).map(({ i }) => i)
      if (vi.length > 0) finalAllowed = vi
    }
    // 1b. Grúa hidráulica — excluir camiones sin grúa para pedidos que la requieren
    // (ej: SEMI sin grúa no puede descargar pallets/bolsas aunque entre por tonelaje y posiciones)
    if (requiereGrua(p)) {
      const gi = camiones.map((c, i) => ({ c, i })).filter(({ c }) => c.grua_hidraulica).map(({ i }) => i)
      // Solo aplicar si efectivamente excluye algún camión (hay camiones sin grúa en la flota)
      if (gi.length > 0 && gi.length < camiones.length) {
        if (finalAllowed !== null) {
          const inter = finalAllowed.filter(i => gi.includes(i))
          if (inter.length > 0) finalAllowed = inter
          // Si inter queda vacío: no borrar la restricción volcador/grúa previa
        } else {
          finalAllowed = gi
        }
      }
    }
    // 2. Mismo cliente
    // Si ya hay una restricción dura (ej: volcador), la intersección puede quedar vacía porque
    // el grupo combinado no cabe en el camión requerido → en ese caso NO borrar la restricción dura,
    // simplemente ignorar el agrupamiento para este pedido (Google puede separar el grupo con penalty).
    if (allowedByPedido[p.id]) {
      if (finalAllowed !== null) {
        // Hay restricción dura previa (volcador) → intersectar solo si el resultado no queda vacío
        const inter = finalAllowed.filter(i => allowedByPedido[p.id].includes(i))
        if (inter.length > 0) finalAllowed = inter
        // Si inter es vacío: el grupo mismo-cliente no puede ir junto (volcador no tiene tonelaje)
        // → mantener la restricción volcador y dejar que Google decida con penalty
      } else {
        finalAllowed = allowedByPedido[p.id]
        if (finalAllowed.length === 0) finalAllowed = null
      }
    }
    // 3. Único camión elegible por capacidad → forzarlo (pedido grande que sólo cabe en uno)
    if (!finalAllowed && elegiblesPorCapacidad.length === 1) {
      finalAllowed = elegiblesPorCapacidad
    }
    // 4. Intersectar con elegibles por capacidad si hay restricción y múltiples opciones
    if (finalAllowed && elegiblesPorCapacidad.length > 0) {
      const inter = finalAllowed.filter(i => elegiblesPorCapacidad.includes(i))
      if (inter.length > 0) finalAllowed = inter
    }

    return {
      label: p.id,
      penaltyCost: p.requiere_volcador ? 9000000 : 1000000,
      deliveries: [delivery],
      loadDemands: {
        weight_kg: { amount: String(Math.round(p.peso_total_kg ?? 0)) },
        positions_x10: { amount: String(Math.round((p.volumen_total_m3 ?? 0) * 10)) },
      },
      shipmentType: getShipmentType(p),
      ...(finalAllowed && finalAllowed.length > 0 ? { allowedVehicleIndices: finalAllowed } : {}),
    }
  }

  // Ordenar por posiciones descendentes (FFD: First Fit Decreasing)
  const shipments = [...conCoords]
    .sort((a, b) => (b.volumen_total_m3 ?? 0) - (a.volumen_total_m3 ?? 0))
    .map(buildShipment)

  // Construir vehicles (camiones con capacidad residual)
  const vehicles = camiones.map(c => {
    const carga = cargaActual[c.codigo] ?? { kg: 0, pos: 0, posGranel: 0 }
    const palletMaxC = PALLET_MAX[c.codigo]
    let librePos = c.posiciones_total - carga.pos
    if (palletMaxC !== undefined && carga.posGranel > 0) {
      // Camión con límite de pallets ya cargado con granel: solo queda palletMax - pallet_ya_cargado
      const posNonGranel = carga.pos - carga.posGranel
      librePos = Math.max(0, palletMaxC - posNonGranel)
    }
    return {
      label: c.codigo,
      startLocation: { latitude: depot.lat, longitude: depot.lng },
      endLocation: { latitude: depot.lat, longitude: depot.lng },
      loadLimits: {
        weight_kg: {
          maxLoad: String(Math.max(0, Math.round(c.tonelaje_max_kg - carga.kg))),
        },
        positions_x10: {
          maxLoad: String(Math.max(0, Math.round(librePos * 10))),
        },
      },
      costPerKilometer: 1.0,
      costPerHour: 30.0,
    }
  })

  // Incompatibilidades: hierro_largo no va con general ni granel en el mismo camión
  const shipmentTypeIncompatibilities = [
    { types: ['hierro_largo', 'general'], incompatibilityMode: 'NOT_PERFORMED_BY_SAME_VEHICLE' },
    { types: ['hierro_largo', 'granel'], incompatibilityMode: 'NOT_PERFORMED_BY_SAME_VEHICLE' },
  ]

  const requestBody = {
    model: {
      globalStartTime: `${dateStr}T08:00:00Z`,
      globalEndTime: `${dateStr}T23:59:00Z`,
      shipments,
      vehicles,
      shipmentTypeIncompatibilities,
    },
    searchMode: 'CONSUME_ALL_AVAILABLE_TIME',
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

  // Mapear respuesta → { pedido_id: camion_codigo } + orden de visitas optimizado
  const asignacion: Record<string, string | null> = { ...sugerencia }
  // ordenEntrega: por camión → { pedido_id: posición_en_ruta }
  // Representa el orden real que devuelve Google (ya optimizado)
  const ordenEntrega: Record<string, number> = {}

  // Pedidos que la API asignó a camiones
  if (result.routes) {
    for (const route of result.routes) {
      const camionCodigo = route.vehicleLabel as string
      const visits = route.visits ?? []
      // Contador de posición dentro de la ruta de este camión
      const contadorPorCamion: Record<string, number> = {}
      for (const visit of visits) {
        const pedidoId = visit.shipmentLabel as string
        if (pedidoId) {
          asignacion[pedidoId] = camionCodigo
          if (!contadorPorCamion[camionCodigo]) contadorPorCamion[camionCodigo] = 1
          ordenEntrega[pedidoId] = contadorPorCamion[camionCodigo]++
        }
      }
    }
  }

  // Pedidos que la API no pudo asignar (skippedShipments) — capturar motivo
  const pedidosSinAsignar: Record<string, string> = {}
  if (result.skippedShipments) {
    for (const skipped of result.skippedShipments) {
      const pedidoId = skipped.label as string
      if (pedidoId) {
        asignacion[pedidoId] = null
        const reason = skipped.reasons?.[0]?.code ?? 'UNKNOWN'
        const p = conCoords.find(x => x.id === pedidoId)
        pedidosSinAsignar[pedidoId] = traducirMotivo(reason, p)
      }
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

  const payloadResumen = {
    vehicles: vehicles.map(v => ({
      label: v.label,
      max_kg: Number(v.loadLimits.weight_kg.maxLoad),
      max_pos_x10: Number(v.loadLimits.positions_x10.maxLoad),
      cost_per_km: v.costPerKilometer,
      cost_per_hour: v.costPerHour,
    })),
    shipments: shipments.map(s => ({
      label: s.label,
      kg: Number(s.loadDemands.weight_kg.amount),
      pos_x10: Number(s.loadDemands.positions_x10.amount),
      tipo: s.shipmentType,
      penalty: s.penaltyCost,
      allowed_vehicles: s.allowedVehicleIndices ?? null,
    })),
    sin_coords: sinCoords.map(p => ({ id: p.id, nv: p.nv })),
  }

  return { asignacion, ordenEntrega, cambios, engine: 'google-route-optimization', payloadResumen, pedidosSinAsignar }
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

    let result: { asignacion: Record<string, string | null>; ordenEntrega?: Record<string, number>; cambios: any[]; tokens?: any; engine: string; payloadResumen?: any; pedidosSinAsignar?: Record<string, string> }

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
      ...(result.payloadResumen ? { payloadResumen: result.payloadResumen } : {}),
      ...(result.pedidosSinAsignar && Object.keys(result.pedidosSinAsignar).length > 0 ? { pedidosSinAsignar: result.pedidosSinAsignar } : {}),
    })
  } catch (error: any) {
    console.error('[sugerir-asignacion] error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
