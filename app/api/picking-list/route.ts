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

// Clave para comparar nombres: sin acentos, minúsculas y solo letras y números
function claveNombre(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function toTitleCase(s: string): string {
  return s.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase())
}


// SDs importadas del Excel del ERP (Abastecimiento -> Importar -> Solicitudes de despacho) que todavia no
// tienen pedido cargado en Omega. Se suman a la lista de preparacion para que el deposito vea todo lo que sale.
async function sdsDelErp(admin: ReturnType<typeof getAdmin>, desde: string, hasta: string, sucursal: string | null) {
  const vacio = { items: [] as { nombre: string; cantidad: number; unidad: string; codigo_material: string | null }[], sds: [] as { id: number; nv: string; cliente: string; direccion: string; sucursal: string; fecha_entrega: string }[] }
  try {
    let sols: any[] = []
    for (let from = 0; ; from += 1000) {
      let q = admin.from('solicitudes_importadas').select('id, id_venta, cliente, direccion, sucursal, fecha_despacho, estado')
        .gte('fecha_despacho', desde).lte('fecha_despacho', hasta).order('id').range(from, from + 999)
      if (sucursal) q = q.eq('sucursal', sucursal)
      const { data } = await q
      sols = sols.concat(data ?? [])
      if (!data || data.length < 1000) break
    }
    sols = sols.filter(s => !/cancel|anulad|rechazad|deliver|entregad/i.test(String(s.estado ?? '')))
    if (!sols.length) return vacio

    // Las que ya tienen pedido en Omega (por NV) no se repiten
    const nvs = [...new Set(sols.map(s => String(s.id_venta)).filter(n => n && n !== '0'))]
    const enOmega = new Set<string>()
    for (let i = 0; i < nvs.length; i += 500) {
      const { data } = await admin.from('pedidos').select('nv').in('nv', nvs.slice(i, i + 500))
      for (const p of data ?? []) enOmega.add(String(p.nv))
    }
    const faltan = sols.filter(s => !enOmega.has(String(s.id_venta)))
    if (!faltan.length) return vacio

    const ids = faltan.map(s => s.id)
    const items: typeof vacio.items = []
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await admin.from('solicitudes_importadas_items')
        .select('id_producto, nombre_producto, tipo, cantidad_solicitada, cantidad_entregada').in('id_solicitud', ids.slice(i, i + 500))
      for (const it of data ?? []) {
        const cant = Number(it.cantidad_solicitada ?? 0) - Number(it.cantidad_entregada ?? 0)
        const rawNombre = stripPrefix(String(it.nombre_producto ?? ''))
        if (cant <= 0 || !rawNombre || /addon/i.test(String(it.tipo ?? ''))) continue // los addons son servicios (transporte), no se preparan
        items.push({ nombre: toTitleCase(rawNombre), cantidad: cant, unidad: 'u', codigo_material: Number(it.id_producto) > 0 ? String(it.id_producto) : null })
      }
    }
    return {
      items,
      sds: faltan.map(s => ({ id: s.id, nv: String(s.id_venta ?? ''), cliente: s.cliente ?? '', direccion: s.direccion ?? '', sucursal: s.sucursal ?? '', fecha_entrega: s.fecha_despacho ?? '' })),
    }
  } catch { return vacio }
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

  // Catálogo de productos del ERP: su id es el código que se usa en Huemul.
  // Se busca por nombre normalizado; si hay varios con el mismo nombre se prefieren los activos
  // y, si siguen siendo varios, se muestran todos los códigos para no inventar uno.
  const catalogo = new Map<string, { id: number; activo: boolean }[]>()
  for (let from = 0; ; from += 1000) {
    const { data: lote } = await admin.from('productos_catalogo').select('id, nombre, activo').order('id').range(from, from + 999)
    for (const c of lote ?? []) {
      if (!c.nombre) continue
      const k = claveNombre(c.nombre)
      if (!catalogo.has(k)) catalogo.set(k, [])
      catalogo.get(k)!.push({ id: c.id, activo: c.activo !== false })
    }
    if (!lote || lote.length < 1000) break
  }
  const codigoDeCatalogo = (nombre: string): string | null => {
    const lista = catalogo.get(claveNombre(nombre))
    if (!lista?.length) return null
    const activos = lista.filter(x => x.activo)
    return (activos.length ? activos : lista).map(x => x.id).join(' / ')
  }

  const erp = await sdsDelErp(admin, fechaDesde, fechaHasta, sucursal)
  // Suma los items del ERP a la lista de totales (agrupa por nombre y unidad igual que los pedidos de Omega)
  const sumarErp = (totales: Record<string, { nombre: string; cantidad: number; unidad: string; codigo_material: string | null }>) => {
    for (const item of erp.items) {
      const key = `${item.nombre}|||${item.unidad}`
      if (!totales[key]) totales[key] = { nombre: item.nombre, cantidad: 0, unidad: item.unidad, codigo_material: item.codigo_material ?? codigoDeCatalogo(item.nombre) }
      totales[key].cantidad += item.cantidad
    }
  }

  if (!todos || todos.length === 0) {
    const soloErp: Record<string, { nombre: string; cantidad: number; unidad: string; codigo_material: string | null }> = {}
    sumarErp(soloErp)
    return NextResponse.json({
      productos: Object.values(soloErp).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      pedidos_count: 0, retiros: [], sds_erp: erp.sds,
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
      .select('pedido_id, nombre, cantidad, unidad, codigo_material, forma_hierro')
      .in('pedido_id', allIds.slice(i, i + BATCH))
    if (batch) allItems = allItems.concat(batch)
  }

  // Indexar items por pedido
  const itemsByPedido: Record<string, { nombre: string; cantidad: number; unidad: string; codigo_material: string | null }[]> = {}
  for (const item of allItems) {
    if (!itemsByPedido[item.pedido_id]) itemsByPedido[item.pedido_id] = []
    const rawNombre = stripPrefix(item.nombre ?? '')
    const formaTxt = item.forma_hierro === 'doblado' ? ' — DOBLADO' : item.forma_hierro === 'derecho' ? ' — DERECHO' : item.forma_hierro === 'indistinto' ? ' — INDISTINTO' : ''
    const nombre = toTitleCase(rawNombre) + formaTxt
    // Usar codigo_material si es numérico; si no, buscar el código ERP por nombre en el catálogo de productos
    const codigoNum = item.codigo_material && !isNaN(Number(item.codigo_material))
      ? item.codigo_material
      : codigoDeCatalogo(rawNombre)
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

  sumarErp(totales)

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
      id: ped.id,
      estado: ped.estado ?? '',
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
    sds_erp: erp.sds,
    fecha_desde: fechaDesde,
    fecha_hasta: fechaHasta,
    sucursal: sucursal ?? null,
  })
}
