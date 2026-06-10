import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function logAuditAPI(userId: string, userName: string, accion: string, detalle: Record<string, any>) {
  try {
    await getAdmin().from('auditoria').insert({ usuario_id: userId, usuario_nombre: userName, accion, modulo: 'Programación', detalle })
  } catch { /* silencioso */ }
}

async function calcularPesoItems(admin: ReturnType<typeof getAdmin>, items: { nombre: string; cantidad: number }[]) {
  const { data: mats } = await admin.from('materiales').select('nombre, cant_x_unid_log, posiciones_x_unid_log, peso_kg_x_posicion')
  if (!mats) return { peso: 0, posiciones: 0 }
  let peso = 0, posiciones = 0
  for (const item of items) {
    const n = item.nombre.toLowerCase().replace(/\s+/g, ' ').trim()
    const candidatos = mats.filter((m: any) => {
      const mn = m.nombre.toLowerCase().replace(/\s+/g, ' ').trim()
      return mn === n || mn.includes(n) || n.includes(mn)
    }).sort((a: any, b: any) => b.nombre.length - a.nombre.length)
    const mat = candidatos[0]
    if (mat && mat.cant_x_unid_log > 0) {
      peso += item.cantidad * (mat.peso_kg_x_posicion / mat.cant_x_unid_log)
      posiciones += Math.ceil(item.cantidad / mat.cant_x_unid_log) * mat.posiciones_x_unid_log
    }
  }
  return { peso: Math.round(peso), posiciones }
}

/**
 * POST /api/separar-pedido-granel
 * Divide un pedido de granel/volcador en N partes con cantidades iguales.
 * Cada parte queda como un pedido independiente (pendiente, sin camión).
 *
 * Body: {
 *   pedido_id: string,
 *   n_partes: number,        // 2..4
 *   _usuario_id?: string,
 *   _usuario_nombre?: string,
 * }
 *
 * Devuelve: { success: true, pedido_ids: string[] }
 *   pedido_ids[0] = ID del pedido original (actualizado con parte 1)
 *   pedido_ids[1..] = IDs de los pedidos nuevos (partes 2..N)
 */
export async function POST(req: NextRequest) {
  try {
    const { pedido_id, n_partes, _usuario_id: userId = '', _usuario_nombre: userName = '' } = await req.json()

    if (!pedido_id || !n_partes || n_partes < 2 || n_partes > 4) {
      return NextResponse.json({ error: 'Faltan datos o n_partes fuera de rango (2-4)' }, { status: 400 })
    }

    const admin = getAdmin()

    // Cargar pedido original
    const { data: original, error: errOrig } = await admin.from('pedidos').select('*').eq('id', pedido_id).single()
    if (errOrig || !original) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })

    // Cargar ítems originales
    const { data: itemsOrig } = await admin.from('pedido_items')
      .select('nombre, cantidad, unidad').eq('pedido_id', pedido_id)
    if (!itemsOrig?.length) return NextResponse.json({ error: 'El pedido no tiene ítems para separar' }, { status: 400 })

    // Sufijos para los despachos: original + "B", "C", "D"
    const sufijos = ['', 'B', 'C', 'D']

    // Construir ítems por parte — división entera (floor para las primeras N-1, resto para la última)
    const itemsPorParte: { nombre: string; cantidad: number; unidad: string }[][] = Array.from(
      { length: n_partes }, () => []
    )

    for (const item of itemsOrig) {
      const cantBase = Math.floor(item.cantidad / n_partes)
      const cantResto = item.cantidad - cantBase * (n_partes - 1)
      for (let i = 0; i < n_partes; i++) {
        const cant = i < n_partes - 1 ? cantBase : cantResto
        if (cant > 0) {
          itemsPorParte[i].push({ nombre: item.nombre, cantidad: cant, unidad: item.unidad ?? 'u' })
        }
      }
    }

    // Calcular peso/posiciones para cada parte
    const totalesPorParte = await Promise.all(
      itemsPorParte.map(items => calcularPesoItems(admin, items))
    )

    const pedidoIds: string[] = [pedido_id]
    const { id: _id, created_at: _ca, updated_at: _ua, camion_id: _cam, orden_entrega: _oe, ...baseData } = original

    // Crear pedidos para partes 2..N (nuevos)
    for (let i = 1; i < n_partes; i++) {
      const { data: nuevo, error: errNuevo } = await admin.from('pedidos').insert({
        ...baseData,
        id_despacho: String(original.id_despacho ?? '') + sufijos[i],
        camion_id: null,
        orden_entrega: null,
        estado: 'pendiente',
        peso_total_kg: totalesPorParte[i].peso || original.peso_total_kg / n_partes,
        volumen_total_m3: totalesPorParte[i].posiciones || null,
        requiere_volcador: true,
        pedido_grande: false,
        notas: (original.notas ? original.notas + ' · ' : '') + `Parte ${i + 1}/${n_partes} — separado de ${original.nv}`,
        grupo_confirmacion: null,
      }).select('id').single()
      if (errNuevo || !nuevo) return NextResponse.json({ error: errNuevo?.message ?? 'Error al crear pedido' }, { status: 500 })

      await admin.from('pedido_items').insert(
        itemsPorParte[i].map(it => ({ pedido_id: nuevo.id, ...it }))
      )
      pedidoIds.push(nuevo.id)
    }

    // Actualizar pedido original con parte 1
    await admin.from('pedido_items').delete().eq('pedido_id', pedido_id)
    await admin.from('pedido_items').insert(
      itemsPorParte[0].map(it => ({ pedido_id, ...it }))
    )
    await admin.from('pedidos').update({
      peso_total_kg: totalesPorParte[0].peso || original.peso_total_kg / n_partes,
      volumen_total_m3: totalesPorParte[0].posiciones || null,
      requiere_volcador: true,
      camion_id: null,
      orden_entrega: null,
      estado: 'pendiente',
      pedido_grande: false,
      notas: (original.notas ? original.notas + ' · ' : '') + `Parte 1/${n_partes} — separado`,
      grupo_confirmacion: null,
    }).eq('id', pedido_id)

    if (userId) {
      logAuditAPI(userId, userName, 'Separó pedido granel en partes', {
        pedido_original: pedido_id, nv: original.nv, n_partes,
        pedido_ids: pedidoIds,
        peso_original: original.peso_total_kg,
      })
    }

    return NextResponse.json({ success: true, pedido_ids: pedidoIds })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
