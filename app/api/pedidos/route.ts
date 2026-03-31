import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// PATCH - actualizar campos de un pedido (reprogramar, cambiar vuelta, etc.)
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, ...updates } = body
    if (!id) return NextResponse.json({ error: 'Falta el id del pedido' }, { status: 400 })

    const { error } = await getAdmin().from('pedidos').update(updates).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// POST - insertar uno o varios pedidos (bulk)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pedidos } = body
    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      return NextResponse.json({ error: 'Se requiere un array de pedidos' }, { status: 400 })
    }

    const admin = getAdmin()
    const resultados: any[] = []
    const errores: any[] = []

    for (const pedido of pedidos) {
      const { items, ...pedidoData } = pedido

      // Skip duplicates
      const { data: existente } = await admin.from('pedidos')
        .select('id').eq('id_despacho', pedidoData.id_despacho).maybeSingle()
      if (existente) {
        errores.push({ id_despacho: pedidoData.id_despacho, error: 'Ya existe' })
        continue
      }

      const { data, error } = await admin.from('pedidos').insert(pedidoData).select('id').single()
      if (error) {
        errores.push({ id_despacho: pedidoData.id_despacho, error: error.message })
        continue
      }

      if (items?.length > 0 && data) {
        const { error: itemsError } = await admin.from('pedido_items').insert(
          items.map((item: any) => ({
            pedido_id: data.id,
            codigo_material: null,
            nombre: item.descripcion ?? item.nombre ?? '',
            cantidad: item.cantidad ?? 1,
            unidad: item.unidad ?? 'u',
          }))
        )
        if (itemsError) {
          errores.push({ id_despacho: pedidoData.id_despacho, error: `items: ${itemsError.message}` })
        }
      }

      resultados.push({ id_despacho: pedidoData.id_despacho, id: data.id })
    }

    return NextResponse.json({
      success: true,
      insertados: resultados.length,
      errores,
      resultados,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// DELETE - eliminar un pedido
export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'Falta el id del pedido' }, { status: 400 })

    const { error } = await getAdmin().from('pedidos').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
