import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// GET /api/sd-decisiones?fecha=2026-05-20
// Devuelve todas las decisiones para una fecha de despacho
export async function GET(req: NextRequest) {
  const admin = getAdmin()
  const { searchParams } = new URL(req.url)
  const fecha = searchParams.get('fecha')

  let q = admin.from('sd_decisiones').select('*').order('id_solicitud')
  if (fecha) q = q.eq('fecha_sd', fecha)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

// POST /api/sd-decisiones
// Body: { decisions: [{ id_solicitud, id_producto?, tipo, sucursal_asignada, fecha_sd, operador? }] }
// Upsert: si ya existe la decisión para esa (solicitud, producto), la actualiza
export async function POST(req: NextRequest) {
  const admin = getAdmin()
  const { decisions } = await req.json()

  if (!Array.isArray(decisions) || decisions.length === 0) {
    return NextResponse.json({ error: 'decisions debe ser un array no vacío' }, { status: 400 })
  }

  const now = new Date().toISOString()
  let saved = 0
  let errors: string[] = []

  for (const dec of decisions) {
    if (!dec.id_solicitud || !dec.tipo) {
      errors.push(`Decisión inválida: ${JSON.stringify(dec)}`)
      continue
    }

    const row = {
      id_solicitud:      Number(dec.id_solicitud),
      id_producto:       dec.id_producto ? Number(dec.id_producto) : null,
      tipo:              dec.tipo,
      sucursal_asignada: dec.sucursal_asignada ?? '',
      fecha_sd:          dec.fecha_sd ?? null,
      operador:          dec.operador ?? null,
      updated_at:        now,
    }

    // Buscar si ya existe
    let existing: any = null
    if (row.id_producto !== null) {
      const { data } = await admin
        .from('sd_decisiones')
        .select('id')
        .eq('id_solicitud', row.id_solicitud)
        .eq('id_producto', row.id_producto)
        .maybeSingle()
      existing = data
    } else {
      const { data } = await admin
        .from('sd_decisiones')
        .select('id')
        .eq('id_solicitud', row.id_solicitud)
        .is('id_producto', null)
        .maybeSingle()
      existing = data
    }

    if (existing?.id) {
      const { error } = await admin.from('sd_decisiones').update(row).eq('id', existing.id)
      if (error) errors.push(error.message)
      else saved++
    } else {
      const { error } = await admin.from('sd_decisiones').insert(row)
      if (error) errors.push(error.message)
      else saved++
    }
  }

  if (errors.length > 0 && saved === 0) {
    return NextResponse.json({ error: errors[0] }, { status: 500 })
  }

  return NextResponse.json({ success: true, saved, errors: errors.length > 0 ? errors : undefined })
}

// DELETE /api/sd-decisiones?fecha=2026-05-20
// Borra todas las decisiones de una fecha (para resetear)
export async function DELETE(req: NextRequest) {
  const admin = getAdmin()
  const { searchParams } = new URL(req.url)
  const fecha = searchParams.get('fecha')

  if (!fecha) return NextResponse.json({ error: 'Falta parámetro fecha' }, { status: 400 })

  const { error } = await admin.from('sd_decisiones').delete().eq('fecha_sd', fecha)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
