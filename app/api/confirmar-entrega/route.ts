import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Usar service role key para bypassear RLS
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
    const foto = formData.get('foto') as File | null

    if (!pedidoId) {
      return NextResponse.json({ error: 'Falta pedido_id' }, { status: 400 })
    }

    let foto_url = null

    if (foto) {
      const fileName = `entregas/${pedidoId}_${Date.now()}.jpg`
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('solicitudes-despacho')
        .upload(fileName, foto)

      if (!uploadError) {
        foto_url = uploadData?.path
      }
    }

    // Solo actualizar notas si el chofer escribió algo (no sobreescribir con null)
    const updates: Record<string, any> = { estado: 'entregado' }
    if (nota) updates.notas = nota

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

    return NextResponse.json({ success: true, foto_url })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}