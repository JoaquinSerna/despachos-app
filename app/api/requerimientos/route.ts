import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// GET /api/requerimientos?estado=&sucursal_origen=&sucursal_destino=&fecha_desde=&fecha_hasta=&tab=pendientes|transito|historial
export async function GET(req: NextRequest) {
  const admin = getAdmin()
  const { searchParams } = new URL(req.url)
  const tab = searchParams.get('tab') ?? 'pendientes'
  const sucursal_origen = searchParams.get('sucursal_origen') ?? ''
  const sucursal_destino = searchParams.get('sucursal_destino') ?? ''
  const fecha_desde = searchParams.get('fecha_desde') ?? ''
  const fecha_hasta = searchParams.get('fecha_hasta') ?? ''

  let query = admin
    .from('requerimientos')
    .select('*, requerimiento_items(*)')
    .order('created_at', { ascending: false })

  if (tab === 'pendientes') {
    query = query.in('estado', ['pendiente', 'conf_stock', 'preparacion'])
  } else if (tab === 'transito') {
    query = query.eq('estado', 'en_transito')
  } else {
    // historial
    query = query.in('estado', ['entregado', 'rechazado'])
  }

  if (sucursal_origen) query = query.eq('sucursal_origen', sucursal_origen)
  if (sucursal_destino) query = query.eq('sucursal_destino', sucursal_destino)
  if (fecha_desde) query = query.gte('fecha_solicitada', fecha_desde)
  if (fecha_hasta) query = query.lte('fecha_solicitada', fecha_hasta)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data ?? [])
}

// Clave para comparar nombres de producto: sin número de línea, acentos ni signos
const claveNombre = (n: string) => (n ?? '').replace(/^\s*\d+\s*[.)-]\s*/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

type ItemNuevo = { id_producto?: number | null; nombre_producto: string; cantidad_solicitada: number; [k: string]: any }

// Una transferencia que tiene una venta (NV) asignada se aprueba sola por la cantidad que esa venta necesita
// (menos lo que ya se pidió por transferencia para la misma NV). Lo que se pidió de más queda pendiente de aprobar.
async function repartirSegunVenta(admin: ReturnType<typeof getAdmin>, nv: string, items: ItemNuevo[]) {
  const { data: pedidos } = await admin.from('pedidos').select('id').eq('nv', nv).neq('estado', 'cancelado').neq('estado', 'rechazado')
  const ids = (pedidos ?? []).map((p: any) => p.id)
  if (!ids.length) return null

  const { data: itemsVenta } = await admin.from('pedido_items').select('nombre, cantidad, codigo_material').in('pedido_id', ids)
  if (!itemsVenta?.length) return null

  const { data: previos } = await admin.from('requerimientos')
    .select('requerimiento_items(id_producto, nombre_producto, cantidad_solicitada, cantidad_aprobada)')
    .eq('nv', nv).neq('estado', 'rechazado')

  const mismoProducto = (it: { id_producto?: number | null; nombre_producto?: string | null }, venta: any) => {
    if (it.id_producto && venta.codigo_material && String(it.id_producto) === String(venta.codigo_material)) return true
    return !!it.nombre_producto && claveNombre(it.nombre_producto) === claveNombre(venta.nombre ?? venta.nombre_producto ?? '')
  }

  const auto: ItemNuevo[] = []
  const extra: ItemNuevo[] = []
  for (const it of items) {
    const pedido = (itemsVenta as any[]).filter(v => mismoProducto(it, v)).reduce((sum, v) => sum + (Number(v.cantidad) || 0), 0)
    const yaPedido = (previos ?? []).flatMap((r: any) => r.requerimiento_items ?? [])
      .filter((x: any) => mismoProducto(it, { codigo_material: x.id_producto, nombre: x.nombre_producto }))
      .reduce((sum: number, x: any) => sum + (Number(x.cantidad_aprobada ?? x.cantidad_solicitada) || 0), 0)
    const cant = Number(it.cantidad_solicitada) || 0
    const aprobable = Math.min(cant, Math.max(0, pedido - yaPedido))
    if (aprobable > 0) auto.push({ ...it, cantidad_solicitada: aprobable })
    if (cant - aprobable > 0) extra.push({ ...it, cantidad_solicitada: cant - aprobable })
  }
  return { auto, extra }
}

async function crearRequerimiento(admin: ReturnType<typeof getAdmin>, reqData: any, items: any[]) {
  const { data: req_, error: reqErr } = await admin.from('requerimientos').insert(reqData).select().single()
  if (reqErr) return { error: reqErr.message as string }
  if (items.length > 0) {
    const { error: itemsErr } = await admin.from('requerimiento_items').insert(items.map(it => ({ ...it, requerimiento_id: req_.id })))
    if (itemsErr) return { error: itemsErr.message as string }
  }
  return { id: req_.id as string }
}

// POST /api/requerimientos — crear nuevo requerimiento con sus items
export async function POST(req: NextRequest) {
  const admin = getAdmin()
  const body = await req.json()
  const { items, ...reqData } = body

  // Con una venta asignada: se aprueba sola por lo que la venta necesita y lo extra queda pendiente
  const conVenta = !!reqData.nv && String(reqData.nv).trim() !== '' && (reqData.estado ?? 'pendiente') === 'pendiente' && Array.isArray(items) && items.length > 0
  if (conVenta) {
    let reparto: Awaited<ReturnType<typeof repartirSegunVenta>> = null
    try { reparto = await repartirSegunVenta(admin, String(reqData.nv).trim(), items) } catch { reparto = null }
    if (reparto && reparto.auto.length > 0) {
      const notaBase = reqData.notas ? `${reqData.notas}\n` : ''
      const aprobada = await crearRequerimiento(admin, {
        ...reqData, estado: 'conf_stock',
        notas: `${notaBase}✅ Aprobada automáticamente: tiene la venta NV ${reqData.nv} asignada.`,
      }, reparto.auto.map(it => ({ ...it, cantidad_aprobada: it.cantidad_solicitada })))
      if (aprobada.error) return NextResponse.json({ error: aprobada.error }, { status: 500 })

      let idExtra: string | null = null
      if (reparto.extra.length > 0) {
        // La cantidad de más no corresponde a la venta: va como solicitud aparte, pendiente de aprobar
        const extra = await crearRequerimiento(admin, {
          ...reqData, nv: null, cliente: null, estado: 'pendiente',
          notas: `${notaBase}Cantidad pedida de más sobre la venta NV ${reqData.nv}: queda pendiente de aprobar.`,
        }, reparto.extra)
        if (extra.error) return NextResponse.json({ error: `La transferencia se aprobó, pero no se pudo crear la parte extra: ${extra.error}`, id: aprobada.id }, { status: 500 })
        idExtra = extra.id ?? null
      }

      // Peso y posiciones de lo aprobado (igual que cuando se aprueba a mano)
      try {
        await fetch(new URL('/api/recalcular-posiciones', req.url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requerimiento_id: aprobada.id }),
        })
      } catch { /* no bloquea la creación */ }

      return NextResponse.json({ success: true, id: aprobada.id, aprobada_automaticamente: true, id_extra: idExtra })
    }
  }

  const creada = await crearRequerimiento(admin, reqData, Array.isArray(items) ? items : [])
  if (creada.error) return NextResponse.json({ error: creada.error }, { status: 500 })
  return NextResponse.json({ success: true, id: creada.id })
}

// PATCH /api/requerimientos — actualizar estado u otros campos
export async function PATCH(req: NextRequest) {
  const admin = getAdmin()
  const body = await req.json()
  const { id, items_update, ...updates } = body

  if (!id) return NextResponse.json({ error: 'Falta id' }, { status: 400 })

  const { error } = await admin.from('requerimientos').update(updates).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Actualizar cantidades aprobadas de items si se enviaron
  if (items_update?.length > 0) {
    for (const item of items_update) {
      const { id: itemId, cantidad_aprobada, notas } = item
      await admin.from('requerimiento_items')
        .update({ cantidad_aprobada, notas })
        .eq('id', itemId)
    }
  }

  return NextResponse.json({ success: true })
}
