import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const PROMPT = `Este PDF contiene múltiples Solicitudes de Despacho. Extraé TODAS las solicitudes y devolvé SOLO un JSON array válido sin texto adicional ni markdown.

Para cada solicitud extraé:
{
  "id_despacho": "número de la solicitud sin el # (ej: 30057)",
  "nv": "número del Presupuesto 2 asociado sin el # (ej: 30689)",
  "cliente": "nombre del cliente",
  "telefono": "teléfono del contacto de obra, o string vacío si dice Sin contacto o Sin especificar",
  "direccion": "dirección de entrega completa",
  "deposito": "nombre del depósito de salida (ej: CAC LA PLATA - DEPOSITO 520)",
  "sucursal_obra": "sucursal de la obra exactamente como figura en el PDF (ej: La Plata - 520, Guernica, Cañuelas, Pinamar)",
  "latitud": número o null,
  "longitud": número o null,
  "horario": "Mañana" o "Tarde",
  "prioridad_texto": "Normal" o "Alta" o "Urgente",
  "productos": [{"descripcion": "nombre exacto del producto", "cantidad": número}]
}

No incluyas en productos los que tengan "Transporte" en el nombre.
Devolvé SOLO el JSON array, sin markdown, sin texto adicional.`

async function llamarClaude(anthropic: Anthropic, base64: string, intento: number): Promise<any> {
  try {
    return await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })
  } catch (err: any) {
    const esOverloaded = err?.status === 529 || err?.error?.type === 'overloaded_error' || err?.message?.includes('overloaded')
    if (esOverloaded && intento < 4) {
      const espera = Math.pow(2, intento) * 3000 // 3s, 6s, 12s, 24s
      await new Promise(r => setTimeout(r, espera))
      return llamarClaude(anthropic, base64, intento + 1)
    }
    throw err
  }
}

export async function POST(request: NextRequest) {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const formData = await request.formData()
    const file = formData.get('pdf') as File
    if (!file) return NextResponse.json({ error: 'No se recibió ningún archivo' }, { status: 400 })

    const bytes = await file.arrayBuffer()
    const base64 = Buffer.from(bytes).toString('base64')

    const response = await llamarClaude(anthropic, base64, 0)

    const texto = response.content[0].type === 'text' ? response.content[0].text : ''
    const limpio = texto.replace(/```json\n?|```\n?/g, '').trim()
    const solicitudes = JSON.parse(limpio)

    return NextResponse.json({ success: true, solicitudes })
  } catch (error: any) {
    const esOverloaded = error?.status === 529 || error?.error?.type === 'overloaded_error' || error?.message?.includes('overloaded')
    const mensaje = esOverloaded
      ? 'Los servidores de IA están sobrecargados en este momento. Esperá unos segundos y volvé a intentar.'
      : error.message
    console.error('leer-masivo error:', error.message)
    return NextResponse.json({ error: mensaje }, { status: esOverloaded ? 503 : 500 })
  }
}
