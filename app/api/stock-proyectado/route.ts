import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface ComprometidoRow {
  id_producto: number
  sucursal: string
  comprometido: number
}

// GET /api/stock-proyectado
// Devuelve la cantidad comprometida en pedidos activos por id_producto y sucursal
// Stock proyectado = stock_actual - comprometido
export async function GET() {
  const admin = getAdmin()
  const today = new Date().toISOString().split('T')[0]

  // 1. Pedidos activos con su sucursal
  const { data: pedidos, error: ePedidos } = await admin
    .from('pedidos')
    .select('id, sucursal')
    .in('estado', ['pendiente', 'conf_stock', 'programado'])
    .gte('fecha_entrega', today)

  if (ePedidos) return NextResponse.json({ error: ePedidos.message }, { status: 500 })
  if (!pedidos || pedidos.length === 0) return NextResponse.json([])

  const pedidoIds = pedidos.map((p: any) => p.id)
  const pedidoSucursal: Record<number, string> = {}
  for (const p of pedidos as any[]) pedidoSucursal[p.id] = p.sucursal

  // 2. Items de esos pedidos
  const { data: items, error: eItems } = await admin
    .from('pedido_items')
    .select('pedido_id, nombre, cantidad')
    .in('pedido_id', pedidoIds)

  if (eItems) return NextResponse.json({ error: eItems.message }, { status: 500 })
  if (!items || items.length === 0) return NextResponse.json([])

  // 3. Aliases (descripcion_pdf → material_id)
  const { data: aliases, error: eAliases } = await admin
    .from('aliases')
    .select('descripcion_pdf, material_id')
    .eq('resuelto', true)

  if (eAliases) return NextResponse.json({ error: eAliases.message }, { status: 500 })

  const aliasMap = new Map<string, number>()
  for (const a of (aliases ?? []) as any[]) {
    aliasMap.set(a.descripcion_pdf, a.material_id)
  }

  // 4. Agregar comprometido por (id_producto, sucursal)
  const comprometidoMap = new Map<string, number>()
  for (const item of (items ?? []) as any[]) {
    const materialId = aliasMap.get(item.nombre)
    if (!materialId) continue
    const sucursal = pedidoSucursal[item.pedido_id]
    if (!sucursal) continue
    const key = `${materialId}|${sucursal}`
    comprometidoMap.set(key, (comprometidoMap.get(key) ?? 0) + Number(item.cantidad))
  }

  const result: ComprometidoRow[] = []
  for (const [key, comprometido] of comprometidoMap) {
    const [idStr, sucursal] = key.split('|')
    result.push({ id_producto: parseInt(idStr), sucursal, comprometido })
  }

  return NextResponse.json(result)
}
