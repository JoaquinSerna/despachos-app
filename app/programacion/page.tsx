'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useRef, Suspense } from 'react'
import { supabase } from '@/app/supabase'
import { puedeEditar } from '@/app/lib/permisos'
import { logAuditoria } from '@/app/lib/auditoria'

interface Pedido {
  id: string; nv: string; cliente: string; direccion: string; sucursal: string
  fecha_entrega: string; vuelta: number; estado: string; estado_pago: string; peso_total_kg: number | null
  volumen_total_m3: number | null; pedido_grande?: boolean; tipo?: string
  notas: string | null; camion_id: string | null; orden_entrega: number | null
  latitud: number | null; longitud: number | null; barrio_cerrado?: boolean; prioridad?: boolean
  requiere_volcador?: boolean
  localidad?: string
  items?: { nombre: string; cantidad: number; unidad: string }[]
}
interface Camion {
  codigo: string; sucursal: string; tipo_unidad: string
  posiciones_total: number; tonelaje_max_kg: number
  grua_hidraulica: boolean; volcador: boolean
}
interface ColumnaKanban { camion: Camion; pedidos: Pedido[]; pesoTotal: number; posTotal: number }

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']
const VUELTAS = [
  { num: 1,  label: 'V1',             horario: '8:00–10:00' },
  { num: 2,  label: 'V2',             horario: '10:00–12:00' },
  { num: 3,  label: 'V3',             horario: '13:00–15:00' },
  { num: 4,  label: 'V4',             horario: '15:00–17:00' },
  { num: 5,  label: 'DHora',          horario: 'Después de hora' },
  { num: -1, label: 'Fuera de prog.', horario: '' },
]
const VUELTA_FUERA = -1
const PAGO_COLOR: Record<string, string> = {
  cobrado: 'bg-green-100 text-green-800', cuenta_corriente: 'bg-blue-100 text-blue-800',
  pendiente_cobro: 'bg-yellow-100 text-yellow-800', pago_en_obra: 'bg-orange-100 text-orange-800',
}
const PAGO_LABEL: Record<string, string> = {
  cobrado: 'Cobrado', cuenta_corriente: 'Cta. Cte.', pendiente_cobro: 'Pend.', pago_en_obra: 'P.Obra',
}

function hoy() { return new Date().toISOString().split('T')[0] }

// Hora de corte para cada vuelta: si ya pasó ese horario, la vuelta no está disponible para hoy
// V4 y "después de hora" no tienen corte — siempre disponibles para emergencias
const VUELTA_CORTE: Record<number, number> = { 1: 8, 2: 10, 3: 13 }
const TODAS_VUELTAS = [
  { num: 1, label: 'Vuelta 1 (8–10h)' },
  { num: 2, label: 'Vuelta 2 (10–12h)' },
  { num: 3, label: 'Vuelta 3 (13–15h)' },
  { num: 4, label: 'Vuelta 4 (15–17h)' },
  { num: 5, label: 'Después de hora' },
]
function vueltasDisponibles(fecha: string): number[] {
  if (fecha !== hoy()) return TODAS_VUELTAS.map(v => v.num)
  const horaActual = new Date().getHours()
  return TODAS_VUELTAS.map(v => v.num).filter(v => !(v in VUELTA_CORTE) || horaActual < VUELTA_CORTE[v])
}
function pesoColumna(ps: Pedido[]) { return ps.reduce((a, p) => a + (p.peso_total_kg ?? 0), 0) }
function posColumna(ps: Pedido[]) { return ps.reduce((a, p) => a + (p.volumen_total_m3 ?? 0), 0) }
function pct(peso: number, max: number) { return max === 0 ? 0 : Math.min(100, Math.round(peso / max * 100)) }
function colorBarra(p: number) { return p >= 90 ? '#E52322' : p >= 70 ? '#f59e0b' : '#10b981' }

function localidadDeDireccion(dir: string): string {
  if (!dir) return ''
  const skip = ['buenos aires', 'b.a.', 'argentina', 'provincia', 'pba', 'prov.']
  const isSkip = (s: string) => skip.some(w => s.toLowerCase().includes(w))

  // Intento 1: dividir por comas (ej: "Calle 50 1234, La Plata, Bs As")
  const parts = dir.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length >= 2) {
    for (let i = parts.length - 1; i >= 1; i--) {
      const p = parts[i]
      if (/^\d+$/.test(p)) continue       // solo números
      if (isSkip(p)) continue              // provincia / país
      if (p.length > 1 && p.length < 50) return p
    }
  }

  // Intento 2: últimas palabras del final que no sean números ni abreviaturas de calle
  // ej: "Av Mitre 456 Guernica" → "Guernica"
  //     "Calle 13 e/ 60 y 61 La Plata" → "La Plata"
  const STOP = /^(n°|nro|nro\.|km|bis|piso|dpto|depto|pb|pp|s\/n|esq\.?|e\/|y|entre|av\.?|calle|ruta|cno|camino|diagonal|diag\.?)$/i
  const words = dir.replace(/,/g, ' ').split(/\s+/).filter(Boolean)
  const cityWords: string[] = []
  for (let i = words.length - 1; i >= 0 && cityWords.length < 3; i--) {
    const w = words[i]
    if (/^\d/.test(w)) break        // encontró un número → parar
    if (STOP.test(w)) break         // abreviatura de calle → parar
    cityWords.unshift(w)
  }
  const candidate = cityWords.join(' ')
  if (candidate.length > 2 && !isSkip(candidate)) return candidate

  return ''
}

// Agrupa pedidos por proximidad geográfica (< 15 km), mismo cliente o misma dirección.
// Se usa tanto en el algoritmo como en el UI para mostrar feedback al usuario.
function buildClusters(pedidos: Pedido[]): Pedido[][] {
  const norm = (d: string) => d.toLowerCase().replace(/[.,\-#°]/g, ' ').replace(/\s+/g, ' ').trim()
  const n = pedidos.length
  const parent = Array.from({ length: n }, (_, i) => i)
  function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])) }
  function union(i: number, j: number) { parent[find(i)] = find(j) }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = pedidos[i], b = pedidos[j]
      if (a.direccion && b.direccion && norm(a.direccion) === norm(b.direccion)) { union(i, j); continue }
      if (a.cliente && b.cliente && a.cliente.toLowerCase().trim() === b.cliente.toLowerCase().trim()) { union(i, j); continue }
      if (a.latitud && a.longitud && b.latitud && b.longitud &&
        distanciaKm(a.latitud, a.longitud, b.latitud, b.longitud) < 15) union(i, j)
    }
  }
  const groups = new Map<number, Pedido[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(pedidos[i])
  }
  return Array.from(groups.values())
}

function sugerirAsignacion(sin: Pedido[], camiones: Camion[], ya: Pedido[], sucursal: string): Record<string, string | null> {
  const deposito = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }
  const acum: Record<string, number> = {}
  const acumPos: Record<string, number> = {}
  camiones.forEach(c => {
    acum[c.codigo] = ya.filter(p => p.camion_id === c.codigo).reduce((a, p) => a + (p.peso_total_kg ?? 0), 0)
    acumPos[c.codigo] = ya.filter(p => p.camion_id === c.codigo).reduce((a, p) => a + (p.volumen_total_m3 ?? 0), 0)
  })
  const asigs: Record<string, string | null> = {}
  // Tracking por camión: true = tiene pedidos "largo" (chapa/perfil/tubo/caño), false = tiene pedidos no-largo, undefined = vacío
  // Hierro normal (barra/malla/vigueta) NO es "largo" y puede mezclarse libremente con pallets/bolsones
  const camionTieneLargo: Record<string, boolean | undefined> = {}
  // Zonas (localidades) que ya tiene cada camión: { camionCodigo: { localidad: cantPedidos } }
  const camionZonas: Record<string, Record<string, number>> = {}

  const HIERRO_KEYWORDS = ['hierro', 'barra', 'varilla', 'malla', 'vigueta', 'alambre', 'pretensado', 'armadura', 'chapa', 'perfil', 'caño', 'tubo', 'canal', 'angulo', 'ángulo', 'zingueria', 'upn', 'ipn']
  // Materiales largos que NO se pueden mezclar con pallets/bolsones (estructurales/metálicos)
  const LARGO_KEYWORDS = ['chapa', 'perfil', 'caño', 'tubo', 'canal', 'angulo', 'ángulo', 'zingueria', 'upn', 'ipn']
  // Excluir cañerías sanitarias/pluviales de PVC: físicamente son largas pero viajan con cualquier material
  const LARGO_EXCL = ['cloacal', 'pluvial', 'sanitario', 'desague', 'desagüe']

  function esLargoPedido(items: { nombre: string }[]) {
    return items.length > 0 && items.some(it => {
      const nombre = it.nombre.toLowerCase()
      if (LARGO_EXCL.some(ex => nombre.includes(ex))) return false
      return LARGO_KEYWORDS.some(kw => nombre.includes(kw))
    })
  }

  // Normalizar dirección para comparación (quita puntuación/tildes menores, lowercase)
  function normDir(dir: string): string {
    return dir.toLowerCase().replace(/[.,\-#°]/g, ' ').replace(/\s+/g, ' ').trim()
  }

  // ¿Dos pedidos van al mismo lugar? (misma dirección normalizada O coords a < 300 m)
  function sonColocados(a: Pedido, b: Pedido): boolean {
    if (a.direccion && b.direccion && normDir(a.direccion) === normDir(b.direccion)) return true
    if (a.latitud && a.longitud && b.latitud && b.longitud) {
      return distanciaKm(a.latitud, a.longitud, b.latitud, b.longitud) < 0.3
    }
    return false
  }

  // Zona de un pedido (localidad ya precalculada o extraída de la dirección)
  function zonaPedido(p: Pedido): string {
    return p.localidad || localidadDeDireccion(p.direccion) || '__sin_zona__'
  }

  // Pre-clasificar camiones que ya tienen pedidos asignados
  camiones.forEach(c => {
    const yaEnCamion = ya.filter(p => p.camion_id === c.codigo)
    camionZonas[c.codigo] = {}
    if (yaEnCamion.length === 0) { camionTieneLargo[c.codigo] = undefined; return }
    const tieneLargo = yaEnCamion.some(p => esLargoPedido(p.items ?? []))
    const tieneNoLargo = yaEnCamion.some(p => !esLargoPedido(p.items ?? []))
    // Si tiene ambos (mezcla ya existente), lo dejamos como undefined para no bloquear más
    camionTieneLargo[c.codigo] = tieneLargo && !tieneNoLargo ? true : (!tieneLargo && tieneNoLargo ? false : undefined)
    // Inicializar conteo de zonas con los pedidos ya asignados
    yaEnCamion.forEach(p => {
      const z = zonaPedido(p)
      if (z !== '__sin_zona__') camionZonas[c.codigo][z] = (camionZonas[c.codigo][z] || 0) + 1
    })
  })

  // ── Registrar asignación de un pedido a un camión ─────────────────────────
  function registrarAsignacion(p: Pedido, c: Camion) {
    asigs[p.id] = c.codigo
    acum[c.codigo] += p.peso_total_kg ?? 0
    acumPos[c.codigo] += p.volumen_total_m3 ?? 0
    const loc = zonaPedido(p)
    if (loc !== '__sin_zona__') camionZonas[c.codigo][loc] = (camionZonas[c.codigo][loc] || 0) + 1
    const pedidoEsLargo = esLargoPedido(p.items ?? [])
    const tipoAnterior = camionTieneLargo[c.codigo]
    if (tipoAnterior === undefined) {
      camionTieneLargo[c.codigo] = pedidoEsLargo
    } else if (tipoAnterior !== pedidoEsLargo) {
      camionTieneLargo[c.codigo] = undefined
    }
  }

  // ── Buscar el mejor camión para un pedido individual ──────────────────────
  function mejorCamionParaPedido(p: Pedido): Camion | null {
    const peso = p.peso_total_kg ?? 0
    const pos = p.volumen_total_m3 ?? 0
    const esVolcador = p.requiere_volcador === true
    const items = p.items ?? []
    const soloHierro = items.length > 0 && items.every(it => HIERRO_KEYWORDS.some(kw => it.nombre.toLowerCase().includes(kw)))
    const requiereGrua = !esVolcador && !soloHierro
    const pedidoEsLargo = esLargoPedido(items)
    const locPedido = zonaPedido(p)

    const elegibles = camiones.filter(c => {
      if (acum[c.codigo] + peso > c.tonelaje_max_kg) return false
      if (c.posiciones_total > 0 && pos > 0 && acumPos[c.codigo] + pos > c.posiciones_total) return false
      if (esVolcador && !c.volcador) return false
      if (requiereGrua && !c.grua_hidraulica) return false
      const tipo = camionTieneLargo[c.codigo]
      if (tipo !== undefined) {
        if (pedidoEsLargo && tipo === false) return false
        if (!pedidoEsLargo && tipo === true) return false
      }
      return true
    })
    if (elegibles.length === 0) return null

    let mejor: Camion | null = null
    let mejorScore = Infinity

    for (const c of elegibles) {
      const todosEnCamion = [
        ...ya.filter(pp => pp.camion_id === c.codigo),
        ...Object.entries(asigs).filter(([, cod]) => cod === c.codigo).map(([id]) => sin.find(pp => pp.id === id)).filter(Boolean) as Pedido[],
      ]
      if (todosEnCamion.some(pp => sonColocados(pp, p))) return c
      if (todosEnCamion.some(pp => pp.cliente === p.cliente)) return c

      const yaConCoords = todosEnCamion.filter(pp => pp.latitud && pp.longitud)
      let score: number
      if (p.latitud && p.longitud && yaConCoords.length > 0) {
        const avgLat = yaConCoords.reduce((s, pp) => s + pp.latitud!, 0) / yaConCoords.length
        const avgLng = yaConCoords.reduce((s, pp) => s + pp.longitud!, 0) / yaConCoords.length
        score = distanciaKm(p.latitud, p.longitud, avgLat, avgLng)
      } else if (p.latitud && p.longitud) {
        score = distanciaKm(deposito.lat, deposito.lng, p.latitud, p.longitud) + 500
      } else {
        score = c.tonelaje_max_kg - acum[c.codigo]
      }
      const tieneZonaTexto = locPedido !== '__sin_zona__' && (camionZonas[c.codigo]?.[locPedido] ?? 0) > 0
      const tieneZonaCoords = p.latitud != null && p.longitud != null && todosEnCamion.some(pp =>
        pp.latitud != null && pp.longitud != null &&
        distanciaKm(p.latitud!, p.longitud!, pp.latitud!, pp.longitud!) < 8
      )
      if (tieneZonaTexto || tieneZonaCoords) score *= 0.25
      if (score < mejorScore) { mejorScore = score; mejor = c }
    }
    return mejor
  }

  // ── Asignación cluster por cluster ────────────────────────────────────────
  const clusters = buildClusters(sin)

  // Ordenar clusters: prioridad > volumen total desc (FFD) > distancia al depósito desc
  clusters.sort((ca, cb) => {
    const prioA = ca.some(p => p.prioridad) ? 1 : 0
    const prioB = cb.some(p => p.prioridad) ? 1 : 0
    if (prioA !== prioB) return prioB - prioA
    const posA = ca.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
    const posB = cb.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
    if (Math.abs(posA - posB) > 2) return posB - posA
    const conCoordsA = ca.filter(p => p.latitud && p.longitud)
    const conCoordsB = cb.filter(p => p.latitud && p.longitud)
    const distA = conCoordsA.length > 0 ? conCoordsA.reduce((s, p) => s + distanciaKm(deposito.lat, deposito.lng, p.latitud!, p.longitud!), 0) / conCoordsA.length : 0
    const distB = conCoordsB.length > 0 ? conCoordsB.reduce((s, p) => s + distanciaKm(deposito.lat, deposito.lng, p.latitud!, p.longitud!), 0) / conCoordsB.length : 0
    return distB - distA
  })

  for (const cluster of clusters) {
    cluster.sort((a, b) => {
      if (a.prioridad && !b.prioridad) return -1
      if (!a.prioridad && b.prioridad) return 1
      return (b.volumen_total_m3 ?? 0) - (a.volumen_total_m3 ?? 0)
    })

    if (cluster.length === 1) {
      const c = mejorCamionParaPedido(cluster[0])
      if (c) registrarAsignacion(cluster[0], c)
      else asigs[cluster[0].id] = null
      continue
    }

    // Cluster multi-pedido: buscar camión que aguante TODOS juntos
    const pesoTotal = cluster.reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
    const posTotal = cluster.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
    const necesitaVolcador = cluster.some(p => p.requiere_volcador === true)
    const clusterEsLargo = cluster.some(p => esLargoPedido(p.items ?? []))
    const clusterEsNoLargo = cluster.some(p => !esLargoPedido(p.items ?? []))
    const necesitaGrua = cluster.some(p => {
      const items = p.items ?? []
      const soloHierro = items.length > 0 && items.every(it => HIERRO_KEYWORDS.some(kw => it.nombre.toLowerCase().includes(kw)))
      return !p.requiere_volcador && !soloHierro
    })

    let mejor: Camion | null = null
    let mejorScore = Infinity

    for (const c of camiones) {
      if (acum[c.codigo] + pesoTotal > c.tonelaje_max_kg) continue
      if (c.posiciones_total > 0 && posTotal > 0 && acumPos[c.codigo] + posTotal > c.posiciones_total) continue
      if (necesitaVolcador && !c.volcador) continue
      if (necesitaGrua && !c.grua_hidraulica) continue
      const tipo = camionTieneLargo[c.codigo]
      if (tipo === true && clusterEsNoLargo && !clusterEsLargo) continue
      if (tipo === false && clusterEsLargo && !clusterEsNoLargo) continue

      const todosEnCamion = [
        ...ya.filter(pp => pp.camion_id === c.codigo),
        ...Object.entries(asigs).filter(([, cod]) => cod === c.codigo).map(([id]) => sin.find(pp => pp.id === id)).filter(Boolean) as Pedido[],
      ]

      // P1: algún pedido del cluster coincide con dirección/cliente ya en el camión
      if (cluster.some(p => todosEnCamion.some(pp => sonColocados(pp, p) || pp.cliente === p.cliente))) {
        mejor = c; break
      }

      // Scoring: centroide del cluster vs centroide del camión
      const ccCoords = cluster.filter(p => p.latitud && p.longitud)
      const tcCoords = todosEnCamion.filter(pp => pp.latitud && pp.longitud)
      let score: number
      if (ccCoords.length > 0 && tcCoords.length > 0) {
        const avgCLat = ccCoords.reduce((s, p) => s + p.latitud!, 0) / ccCoords.length
        const avgCLng = ccCoords.reduce((s, p) => s + p.longitud!, 0) / ccCoords.length
        const avgTLat = tcCoords.reduce((s, pp) => s + pp.latitud!, 0) / tcCoords.length
        const avgTLng = tcCoords.reduce((s, pp) => s + pp.longitud!, 0) / tcCoords.length
        score = distanciaKm(avgCLat, avgCLng, avgTLat, avgTLng)
      } else if (ccCoords.length > 0) {
        const avgCLat = ccCoords.reduce((s, p) => s + p.latitud!, 0) / ccCoords.length
        const avgCLng = ccCoords.reduce((s, p) => s + p.longitud!, 0) / ccCoords.length
        score = distanciaKm(deposito.lat, deposito.lng, avgCLat, avgCLng) + 500
      } else {
        score = c.tonelaje_max_kg - acum[c.codigo]
      }

      // Bonus zona: si algún pedido del cluster tiene afinidad de zona con el camión
      const tieneZona = cluster.some(p => {
        const loc = zonaPedido(p)
        const tieneTexto = loc !== '__sin_zona__' && (camionZonas[c.codigo]?.[loc] ?? 0) > 0
        const tieneCoords = p.latitud != null && p.longitud != null && todosEnCamion.some(pp =>
          pp.latitud != null && pp.longitud != null &&
          distanciaKm(p.latitud!, p.longitud!, pp.latitud!, pp.longitud!) < 8
        )
        return tieneTexto || tieneCoords
      })
      if (tieneZona) score *= 0.25

      if (score < mejorScore) { mejorScore = score; mejor = c }
    }

    if (mejor) {
      for (const p of cluster) registrarAsignacion(p, mejor)
    } else {
      // Fallback: no hay camión que aguante el cluster completo → asignar individualmente
      for (const p of cluster) {
        const c = mejorCamionParaPedido(p)
        if (c) registrarAsignacion(p, c)
        else asigs[p.id] = null
      }
    }
  }
  return asigs
}

const BIG_MODES = ['stock', 'separar', 'reprog']

function PedidoCard({ pedido, onDragStart, onCancelar, onCambiarVuelta, onReprogramar, onEditarPeso, onToggleVolcador, onSepararPedido, onMoverSucursal, onIncidenciaStock, onNeedsExpand, soloVer = false }: {
  pedido: Pedido
  onDragStart: (e: React.DragEvent, p: Pedido) => void
  onCancelar: (id: string) => void
  onCambiarVuelta: (id: string, vuelta: number) => void
  onReprogramar: (id: string, fecha: string, vuelta: number, motivo: string) => void
  onEditarPeso: (id: string, peso: number, posiciones: number) => void
  onToggleVolcador: (id: string, valor: boolean) => void
  onSepararPedido: (id: string, itemsNuevo: any[], itemsMantener: any[]) => void
  onMoverSucursal: (id: string, sucursal: string) => void
  onIncidenciaStock: (id: string, itemsSinStock: any[], itemsConStock: any[]) => void
  onNeedsExpand?: (id: string, needs: boolean) => void
  soloVer?: boolean
}) {
  const [expandido, setExpandido] = useState(false)
  const [modo, _setModo] = useState<'normal' | 'vuelta' | 'reprog' | 'cancelar' | 'editar_peso' | 'separar' | 'mover_sucursal' | 'stock'>('normal')
  const setModo = (m: typeof modo) => {
    _setModo(m)
    onNeedsExpand?.(pedido.id, BIG_MODES.includes(m))
  }
  useEffect(() => {
    return () => { onNeedsExpand?.(pedido.id, false) }
  }, [])
  const [editPeso, setEditPeso] = useState(0)
  const [editPos, setEditPos] = useState(0)
  const [cantNuevo, setCantNuevo] = useState<Record<number, number>>({})
  const [stockDisp, setStockDisp] = useState<Record<number, number>>({})
  const [reprogFecha, setReprogFecha] = useState('')
  const [reprogVuelta, setReprogVuelta] = useState(1)
  const [reprogMotivo, setReprogMotivo] = useState('')
  const mananaStr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0] })()
  const esReprogramado = pedido.notas?.startsWith('⚡')
  const esRetiro = pedido.tipo === 'retiro'
  const borderColor = esRetiro ? '#0d9488' : pedido.pedido_grande ? '#f59e0b' : esReprogramado ? '#fbbf24' : '#f0f0f0'
  const bgColor = esRetiro ? '#f0fdfa' : pedido.pedido_grande ? '#fffbeb' : 'white'
  return (
    <div draggable={!soloVer} onDragStart={e => { if (!soloVer) onDragStart(e, pedido) }}
      className="rounded-lg p-3 mb-2 select-none hover:shadow-md transition-shadow"
      style={{ border: `1px solid ${borderColor}`, background: bgColor, cursor: soloVer ? 'default' : 'grab' }}>
      {esRetiro && (
        <div className="text-xs font-semibold mb-1.5 px-2 py-1 rounded-lg flex items-center gap-1.5"
          style={{ background: '#ccfbf1', color: '#0f766e' }}>
          🔄 Retiro — no cuenta para cupos
        </div>
      )}
      {pedido.pedido_grande && !esRetiro && (
        <div className="text-xs font-semibold mb-1.5 px-2 py-1 rounded-lg"
          style={{ background: '#fde68a', color: '#92400e' }}>
          ⚠️ Pedido grande — requiere separación
        </div>
      )}
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-semibold text-xs leading-tight" style={{ color: '#254A96' }}>{pedido.cliente}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${PAGO_COLOR[pedido.estado_pago] ?? 'bg-gray-100 text-gray-600'}`}>
            {PAGO_LABEL[pedido.estado_pago] ?? pedido.estado_pago}
          </span>
          {!soloVer && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('cancelar') }}
              title="Cancelar pedido"
              className="w-4 h-4 flex items-center justify-center rounded hover:bg-red-50 transition-colors"
              style={{ color: '#E52322', fontSize: '10px', lineHeight: 1 }}>
              ✕
            </button>
          )}
        </div>
      </div>
      <p className="text-xs leading-tight" style={{ color: '#B9BBB7' }}>{pedido.direccion}</p>
      {pedido.localidad && (
        <span className="inline-block text-xs font-semibold rounded px-1.5 py-0.5 mt-0.5 mb-1"
          style={{ background: '#dbeafe', color: '#1e40af', fontSize: 10 }}>
          📍 {pedido.localidad}
        </span>
      )}
      <div className="flex justify-between items-center">
        <span className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</span>
        <div className="flex items-center gap-1.5">
          {pedido.volumen_total_m3 != null && pedido.volumen_total_m3 > 0 && (
            <span className="text-xs" style={{ color: '#B9BBB7' }}>{pedido.volumen_total_m3} pos.</span>
          )}
          {pedido.peso_total_kg != null && (
            soloVer
              ? <span className="text-xs font-semibold" style={{ color: '#254A96' }}>{pedido.peso_total_kg} kg</span>
              : <button onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); setEditPeso(pedido.peso_total_kg ?? 0); setEditPos(pedido.volumen_total_m3 ?? 0); setModo('editar_peso') }}
                  className="text-xs font-semibold hover:underline"
                  style={{ color: '#254A96' }} title="Editar peso y posiciones">
                  {pedido.peso_total_kg} kg ✎
                </button>
          )}
          {pedido.peso_total_kg == null && (
            soloVer
              ? <span className="text-xs" style={{ color: '#B9BBB7' }}>sin peso</span>
              : <button onMouseDown={e => e.stopPropagation()}
                  onClick={e => { e.stopPropagation(); setEditPeso(0); setEditPos(0); setModo('editar_peso') }}
                  className="text-xs hover:underline" style={{ color: '#f59e0b' }} title="Ingresar peso y posiciones">
                  ⚠ sin peso ✎
                </button>
          )}
        </div>
      </div>
      {modo === 'cancelar' ? (
        <div className="mt-2 p-2.5 rounded-lg" style={{ background: '#fde8e8' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#E52322' }}>¿Cancelar este pedido?</p>
          <div className="flex gap-1.5">
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onCancelar(pedido.id) }}
              className="flex-1 text-xs py-1.5 rounded font-medium text-white"
              style={{ background: '#E52322' }}>Sí, cancelar</button>
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('normal') }}
              className="text-xs px-3 py-1.5 rounded"
              style={{ background: '#f4f4f3', color: '#666' }}>No</button>
          </div>
        </div>
      ) : modo === 'reprog' ? (
        <div className="mt-2 p-2.5 rounded-lg" style={{ background: '#f4f4f3' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#254A96' }}>📅 Reprogramar entrega</p>
          <div className="space-y-1.5">
            <input type="date" value={reprogFecha} min={hoy()}
              onChange={e => setReprogFecha(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8' }} />
            <select value={reprogVuelta} onChange={e => setReprogVuelta(parseInt(e.target.value))}
              onMouseDown={e => e.stopPropagation()}
              className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8' }}>
              {TODAS_VUELTAS.map(({ num, label }) => {
                const disponible = vueltasDisponibles(reprogFecha).includes(num)
                return (
                  <option key={num} value={num} disabled={!disponible}>
                    {label}{!disponible ? ' (pasada)' : ''}
                  </option>
                )
              })}
            </select>
            <input type="text" value={reprogMotivo}
              onChange={e => setReprogMotivo(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              placeholder="Motivo (ej: lluvia, cliente no disponible)"
              className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8' }} />
          </div>
          <div className="flex gap-1.5 mt-2">
            <button disabled={!reprogFecha}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onReprogramar(pedido.id, reprogFecha, reprogVuelta, reprogMotivo); setModo('normal') }}
              className="flex-1 text-xs py-1.5 rounded font-medium text-white disabled:opacity-40"
              style={{ background: '#254A96' }}>Confirmar</button>
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('normal') }}
              className="text-xs px-2 py-1.5 rounded"
              style={{ background: '#e8edf8', color: '#666' }}>×</button>
          </div>
        </div>
      ) : modo === 'vuelta' ? (
        <div className="mt-2 flex items-center gap-1.5">
          <select
            onMouseDown={e => e.stopPropagation()}
            onChange={e => { onCambiarVuelta(pedido.id, parseInt(e.target.value)); setModo('normal') }}
            defaultValue=""
            className="text-xs border rounded px-2 py-1 flex-1 focus:outline-none"
            style={{ borderColor: '#e8edf8' }}>
            <option value="" disabled>Mover a vuelta...</option>
            {[1, 2, 3, 4].filter(v => v !== pedido.vuelta).map(v => (
              <option key={v} value={v}>Vuelta {v}</option>
            ))}
          </select>
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setModo('normal') }}
            className="text-xs" style={{ color: '#B9BBB7' }}>×</button>
        </div>
      ) : modo === 'mover_sucursal' ? (
        <div className="mt-2 flex items-center gap-1.5">
          <select
            onMouseDown={e => e.stopPropagation()}
            onChange={e => { onMoverSucursal(pedido.id, e.target.value); setModo('normal') }}
            defaultValue=""
            className="text-xs border rounded px-2 py-1 flex-1 focus:outline-none"
            style={{ borderColor: '#e8edf8' }}>
            <option value="" disabled>Mover a sucursal...</option>
            {SUCURSALES.filter(s => s !== pedido.sucursal).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setModo('normal') }}
            className="text-xs" style={{ color: '#B9BBB7' }}>×</button>
        </div>
      ) : modo === 'stock' ? (
        <div className="mt-2 p-2.5 rounded-lg" style={{ background: '#fff8e1', border: '1px solid #fcd34d' }}>
          <p className="text-xs font-medium mb-1" style={{ color: '#b45309' }}>⚠ Incidencia de stock</p>
          <p className="text-xs mb-2" style={{ color: '#b45309' }}>Indicá cuánto hay disponible. Los ítems sin stock quedan como pendiente para reprogramar.</p>
          <div className="space-y-1.5 mb-2">
            {(pedido.items ?? []).map((item, i) => {
              const disp = stockDisp[i] ?? item.cantidad
              const sinStock = disp === 0
              const parcial = disp > 0 && disp < item.cantidad
              return (
                <div key={i} onMouseDown={e => e.stopPropagation()}
                  className="rounded px-2 py-1.5"
                  style={{ background: sinStock ? '#fde8e8' : parcial ? '#fef3c7' : '#f0fdf4', border: `1px solid ${sinStock ? '#fca5a5' : parcial ? '#fcd34d' : '#bbf7d0'}` }}>
                  <p className="text-xs mb-1 leading-tight font-medium" style={{ color: '#1a1a1a' }}>{item.nombre}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: '#666' }}>Stock disponible:</span>
                    <input type="number" min={0} max={item.cantidad} step={1}
                      value={disp}
                      onMouseDown={e => e.stopPropagation()}
                      onChange={e => {
                        const n = Math.min(Math.max(0, parseInt(e.target.value) || 0), item.cantidad)
                        setStockDisp(prev => ({ ...prev, [i]: n }))
                      }}
                      className="w-16 text-xs border rounded px-1.5 py-1 focus:outline-none text-center font-bold"
                      style={{ borderColor: sinStock ? '#fca5a5' : '#e8edf8' }} />
                    <span className="text-xs" style={{ color: '#666' }}>/ {item.cantidad} {item.unidad}</span>
                    <span className="text-xs ml-auto font-medium"
                      style={{ color: sinStock ? '#E52322' : parcial ? '#b45309' : '#065f46' }}>
                      {sinStock ? 'Sin stock' : parcial ? `Falta ${item.cantidad - disp}` : 'OK'}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex gap-1.5">
            <button onMouseDown={e => e.stopPropagation()}
              disabled={(pedido.items ?? []).every((item, i) => (stockDisp[i] ?? item.cantidad) === item.cantidad)}
              onClick={e => {
                e.stopPropagation()
                const items = pedido.items ?? []
                const conStock = items
                  .map((item, i) => ({ ...item, cantidad: stockDisp[i] ?? item.cantidad }))
                  .filter(item => item.cantidad > 0)
                const sinStock = items
                  .map((item, i) => ({ ...item, cantidad: item.cantidad - (stockDisp[i] ?? item.cantidad) }))
                  .filter(item => item.cantidad > 0)
                onIncidenciaStock(pedido.id, sinStock, conStock)
                setModo('normal'); setStockDisp({})
              }}
              className="flex-1 text-xs py-1.5 rounded font-medium text-white disabled:opacity-40"
              style={{ background: '#b45309' }}>
              Confirmar incidencia
            </button>
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('normal'); setStockDisp({}) }}
              className="text-xs px-2 py-1.5 rounded" style={{ background: '#e8edf8', color: '#666' }}>×</button>
          </div>
        </div>
      ) : modo === 'editar_peso' ? (
        <div className="mt-2 p-2.5 rounded-lg" style={{ background: '#f4f4f3' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#254A96' }}>✎ Editar peso y posiciones</p>
          <div className="grid grid-cols-2 gap-1.5">
            <div>
              <label className="text-xs mb-0.5 block" style={{ color: '#666' }}>Peso (kg)</label>
              <input type="number" min="0" value={editPeso}
                onChange={e => setEditPeso(parseFloat(e.target.value) || 0)}
                onMouseDown={e => e.stopPropagation()}
                className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="text-xs mb-0.5 block" style={{ color: '#666' }}>Posiciones</label>
              <input type="number" min="0" step="0.5" value={editPos}
                onChange={e => setEditPos(parseFloat(e.target.value) || 0)}
                onMouseDown={e => e.stopPropagation()}
                className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
          </div>
          <div className="flex gap-1.5 mt-2">
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onEditarPeso(pedido.id, editPeso, editPos); setModo('normal') }}
              className="flex-1 text-xs py-1.5 rounded font-medium text-white"
              style={{ background: '#254A96' }}>Guardar</button>
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('normal') }}
              className="text-xs px-2 py-1.5 rounded"
              style={{ background: '#e8edf8', color: '#666' }}>×</button>
          </div>
        </div>
      ) : modo === 'separar' ? (
        <div className="mt-2 p-2.5 rounded-lg" style={{ background: '#f4f4f3' }}>
          <p className="text-xs font-medium mb-1" style={{ color: '#254A96' }}>✂ Nuevo pedido — indicá cuánto va</p>
          <p className="text-xs mb-2" style={{ color: '#B9BBB7' }}>Dejá en 0 lo que queda en el pedido original</p>
          <div className="space-y-1.5 mb-2">
            {(pedido.items ?? []).map((item, i) => {
              const val = cantNuevo[i] ?? 0
              const activo = val > 0
              return (
                <div key={i} onMouseDown={e => e.stopPropagation()}
                  className="rounded px-2 py-1.5"
                  style={{ background: activo ? '#e8edf8' : '#fff', border: '1px solid #e8edf8' }}>
                  <p className="text-xs mb-1 leading-tight" style={{ color: '#1a1a1a' }}>{item.nombre}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>Nuevo:</span>
                    <input type="number" min={0} max={item.cantidad} step={1}
                      value={val === 0 ? '' : val}
                      placeholder="0"
                      onMouseDown={e => e.stopPropagation()}
                      onChange={e => {
                        const n = Math.min(Math.max(0, parseInt(e.target.value) || 0), item.cantidad)
                        setCantNuevo(prev => ({ ...prev, [i]: n }))
                      }}
                      className="w-16 text-xs border rounded px-1.5 py-1 focus:outline-none text-center font-medium"
                      style={{ borderColor: '#e8edf8' }} />
                    <span className="text-xs font-medium" style={{ color: '#254A96' }}>{item.unidad}</span>
                    <span className="text-xs ml-auto" style={{ color: '#B9BBB7' }}>
                      orig: {item.cantidad - val} {item.unidad}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex gap-1.5">
            <button onMouseDown={e => e.stopPropagation()}
              disabled={!Object.values(cantNuevo).some(v => v > 0) ||
                (pedido.items ?? []).every((item, i) => (cantNuevo[i] ?? 0) >= item.cantidad)}
              onClick={e => {
                e.stopPropagation()
                const items = pedido.items ?? []
                const itemsNuevo = items
                  .map((item, i) => ({ ...item, cantidad: cantNuevo[i] ?? 0 }))
                  .filter(item => item.cantidad > 0)
                const itemsMantener = items
                  .map((item, i) => ({ ...item, cantidad: item.cantidad - (cantNuevo[i] ?? 0) }))
                  .filter(item => item.cantidad > 0)
                onSepararPedido(pedido.id, itemsNuevo, itemsMantener)
                setModo('normal')
              }}
              className="flex-1 text-xs py-1.5 rounded font-medium text-white disabled:opacity-40"
              style={{ background: '#254A96' }}>Crear pedido separado</button>
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('normal'); setCantNuevo({}) }}
              className="text-xs px-2 py-1.5 rounded" style={{ background: '#e8edf8', color: '#666' }}>×</button>
          </div>
        </div>
      ) : soloVer ? null : (
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setModo('vuelta') }}
            className="text-xs hover:underline" style={{ color: '#B9BBB7' }}>
            V{pedido.vuelta} · cambiar
          </button>
          <span style={{ color: '#e0e0e0' }}>|</span>
          <button onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setStockDisp({}); setModo('stock') }}
            className="text-xs hover:underline font-medium" style={{ color: '#b45309' }}>
            ⚠ stock
          </button>
          <span style={{ color: '#e0e0e0' }}>|</span>
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setModo('mover_sucursal') }}
            className="text-xs hover:underline" style={{ color: '#B9BBB7' }}>
            🏭 {pedido.sucursal}
          </button>
          <span style={{ color: '#e0e0e0' }}>|</span>
          <button onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setModo('reprog'); setReprogFecha(''); setReprogVuelta(1); setReprogMotivo('') }}
            className="text-xs hover:underline" style={{ color: '#f59e0b' }}>
            📅 reprogramar
          </button>
          {(pedido.items?.length ?? 0) > 0 && (
            <>
              <span style={{ color: '#e0e0e0' }}>|</span>
              <button onMouseDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation()
                  setCantNuevo({})
                  setModo('separar')
                }}
                className="text-xs hover:underline" style={{ color: '#254A96' }}>
                ✂ separar
              </button>
            </>
          )}
        </div>
      )}
      {pedido.items && pedido.items.length > 0 && modo !== 'separar' && (
        <div className="mt-1.5">
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpandido(!expandido) }}
            className="text-xs font-medium" style={{ color: '#254A96' }}>
            {expandido ? '▲ Ocultar' : `▼ ${pedido.items.length} producto${pedido.items.length > 1 ? 's' : ''}`}
          </button>
          {expandido && (
            <div className="mt-1.5 space-y-1">
              {pedido.items.map((item, i) => (
                <div key={i} className="flex justify-between text-xs rounded px-2 py-1" style={{ background: '#f4f4f3', color: '#666' }}>
                  <span>{item.nombre}</span>
                  <span className="shrink-0 ml-2 font-medium">{item.cantidad} {item.unidad}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-1 flex-wrap mt-1.5">
        {pedido.prioridad && <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: '#fef3c7', color: '#b45309' }}>⭐ Prioridad</span>}
        {pedido.barrio_cerrado && <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: '#e8edf8', color: '#254A96' }}>🔒 Barrio cerrado</span>}
        {soloVer
          ? pedido.requiere_volcador && <span className="text-xs px-1.5 py-0.5 rounded font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>🚛 Volcador</span>
          : <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onToggleVolcador(pedido.id, !pedido.requiere_volcador) }}
              className="text-xs px-1.5 py-0.5 rounded font-medium transition-colors"
              style={pedido.requiere_volcador
                ? { background: '#fde8e8', color: '#E52322' }
                : { background: '#f4f4f3', color: '#B9BBB7' }}
              title={pedido.requiere_volcador ? 'Requiere volcador (click para quitar)' : 'Marcar como requiere volcador'}>
              🚛 {pedido.requiere_volcador ? 'Volcador' : 'volcador?'}
            </button>
        }
      </div>
      {pedido.notas && <p className="text-xs rounded px-2 py-1 mt-1.5 leading-tight" style={{ background: esReprogramado ? '#fef3c7' : '#fff8e1', color: '#b45309' }}>{pedido.notas}</p>}
    </div>
  )
}

function ColumnaCamion({ columna, sinAsignar = false, onDrop, onDragOver, onDragLeave, onDragStart, isDragOver, onCancelar, onCambiarVuelta, onReprogramar, onReprogramarCamion, onEditarPeso, onToggleVolcador, onSepararPedido, onMoverSucursal, onIncidenciaStock, deposito, soloVer = false, bloqueado = false, onToggleLock }: {
  columna: ColumnaKanban; sinAsignar?: boolean
  onDrop: (e: React.DragEvent, cod: string | null) => void
  onDragOver: (e: React.DragEvent, cod: string | null) => void
  onDragLeave: () => void; onDragStart: (e: React.DragEvent, p: Pedido) => void; isDragOver: boolean
  onCancelar: (id: string) => void
  onCambiarVuelta: (id: string, vuelta: number) => void
  onReprogramar: (id: string, fecha: string, vuelta: number, motivo: string) => void
  onReprogramarCamion?: (codigo: string) => void
  onEditarPeso: (id: string, peso: number, posiciones: number) => void
  onToggleVolcador: (id: string, valor: boolean) => void
  onSepararPedido: (id: string, itemsNuevo: any[], itemsMantener: any[]) => void
  onMoverSucursal: (id: string, sucursal: string) => void
  onIncidenciaStock: (id: string, itemsSinStock: any[], itemsConStock: any[]) => void
  deposito?: { lat: number; lng: number }
  soloVer?: boolean
  bloqueado?: boolean
  onToggleLock?: () => void
}) {
  const { camion, pedidos, pesoTotal, posTotal } = columna
  const [manualExpanded, setManualExpanded] = useState(false)
  const [needingIds, setNeedingIds] = useState<Set<string>>(new Set())
  const isExpanded = manualExpanded || needingIds.size > 0
  const handleNeedsExpand = (pedidoId: string, needs: boolean) => {
    setNeedingIds(prev => { const s = new Set(prev); needs ? s.add(pedidoId) : s.delete(pedidoId); return s })
  }
  const p = sinAsignar ? 0 : pct(pesoTotal, camion.tonelaje_max_kg)
  const pPos = (!sinAsignar && camion.posiciones_total > 0) ? pct(posTotal, camion.posiciones_total) : 0
  const maxDistKm = !sinAsignar && deposito
    ? Math.max(0, ...pedidos.filter(p => p.latitud && p.longitud).map(p => distanciaKm(deposito.lat, deposito.lng, p.latitud!, p.longitud!)))
    : 0
  const maxVueltas = maxDistKm > 0 ? maxVueltasPorDistancia(maxDistKm) : null
  const w = isExpanded ? 360 : 220
  return (
    <div onDrop={e => onDrop(e, sinAsignar ? null : camion.codigo)}
      onDragOver={e => onDragOver(e, sinAsignar ? null : camion.codigo)}
      onDragLeave={onDragLeave}
      className="flex flex-col h-full shrink-0 rounded-xl transition-all"
      style={{
        width: w, minWidth: w,
        border: `2px ${sinAsignar ? 'dashed' : 'solid'} ${isDragOver ? '#254A96' : bloqueado ? '#f59e0b' : '#f0f0f0'}`,
        background: isDragOver ? '#e8edf8' : bloqueado ? '#fffbeb' : '#f9f9f9',
        boxShadow: isDragOver ? '0 0 0 3px rgba(37,74,150,0.12)' : bloqueado ? '0 0 0 2px rgba(245,158,11,0.15)' : 'none',
      }}>
      <div className="p-3 rounded-t-xl shrink-0" style={{ background: sinAsignar ? 'transparent' : 'white', borderBottom: sinAsignar ? 'none' : '1px solid #f0f0f0' }}>
        {sinAsignar ? (
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm font-semibold" style={{ color: '#B9BBB7' }}>Sin asignar</p>
              <p className="text-xs" style={{ color: '#B9BBB7' }}>{pedidos.length} pedidos</p>
            </div>
            <button onClick={() => setManualExpanded(e => !e)} className="text-xs px-1.5 py-0.5 rounded" style={{ color: '#B9BBB7', background: '#f0f0f0' }} title={isExpanded ? 'Contraer' : 'Expandir'}>
                {isExpanded ? '◀' : '▶'}
              </button>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center mb-1">
              <span className="font-bold text-sm" style={{ color: '#254A96' }}>{camion.codigo}</span>
              <div className="flex gap-1 items-center">
                {(camion as any)._en_ruta && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: '#fff3e0', color: '#e65100' }}
                    title={`Posiblemente en ruta — salió en V${(camion as any)._en_ruta_desde_vuelta} con entrega a ~${(camion as any)._en_ruta_dist_km}km`}>
                    🚛 V{(camion as any)._en_ruta_desde_vuelta} en ruta
                  </span>
                )}
                {(camion as any)._desde_sucursal && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: '#f5f3ff', color: '#7c3aed' }}
                    title={`Viene de ${(camion as any)._desde_sucursal}, disponible desde V${(camion as any)._disponible_desde_vuelta ?? 2}`}>
                    🔀 {(camion as any)._desde_sucursal} V{(camion as any)._disponible_desde_vuelta ?? 2}+
                  </span>
                )}
                {camion.grua_hidraulica && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#e8edf8', color: '#254A96' }}>Grúa</span>}
                {camion.volcador && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#fef3c7', color: '#d97706' }}>Volc.</span>}
                {onToggleLock && (
                  <button onClick={onToggleLock} className="text-xs px-1.5 py-0.5 rounded" title={bloqueado ? 'Desbloqueado para sugerencia' : 'Bloquear: excluir de la sugerencia'}
                    style={{ background: bloqueado ? '#fef3c7' : '#f0f0f0', color: bloqueado ? '#d97706' : '#B9BBB7' }}>
                    {bloqueado ? '🔒' : '🔓'}
                  </button>
                )}
                <button onClick={() => setManualExpanded(e => !e)} className="text-xs px-1.5 py-0.5 rounded ml-1" style={{ color: '#B9BBB7', background: '#f0f0f0' }} title={isExpanded ? 'Contraer' : 'Expandir'}>
                  {isExpanded ? '◀' : '▶'}
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs" style={{ color: '#B9BBB7' }}>{camion.tipo_unidad}</p>
              {maxVueltas !== null && (
                <span className="text-xs px-1.5 py-0.5 rounded font-medium"
                  style={{ background: maxVueltas <= 2 ? '#fde8e8' : maxVueltas === 3 ? '#fef3c7' : '#d1fae5', color: maxVueltas <= 2 ? '#E52322' : maxVueltas === 3 ? '#b45309' : '#065f46' }}>
                  máx {maxVueltas}v · {Math.round(maxDistKm)}km
                </span>
              )}
            </div>
            <div className="w-full rounded-full h-1.5 mb-0.5" style={{ background: '#f0f0f0' }}>
              <div className="h-1.5 rounded-full transition-all" style={{ width: `${p}%`, background: colorBarra(p) }} />
            </div>
            {camion.posiciones_total > 0 && (
              <div className="w-full rounded-full h-1 mb-1" style={{ background: '#f0f0f0' }}>
                <div className="h-1 rounded-full transition-all" style={{ width: `${pPos}%`, background: colorBarra(pPos) }} />
              </div>
            )}
            <div className="flex justify-between items-center text-xs" style={{ color: '#B9BBB7' }}>
              <span>{Math.round(pesoTotal)} kg{camion.posiciones_total > 0 ? ` · ${Math.round(posTotal)} pos.` : ''}</span>
              <div className="flex items-center gap-2">
                <span style={{ color: (p >= 90 || pPos >= 90) ? '#E52322' : '#B9BBB7', fontWeight: (p >= 90 || pPos >= 90) ? 600 : 400 }}>
                  {p}%{camion.posiciones_total > 0 ? ` · ${pPos}%pos` : ''} · {camion.tonelaje_max_kg} kg
                </span>
                {onReprogramarCamion && pedidos.length > 0 && (
                  <button onClick={() => onReprogramarCamion(camion.codigo)}
                    title="Reprogramar pedidos de este camión"
                    className="px-1.5 py-0.5 rounded text-xs font-medium"
                    style={{ background: '#fef3c7', color: '#b45309' }}>📅</button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
      <div className="p-2 flex-1 overflow-y-auto">
        {pedidos.length === 0
          ? <div className="text-center py-8 text-xs" style={{ color: '#B9BBB7' }}>{sinAsignar ? 'Todos asignados ✓' : 'Arrastrá pedidos acá'}</div>
          : pedidos.map(p => <PedidoCard key={p.id} pedido={p} onDragStart={onDragStart} onCancelar={onCancelar} onCambiarVuelta={onCambiarVuelta} onReprogramar={onReprogramar} onEditarPeso={onEditarPeso} onToggleVolcador={onToggleVolcador} onSepararPedido={onSepararPedido} onMoverSucursal={onMoverSucursal} onIncidenciaStock={onIncidenciaStock} onNeedsExpand={handleNeedsExpand} soloVer={soloVer} />)}
      </div>
    </div>
  )
}
const DEPOSITOS: Record<string, { lat: number; lng: number }> = {
  'LP520':    { lat: -34.965403, lng: -58.06488 },
  'LP139':    { lat: -34.914872, lng: -58.023912 },
  'Guernica': { lat: -34.91118,  lng: -58.39945 },
  'Cañuelas': { lat: -35.0004012, lng: -58.7474278 },
  'Pinamar':  { lat: -37.207852, lng: -56.972302 },
}

function distanciaKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function maxVueltasPorDistancia(distKm: number): number {
  if (distKm < 20) return 4
  if (distKm < 50) return 3
  if (distKm < 100) return 2
  return 1
}

function calcularOrdenRuta(pedidos: Pedido[], sucursal: string): Record<string, number> {
  const deposito = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }
  const conCoords = pedidos.filter(p => p.latitud && p.longitud)
  const sinCoords = pedidos.filter(p => !p.latitud || !p.longitud)

  const ordenados: Pedido[] = []
  const restantes = [...conCoords]
  let latActual = deposito.lat
  let lngActual = deposito.lng

  while (restantes.length > 0) {
    let minDist = Infinity
    let minIdx = 0
    restantes.forEach((p, i) => {
      const d = Math.pow((p.latitud ?? 0) - latActual, 2) + Math.pow((p.longitud ?? 0) - lngActual, 2)
      if (d < minDist) { minDist = d; minIdx = i }
    })
    const siguiente = restantes.splice(minIdx, 1)[0]
    ordenados.push(siguiente)
    latActual = siguiente.latitud!
    lngActual = siguiente.longitud!
  }

  const todos = [...ordenados, ...sinCoords]
  const resultado: Record<string, number> = {}
  todos.forEach((p, i) => { resultado[p.id] = i + 1 })
  return resultado
}
function ProgramacionInner() {
  const router = useRouter()
  const params = useSearchParams()
  const [fecha, setFecha] = useState(params.get('fecha') ?? hoy())
  const [sucursal, setSucursal] = useState(params.get('sucursal') ?? 'LP520')
  const [vueltaActiva, setVueltaActiva] = useState(1)
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [camiones, setCamiones] = useState<Camion[]>([])
  const [columnas, setColumnas] = useState<ColumnaKanban[]>([])
  const [sinAsignar, setSinAsignar] = useState<Pedido[]>([])
  const [cargando, setCargando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [confirmado, setConfirmado] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const dragPedido = useRef<Pedido | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [modalReprogVuelta, setModalReprogVuelta] = useState(false)
  const [reprogVueltaFecha, setReprogVueltaFecha] = useState('')
  const [reprogVueltaNueva, setReprogVueltaNueva] = useState(1)
  const [camionParaReprog, setCamionParaReprog] = useState<string | null>(null)
  const [overflowPedidos, setOverflowPedidos] = useState<Pedido[]>([])
  const [bannerGrandeDismissed, setBannerGrandeDismissed] = useState(false)
  const [flotaSinRevisar, setFlotaSinRevisar] = useState(false)
  const [contadorSinVuelta, setContadorSinVuelta] = useState(0)
  const [modalRutas, setModalRutas] = useState(false)
  const [vultasCerradasManual, setVultasCerradasManual] = useState<Set<number>>(new Set())
  const [camionesBlockeados, setCamionesBlockeados] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('camionesBlockeados')
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>()
    } catch { return new Set<string>() }
  })
  const enrichGenRef = useRef(0)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => { setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000) }

  const [puedeEditarProg, setPuedeEditarProg] = useState(false)
  const [userId, setUserId] = useState('')
  const [userNombre, setUserNombre] = useState('')
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return
      setUserId(user.id)
      supabase.from('usuarios').select('rol, permisos, sucursal, nombre').eq('id', user.id).single().then(({ data }) => {
        if (!data) return
        setPuedeEditarProg(puedeEditar(data.permisos, data.rol, 'programacion'))
        setUserNombre(data.nombre ?? '')
        // Pre-seleccionar sucursal del usuario si no viene por URL param
        if (data.sucursal && !params.get('sucursal')) setSucursal(data.sucursal)
      })
    })
  }, [])

  useEffect(() => { cargarDatos() }, [fecha, sucursal, vueltaActiva])

  async function cargarDatos() {
    setCargando(true); setConfirmado(false)
    let q = supabase.from('pedidos')
      .select('*, prioridad, barrio_cerrado')
      .eq('fecha_entrega', fecha).eq('sucursal', sucursal)
      .in('estado', ['pendiente', 'programado']).order('cliente')
    q = vueltaActiva === VUELTA_FUERA ? q.eq('vuelta', 0) : q.eq('vuelta', vueltaActiva)
    const { data: pd } = await q
    const pedidosBase = pd ?? []
    // Fetch items via API (admin key, bypasses RLS)
    let todosConItems: Pedido[] = pedidosBase
    if (pedidosBase.length > 0) {
      const ids = pedidosBase.map((p: any) => p.id).join(',')
      try {
        const res = await fetch(`/api/pedido-items?ids=${ids}`)
        const json = await res.json()
        if (json.items && json.items.length > 0) {
          const itemsMap: Record<string, { nombre: string; cantidad: number; unidad: string }[]> = {}
          for (const it of json.items) {
            if (!itemsMap[it.pedido_id]) itemsMap[it.pedido_id] = []
            itemsMap[it.pedido_id].push({ nombre: it.nombre, cantidad: it.cantidad, unidad: it.unidad })
          }
          todosConItems = pedidosBase.map((p: any) => {
            const items = itemsMap[p.id] ?? []
            // Auto-detectar volcador si tiene items con "granel" y aún no está marcado
            const tieneGranel = items.some((i: any) => i.nombre.toLowerCase().includes('granel'))
            if (tieneGranel && !p.requiere_volcador) {
              fetch('/api/pedidos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, requiere_volcador: true }) })
            }
            return { ...p, items, requiere_volcador: tieneGranel || p.requiere_volcador }
          })
        }
      } catch { /* si falla, mostrar pedidos sin items */ }
    }
    // Una sola consulta cubre flota propia + camiones de otras sucursales;
    // el contador de sin-vuelta corre en paralelo para no bloquear
    const [{ data: allFd }, { count: cSinVuelta }] = await Promise.all([
      supabase.from('flota_dia')
        .select('camion_codigo, sucursal, revisado, sucursal_extra, sucursal_extra_desde_vuelta')
        .eq('fecha', fecha).eq('activo', true)
        .or(`sucursal.eq.${sucursal},sucursal_extra.eq.${sucursal}`),
      supabase.from('pedidos')
        .select('id', { count: 'exact', head: true })
        .eq('fecha_entrega', fecha).eq('sucursal', sucursal)
        .eq('vuelta', 0).in('estado', ['pendiente', 'programado']),
    ])
    const fd = (allFd ?? []).filter((f: any) => f.sucursal === sucursal)
    const fdExtra = (allFd ?? []).filter((f: any) => f.sucursal_extra === sucursal)
    setContadorSinVuelta(cSinVuelta ?? 0)

    let codigos = fd.map((f: any) => f.camion_codigo)
    let flotaSinRevisar = fd.length === 0 || fd.some((f: any) => f.revisado === false)

    // Fallback a flota base si no hay flota_dia para este día
    if (codigos.length === 0) {
      const { data: baseData } = await supabase.from('camiones_flota').select('codigo').eq('sucursal', sucursal).eq('activo', true)
      codigos = (baseData ?? []).map((b: any) => b.codigo)
      flotaSinRevisar = true
    }

    // Agregar camiones de otras sucursales que operan también acá
    const codigosExtra = fdExtra.map((f: any) => f.camion_codigo)
    const todosCodigos = [...new Set([...codigos, ...codigosExtra])]

    const { data: cd } = todosCodigos.length > 0 ? await supabase.from('camiones_flota').select('*').in('codigo', todosCodigos).eq('activo', true) : { data: [] }

    // Enriquecer con metadata de sucursal extra y ordenar por código
    const cams = (cd ?? [])
      .map((c: any) => {
        const extra = fdExtra.find((f: any) => f.camion_codigo === c.codigo)
        return extra
          ? { ...c, _desde_sucursal: extra.sucursal, _disponible_desde_vuelta: extra.sucursal_extra_desde_vuelta ?? 2 }
          : c
      })
      .sort((a: any, b: any) => a.codigo.localeCompare(b.codigo, undefined, { numeric: true, sensitivity: 'base' }))
    setFlotaSinRevisar(flotaSinRevisar)

    // Cargar vueltas cerradas manualmente para esta fecha/sucursal
    const { data: vcmData } = await supabase
      .from('vueltas_cerradas_manual')
      .select('vuelta')
      .eq('fecha', fecha)
      .eq('sucursal', sucursal)
    // vuelta=0 en DB = VUELTA_FUERA (-1) en UI
    setVultasCerradasManual(new Set((vcmData ?? []).map((r: any) => r.vuelta === 0 ? VUELTA_FUERA : r.vuelta as number)))

    // Marcar camiones posiblemente en ruta según distancia máxima en vueltas pasadas
    let camsConAviso = cams
    if (vueltaActiva > 1) {
      const { data: pedPasados } = await supabase
        .from('pedidos')
        .select('camion_id, vuelta, latitud, longitud')
        .eq('fecha_entrega', fecha)
        .eq('sucursal', sucursal)
        .eq('estado', 'programado')
        .lt('vuelta', vueltaActiva)
        .not('camion_id', 'is', null)

      const deposito = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }
      // cod → { vuelta, distKm } de la vuelta pasada más reciente que genera aviso
      const enRuta: Record<string, { vuelta: number; distKm: number }> = {}

      if (pedPasados && pedPasados.length > 0) {
        const porCamionVuelta: Record<string, Record<number, { lat: number; lng: number }[]>> = {}
        for (const p of pedPasados) {
          if (!p.camion_id || !p.vuelta) continue
          if (!porCamionVuelta[p.camion_id]) porCamionVuelta[p.camion_id] = {}
          if (!porCamionVuelta[p.camion_id][p.vuelta]) porCamionVuelta[p.camion_id][p.vuelta] = []
          if (p.latitud && p.longitud) {
            porCamionVuelta[p.camion_id][p.vuelta].push({ lat: p.latitud, lng: p.longitud })
          }
        }
        for (const [camionCod, vueltas] of Object.entries(porCamionVuelta)) {
          for (const [vStr, coords] of Object.entries(vueltas)) {
            const v = parseInt(vStr)
            if (coords.length === 0) continue
            const maxDist = Math.max(...coords.map(c => distanciaKm(deposito.lat, deposito.lng, c.lat, c.lng)))
            const maxVueltas = maxVueltasPorDistancia(maxDist)
            const vultasASkip = Math.ceil(5 / maxVueltas) - 1
            if (vultasASkip > 0 && vueltaActiva <= v + vultasASkip) {
              // Guardar la vuelta más reciente que genera el aviso
              if (!enRuta[camionCod] || v > enRuta[camionCod].vuelta) {
                enRuta[camionCod] = { vuelta: v, distKm: Math.round(maxDist) }
              }
            }
          }
        }
      }

      // Marcar camiones con aviso (siempre se muestran, nunca se ocultan)
      camsConAviso = cams.map(c => enRuta[c.codigo]
        ? { ...c, _en_ruta: true, _en_ruta_desde_vuelta: enRuta[c.codigo].vuelta, _en_ruta_dist_km: enRuta[c.codigo].distKm }
        : c
      )
    }

    const conLocalidad = todosConItems.map((p: any) => ({ ...p, localidad: localidadDeDireccion(p.direccion) }))
    setPedidos(conLocalidad); setCamiones(camsConAviso); construirColumnas(conLocalidad, camsConAviso); setCargando(false)
    enrichLocalidades(conLocalidad)
  }

  function construirColumnas(todos: Pedido[], cams: Camion[]) {
    const camCodigos = new Set(cams.map(c => c.codigo))
    setColumnas(cams.map(c => { const ps = todos.filter(p => p.camion_id === c.codigo); return { camion: c, pedidos: ps, pesoTotal: pesoColumna(ps), posTotal: posColumna(ps) } }))
    // Pedidos sin camión asignado + pedidos cuyo camión no pertenece a esta sucursal (ej: asignado a camión de otra sucursal)
    setSinAsignar(todos.filter(p => !p.camion_id || !camCodigos.has(p.camion_id)))
  }

  async function enrichLocalidades(peds: Pedido[]) {
    const gen = ++enrichGenRef.current
    const conCoords = peds.filter(p => p.latitud && p.longitud)
    if (conCoords.length === 0) return
    const buckets = new Map<string, { lat: number; lng: number; ids: string[] }>()
    for (const p of conCoords) {
      const key = `${p.latitud!.toFixed(2)},${p.longitud!.toFixed(2)}`
      if (!buckets.has(key)) buckets.set(key, { lat: p.latitud!, lng: p.longitud!, ids: [] })
      buckets.get(key)!.ids.push(p.id)
    }
    for (const [, { lat, lng, ids }] of buckets) {
      if (enrichGenRef.current !== gen) return
      await new Promise<void>(r => setTimeout(r, 1100))
      if (enrichGenRef.current !== gen) return
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`,
          { headers: { 'User-Agent': 'despachos-app' } }
        )
        const data = await res.json()
        const loc: string = data.address?.city || data.address?.town || data.address?.village || data.address?.suburb || ''
        if (!loc || enrichGenRef.current !== gen) continue
        setPedidos(prev => prev.map(p => ids.includes(p.id) ? { ...p, localidad: loc } : p))
        setColumnas(prev => prev.map(col => ({
          ...col,
          pedidos: col.pedidos.map(p => ids.includes(p.id) ? { ...p, localidad: loc } : p),
        })))
        setSinAsignar(prev => prev.map(p => ids.includes(p.id) ? { ...p, localidad: loc } : p))
      } catch { /* nominatim fail silently */ }
    }
  }

  async function handleSugerir() {
    const sin = pedidos.filter(p => !p.camion_id)
    if (!sin.length) return
    const camionesLibres = camiones.filter(c => !camionesBlockeados.has(c.codigo))
    const ya = pedidos.filter(p => p.camion_id)

    // Mostrar clusters detectados para feedback visual
    const clusters = buildClusters(sin).filter(c => c.length > 1)
    if (clusters.length > 0) {
      const desc = clusters.map(c => c.map(p => p.cliente.split(' ')[0]).join('+') ).join(' | ')
      showToast(`🗂️ ${clusters.length} grupo${clusters.length > 1 ? 's' : ''} detectado${clusters.length > 1 ? 's' : ''}: ${desc}`)
    }

    const asigs = sugerirAsignacion(sin, camionesLibres, ya, sucursal)

    // Revisión con IA: Haiku corrige agrupaciones que el algoritmo no detecta
    setCargando(true)
    try {
      const res = await fetch('/api/sugerir-asignacion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidos: sin, camiones: camionesLibres, ya_asignados: ya, sugerencia: asigs, sucursal }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.asignacion) {
          Object.assign(asigs, data.asignacion)
          if (data.cambios?.length) {
            showToast(`🤖 IA corrigió ${data.cambios.length} asignación${data.cambios.length > 1 ? 'es' : ''}`)
          }
        }
      }
    } catch { /* si la IA falla, usamos la sugerencia del algoritmo igual */ }
    setCargando(false)

    const act = pedidos.map(p => ({ ...p, camion_id: p.id in asigs ? asigs[p.id] : p.camion_id }))
    setPedidos(act); construirColumnas(act, camiones)
    const overflow = act.filter(p => asigs[p.id] === null)
    setOverflowPedidos(vueltaActiva < 4 ? overflow : [])
  }

  async function handleLimpiar() {
    const conAsignacion = pedidos.filter(p => p.camion_id)
    // Limpiar estado local inmediatamente
    const limpio = pedidos.map(p => ({ ...p, camion_id: null }))
    setPedidos(limpio); construirColumnas(limpio, camiones); setConfirmado(false)
    // Limpiar DB si había algo confirmado
    if (conAsignacion.length > 0) {
      setGuardando(true)
      try {
        await Promise.all(conAsignacion.map(p =>
          supabase.from('pedidos').update({ camion_id: null, estado: 'pendiente', orden_entrega: null }).eq('id', p.id)
        ))
      } catch (e: any) {
        showToast(`Error al limpiar: ${e.message}`, 'err')
      } finally {
        setGuardando(false)
      }
    }
  }

  async function handleMoverOverflow() {
    const nextVuelta = vueltaActiva + 1
    try {
      await Promise.all(overflowPedidos.map(p =>
        patchPedido(p.id, { vuelta: nextVuelta, camion_id: null, orden_entrega: null, estado: 'pendiente' })
      ))
      showToast(`${overflowPedidos.length} pedidos movidos a V${nextVuelta}`)
      setOverflowPedidos([])
      cargarDatos()
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
  }

  function handleDrop(e: React.DragEvent, cod: string | null) {
    e.preventDefault(); setDragOver(null)
    if (!dragPedido.current) return
    const dropped = dragPedido.current
    const camionAnterior = dropped.camion_id
    const id = dropped.id; dragPedido.current = null
    const act = pedidos.map(p => p.id === id ? { ...p, camion_id: cod } : p)
    setPedidos(act); construirColumnas(act, camiones)
    if (userId) {
      const accion = cod ? 'Asignó camión' : 'Desasignó camión'
      logAuditoria(userId, userNombre, accion, 'Programación', { pedido_nv: dropped.nv, cliente: dropped.cliente, camion_anterior: camionAnterior, camion_nuevo: cod })
    }
  }

  async function handleConfirmar() {
    setGuardando(true)

    const asignados = pedidos.filter(p => p.camion_id)
    const sinCamion = pedidos.filter(p => !p.camion_id)

    const porCamion: Record<string, Pedido[]> = {}
    asignados.forEach(p => {
      if (!porCamion[p.camion_id!]) porCamion[p.camion_id!] = []
      porCamion[p.camion_id!].push(p)
    })

    const ordenes: Record<string, number> = {}
    Object.entries(porCamion).forEach(([, pedidosCamion]) => {
      const orden = calcularOrdenRuta(pedidosCamion, sucursal)
      Object.assign(ordenes, orden)
    })

    try {
      const resultados = await Promise.all([
        ...asignados.map(p =>
          supabase.from('pedidos').update({
            camion_id: p.camion_id,
            estado: 'programado',
            orden_entrega: ordenes[p.id] ?? null,
          }).eq('id', p.id)
        ),
        ...sinCamion.map(p =>
          supabase.from('pedidos').update({
            camion_id: null,
            estado: 'pendiente',
            orden_entrega: null,
          }).eq('id', p.id)
        ),
      ])

      const errores = resultados.filter(r => r.error)
      if (errores.length > 0) {
        console.error('Errores al confirmar:', errores.map(r => r.error))
        showToast(`Error al guardar: ${errores[0].error?.message ?? 'error desconocido'}`, 'err')
      } else {
        setConfirmado(true)
        showToast('Programación confirmada')
        if (userId) logAuditoria(userId, userNombre, 'Confirmó programación', 'Programación', { fecha, sucursal, vuelta: vueltaActiva, total_pedidos: pedidos.length, total_camiones: Object.keys(columnas.reduce((acc, col) => { if (col.pedidos.length > 0) acc[col.camion.codigo] = true; return acc }, {} as Record<string, boolean>)).length })
      }
    } catch (e: any) {
      showToast(`Error inesperado: ${e.message}`, 'err')
    } finally {
      setGuardando(false)
    }
  }

  async function handleAsignarVuelta(id: string, vuelta: number) {
    try {
      await patchPedido(id, { vuelta, camion_id: null, orden_entrega: null })
      const act = pedidos.filter(p => p.id !== id)
      setPedidos(act); construirColumnas(act, camiones)
      setContadorSinVuelta(prev => Math.max(0, prev - 1))
      showToast(`Pedido asignado a ${vuelta === 5 ? 'DHora' : `V${vuelta}`}`)
    } catch { showToast('Error al asignar vuelta', 'err') }
  }

  async function handleEditarPeso(id: string, peso: number, posiciones: number) {
    const pedido = pedidos.find(p => p.id === id)
    try {
      await patchPedido(id, { peso_total_kg: peso, volumen_total_m3: posiciones, pedido_grande: false })
      const act = pedidos.map(p => p.id === id ? { ...p, peso_total_kg: peso, volumen_total_m3: posiciones, pedido_grande: false } : p)
      setPedidos(act); construirColumnas(act, camiones)
      showToast('Peso y posiciones actualizados')
      if (userId && pedido) logAuditoria(userId, userNombre, 'Editó peso/posiciones', 'Programación', { nv: pedido.nv, cliente: pedido.cliente, peso_anterior: pedido.peso_total_kg, peso_nuevo: peso, pos_anterior: pedido.volumen_total_m3, pos_nuevo: posiciones })
    } catch { showToast('Error al actualizar', 'err') }
  }

  async function patchPedido(id: string, updates: Record<string, any>) {
    const res = await fetch('/api/pedidos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...updates }) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Error desconocido')
  }

  async function handleToggleVolcador(id: string, valor: boolean) {
    const pedido = pedidos.find(p => p.id === id)
    try {
      await patchPedido(id, { requiere_volcador: valor })
      const act = pedidos.map(p => p.id === id ? { ...p, requiere_volcador: valor } : p)
      setPedidos(act); construirColumnas(act, camiones)
      if (userId && pedido) logAuditoria(userId, userNombre, valor ? 'Marcó requiere volcador' : 'Quitó requiere volcador', 'Programación', { nv: pedido.nv, cliente: pedido.cliente })
    } catch { showToast('Error al actualizar tipo de camión', 'err') }
  }

  async function handleIncidenciaStock(id: string, itemsSinStock: any[], itemsConStock: any[]) {
    try {
      const res = await fetch('/api/separar-pedido', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedido_id: id, items_nuevo: itemsSinStock, items_mantener: itemsConStock, motivo: 'stock' }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      if (data.tipo === 'reprogramado_completo') {
        showToast('Pedido sin stock — movido a pendiente para reprogramar')
        const act = pedidos.filter(p => p.id !== id)
        setPedidos(act); construirColumnas(act, camiones)
      } else {
        showToast('Incidencia registrada — ítems sin stock separados como pendiente')
        cargarDatos()
      }
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
  }

  async function handleMoverSucursal(id: string, nuevaSucursal: string) {
    const pedido = pedidos.find(p => p.id === id)
    try {
      await patchPedido(id, { sucursal: nuevaSucursal, camion_id: null, orden_entrega: null })
      // El pedido desaparece de esta vista (era de otra sucursal)
      const act = pedidos.filter(p => p.id !== id)
      setPedidos(act); construirColumnas(act, camiones)
      showToast(`Pedido movido a ${nuevaSucursal}`)
      if (userId && pedido) logAuditoria(userId, userNombre, 'Movió pedido a sucursal', 'Programación', { nv: pedido.nv, cliente: pedido.cliente, sucursal_anterior: pedido.sucursal, sucursal_nueva: nuevaSucursal })
    } catch { showToast('Error al mover sucursal', 'err') }
  }

  async function handleSepararPedido(id: string, itemsNuevo: any[], itemsMantener: any[]) {
    try {
      const res = await fetch('/api/separar-pedido', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedido_id: id, items_nuevo: itemsNuevo, items_mantener: itemsMantener }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      showToast('Pedido separado correctamente')
      cargarDatos() // recargar para ver ambos pedidos
    } catch (e: any) { showToast(`Error al separar: ${e.message}`, 'err') }
  }

  async function handleCancelar(id: string) {
    const pedido = pedidos.find(p => p.id === id)
    try {
      const res = await fetch('/api/pedidos', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error desconocido')
      const act = pedidos.filter(p => p.id !== id)
      setPedidos(act); construirColumnas(act, camiones)
      showToast('Pedido eliminado')
      if (userId && pedido) logAuditoria(userId, userNombre, 'Canceló pedido', 'Programación', { nv: pedido.nv, cliente: pedido.cliente, sucursal: pedido.sucursal })
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
  }

  async function handleCambiarVuelta(id: string, nuevaVuelta: number) {
    const pedido = pedidos.find(p => p.id === id)
    try {
      await patchPedido(id, { vuelta: nuevaVuelta, camion_id: null, estado: 'pendiente' })
      const act = pedidos.filter(p => p.id !== id)
      setPedidos(act); construirColumnas(act, camiones)
      showToast(`Pedido movido a Vuelta ${nuevaVuelta}`)
      if (userId && pedido) logAuditoria(userId, userNombre, 'Cambió vuelta', 'Programación', { nv: pedido.nv, cliente: pedido.cliente, vuelta_anterior: pedido.vuelta, vuelta_nueva: nuevaVuelta })
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
  }

  async function handleReprogramarVuelta() {
    if (!reprogVueltaFecha || pedidos.length === 0) return
    setGuardando(true)
    const aReprogramar = camionParaReprog
      ? pedidos.filter(p => p.camion_id === camionParaReprog)
      : pedidos
    try {
      const contexto = camionParaReprog ? `camión ${camionParaReprog}` : `vuelta completa`
      const nota = `⚡ Reprog. ${contexto} desde ${fecha} V${vueltaActiva}`
      await Promise.all(aReprogramar.map(p =>
        fetch('/api/pedidos', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, fecha_entrega: reprogVueltaFecha, vuelta: reprogVueltaNueva, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: p.notas ? `${p.notas} | ${nota}` : nota })
        })
      ))
      setModalReprogVuelta(false)
      showToast(`${aReprogramar.length} pedidos reprogramados`)
      if (userId) logAuditoria(userId, userNombre, 'Reprogramó vuelta completa', 'Programación', { fecha, vuelta: vueltaActiva, pedidos_count: aReprogramar.length, fecha_destino: reprogVueltaFecha })
      cargarDatos()
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
    setGuardando(false)
  }

  async function handleReprogramar(id: string, fecha: string, vuelta: number, motivo: string) {
    const pedido = pedidos.find(p => p.id === id)
    if (!pedido) return
    const nota = `⚡ Reprogramado desde ${pedido.fecha_entrega} V${pedido.vuelta}${motivo ? ` — ${motivo}` : ''}`
    const notaFinal = pedido.notas ? `${pedido.notas} | ${nota}` : nota
    try {
      await patchPedido(id, { fecha_entrega: fecha, vuelta, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: notaFinal })
      const act = pedidos.filter(p => p.id !== id)
      setPedidos(act); construirColumnas(act, camiones)
      showToast(`Pedido de ${pedido.cliente} reprogramado para el ${fecha}`)
      if (userId) logAuditoria(userId, userNombre, 'Reprogramó pedido', 'Programación', { nv: pedido.nv, cliente: pedido.cliente, fecha_nueva: fecha, vuelta_nueva: vuelta, motivo })
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
  }

  async function handleToggleVueltaCerrada(vueltaUI: number) {
    // En la UI "Fuera de prog." es -1, en la DB se guarda como 0 (igual que los pedidos)
    const vueltaDB = vueltaUI === VUELTA_FUERA ? 0 : vueltaUI
    const label = vueltaUI === VUELTA_FUERA ? 'Fuera de prog.' : `Vuelta ${vueltaUI}`
    const estaCerrada = vultasCerradasManual.has(vueltaUI)
    try {
      if (estaCerrada) {
        await supabase.from('vueltas_cerradas_manual')
          .delete().eq('fecha', fecha).eq('sucursal', sucursal).eq('vuelta', vueltaDB)
        setVultasCerradasManual(prev => { const s = new Set(prev); s.delete(vueltaUI); return s })
        showToast(`${label} abierta`)
      } else {
        await supabase.from('vueltas_cerradas_manual')
          .insert({ fecha, sucursal, vuelta: vueltaDB, cerrada_por: userId || null })
        setVultasCerradasManual(prev => new Set([...prev, vueltaUI]))
        showToast(`${label} cerrada manualmente`)
      }
      if (userId) logAuditoria(userId, userNombre, estaCerrada ? 'Abrió vuelta manualmente' : 'Cerró vuelta manualmente', 'Programación', { fecha, sucursal, vuelta: vueltaDB })
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
  }

  const totalAsig = pedidos.filter(p => p.camion_id).length
  const totalSin = pedidos.length - totalAsig

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Modal reprogramar vuelta / camión */}
      {modalReprogVuelta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <h3 className="font-semibold text-sm mb-1" style={{ color: '#254A96' }}>
              📅 {camionParaReprog ? `Reprogramar camión ${camionParaReprog}` : 'Reprogramar vuelta completa'}
            </h3>
            <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>
              {camionParaReprog
                ? `Se moverán los ${pedidos.filter(p => p.camion_id === camionParaReprog).length} pedidos del camión ${camionParaReprog} (V${vueltaActiva}).`
                : `Se moverán los ${pedidos.length} pedidos de V${vueltaActiva} del ${fecha}.`}
            </p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva fecha</label>
                <input type="date" value={reprogVueltaFecha}
                  min={hoy()}
                  onChange={e => setReprogVueltaFecha(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva vuelta</label>
                <select value={reprogVueltaNueva} onChange={e => setReprogVueltaNueva(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                  {TODAS_VUELTAS.map(({ num, label }) => {
                    const disponible = vueltasDisponibles(reprogVueltaFecha).includes(num)
                    return (
                      <option key={num} value={num} disabled={!disponible}>
                        {label}{!disponible ? ' (pasada)' : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button disabled={!reprogVueltaFecha || guardando}
                onClick={handleReprogramarVuelta}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: '#254A96' }}>
                {guardando ? 'Reprogramando…' : 'Confirmar'}
              </button>
              <button onClick={() => { setModalReprogVuelta(false); setCamionParaReprog(null) }}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b shrink-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="px-4 md:px-6">
          <div className="h-14 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <button onClick={() => router.push('/dashboard')} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg shrink-0"
                style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</button>
              <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
              <div className="hidden sm:block">
                <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Programación</span>
                <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Asignación de pedidos a camiones</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="date" value={fecha} onChange={e => { setFecha(e.target.value); setConfirmado(false); setBannerGrandeDismissed(false) }}
                className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              <select value={sucursal} onChange={e => { setSucursal(e.target.value); setConfirmado(false); setBannerGrandeDismissed(false) }}
                className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-1.5 pb-3 flex-wrap items-center">
            {VUELTAS.map(v => {
              const activo = vueltaActiva === v.num
              const esFuera = v.num === VUELTA_FUERA
              const badge = esFuera && contadorSinVuelta > 0
              const cerradaManual = !esFuera && vultasCerradasManual.has(v.num)
              return (
                <div key={v.num} className="flex items-center gap-0.5">
                  <button onClick={() => setVueltaActiva(v.num)}
                    className="relative px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                    style={{
                      background: activo ? '#254A96' : cerradaManual ? '#fde8e8' : '#f4f4f3',
                      color: activo ? 'white' : cerradaManual ? '#E52322' : '#666',
                    }}>
                    {v.label}
                    {cerradaManual && <span className="ml-1 text-xs">🔒</span>}
                    {v.horario && !cerradaManual && <span className="text-xs opacity-70 ml-1">{v.horario}</span>}
                    {badge && (
                      <span className="absolute -top-1.5 -right-1.5 flex items-center justify-center rounded-full font-bold text-white"
                        style={{ minWidth: 17, height: 17, fontSize: 9, padding: '0 3px', background: '#E52322' }}>
                        {contadorSinVuelta}
                      </span>
                    )}
                  </button>
                  {puedeEditarProg && (
                    <button
                      onClick={() => handleToggleVueltaCerrada(v.num)}
                      title={cerradaManual
                        ? `Abrir ${esFuera ? 'Fuera de prog.' : `vuelta ${v.num}`}`
                        : `Cerrar ${esFuera ? 'Fuera de prog.' : `vuelta ${v.num}`} manualmente`}
                      className="px-1.5 py-1 rounded text-xs transition-colors"
                      style={{
                        color: cerradaManual ? '#E52322' : '#B9BBB7',
                        background: cerradaManual ? '#fde8e8' : '#f4f4f3',
                      }}>
                      {cerradaManual ? '🔒' : '🔓'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </nav>

      {/* Barra acciones */}
      <div className="bg-white border-b shrink-0 px-4 md:px-6 py-2.5" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-5 text-sm" style={{ color: '#B9BBB7' }}>
            <span>Total: <strong style={{ color: '#254A96' }}>{pedidos.length}</strong></span>
            <span>Asignados: <strong style={{ color: '#10b981' }}>{totalAsig}</strong></span>
            <span>Sin asignar: <strong style={{ color: totalSin > 0 ? '#E52322' : '#B9BBB7' }}>{totalSin}</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setModalRutas(true)} disabled={cargando || pedidos.length === 0}
              className="px-3 py-2 text-sm font-medium rounded-lg border transition-colors disabled:opacity-40"
              style={{ borderColor: '#e8edf8', color: '#254A96', background: '#f4f4f3' }}>
              🗺️ Ver rutas
            </button>
            {puedeEditarProg && vueltaActiva !== VUELTA_FUERA && <>
              <button onClick={handleLimpiar}
                disabled={cargando || guardando}
                className="px-3 py-2 text-sm rounded-lg border transition-colors disabled:opacity-40"
                style={{ borderColor: '#e8edf8', color: '#666' }}>Limpiar</button>
              <button onClick={() => { setCamionParaReprog(null); setModalReprogVuelta(true); setReprogVueltaFecha(''); setReprogVueltaNueva(1) }}
                disabled={cargando || guardando || pedidos.length === 0}
                className="px-3 py-2 text-sm rounded-lg border transition-colors disabled:opacity-40"
                style={{ borderColor: '#fbbf24', color: '#b45309', background: '#fef3c7' }}>📅 Reprog. vuelta</button>
              <button onClick={handleSugerir} disabled={cargando || guardando || totalSin === 0}
                className="px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors disabled:opacity-40"
                style={{ background: '#7c3aed' }}>✦ Sugerir</button>
              <button onClick={handleConfirmar} disabled={cargando || guardando || totalAsig === 0 || confirmado}
                className="px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-40"
                style={{ background: confirmado ? '#d1fae5' : '#254A96', color: confirmado ? '#065f46' : 'white' }}>
                {guardando ? 'Guardando…' : confirmado ? '✓ Confirmado' : 'Confirmar'}
              </button>
            </>}
            {!puedeEditarProg && (
              <span className="text-xs px-3 py-2 rounded-lg" style={{ background: '#f4f4f3', color: '#B9BBB7' }}>
                👁️ Solo visualización
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Kanban — ocupa todo el alto restante */}
      <div className="flex-1 overflow-hidden flex flex-col px-3 pt-2 pb-3">

        {/* Banner flota sin revisar */}
        {flotaSinRevisar && (
          <div className="mb-2 rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e' }}>
            <span className="text-lg">⚠️</span>
            <p className="text-sm flex-1">
              <strong>Flota sin revisar</strong> — El admin de flota todavía no confirmó los camiones para este día. Los cupos son estimados en base a la flota habitual.
            </p>
          </div>
        )}

        {/* Banner pedidos grandes */}
        {pedidos.some(p => p.pedido_grande) && !bannerGrandeDismissed && (
          <div className="mb-2 rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e' }}>
            <span className="text-lg">⚠️</span>
            <div className="flex-1">
              <span className="font-semibold text-sm">
                {pedidos.filter(p => p.pedido_grande).length === 1
                  ? 'Hay 1 pedido grande que requiere separación manual'
                  : `Hay ${pedidos.filter(p => p.pedido_grande).length} pedidos grandes que requieren separación manual`}
              </span>
              <span className="text-xs ml-2">— Usá "Separar pedido" o editá el peso en la tarjeta correspondiente</span>
            </div>
            <button
              onClick={() => setBannerGrandeDismissed(true)}
              className="text-xs px-2 py-1 rounded-lg font-medium flex-shrink-0"
              style={{ background: '#fde68a', color: '#92400e' }}
              title="Descartar aviso"
            >
              ✕ Descartar
            </button>
          </div>
        )}

        {/* Banner overflow */}
        {overflowPedidos.length > 0 && (
          <div className="mb-4 rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap"
            style={{ background: '#fef3c7', border: '1px solid #fbbf24' }}>
            <div>
              <p className="text-sm font-semibold" style={{ color: '#b45309' }}>
                {overflowPedidos.length} pedido{overflowPedidos.length > 1 ? 's' : ''} no entran en los camiones de V{vueltaActiva}
              </p>
              <p className="text-xs mt-0.5" style={{ color: '#92400e' }}>
                ¿Moverlos a Vuelta {vueltaActiva + 1} para programar ahí?
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={handleMoverOverflow}
                className="text-xs px-3 py-1.5 rounded-lg font-semibold text-white"
                style={{ background: '#b45309' }}>
                Mover a V{vueltaActiva + 1}
              </button>
              <button onClick={() => setOverflowPedidos([])}
                className="text-xs px-3 py-1.5 rounded-lg font-medium"
                style={{ background: 'white', color: '#b45309', border: '1px solid #fbbf24' }}>
                Dejar sin asignar
              </button>
            </div>
          </div>
        )}

        {cargando ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : pedidos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
            <div className="text-5xl mb-4">📦</div>
            <p className="font-medium">No hay pedidos para esta fecha y sucursal</p>
            <p className="text-sm mt-1">
              {vueltaActiva === VUELTA_FUERA ? 'No hay pedidos fuera de programación' : 'Cambiá la fecha, la sucursal o la vuelta'}
            </p>
          </div>
        ) : vueltaActiva === VUELTA_FUERA ? (
          /* ── Vista especial: pedidos sin vuelta asignada ── */
          <div className="flex-1 overflow-y-auto p-4">
            <div className="max-w-2xl mx-auto space-y-2">
              <p className="text-xs mb-3 font-medium" style={{ color: '#B9BBB7' }}>
                {pedidos.length} pedido{pedidos.length !== 1 ? 's' : ''} sin vuelta asignada{puedeEditarProg ? ' — elegí a qué vuelta mandar cada uno' : ''}
              </p>
              {pedidos.map(p => (
                <div key={p.id} className="bg-white rounded-xl border px-4 py-3 flex items-center gap-4"
                  style={{ borderColor: '#e8edf8' }}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
                    <p className="text-xs truncate" style={{ color: '#B9BBB7' }}>
                      {p.nv && <span className="mr-2">NV {p.nv}</span>}
                      {p.direccion}
                    </p>
                    {(p.peso_total_kg || p.volumen_total_m3) && (
                      <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                        {p.peso_total_kg ? `${(p.peso_total_kg / 1000).toFixed(2)} t` : ''}
                        {p.peso_total_kg && p.volumen_total_m3 ? ' · ' : ''}
                        {p.volumen_total_m3 ? `${p.volumen_total_m3} pos.` : ''}
                      </p>
                    )}
                  </div>
                  {puedeEditarProg && (
                    <div className="flex gap-1 shrink-0">
                      {[1, 2, 3, 4].map(v => (
                        <button key={v} onClick={() => handleAsignarVuelta(p.id, v)}
                          className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors"
                          style={{ background: '#e8edf8', color: '#254A96' }}>
                          V{v}
                        </button>
                      ))}
                      <button onClick={() => handleAsignarVuelta(p.id, 5)}
                        className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors"
                        style={{ background: '#f0f9ff', color: '#0369a1' }}>
                        DHora
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : camiones.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
            <div className="text-5xl mb-4">🚛</div>
            <p className="font-medium">No hay camiones configurados para esta fecha</p>
            <button onClick={() => router.push('/flota')} className="mt-3 text-sm font-medium" style={{ color: '#254A96' }}>Ir a Flota del día →</button>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex gap-2">
            {/* Sin asignar — fija a la izquierda */}
            <div className="shrink-0 h-full" style={{ zIndex: 10 }}>
              <ColumnaCamion sinAsignar
                columna={{ camion: { codigo: '', sucursal, tipo_unidad: '', posiciones_total: 0, tonelaje_max_kg: 0, grua_hidraulica: false, volcador: false }, pedidos: sinAsignar, pesoTotal: 0, posTotal: 0 }}
                onDrop={handleDrop}
                onDragOver={(e, cod) => { e.preventDefault(); setDragOver(cod ?? 'sin_asignar') }}
                onDragLeave={() => setDragOver(null)}
                onDragStart={(e, p) => { dragPedido.current = p; e.dataTransfer.effectAllowed = 'move' }}
                isDragOver={dragOver === 'sin_asignar'}
                onCancelar={handleCancelar}
                onCambiarVuelta={handleCambiarVuelta}
                onReprogramar={handleReprogramar}
                onEditarPeso={handleEditarPeso}
                onToggleVolcador={handleToggleVolcador}
                onSepararPedido={handleSepararPedido}
                onMoverSucursal={handleMoverSucursal}
                onIncidenciaStock={handleIncidenciaStock}
                soloVer={!puedeEditarProg} />
            </div>
            <div className="w-px shrink-0 self-stretch" style={{ background: '#e8edf8' }} />
            {/* Camiones — scroll horizontal */}
            <div className="flex-1 overflow-x-auto overflow-y-hidden h-full">
              <div className="flex gap-2 h-full pr-2">
                {columnas.map(col => (
                  <ColumnaCamion key={col.camion.codigo} columna={col}
                    onDrop={handleDrop}
                    onDragOver={(e, cod) => { e.preventDefault(); setDragOver(cod ?? 'sin_asignar') }}
                    onDragLeave={() => setDragOver(null)}
                    onDragStart={(e, p) => { dragPedido.current = p; e.dataTransfer.effectAllowed = 'move' }}
                    isDragOver={dragOver === col.camion.codigo}
                    onCancelar={handleCancelar}
                    onCambiarVuelta={handleCambiarVuelta}
                    onReprogramar={handleReprogramar}
                    onEditarPeso={handleEditarPeso}
                    onToggleVolcador={handleToggleVolcador}
                    onSepararPedido={handleSepararPedido}
                    onMoverSucursal={handleMoverSucursal}
                    onIncidenciaStock={handleIncidenciaStock}
                    onReprogramarCamion={codigo => { setCamionParaReprog(codigo); setModalReprogVuelta(true); setReprogVueltaFecha(''); setReprogVueltaNueva(1) }}
                    deposito={DEPOSITOS[sucursal]}
                    soloVer={!puedeEditarProg}
                    bloqueado={camionesBlockeados.has(col.camion.codigo)}
                    onToggleLock={puedeEditarProg ? () => setCamionesBlockeados(prev => {
                      const s = new Set(prev)
                      s.has(col.camion.codigo) ? s.delete(col.camion.codigo) : s.add(col.camion.codigo)
                      try { localStorage.setItem('camionesBlockeados', JSON.stringify([...s])) } catch {}
                      return s
                    }) : undefined} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {modalRutas && (
        <ModalRutas
          columnas={columnas}
          sinAsignar={sinAsignar}
          sucursal={sucursal}
          onClose={() => setModalRutas(false)}
        />
      )}
    </div>
  )
}

// ─── Modal Previsualización de Rutas ────────────────────────────────────────────

const TRUCK_COLORS = ['#254A96', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#84cc16']

function ModalRutas({ columnas, sinAsignar, sucursal, onClose }: {
  columnas: ColumnaKanban[]
  sinAsignar: Pedido[]
  sucursal: string
  onClose: () => void
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<any>(null)

  // Filtrar SOLO camiones con al menos un pedido geocodificado — se usa para mapa Y leyenda (índices consistentes)
  const colsConPedidos = columnas.filter(c => c.pedidos.some(p => p.latitud && p.longitud))
  const sinAsignarConCoords = sinAsignar.filter(p => p.latitud && p.longitud)
  const totalConCoords = colsConPedidos.reduce((a, c) => a + c.pedidos.filter(p => p.latitud && p.longitud).length, 0) + sinAsignarConCoords.length

  useEffect(() => {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link')
      link.id = 'leaflet-css'; link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
      document.head.appendChild(link)
    }

    function initMap() {
      if (!mapRef.current) return
      const L = (window as any).L
      if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null }

      const depot = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }
      const map = L.map(mapRef.current).setView([depot.lat, depot.lng], 12)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map)

      L.marker([depot.lat, depot.lng], {
        icon: L.divIcon({
          html: `<div style="background:#1a1a1a;color:white;padding:3px 7px;border-radius:6px;font-size:11px;font-weight:bold;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.4)">🏭 ${sucursal}</div>`,
          className: '', iconSize: [90, 24], iconAnchor: [45, 12],
        })
      }).addTo(map)

      const boundsPoints: [number, number][] = [[depot.lat, depot.lng]]

      // Agrupar pedidos por ubicación exacta (4 decimales ≈ 11m) para no superponer marcadores
      function locKey(p: Pedido) { return `${Math.round(p.latitud! * 1e4)},${Math.round(p.longitud! * 1e4)}` }

      // Popup completo para uno o varios pedidos en la misma ubicación
      function buildPopup(color: string, camion: string, peds: Pedido[], ordenes: number[]) {
        return peds.map((p, gi) => {
          const itemsHtml = p.items && p.items.length > 0
            ? `<div style="margin-top:4px;border-top:1px solid #f0f0f0;padding-top:4px">${p.items.map(it =>
                `<div style="font-size:11px;color:#555">• ${it.nombre} × ${it.cantidad} ${it.unidad}</div>`
              ).join('')}</div>`
            : ''
          return `<div style="min-width:220px;max-width:280px${gi > 0 ? ';border-top:2px solid #e5e7eb;margin-top:10px;padding-top:10px' : ''}">
            <div style="font-weight:700;color:${color};font-size:13px">${camion} · Parada ${ordenes[gi]}</div>
            <div style="font-weight:700;font-size:13px;margin-top:3px">${p.cliente}</div>
            <div style="font-size:11px;color:#6b7280;margin-top:1px">NV ${p.nv}</div>
            <div style="font-size:11px;color:#374151;margin-top:3px">${p.direccion}</div>
            ${p.localidad ? `<div style="font-size:11px;color:#1e40af;margin-top:1px">📍 ${p.localidad}</div>` : ''}
            ${itemsHtml}
            <div style="font-size:11px;color:#9ca3af;margin-top:4px">${p.peso_total_kg ?? '?'} kg · ${p.volumen_total_m3 ?? '?'} pos</div>
          </div>`
        }).join('')
      }

      // Iterar colsConPedidos (ya filtrado) — mismo índice que la leyenda → colores consistentes
      colsConPedidos.forEach((col, idx) => {
        const color = TRUCK_COLORS[idx % TRUCK_COLORS.length]
        const peds = col.pedidos
          .filter(p => p.latitud && p.longitud)
          .sort((a, b) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))

        L.polyline(
          [[depot.lat, depot.lng], ...peds.map(p => [p.latitud!, p.longitud!] as [number, number]), [depot.lat, depot.lng]],
          { color, weight: 3, opacity: 0.85, dashArray: '8,5' }
        ).addTo(map)

        // Agrupar por ubicación para mostrar todos los pedidos en un solo marcador
        const grupos = new Map<string, { peds: Pedido[]; ordenes: number[] }>()
        peds.forEach((p, i) => {
          const k = locKey(p)
          if (!grupos.has(k)) grupos.set(k, { peds: [], ordenes: [] })
          grupos.get(k)!.peds.push(p)
          grupos.get(k)!.ordenes.push(i + 1)
        })

        grupos.forEach(({ peds: gp, ordenes }) => {
          const label = ordenes.join('·')
          const w = Math.max(26, 14 + label.length * 8)
          L.marker([gp[0].latitud!, gp[0].longitud!], {
            icon: L.divIcon({
              html: `<div style="background:${color};color:white;min-width:${w}px;height:26px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;border:2px solid white;box-shadow:0 1px 5px rgba(0,0,0,0.35);padding:0 5px">${label}</div>`,
              className: '', iconSize: [w, 26], iconAnchor: [w / 2, 13],
            })
          })
            .bindPopup(buildPopup(color, col.camion.codigo, gp, ordenes), { maxWidth: 300 })
            .addTo(map)
          boundsPoints.push([gp[0].latitud!, gp[0].longitud!])
        })
      })

      // Sin asignar
      sinAsignarConCoords.forEach(p => {
        L.marker([p.latitud!, p.longitud!], {
          icon: L.divIcon({
            html: `<div style="background:#9ca3af;color:white;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.3)">?</div>`,
            className: '', iconSize: [22, 22], iconAnchor: [11, 11],
          })
        })
          .bindPopup(`<div style="min-width:180px"><b>Sin asignar</b><br><b>${p.cliente}</b><br><span style="font-size:11px;color:#6b7280">NV ${p.nv}</span><br><span style="font-size:11px;color:#374151">${p.direccion}</span></div>`)
          .addTo(map)
        boundsPoints.push([p.latitud!, p.longitud!])
      })

      if (boundsPoints.length > 1) map.fitBounds(boundsPoints, { padding: [30, 30] })
      leafletRef.current = map
    }

    if ((window as any).L) { setTimeout(initMap, 50) }
    else {
      const script = document.createElement('script')
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
      script.onload = () => setTimeout(initMap, 50)
      document.body.appendChild(script)
    }
    return () => { if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null } }
  }, [columnas, sinAsignar, sucursal]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white" style={{ fontFamily: 'Barlow, sans-serif' }}>
      <div className="px-5 py-3 flex items-center justify-between gap-4 shrink-0 border-b" style={{ borderColor: '#f0f0f0' }}>
        <div>
          <p className="font-bold text-sm" style={{ color: '#254A96' }}>🗺️ Previsualización de rutas</p>
          <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
            {totalConCoords} paradas con ubicación · líneas de puntos = ruta en orden de entrega
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 flex-1 justify-center">
          {colsConPedidos.map((col, idx) => (
            <div key={col.camion.codigo} className="flex items-center gap-1.5">
              <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: TRUCK_COLORS[idx % TRUCK_COLORS.length] }} />
              <span className="text-xs font-semibold" style={{ color: '#1a1a1a' }}>{col.camion.codigo}</span>
              <span className="text-xs" style={{ color: '#B9BBB7' }}>
                ({col.pedidos.filter(p => p.latitud && p.longitud).length} ubic. / {col.pedidos.length} ped.)
              </span>
            </div>
          ))}
          {sinAsignarConCoords.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: '#9ca3af' }} />
              <span className="text-xs font-semibold" style={{ color: '#1a1a1a' }}>Sin asignar</span>
              <span className="text-xs" style={{ color: '#B9BBB7' }}>({sinAsignarConCoords.length})</span>
            </div>
          )}
        </div>
        <button onClick={onClose} className="text-2xl leading-none px-2 shrink-0" style={{ color: '#B9BBB7' }}>×</button>
      </div>
      <div ref={mapRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  )
}

export default function ProgramacionPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} /></div>}>
      <ProgramacionInner />
    </Suspense>
  )
}