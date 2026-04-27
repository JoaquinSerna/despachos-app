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

function esGranel(nombre: string): boolean {
  return nombre.toLowerCase().includes('granel')
}

async function calcularPesoItems(admin: ReturnType<typeof getAdmin>, items: { nombre: string; cantidad: number }[]) {
  const { data: mats } = await admin.from('materiales').select('nombre, cant_x_unid_log, posiciones_x_unid_log, peso_kg_x_posicion, unidad_base')
  if (!mats) return { peso: 0, posiciones: 0 }
  let peso = 0, posiciones = 0
  for (const item of items) {
    const n = item.nombre.toLowerCase().replace(/\s+/g, ' ').trim()
    // Preferir el match más específico (nombre más largo)
    const candidatos = mats.filter((m: any) => {
      const mn = m.nombre.toLowerCase().replace(/\s+/g, ' ').trim()
      return mn === n || mn.includes(n) || n.includes(mn)
    }).sort((a: any, b: any) => b.nombre.length - a.nombre.length)
    const mat = candidatos[0]
    if (mat && mat.cant_x_unid_log > 0) {
      const pesoUnitario = mat.peso_kg_x_posicion / mat.cant_x_unid_log
      peso += item.cantidad * pesoUnitario
      const unidades = Math.ceil(item.cantidad / mat.cant_x_unid_log)
      posiciones += unidades * mat.posiciones_x_unid_log
    }
  }
  return { peso, posiciones }
}

// POST - separar un pedido en dos
// motivo: 'separar' (default) | 'stock'
// Si items_mantener está vacío (todo sin stock) → el pedido entero vuelve a pendiente sin crear uno nuevo
export async function POST(req: NextRequest) {
  try {
    const { pedido_id, items_nuevo, items_mantener, motivo, _usuario_id, _usuario_nombre } = await req.json()
    const uId = _usuario_id ?? ''
    const uNombre = _usuario_nombre ?? ''
    if (!pedido_id || !items_nuevo?.length) {
      return NextResponse.json({ error: 'Faltan datos: pedido_id, items_nuevo' }, { status: 400 })
    }

    const esStock = motivo === 'stock'
    const admin = getAdmin()

    // Obtener pedido original
    const { data: original, error: errOrig } = await admin.from('pedidos').select('*').eq('id', pedido_id).single()
    if (errOrig || !original) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Caso: todo sin stock → el pedido entero vuelve a pendiente
    if (!items_mantener?.length) {
      const nota = (original.notas ? original.notas + ' · ' : '') + '⚠ Sin stock — reprogramar'
      await admin.from('pedidos').update({
        estado: 'pendiente',
        camion_id: null,
        orden_entrega: null,
        notas: nota,
      }).eq('id', pedido_id)
      if (uId) logAuditAPI(uId, uNombre, 'Registró incidencia de stock', 'Programación', { pedido_id, items_sin_stock: items_nuevo })
      return NextResponse.json({ success: true, tipo: 'reprogramado_completo' })
    }

    // Caso normal: separar en dos pedidos
    const [totalesNuevo, totalesMantener] = await Promise.all([
      calcularPesoItems(admin, items_nuevo),
      calcularPesoItems(admin, items_mantener),
    ])

    const nuevoRequiereVolcador = items_nuevo.some((i: any) => esGranel(i.nombre))
    const mantenerRequiereVolcador = items_mantener.some((i: any) => esGranel(i.nombre))

    const notaNuevo = esStock
      ? (original.notas ? original.notas + ' · ' : '') + '⚠ Sin stock — reprogramar'
      : (original.notas ? original.notas + ' · ' : '') + 'Separado de solicitud original'

    const notaMantener = esStock
      ? (original.notas ? original.notas + ' · ' : '') + '⚠ Entrega parcial — falta stock en ítems separados'
      : original.notas

    // Crear nuevo pedido (los ítems sin stock / separados)
    const { id: _id, created_at: _ca, updated_at: _ua, camion_id: _cam, orden_entrega: _oe, ...baseData } = original
    const { data: nuevoPedido, error: errNuevo } = await admin.from('pedidos').insert({
      ...baseData,
      id_despacho: String(original.id_despacho) + 'B',
      camion_id: null,
      orden_entrega: null,
      estado: 'pendiente',
      peso_total_kg: totalesNuevo.peso || null,
      volumen_total_m3: totalesNuevo.posiciones || null,
      requiere_volcador: nuevoRequiereVolcador,
      notas: notaNuevo,
      pedido_grande: false,
    }).select('id').single()
    if (errNuevo) return NextResponse.json({ error: errNuevo.message }, { status: 400 })

    await admin.from('pedido_items').insert(
      items_nuevo.map((i: any) => ({ pedido_id: nuevoPedido.id, nombre: i.nombre, cantidad: i.cantidad, unidad: i.unidad ?? 'u' }))
    )

    // Actualizar pedido original con los ítems que sí van hoy
    await admin.from('pedido_items').delete().eq('pedido_id', pedido_id)
    await admin.from('pedido_items').insert(
      items_mantener.map((i: any) => ({ pedido_id, nombre: i.nombre, cantidad: i.cantidad, unidad: i.unidad ?? 'u' }))
    )
    await admin.from('pedidos').update({
      peso_total_kg: totalesMantener.peso || null,
      volumen_total_m3: totalesMantener.posiciones || null,
      requiere_volcador: mantenerRequiereVolcador,
      notas: notaMantener,
      pedido_grande: false,
    }).eq('id', pedido_id)

    if (uId) {
      if (esStock) {
        logAuditAPI(uId, uNombre, 'Registró incidencia de stock', 'Programación', { pedido_id, items_sin_stock: items_nuevo })
      } else {
        logAuditAPI(uId, uNombre, 'Separó pedido', 'Programación', { pedido_id, nv_original: original.nv, nv_nuevo: String(original.id_despacho) + 'B' })
      }
    }
    return NextResponse.json({ success: true, tipo: 'separado', nuevo_id: nuevoPedido.id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
