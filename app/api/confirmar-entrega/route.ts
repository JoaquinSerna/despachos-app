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
    const pedidoId = formData.get('pedido_id') as string
    const nota = formData.get('nota') as string
    const estado = (formData.get('estado') as string) || 'entregado'
    const motivoRechazo = formData.get('motivo_rechazo') as string | null

    if (!pedidoId) {
      return NextResponse.json({ error: 'Falta pedido_id' }, { status: 400 })
    }

    // Recopilar todas las fotos enviadas (foto_0, foto_1, ... + label_0, label_1, ...)
    const fotosSubidas: { url: string; label: string | null }[] = []
    let i = 0
    while (true) {
      const file = formData.get(`foto_${i}`) as File | null
      if (!file) break
      const label = (formData.get(`label_${i}`) as string) || null
      const ext = file.type === 'image/png' ? 'png' : 'jpg'
      const fileName = `entregas/${pedidoId}_${Date.now()}_${i}.${ext}`
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('solicitudes-despacho')
        .upload(fileName, file)
      if (!uploadError && uploadData?.path) {
        fotosSubidas.push({ url: uploadData.path, label })
      }
      i++
    }

    // Insertar en pedido_fotos
    if (fotosSubidas.length > 0) {
      await supabase.from('pedido_fotos').insert(
        fotosSubidas.map(f => ({ pedido_id: pedidoId, url: f.url, label: f.label }))
      )
    }

    // Actualizar estado del pedido
    const updates: Record<string, any> = { estado }
    if (estado === 'rechazado' && motivoRechazo) {
      // Guardar motivo de rechazo en notas (no existe columna separada)
      updates.notas = nota ? `${nota} | ✕ ${motivoRechazo}` : `✕ ${motivoRechazo}`
    } else if (nota) {
      updates.notas = nota
    }

    const { data: updated, error } = await supabase
      .from('pedidos')
      .update(updates)
      .eq('id', pedidoId)
      .select('id')

    if (error) {
      console.error('confirmar-entrega error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!updated || updated.length === 0) {
      return NextResponse.json({ error: `Pedido ${pedidoId} no encontrado o sin permiso` }, { status: 404 })
    }

    return NextResponse.json({ success: true, fotos: fotosSubidas.length })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
