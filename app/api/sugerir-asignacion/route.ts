import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

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
  camion_id?: string | null
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

    // Construir el estado completo de cada camión DESPUÉS de aplicar la sugerencia del algoritmo
    const pedidosPorCamion: Record<string, PedidoInput[]> = {}
    camiones.forEach(c => { pedidosPorCamion[c.codigo] = [] })

    ya_asignados.forEach(p => {
      if (p.camion_id && pedidosPorCamion[p.camion_id]) {
        pedidosPorCamion[p.camion_id].push(p)
      }
    })
    pedidos.forEach(p => {
      const cam = sugerencia[p.id]
      if (cam && pedidosPorCamion[cam]) {
        pedidosPorCamion[cam].push(p)
      }
    })

    const sinAsignar = pedidos.filter(p => sugerencia[p.id] === null || sugerencia[p.id] === undefined)

    function descPedido(p: PedidoInput) {
      const loc = p.localidad ? `[${p.localidad}]` : ''
      return `NV${p.nv} | ${p.cliente} | "${p.direccion}" ${loc} | ${p.volumen_total_m3 ?? 0}pos ${p.peso_total_kg ?? 0}kg`
    }

    // Resumen de camiones con carga real post-sugerencia
    const camionesStr = camiones.map(c => {
      const ps = pedidosPorCamion[c.codigo]
      const kgUsado = ps.reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
      const posUsado = ps.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
      const listaStr = ps.length
        ? ps.map(p => `    - ${descPedido(p)}`).join('\n')
        : '    (vacío)'
      return `${c.codigo} [${c.tipo_unidad}, grua=${c.grua_hidraulica ? 'SÍ' : 'NO'}, volcador=${c.volcador ? 'SÍ' : 'NO'}] Máx:${c.tonelaje_max_kg}kg/${c.posiciones_total}pos — Libre:${c.tonelaje_max_kg - kgUsado}kg/${c.posiciones_total - posUsado}pos\n${listaStr}`
    }).join('\n\n')

    const sinAsignarStr = sinAsignar.length
      ? sinAsignar.map(p => `  - ${descPedido(p)}`).join('\n')
      : '  (ninguno)'

    // Pre-computar clusters geográficos entre todos los pedidos (sin asignar)
    // para mostrárselos explícitamente a la IA
    function computarClusters(ps: PedidoInput[]): PedidoInput[][] {
      const n = ps.length
      const parent = Array.from({ length: n }, (_, i) => i)
      function find(i: number): number { return parent[i] === i ? i : (parent[i] = find(parent[i])) }
      function union(i: number, j: number) { parent[find(i)] = find(j) }
      const normDir = (d: string) => d.toLowerCase().replace(/[.,\-#°]/g, ' ').replace(/\s+/g, ' ').trim()
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = ps[i], b = ps[j]
          if (a.direccion && b.direccion && normDir(a.direccion) === normDir(b.direccion)) { union(i, j); continue }
          if (a.cliente && b.cliente && a.cliente.toLowerCase().trim() === b.cliente.toLowerCase().trim()) { union(i, j); continue }
          if (a.latitud != null && a.longitud != null && b.latitud != null && b.longitud != null) {
            if (distKm(a.latitud, a.longitud, b.latitud, b.longitud) < 15) union(i, j)
          }
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
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Respuesta IA sin JSON', raw: text }, { status: 500 })
    }

    const result = JSON.parse(jsonMatch[0])

    // Validar que los cambios no desborden capacidad
    const asignacionFinal: Record<string, string | null> = { ...sugerencia }
    const cambiosValidos: typeof result.cambios = []

    if (result.asignacion && typeof result.asignacion === 'object') {
      // Recalcular carga con la propuesta de la IA
      const kgProp: Record<string, number> = {}
      const posProp: Record<string, number> = {}
      camiones.forEach(c => {
        kgProp[c.codigo] = ya_asignados
          .filter(p => p.camion_id === c.codigo)
          .reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
        posProp[c.codigo] = ya_asignados
          .filter(p => p.camion_id === c.codigo)
          .reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
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
        if ((kgProp[c.codigo] ?? 0) > c.tonelaje_max_kg || (posProp[c.codigo] ?? 0) > c.posiciones_total) {
          valido = false
          break
        }
      }

      if (valido) {
        Object.assign(asignacionFinal, result.asignacion)
        cambiosValidos.push(...(result.cambios ?? []))
      }
    }

    return NextResponse.json({ asignacion: asignacionFinal, cambios: cambiosValidos, tokens: response.usage })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
