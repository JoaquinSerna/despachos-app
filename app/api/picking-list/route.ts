import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const fecha = searchParams.get('fecha')
  const sucursal = searchParams.get('sucursal')

  if (!fecha) return NextResponse.json({ error: 'Falta fecha' }, { status: 400 })

  const admin = getAdmin()

  let q = admin.from('pedidos')
    .select('id, nv, cliente, estado, camion_id, vuelta, sucursal')
    .eq('fecha_entrega', fecha)
    .neq('estado', 'cancelado')
    .neq('estado', 'rechazado')
  if (sucursal) q = q.eq('sucursal', sucursal)

  const { data: pedidos, error: pedErr } = await q
  if (pedErr) return NextResponse.json({ error: pedErr.message }, { status: 500 })
  if (!pedidos || pedidos.length === 0) {
    return NextResponse.json({ productos: [], pedidos_count: 0, fecha, sucursal: sucursal ?? null })
  }

  const pedidoIds = pedidos.map(p => p.id)
  let allItems: any[] = []
  const BATCH = 500
  for (let i = 0; i < pedidoIds.length; i += BATCH) {
    const { data: batch } = await admin.from('pedido_items')
      .select('pedido_id, nombre, cantidad, unidad')
      .in('pedido_id', pedidoIds.slice(i, i + BATCH))
    if (batch) allItems = allItems.concat(batch)
  }

  // Agregar por producto — strip prefijo numérico tipo "1." o "2.CEMENTO..." que agrega la IA al leer PDFs
  function stripPrefix(nombre: string): string {
    return nombre.replace(/^\d+\./, '').trim()
  }

  const totales: Record<string, { nombre: string; cantidad: number; unidad: string }> = {}
  for (const item of allItems) {
    const nombre = stripPrefix(item.nombre ?? '')
    if (!nombre) continue
    const key = `${nombre}|||${item.unidad ?? 'u'}`
    if (!totales[key]) totales[key] = { nombre, cantidad: 0, unidad: item.unidad ?? 'u' }
    totales[key].cantidad += Number(item.cantidad) || 0
  }

  const productos = Object.values(totales)
    .filter(p => p.nombre)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))

  return NextResponse.json({ productos, pedidos_count: pedidos.length, fecha, sucursal: sucursal ?? null })
}
