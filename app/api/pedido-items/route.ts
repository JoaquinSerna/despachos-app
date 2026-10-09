import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// GET /api/pedido-items?ids=id1,id2,id3
export async function GET(req: NextRequest) {
  try {
    const ids = req.nextUrl.searchParams.get('ids')
    if (!ids) return NextResponse.json({ items: [] })

    const pedidoIds = ids.split(',').filter(Boolean)
    if (pedidoIds.length === 0) return NextResponse.json({ items: [] })

    const { data, error } = await getAdmin()
      .from('pedido_items')
      .select('pedido_id, nombre, cantidad, unidad, forma_hierro')
      .in('pedido_id', pedidoIds)

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ items: data ?? [] })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
