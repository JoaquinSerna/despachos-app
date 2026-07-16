import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(request: NextRequest) {
  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY!
    })

    const formData = await request.formData()
    const file = formData.get('pdf') as File

    if (!file) {
      return NextResponse.json({ error: 'No se recibió ningún archivo' }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const base64 = Buffer.from(bytes).toString('base64')

    const esImagen = file.type.startsWith('image/')
    const mediaType = esImagen ? (file.type as 'image/jpeg' | 'image/png' | 'image/webp') : 'application/pdf'

    const archivoContent: any = esImagen
      ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            archivoContent,
            {
              type: 'text',
              text: `Primero verificá si este documento es una Solicitud de Despacho oficial de Construyo al Costo.
Para ser válido debe contener el encabezado "Solicitud de Despacho Pendiente #[número]" y el logo o nombre "Construyo al Costo".

Si NO es una Solicitud de Despacho de Construyo al Costo, devolvé SOLO este JSON:
{"documento_valido": false}

Si SÍ es válido, extraé los datos y devolvé SOLO este JSON (sin texto adicional ni markdown):
{
  "documento_valido": true,
  "nv": "número del Presupuesto 2 asociado sin el # (ej: 35390)",
  "id_despacho": "número de la Solicitud de Despacho sin el # (ej: 29639)",
  "cliente": "nombre del cliente",
  "telefono": "teléfono del contacto de obra o string vacío",
  "direccion": "dirección de entrega completa",
  "deposito": "nombre del depósito de salida (ej: CAC LA PLATA 520, CAC GUERNICA, CAC CAÑUELAS, CAC COSTA ATLANTICA)",
  "sucursal_obra": "sucursal de la obra exactamente como figura en el PDF (ej: Pinamar, La Plata, Guernica, Cañuelas)",
  "latitud": -37.254967,
  "longitud": -56.984971,
  "productos": [
    {"descripcion": "nombre del producto sin prefijos numéricos (ej: si dice '1.Arena en bolson' devolvé 'Arena en bolson')", "cantidad": 10}
  ]
}
No incluyas productos cuya descripción contenga "Transporte" ni "Pallet". Solo el JSON, sin markdown.`
            }
          ]
        }
      ]
    })

    const texto = response.content[0].type === 'text' ? response.content[0].text : ''
    const limpio = texto.replace(/```json|```/g, '').trim()
    const datos = JSON.parse(limpio)

    if (datos.documento_valido === false) {
      return NextResponse.json({
        success: false,
        error: 'El documento no es una Solicitud de Despacho de Construyo al Costo. Solo se aceptan SDs generadas por el sistema.'
      }, { status: 422 })
    }

    if (Array.isArray(datos.productos)) {
      datos.productos = datos.productos.map((p: any) => ({ ...p, descripcion: typeof p.descripcion === 'string' ? p.descripcion.toUpperCase() : p.descripcion }))
    }

    return NextResponse.json({ success: true, datos })
  } catch (error: any) {
    console.error('Error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

}