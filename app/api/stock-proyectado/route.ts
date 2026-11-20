import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface ComprometidoRow {
  id_producto: number
  sucursal: string
  comprometido: number
}

// GET /api/stock-proyectado
// Cantidad comprometida por id_producto (ERP) y sucursal en las solicitudes de despacho pendientes
// del Excel del ERP (Wemul), de hoy en adelante. Stock proyectado = stock_actual - comprometido
export async function GET() {
  const admin = getAdmin()
  const hoy = new Date().toISOString().split('T')[0]

  const sucursalDe: Record<number, string> = {}
  const ids: number[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from('solicitudes_importadas').select('id, sucursal')
      .eq('estado', 'pending').gte('fecha_despacho', hoy).order('id').range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const s of data ?? []) { sucursalDe[s.id] = s.sucursal; ids.push(s.id) }
    if (!data || data.length < 1000) break
  }
  if (!ids.length) return NextResponse.json([])

  const mapa = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await admin.from('solicitudes_importadas_items')
      .select('id_solicitud, id_producto, tipo, cantidad_solicitada, cantidad_entregada').in('id_solicitud', ids.slice(i, i + 300))
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const it of data ?? []) {
      if (/addon/i.test(String(it.tipo ?? '')) || !(Number(it.id_producto) > 0)) continue
      const falta = Number(it.cantidad_solicitada ?? 0) - Number(it.cantidad_entregada ?? 0)
      const suc = sucursalDe[it.id_solicitud]
      if (falta <= 0 || !suc) continue
      const k = `${it.id_producto}|${suc}`
      mapa.set(k, (mapa.get(k) ?? 0) + falta)
    }
  }

  const result: ComprometidoRow[] = []
  for (const [k, comprometido] of mapa) {
    const [id, sucursal] = k.split('|')
    result.push({ id_producto: Number(id), sucursal, comprometido })
  }
  return NextResponse.json(result)
}
