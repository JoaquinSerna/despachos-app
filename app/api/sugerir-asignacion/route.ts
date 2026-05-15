import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

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

    // Resumen de camiones con carga real post-sugerencia
    const camionesStr = camiones.map(c => {
      const ps = pedidosPorCamion[c.codigo]
      const kgUsado = ps.reduce((s, p) => s + (p.peso_total_kg ?? 0), 0)
      const posUsado = ps.reduce((s, p) => s + (p.volumen_total_m3 ?? 0), 0)
      const listaStr = ps.length
        ? ps.map(p => `NV${p.nv}(${p.cliente.substring(0, 15)},${p.volumen_total_m3 ?? 0}pos,${p.peso_total_kg ?? 0}kg)`).join(' | ')
        : 'vacío'
      return `${c.codigo} [${c.tipo_unidad}, grua=${c.grua_hidraulica ? 'SÍ' : 'NO'}, volcador=${c.volcador ? 'SÍ' : 'NO'}]\n  Máx: ${c.tonelaje_max_kg}kg / ${c.posiciones_total}pos\n  Usado: ${kgUsado}kg / ${posUsado}pos\n  Libre: ${c.tonelaje_max_kg - kgUsado}kg / ${c.posiciones_total - posUsado}pos\n  Pedidos: ${listaStr}`
    }).join('\n\n')

    const sinAsignarStr = sinAsignar.length
      ? sinAsignar.map(p => `NV${p.nv}(${p.cliente},${p.volumen_total_m3 ?? 0}pos,${p.peso_total_kg ?? 0}kg)`).join(', ')
      : 'ninguno'

    const prompt = `Sos un asistente de logística para ${sucursal}, empresa de materiales de construcción en Argentina.

El algoritmo ya generó una asignación. Revisala y corregí SOLO los problemas claros de agrupación.

ESTADO DE CAMIONES (con la asignación actual del algoritmo):
${camionesStr}

SIN ASIGNAR: ${sinAsignarStr}

REGLAS ESTRICTAS que no podés violar:
- No superes el máximo de kg ni de posiciones de ningún camión
- Pedidos que requieren grua → solo camiones con grua=SÍ
- Pedidos que requieren volcador → solo camiones con volcador=SÍ

PROBLEMAS A CORREGIR (en orden de prioridad):
1. Mismo cliente + misma dirección en camiones distintos → unificar en un mismo camión
2. Pedidos del mismo cliente en camiones distintos → unificar si entra la capacidad
3. Pedidos a ciudades/zonas claramente cercanas (ej: ambos en Buenos Aires, ambos en Lanús) que están separados → agrupar si hay capacidad

IMPORTANTE: Solo hacé cambios si mejoran la agrupación Y la capacidad lo permite. Si para agrupar A con B necesitás mover C a otro lugar, hacelo, pero verificá que todo entre.

Respondé ÚNICAMENTE con JSON válido:
{
  "asignacion": { "<id_pedido>": "<codigo_camion_o_null>" },
  "cambios": [{ "nv": "<nv>", "de": "<camion_anterior_o_SIN_ASIGNAR>", "a": "<camion_nuevo_o_SIN_ASIGNAR>", "motivo": "<motivo>" }]
}

La "asignacion" debe incluir TODOS los pedidos de la lista, no solo los que cambiaste.`

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

      for (const [pedidoId, camCod] of Object.entries(result.asignacion)) {
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
