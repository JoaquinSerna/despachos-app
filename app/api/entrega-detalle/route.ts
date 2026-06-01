import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// POST /api/entrega-detalle
// Body: {
//   pedido_id: string,
//   id_despacho: string | null,
//   nv: string,
//   items: { nombre: string, cantidad_solicitada: number, cantidad_entregada: number, unidad: string }[]
// }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pedido_id, id_despacho, nv, items } = body

    if (!pedido_id) return NextResponse.json({ error: 'Falta pedido_id' }, { status: 400 })
    if (!Array.isArray(items) || items.length === 0) {
      // Sin items — se acepta silenciosamente (pedido sin detalle de productos)
      return NextResponse.json({ success: true, registros: 0 })
    }

    const records = items.map((item: any) => ({
      pedido_id,
      id_despacho: id_despacho ?? null,
      nv: nv ?? null,
      nombre_item: item.nombre,
      cantidad_solicitada: Number(item.cantidad_solicitada) || 0,
      cantidad_entregada: Number(item.cantidad_entregada) || 0,
      unidad: item.unidad ?? null,
    }))

    const { error } = await getAdmin().from('entrega_detalle').insert(records)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ success: true, registros: records.length })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET /api/entrega-detalle?pedido_id=X  →  devuelve el detalle de una entrega
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const pedido_id = searchParams.get('pedido_id')
  const nv = searchParams.get('nv')
  const id_despacho = searchParams.get('id_despacho')

  const admin = getAdmin()
  let q = admin.from('entrega_detalle').select('*').order('created_at', { ascending: false })

  if (pedido_id) q = q.eq('pedido_id', pedido_id)
  else if (nv) q = q.eq('nv', nv)
  else if (id_despacho) q = q.eq('id_despacho', id_despacho)
  else return NextResponse.json({ error: 'Falta parámetro de búsqueda' }, { status: 400 })

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}
