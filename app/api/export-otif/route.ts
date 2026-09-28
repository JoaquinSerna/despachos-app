import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { GoogleAuth } from 'google-auth-library'

export const maxDuration = 300

const SHEET_ID = '11_HUxnowXeXL8n3P9InenSOZMvj2l9uxzt0gUeJOSN4'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function getSheetsToken(): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON!
  const cleaned = raw.trim().replace(/^["']/, '').replace(/["']$/, '')
  const credentials = JSON.parse(cleaned)
  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  const token = await auth.getAccessToken()
  if (!token) throw new Error('No se pudo obtener token de Google Sheets')
  return token
}

async function sheetsRequest(token: string, method: string, path: string, body?: any) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Sheets API ${method} ${path}: ${res.status} ${err.slice(0, 200)}`)
  }
  return res.json()
}

// Convierte filas de objetos a array de arrays (valores en orden de headers)
function toRows(data: any[], headers: string[]): any[][] {
  return data.map(row => headers.map(h => {
    const v = row[h]
    if (v === null || v === undefined) return ''
    if (typeof v === 'object') return JSON.stringify(v)
    return v
  }))
}

async function upsertSheet(token: string, sheetTitle: string, headers: string[], rows: any[][]) {
  // Obtener info del spreadsheet para ver si la hoja ya existe
  const meta = await sheetsRequest(token, 'GET', '')
  const sheets = meta.sheets as any[]
  const existing = sheets.find((s: any) => s.properties.title === sheetTitle)

  if (!existing) {
    // Crear la hoja
    await sheetsRequest(token, 'POST', ':batchUpdate', {
      requests: [{ addSheet: { properties: { title: sheetTitle } } }],
    })
  } else {
    // Limpiar contenido existente
    await sheetsRequest(token, 'POST', '/values:batchClear', {
      ranges: [`${sheetTitle}!A1:ZZ`],
    })
  }

  // Escribir headers + datos
  const values = [headers, ...rows]
  await sheetsRequest(token, 'PUT',
    `/values/${encodeURIComponent(sheetTitle + '!A1')}?valueInputOption=RAW`,
    { values }
  )
}

export async function GET(req: NextRequest) {
  // Vercel envía Authorization: Bearer <CRON_SECRET> en crons
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const admin = getAdmin()
    const token = await getSheetsToken()

    // ── 1. PEDIDOS ────────────────────────────────────────────────────────────
    const { data: pedidos, error: ePedidos } = await admin
      .from('pedidos')
      .select('id, nv, cliente, direccion, sucursal, fecha_entrega, vuelta, estado, peso_total_kg, volumen_total_m3, requiere_volcador, created_at')
      .order('fecha_entrega', { ascending: false })
    if (ePedidos) throw new Error('pedidos: ' + ePedidos.message)

    const headersPedidos = ['id', 'nv', 'cliente', 'direccion', 'sucursal', 'fecha_entrega', 'vuelta', 'estado', 'peso_total_kg', 'volumen_total_m3', 'requiere_volcador', 'created_at']
    await upsertSheet(token, 'pedidos', headersPedidos, toRows(pedidos ?? [], headersPedidos))

    // ── 2. ENTREGA_DETALLE ────────────────────────────────────────────────────
    const { data: entregas, error: eEntregas } = await admin
      .from('entrega_detalle')
      .select('id, pedido_id, id_despacho, nv, nombre_item, cantidad_solicitada, cantidad_entregada, unidad, motivo, created_at')
      .order('created_at', { ascending: false })
    if (eEntregas) throw new Error('entrega_detalle: ' + eEntregas.message)

    const headersEntregas = ['id', 'pedido_id', 'id_despacho', 'nv', 'nombre_item', 'cantidad_solicitada', 'cantidad_entregada', 'unidad', 'motivo', 'created_at']
    await upsertSheet(token, 'entrega_detalle', headersEntregas, toRows(entregas ?? [], headersEntregas))

    // ── 3. REPROGRAMACIONES ───────────────────────────────────────────────────
    const { data: repros, error: eRepros } = await admin
      .from('reprogramaciones')
      .select('id, pedido_id, nv, fecha_from, fecha_to, vuelta_from, vuelta_to, motivo, adelanta, delta_dias, reprogramado_at, created_at')
      .order('created_at', { ascending: false })
    if (eRepros) throw new Error('reprogramaciones: ' + eRepros.message)

    const headersRepros = ['id', 'pedido_id', 'nv', 'fecha_from', 'fecha_to', 'vuelta_from', 'vuelta_to', 'motivo', 'adelanta', 'delta_dias', 'reprogramado_at', 'created_at']
    await upsertSheet(token, 'reprogramaciones', headersRepros, toRows(repros ?? [], headersRepros))

    // ── 4. Hoja de control ────────────────────────────────────────────────────
    const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
    await upsertSheet(token, 'ultimo_export', ['campo', 'valor'], [
      ['fecha_export', ahora],
      ['pedidos', String(pedidos?.length ?? 0)],
      ['entrega_detalle', String(entregas?.length ?? 0)],
      ['reprogramaciones', String(repros?.length ?? 0)],
    ])

    return NextResponse.json({
      ok: true,
      exportado: ahora,
      pedidos: pedidos?.length,
      entregas: entregas?.length,
      reprogramaciones: repros?.length,
    })
  } catch (e: any) {
    console.error('[export-otif]', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
