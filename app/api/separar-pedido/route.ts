import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function esGranel(nombre: string): boolean {
  return nombre.toLowerCase().includes('granel')
}

const MAX_BOLSAS_POR_PALLET = 60

async function calcularPesoItems(admin: ReturnType<typeof getAdmin>, items: { nombre: string; cantidad: number }[]) {
  const { data: mats } = await admin.from('materiales').select('nombre, cant_x_unid_log, posiciones_x_unid_log, peso_kg_x_posicion, unidad_base')
  if (!mats) return { peso: 0, posiciones: 0 }
  let peso = 0, posiciones = 0, totalBolsas = 0
  for (const item of items) {
    const n = item.nombre.toLowerCase().replace(/\s+/g, ' ').trim()
    const mat = mats.find((m: any) => {
      const mn = m.nombre.toLowerCase().replace(/\s+/g, ' ').trim()
      return mn === n || mn.includes(n) || n.includes(mn)
    })
    if (mat) {
      const pesoUnitario = mat.cant_x_unid_log > 0 ? mat.peso_kg_x_posicion / mat.cant_x_unid_log : 0
      peso += item.cantidad * pesoUnitario
      if (mat.unidad_base === 'bolsa') {
        totalBolsas += item.cantidad
      } else {
        const unidades = Math.ceil(item.cantidad / mat.cant_x_unid_log)
        posiciones += unidades * mat.posiciones_x_unid_log
      }
    }
  }
  posiciones += Math.ceil(totalBolsas / MAX_BOLSAS_POR_PALLET)
  return { peso, posiciones }
}

// POST - separar un pedido en dos
// motivo: 'separar' (default) | 'stock'
// Si items_mantener está vacío (todo sin stock) → el pedido entero vuelve a pendiente sin crear uno nuevo
export async function POST(req: NextRequest) {
  try {
    const { pedido_id, items_nuevo, items_mantener, motivo } = await req.json()
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
    }).eq('id', pedido_id)

    return NextResponse.json({ success: true, tipo: 'separado', nuevo_id: nuevoPedido.id })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
