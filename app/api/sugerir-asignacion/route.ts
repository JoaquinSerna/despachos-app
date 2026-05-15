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

    // Calcular capacidad usada incluyendo ya_asignados + sugerencia actual
    const kgUsados: Record<string, number> = {}
    const posUsados: Record<string, number> = {}
    camiones.forEach(c => { kgUsados[c.codigo] = 0; posUsados[c.codigo] = 0 })

    ya_asignados.forEach(p => {
      if (p.camion_id && kgUsados[p.camion_id] !== undefined) {
        kgUsados[p.camion_id] += p.peso_total_kg ?? 0
        posUsados[p.camion_id] += p.volumen_total_m3 ?? 0
      }
    })

    // Construir resumen legible para el prompt
    const camionesStr = camiones.map(c => {
      const kg = kgUsados[c.codigo] ?? 0
      const pos = posUsados[c.codigo] ?? 0
      return `${c.codigo} (${c.tipo_unidad}): cap ${c.tonelaje_max_kg}kg/${c.posiciones_total}pos, usado ${kg}kg/${pos}pos, grua=${c.grua_hidraulica}, volcador=${c.volcador}`
    }).join('\n')

    const pedidosStr = pedidos.map(p => {
      const camionSugerido = sugerencia[p.id] ?? 'SIN_ASIGNAR'
      const loc = p.localidad || ''
      const coords = p.latitud && p.longitud ? `(${p.latitud.toFixed(4)},${p.longitud.toFixed(4)})` : 'sin_coords'
      const items = (p.items ?? []).map(i => i.nombre).join(', ')
      return `ID:${p.id} NV:${p.nv} | ${p.cliente} | ${p.direccion}${loc ? ' [' + loc + ']' : ''} ${coords} | ${p.peso_total_kg ?? 0}kg ${p.volumen_total_m3 ?? 0}pos | items:${items || '-'} | sugerido:${camionSugerido}`
    }).join('\n')

    const prompt = `Sos un asistente de logística para una empresa de materiales de construcción en Argentina (sucursal ${sucursal}).

Un algoritmo ya hizo una asignación de pedidos a camiones. Revisá la asignación y corregí SOLO los casos claramente malos.

CAMIONES DISPONIBLES (con capacidad restante después de ya_asignados):
${camionesStr}

PEDIDOS A ASIGNAR (con asignación actual del algoritmo):
${pedidosStr}

REGLAS que debés respetar:
1. Mismo cliente + misma dirección → mismo camión (siempre)
2. Pedidos a la misma ciudad/zona geográfica → mismo camión cuando sea posible
3. No superar tonelaje_max_kg ni posiciones_total de ningún camión (sumá kg/pos de todos los pedidos asignados)
4. Si un pedido dice requiere_volcador=true → solo camiones con volcador=true
5. Materiales sueltos (arena, piedra, ladrillo, cemento, cal) necesitan grua=true para descarga. Hierro puro (barras/mallas) puede ir en camión sin grúa.
6. No asignés a SIN_ASIGNAR si hay camión con capacidad disponible

Respondé SOLO con JSON válido, sin texto adicional:
{
  "asignacion": { "<pedido_id>": "<camion_codigo o null>" },
  "cambios": [{ "nv": "<nv>", "de": "<camion_anterior>", "a": "<camion_nuevo>", "motivo": "<motivo breve>" }]
}

Si la asignación del algoritmo ya es correcta, devolvé la misma asignación con "cambios": [].`

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = (response.content[0] as { type: string; text: string }).text.trim()

    // Extraer JSON de la respuesta
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return NextResponse.json({ error: 'Respuesta IA no tiene JSON válido', raw: text }, { status: 500 })
    }

    const result = JSON.parse(jsonMatch[0])
    return NextResponse.json({ ...result, tokens: response.usage })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
