import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { normalizarCuit, normalizarRemito } from '../../lib/compras-utils'

export const maxDuration = 30

// El número de remito es el dato crítico: se usa un modelo fuerte para fotos torcidas o con sombra.
const MODELO = 'claude-sonnet-5-5'
const ROLES_PERMITIDOS = ['gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador']

const PROMPT = `Esta es la foto de un REMITO que un proveedor entrega a Construyo al Costo (CAC).
Extraé SOLO los datos del encabezado y devolvé únicamente un JSON (sin texto adicional ni markdown):
{
  "numero_remito": "número del comprobante en formato 0001-00012345 (punto de venta de 4 o 5 dígitos, guión, número de 8 dígitos). Suele estar arriba a la derecha junto a 'Remito' o 'N°'. NO uses el CAI, el CPE/carta de porte, el número de pedido, la orden de compra ni códigos de cliente. null si no se lee con seguridad.",
  "cuit_emisor": "CUIT de quien EMITE el remito (el proveedor, en el encabezado), solo dígitos. NO el CUIT del destinatario/cliente (Construyo al Costo). null si no se lee.",
  "razon_social_emisor": "nombre o razón social de quien emite el remito, o null",
  "fecha": "fecha del remito en formato YYYY-MM-DD, o null",
  "orden_compra": "número de orden de compra del cliente SOLO si figura claramente indicado (campo 'OC', 'Orden de compra' o 'Pedido del cliente'); si no, null",
  "confianza": "alta, media o baja: qué tan seguro estás del número de remito"
}
Nunca inventes ni completes dígitos: si hay dudas sobre un dato, devolvé null para ese campo.`

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

const texto = (v: any): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export async function POST(req: NextRequest) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })
    const admin = getAdmin()
    const { data: { user }, error: authErr } = await admin.auth.getUser(token)
    if (authErr || !user) return NextResponse.json({ ok: false, error: 'Token inválido' }, { status: 401 })
    const { data: perfil } = await admin.from('usuarios').select('rol').eq('id', user.id).single()
    if (!ROLES_PERMITIDOS.includes(perfil?.rol ?? '')) {
      return NextResponse.json({ ok: false, error: 'Sin permiso' }, { status: 403 })
    }

    const file = (await req.formData()).get('file') as File | null
    if (!file || !file.type.startsWith('image/')) {
      return NextResponse.json({ ok: false, error: 'Falta la imagen' }, { status: 400 })
    }
    if (file.size > 8 * 1024 * 1024) {
      return NextResponse.json({ ok: false, error: 'La imagen es demasiado grande' }, { status: 413 })
    }
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    const mediaType = (['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp'

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const response = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })

    const crudo = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const json = JSON.parse(crudo.replace(/```json|```/g, '').trim())

    const numero = texto(json.numero_remito)
    const fecha = texto(json.fecha)
    const datos = {
      numero_remito: numero ? normalizarRemito(numero).valor : null,
      cuit_emisor: normalizarCuit(texto(json.cuit_emisor)),
      razon_social_emisor: texto(json.razon_social_emisor),
      fecha: fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null,
      orden_compra: texto(json.orden_compra),
      confianza: ['alta', 'media', 'baja'].includes(String(json.confianza)) ? String(json.confianza) : null,
    }
    return NextResponse.json({ ok: true, datos })
  } catch (e: any) {
    console.error('leer-remito error:', e?.message)
    return NextResponse.json({ ok: false, error: 'No se pudo leer el remito' }, { status: 500 })
  }
}
