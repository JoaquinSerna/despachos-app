import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// POST /api/ventas-erp  { nvs: string[] }
// Para cada NV devuelve sus solicitudes de despacho del Excel del ERP (Wemul): fecha y estado.
// El estado se traduce al vocabulario de pedidos: pending -> programado, sent -> en_camino, delivered -> entregado.
const ESTADO: Record<string, string> = { pending: 'programado', sent: 'en_camino', delivered: 'entregado' }

export async function POST(req: NextRequest) {
  const { nvs } = await req.json() as { nvs?: string[] }
  const ids = [...new Set((nvs ?? []).map(n => Number(n)).filter(n => Number.isInteger(n) && n > 0))]
  if (!ids.length) return NextResponse.json({})
  const admin = getAdmin()
  const por: Record<string, { fecha_entrega: string | null; estado: string; sd: number; cliente: string }[]> = {}
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await admin.from('solicitudes_importadas')
      .select('id, id_venta, fecha_despacho, estado, cliente').in('id_venta', ids.slice(i, i + 200))
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    for (const s of data ?? []) {
      (por[String(s.id_venta)] ??= []).push({ fecha_entrega: s.fecha_despacho, estado: ESTADO[String(s.estado)] ?? 'programado', sd: s.id, cliente: s.cliente ?? '' })
    }
  }
  return NextResponse.json(por)
}
