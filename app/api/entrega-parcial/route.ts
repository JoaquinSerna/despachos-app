import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(request: NextRequest) {
  try {
    const admin = getAdmin()
    const formData = await request.formData()
    const pedidoId = formData.get('pedido_id') as string
    const itemsPendientesRaw = formData.get('items_pendientes') as string
    const nota = formData.get('nota') as string | null

    if (!pedidoId || !itemsPendientesRaw) {
      return NextResponse.json({ error: 'Faltan datos requeridos' }, { status: 400 })
    }

    const itemsPendientes = JSON.parse(itemsPendientesRaw) as { nombre: string; cantidad: number; unidad: string }[]

    // Fetch original pedido
    const { data: original, error: fetchErr } = await admin
      .from('pedidos')
      .select('*')
      .eq('id', pedidoId)
      .single()

    if (fetchErr || !original) {
      return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    }

    // Upload photos and link to original pedido
    const fotosSubidas: { url: string; label: string | null }[] = []
    let i = 0
    while (true) {
      const file = formData.get(`foto_${i}`) as File | null
      if (!file) break
      const label = (formData.get(`label_${i}`) as string) || null
      const ext = file.type === 'image/png' ? 'png' : 'jpg'
      const fileName = `entregas/${pedidoId}_parcial_${Date.now()}_${i}.${ext}`
      const { data: uploadData, error: uploadErr } = await admin.storage
        .from('solicitudes-despacho')
        .upload(fileName, file)
      if (!uploadErr && uploadData?.path) {
        fotosSubidas.push({ url: uploadData.path, label })
      }
      i++
    }

    if (fotosSubidas.length > 0) {
      await admin.from('pedido_fotos').insert(
        fotosSubidas.map(f => ({ pedido_id: pedidoId, url: f.url, label: f.label }))
      )
    }

    // Mark original as entregado_parcial
    const notaEntrega = nota ? `${nota} | 📦 Entrega parcial` : '📦 Entrega parcial'
    const notaFinal = original.notas ? `${original.notas} | ${notaEntrega}` : notaEntrega
    await admin.from('pedidos').update({
      estado: 'entregado_parcial',
      notas: notaFinal,
    }).eq('id', pedidoId)

    // Create saldo pedido with pending items
    let saldoId: string | null = null
    if (itemsPendientes.length > 0) {
      const { data: nuevoPedido, error: insertErr } = await admin
        .from('pedidos')
        .insert({
          nv: original.nv,
          id_despacho: original.id_despacho,
          cliente: original.cliente,
          direccion: original.direccion,
          sucursal: original.sucursal,
          fecha_entrega: original.fecha_entrega,
          vuelta: original.vuelta,
          estado: 'programado',
          camion_id: null,
          telefono: original.telefono,
          tipo: original.tipo,
          latitud: original.latitud,
          longitud: original.longitud,
          barrio_cerrado: original.barrio_cerrado,
          requiere_volcador: original.requiere_volcador,
          prioridad: true,
          notas: `📦 Saldo parcial — NV ${original.nv}`,
          estado_pago: original.estado_pago,
          volumen_total_m3: null,
          peso_total_kg: null,
          pedido_grande: false,
        })
        .select('id')
        .single()

      if (!insertErr && nuevoPedido) {
        saldoId = nuevoPedido.id
        await admin.from('pedido_items').insert(
          itemsPendientes.map(item => ({
            pedido_id: nuevoPedido.id,
            nombre: item.nombre,
            cantidad: item.cantidad,
            unidad: item.unidad,
          }))
        )
      }
    }

    return NextResponse.json({ success: true, saldo_id: saldoId, fotos: fotosSubidas.length })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
