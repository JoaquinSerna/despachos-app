import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const requerimientoId = formData.get('requerimiento_id') as string
    if (!requerimientoId) {
      return NextResponse.json({ error: 'Falta requerimiento_id' }, { status: 400 })
    }

    const fechaRecepcion = (formData.get('fecha_recepcion') as string) || new Date().toISOString().split('T')[0]
    const tipoEntrega   = (formData.get('tipo_entrega') as string) || 'completa'
    const notas         = formData.get('notas') as string | null
    const nViaje        = formData.get('n_viaje') as string | null
    const codVehiculo   = formData.get('cod_vehiculo') as string | null

    // Subir fotos al bucket solicitudes-despacho/requerimientos/
    const fotosSubidas: { url: string; label: string | null }[] = []
    let i = 0
    while (true) {
      const file = formData.get(`foto_${i}`) as File | null
      if (!file) break
      const label = (formData.get(`label_${i}`) as string) || null
      const ext = file.type === 'image/png' ? 'png' : 'jpg'
      const fileName = `requerimientos/${requerimientoId}_${Date.now()}_${i}.${ext}`
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('solicitudes-despacho')
        .upload(fileName, file)
      if (!uploadError && uploadData?.path) {
        fotosSubidas.push({ url: uploadData.path, label })
      }
      i++
    }

    if (fotosSubidas.length > 0) {
      await supabase.from('requerimiento_fotos').insert(
        fotosSubidas.map(f => ({ requerimiento_id: requerimientoId, url: f.url, label: f.label }))
      )
    }

    const updates: Record<string, any> = {
      estado: 'entregado',
      fecha_recepcion: fechaRecepcion,
      tipo_entrega: tipoEntrega,
    }
    if (nViaje) updates.n_viaje = nViaje
    if (codVehiculo) updates.cod_vehiculo = codVehiculo
    if (notas) updates.notas = notas

    const { data: updated, error } = await supabase
      .from('requerimientos')
      .update(updates)
      .eq('id', requerimientoId)
      .select('id')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: 'Requerimiento no encontrado' }, { status: 404 })
    }

    return NextResponse.json({ success: true, fotos: fotosSubidas.length })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
