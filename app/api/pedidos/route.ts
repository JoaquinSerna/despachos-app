import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function logAuditAPI(usuarioId: string, usuarioNombre: string, accion: string, modulo: string, detalle?: Record<string, any>) {
  try {
    await getAdmin().from('auditoria').insert({ usuario_id: usuarioId, usuario_nombre: usuarioNombre, accion, modulo, detalle: detalle ?? null })
  } catch (e) { console.error('Error de auditoría API:', e) }
}

// PATCH - actualizar campos de un pedido (reprogramar, cambiar vuelta, etc.)
// Con _bulk_camion=true: actualiza todos los pedidos de un camión en una fecha
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const { id, _bulk_camion, _usuario_id, _usuario_nombre, ...rest } = body
    const uId = _usuario_id ?? ''
    const uNombre = _usuario_nombre ?? ''

    if (_bulk_camion) {
      // Actualizar pedidos programados de un camión en una fecha, filtrado por vuelta
      const { camion_id, fecha_entrega, ...updates } = rest
      if (!camion_id || !fecha_entrega) return NextResponse.json({ error: 'Falta camion_id o fecha_entrega' }, { status: 400 })
      const { vuelta, ...restUpdates } = updates
      const admin = getAdmin()
      let error: any
      let pedidosCount = 0
      if (vuelta != null) {
        // Con filtro de vuelta
        const { data: peds } = await admin.from('pedidos').select('id', { count: 'exact' }).eq('camion_id', camion_id).eq('fecha_entrega', fecha_entrega).eq('estado', 'programado').eq('vuelta', Number(vuelta))
        pedidosCount = peds?.length ?? 0
        const res = await admin.from('pedidos').update(restUpdates)
          .eq('camion_id', camion_id)
          .eq('fecha_entrega', fecha_entrega)
          .eq('estado', 'programado')
          .eq('vuelta', Number(vuelta))
        error = res.error
      } else {
        // Sin filtro de vuelta (retrocompatibilidad)
        const { data: peds } = await admin.from('pedidos').select('id').eq('camion_id', camion_id).eq('fecha_entrega', fecha_entrega).eq('estado', 'programado')
        pedidosCount = peds?.length ?? 0
        const res = await admin.from('pedidos').update(restUpdates)
          .eq('camion_id', camion_id)
          .eq('fecha_entrega', fecha_entrega)
          .eq('estado', 'programado')
        error = res.error
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      if (uId) logAuditAPI(uId, uNombre, 'Asignación masiva de camión', 'Pedidos API', { camion_id, pedidos_count: pedidosCount })
      return NextResponse.json({ success: true })
    }

    if (!id) return NextResponse.json({ error: 'Falta el id del pedido' }, { status: 400 })
    const { error } = await getAdmin().from('pedidos').update(rest).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    if (uId) logAuditAPI(uId, uNombre, 'Actualizó pedido', 'Pedidos API', { id, campos_actualizados: Object.keys(rest) })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// POST - insertar uno o varios pedidos (bulk)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { pedidos, _usuario_id, _usuario_nombre } = body
    const uId = _usuario_id ?? ''
    const uNombre = _usuario_nombre ?? ''
    if (!Array.isArray(pedidos) || pedidos.length === 0) {
      return NextResponse.json({ error: 'Se requiere un array de pedidos' }, { status: 400 })
    }

    const admin = getAdmin()
    const resultados: any[] = []
    const errores: any[] = []
    let items_ok = 0
    let items_error_msg = ''

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
            nombre: item.descripcion ?? item.nombre ?? '',
            cantidad: item.cantidad ?? 1,
            unidad: item.unidad ?? 'u',
          }))
        )
        if (itemsError) {
          items_error_msg = itemsError.message
          errores.push({ id_despacho: pedidoData.id_despacho, error: `items: ${itemsError.message}` })
        } else {
          items_ok++
        }
      }

      resultados.push({ id_despacho: pedidoData.id_despacho, id: data.id })
    }

    if (uId && resultados.length > 0) {
      const sucursal = pedidos[0]?.sucursal ?? ''
      const fecha = pedidos[0]?.fecha_entrega ?? ''
      logAuditAPI(uId, uNombre, 'Cargó pedidos masivo', 'Pedidos API', { cantidad: resultados.length, sucursal, fecha })
    }
    return NextResponse.json({
      success: true,
      insertados: resultados.length,
      items_ok,
      items_error_msg: items_error_msg || null,
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
    const body = await req.json()
    const { id, _usuario_id, _usuario_nombre } = body
    const uId = _usuario_id ?? ''
    const uNombre = _usuario_nombre ?? ''
    if (!id) return NextResponse.json({ error: 'Falta el id del pedido' }, { status: 400 })

    const { error } = await getAdmin().from('pedidos').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    if (uId) logAuditAPI(uId, uNombre, 'Eliminó pedido', 'Pedidos API', { id })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
