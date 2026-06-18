import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

const DEPOSITOS: Record<string, { lat: number; lng: number }> = {
  'LP520':    { lat: -34.965403, lng: -58.06488 },
  'LP139':    { lat: -34.914872, lng: -58.023912 },
  'Guernica': { lat: -34.91118,  lng: -58.39945 },
  'Cañuelas': { lat: -35.0004012, lng: -58.7474278 },
  'Pinamar':  { lat: -37.207852, lng: -56.972302 },
}

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function calcularOrden(pedidos: any[], sucursal: string): Record<string, number> {
  const deposito = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }
  const conCoords = pedidos.filter(p => p.latitud && p.longitud)
  const sinCoords = pedidos.filter(p => !p.latitud || !p.longitud)

  if (conCoords.length === 0) {
    const r: Record<string, number> = {}
    sinCoords.forEach((p, i) => { r[p.id] = i + 1 })
    return r
  }

  // Nearest Neighbor
  const ordenados: any[] = []
  const restantes = [...conCoords]
  let latActual = deposito.lat, lngActual = deposito.lng
  while (restantes.length > 0) {
    let minDist = Infinity, minIdx = 0
    restantes.forEach((p, i) => {
      const d = Math.pow(p.latitud - latActual, 2) + Math.pow(p.longitud - lngActual, 2)
      if (d < minDist) { minDist = d; minIdx = i }
    })
    const siguiente = restantes.splice(minIdx, 1)[0]
    ordenados.push(siguiente)
    latActual = siguiente.latitud
    lngActual = siguiente.longitud
  }

  // 2-opt
  function totalDist(ruta: any[]): number {
    let d = 0, pLat = deposito.lat, pLng = deposito.lng
    for (const p of ruta) {
      d += distKm(pLat, pLng, p.latitud, p.longitud)
      pLat = p.latitud; pLng = p.longitud
    }
    return d
  }
  let mejorado = true
  while (mejorado && ordenados.length > 2) {
    mejorado = false
    const distActual = totalDist(ordenados)
    outer: for (let i = 0; i < ordenados.length - 1; i++) {
      for (let j = i + 2; j < ordenados.length; j++) {
        const candidato = [
          ...ordenados.slice(0, i + 1),
          ...ordenados.slice(i + 1, j + 1).reverse(),
          ...ordenados.slice(j + 1),
        ]
        if (totalDist(candidato) < distActual - 0.001) {
          ordenados.splice(0, ordenados.length, ...candidato)
          mejorado = true
          break outer
        }
      }
    }
  }

  const todos = [...ordenados, ...sinCoords]
  const resultado: Record<string, number> = {}
  todos.forEach((p, i) => { resultado[p.id] = i + 1 })
  return resultado
}

// POST /api/recalcular-orden
// Body: { pedido_id } — recalcula el orden_entrega del grupo camion+vuelta+fecha
export async function POST(req: NextRequest) {
  try {
    const { pedido_id } = await req.json()
    if (!pedido_id) return NextResponse.json({ error: 'Falta pedido_id' }, { status: 400 })

    const admin = getAdmin()

    // Obtener el pedido para saber camion_id, vuelta, fecha y sucursal
    const { data: pedido, error: errPedido } = await admin
      .from('pedidos')
      .select('id, camion_id, vuelta, fecha_entrega, sucursal')
      .eq('id', pedido_id)
      .single()

    if (errPedido || !pedido) return NextResponse.json({ error: 'Pedido no encontrado' }, { status: 404 })
    if (!pedido.camion_id) return NextResponse.json({ skipped: true, reason: 'Sin camión asignado' })

    // Traer todos los pedidos del mismo camion+vuelta+fecha con coords
    const { data: grupo, error: errGrupo } = await admin
      .from('pedidos')
      .select('id, latitud, longitud')
      .eq('camion_id', pedido.camion_id)
      .eq('vuelta', pedido.vuelta)
      .eq('fecha_entrega', pedido.fecha_entrega)
      .in('estado', ['pendiente', 'programado'])

    if (errGrupo || !grupo || grupo.length === 0) return NextResponse.json({ skipped: true, reason: 'Sin pedidos en el grupo' })

    const nuevoOrden = calcularOrden(grupo, pedido.sucursal)

    // Actualizar orden_entrega para cada pedido del grupo
    await Promise.all(
      Object.entries(nuevoOrden).map(([id, orden]) =>
        admin.from('pedidos').update({ orden_entrega: orden }).eq('id', id)
      )
    )

    return NextResponse.json({ success: true, pedidos_actualizados: grupo.length })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
