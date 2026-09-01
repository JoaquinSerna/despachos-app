import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// PATCH - guarda km_ruta calculado por Valhalla, solo si el campo está vacío
// (no sobreescribe km reales ingresados manualmente)
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { camion_codigo, fecha, km_ruta } = body
    if (!camion_codigo || !fecha || km_ruta == null) {
      return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 })
    }

    const admin = getAdmin()

    // Verificar si ya tiene km_ruta → no sobreescribir
    const { data: current } = await admin
      .from('flota_dia')
      .select('km_ruta')
      .eq('camion_codigo', camion_codigo)
      .eq('fecha', fecha)
      .maybeSingle()

    if (!current) {
      return NextResponse.json({ skipped: 'no existe registro flota_dia para este camion/fecha' })
    }
    if (current.km_ruta !== null) {
      return NextResponse.json({ skipped: 'km_ruta ya tiene valor, se conserva el existente' })
    }

    const { error } = await admin
      .from('flota_dia')
      .update({ km_ruta })
      .eq('camion_codigo', camion_codigo)
      .eq('fecha', fecha)

    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ success: true, km_ruta })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
