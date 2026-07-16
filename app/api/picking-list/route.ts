import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function stripPrefix(nombre: string): string {
  return nombre.replace(/^\d+\./, '').trim()
}

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const fechaDesde = searchParams.get('fecha_desde') ?? searchParams.get('fecha')
  const fechaHasta = searchParams.get('fecha_hasta') ?? searchParams.get('fecha')
  const sucursal = searchParams.get('sucursal')

  if (!fechaDesde || !fechaHasta) return NextResponse.json({ error: 'Falta fecha' }, { status: 400 })

  const admin = getAdmin()

  // Traer pedidos normales (tipo != 'retiro') y retiros por separado
  let qBase = admin.from('pedidos')
    .select('id, nv, cliente, direccion, estado, camion_id, vuelta, sucursal, tipo, fecha_entrega')
    .gte('fecha_entrega', fechaDesde)
    .lte('fecha_entrega', fechaHasta)
    .neq('estado', 'cancelado')
    .neq('estado', 'rechazado')
  if (sucursal) qBase = qBase.eq('sucursal', sucursal)

  const { data: todos, error: pedErr } = await qBase
  if (pedErr) return NextResponse.json({ error: pedErr.message }, { status: 500 })
  if (!todos || todos.length === 0) {
    return NextResponse.json({
      productos: [], pedidos_count: 0, retiros: [],
      fecha_desde: fechaDesde, fecha_hasta: fechaHasta, sucursal: sucursal ?? null,
    })
  }

  const pedidosNormales = todos.filter(p => p.tipo !== 'retiro')
  const pedidosRetiro  = todos.filter(p => p.tipo === 'retiro')

  // Items de todos los pedidos
  const allIds = todos.map(p => p.id)
  let allItems: any[] = []
  const BATCH = 500
  for (let i = 0; i < allIds.length; i += BATCH) {
    const { data: batch } = await admin.from('pedido_items')
      .select('pedido_id, nombre, cantidad, unidad, codigo_material')
      .in('pedido_id', allIds.slice(i, i + BATCH))
    if (batch) allItems = allItems.concat(batch)
  }

  // Indexar items por pedido
  const itemsByPedido: Record<string, { nombre: string; cantidad: number; unidad: string; codigo_material: string | null }[]> = {}
  for (const item of allItems) {
    if (!itemsByPedido[item.pedido_id]) itemsByPedido[item.pedido_id] = []
    const nombre = toTitleCase(stripPrefix(item.nombre ?? ''))
    const codigoNum = item.codigo_material && !isNaN(Number(item.codigo_material)) ? item.codigo_material : null
    if (nombre) itemsByPedido[item.pedido_id].push({ nombre, cantidad: Number(item.cantidad) || 0, unidad: item.unidad ?? 'u', codigo_material: codigoNum })
  }

  // Agregar productos normales
  const totales: Record<string, { nombre: string; cantidad: number; unidad: string; codigo_material: string | null }> = {}
  for (const ped of pedidosNormales) {
    for (const item of itemsByPedido[ped.id] ?? []) {
      const key = `${item.nombre}|||${item.unidad}`
      if (!totales[key]) totales[key] = { nombre: item.nombre, cantidad: 0, unidad: item.unidad, codigo_material: item.codigo_material ?? null }
      totales[key].cantidad += item.cantidad
    }
  }

  const productos = Object.values(totales)
    .filter(p => p.nombre)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))

  // Retiros: cada pedido con sus items
  const retiros = pedidosRetiro.map(ped => ({
    id: ped.id,
    nv: ped.nv,
    cliente: ped.cliente ?? '',
    direccion: ped.direccion ?? '',
    sucursal: ped.sucursal ?? '',
    fecha_entrega: ped.fecha_entrega ?? '',
    items: itemsByPedido[ped.id] ?? [],
  }))

  // Desglose por pedido (para Excel)
  const pedidosDetalle = pedidosNormales
    .filter(ped => (itemsByPedido[ped.id] ?? []).length > 0)
    .map(ped => ({
      nv: ped.nv ?? '',
      cliente: ped.cliente ?? '',
      direccion: ped.direccion ?? '',
      sucursal: ped.sucursal ?? '',
      fecha_entrega: ped.fecha_entrega ?? '',
      camion_id: ped.camion_id ?? '',
      vuelta: ped.vuelta ?? 0,
      items: itemsByPedido[ped.id] ?? [],
    }))

  return NextResponse.json({
    productos,
    pedidos_count: pedidosNormales.length,
    pedidos_detalle: pedidosDetalle,
    retiros,
    fecha_desde: fechaDesde,
    fecha_hasta: fechaHasta,
    sucursal: sucursal ?? null,
  })
}
