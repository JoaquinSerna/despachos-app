import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function normalizar(s: string): string {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/\s*x\s*/g, 'x')
    .replace(/(\d)\s*(mt|kg|cm|mm|m)\b/g, '$1$2')
    .replace(/\s+/g, ' ').trim()
}

// Fracción de tokens del string más corto que aparecen en el más largo
function tokenSim(a: string, b: string): number {
  const ta = a.split(/\s+/).filter(t => t.length > 1)
  const tb = b.split(/\s+/).filter(t => t.length > 1)
  if (!ta.length || !tb.length) return 0
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  const hits = shorter.filter(t => longer.some(lt => lt === t || lt.startsWith(t) || t.startsWith(lt)))
  return hits.length / shorter.length
}

function matchMaterial(
  nombreItem: string,
  materiales: any[],
  aliasMap: Record<string, number>
): any | null {
  const nombreNorm = normalizar(nombreItem)

  // 1. Check alias (human-confirmed)
  const aliasMatId = aliasMap[nombreNorm]
  if (aliasMatId) {
    const fromAlias = materiales.find(m => m.id === aliasMatId)
    if (fromAlias) return fromAlias
  }

  // 2. Fallback: fuzzy scoring
  const candidatos = materiales
    .map(m => {
      const nt = normalizar(m.nombre)
      let score = 0
      if (nt === nombreNorm) score = 1.0
      else if (nt.includes(nombreNorm) || nombreNorm.includes(nt)) score = 0.9
      else { const s = tokenSim(nombreNorm, nt); if (s >= 0.6) score = s }
      return { m, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.m.nombre.length - a.m.nombre.length)
  return candidatos[0]?.m ?? null
}

function calcularPesoYPosiciones(
  items: { cantidad: number; material: any }[]
): { posicionesTotal: number; pesoTotal: number } {
  const HIERRO_LARGO_KW = ['hierro', 'barra', 'varilla', 'malla']
  let posicionesTotal = 0
  let pesoTotal = 0
  let esHierroLargo = false

  for (const { cantidad, material } of items) {
    if (!material?.cant_x_unid_log) continue
    const nombreLower = (material.nombre ?? '').toLowerCase()
    if (HIERRO_LARGO_KW.some(kw => nombreLower.includes(kw))) esHierroLargo = true
    posicionesTotal += Math.ceil(cantidad / material.cant_x_unid_log) * material.posiciones_x_unid_log
    pesoTotal += cantidad * (material.peso_kg_x_posicion / material.cant_x_unid_log)
  }

  if (esHierroLargo && Math.round(pesoTotal) > 2000) {
    posicionesTotal = Math.max(posicionesTotal, Math.ceil(pesoTotal / 1000))
  }

  return { posicionesTotal, pesoTotal }
}

// POST /api/recalcular-posiciones
// Body: { pedido_id: string } | { pedido_ids: string[] }
//       { requerimiento_id: string } | { requerimiento_ids: string[] }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const admin = getAdmin()

    // ── Requerimientos (transferencias) ──────────────────────────────────────
    const reqIds: string[] = body.requerimiento_id
      ? [body.requerimiento_id]
      : Array.isArray(body.requerimiento_ids) ? body.requerimiento_ids : []

    if (reqIds.length > 0) {
      const { data: materiales, error: matErr } = await admin.from('materiales').select('*')
      if (matErr) return NextResponse.json({ error: matErr.message }, { status: 500 })

      const materialMap: Record<number, any> = {}
      for (const m of materiales ?? []) materialMap[m.id] = m

      const resultados: { id: string; posiciones: number; peso_kg: number }[] = []

      for (const reqId of reqIds) {
        const { data: items, error: itemsErr } = await admin
          .from('requerimiento_items')
          .select('id_producto, cantidad, cantidad_aprobada')
          .eq('requerimiento_id', reqId)

        if (itemsErr || !items?.length) {
          resultados.push({ id: reqId, posiciones: 0, peso_kg: 0 })
          continue
        }

        const mapped = items.map((it: any) => ({
          cantidad: it.cantidad_aprobada ?? it.cantidad,
          material: materialMap[it.id_producto],
        }))

        const { posicionesTotal, pesoTotal } = calcularPesoYPosiciones(mapped)

        const { error: updErr } = await admin
          .from('requerimientos')
          .update({ volumen_total_m3: posicionesTotal, peso_total_kg: Math.round(pesoTotal) })
          .eq('id', reqId)

        if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

        resultados.push({ id: reqId, posiciones: posicionesTotal, peso_kg: Math.round(pesoTotal) })
      }

      return NextResponse.json({ success: true, resultados })
    }

    // ── Pedidos (flujo original) ──────────────────────────────────────────────
    const ids: string[] = body.pedido_id
      ? [body.pedido_id]
      : Array.isArray(body.pedido_ids) ? body.pedido_ids : []

    if (ids.length === 0) {
      return NextResponse.json({ error: 'Falta pedido_id, pedido_ids, requerimiento_id o requerimiento_ids' }, { status: 400 })
    }

    // Cargar materiales y aliases una sola vez
    const [{ data: materiales, error: matErr }, { data: aliases, error: aliasErr }] = await Promise.all([
      admin.from('materiales').select('*'),
      admin.from('material_aliases').select('descripcion_pdf, material_id').eq('resuelto', true),
    ])
    if (matErr) return NextResponse.json({ error: matErr.message }, { status: 500 })
    if (aliasErr) return NextResponse.json({ error: aliasErr.message }, { status: 500 })

    // Build alias map: normalized description → material_id
    const aliasMap: Record<string, number> = {}
    for (const a of aliases ?? []) {
      if (a.material_id) aliasMap[normalizar(a.descripcion_pdf)] = a.material_id
    }

    const resultados: { id: string; posiciones: number; peso_kg: number; items_sin_match: string[] }[] = []

    for (const pedidoId of ids) {
      const { data: items, error: itemsErr } = await admin
        .from('pedido_items')
        .select('nombre, cantidad')
        .eq('pedido_id', pedidoId)

      if (itemsErr || !items?.length) {
        resultados.push({ id: pedidoId, posiciones: 0, peso_kg: 0, items_sin_match: [] })
        continue
      }

      const sinMatch: string[] = []
      const mapped = items.map((item: any) => {
        const material = matchMaterial(item.nombre, materiales ?? [], aliasMap)
        if (!material) sinMatch.push(item.nombre)
        return { cantidad: item.cantidad, material }
      })

      const { posicionesTotal, pesoTotal } = calcularPesoYPosiciones(mapped)

      // Actualizar el pedido
      const { error: updErr } = await admin
        .from('pedidos')
        .update({ volumen_total_m3: posicionesTotal, peso_total_kg: Math.round(pesoTotal) })
        .eq('id', pedidoId)

      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 })
      }

      resultados.push({
        id: pedidoId,
        posiciones: posicionesTotal,
        peso_kg: Math.round(pesoTotal),
        items_sin_match: sinMatch,
      })
    }

    return NextResponse.json({ success: true, resultados })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
