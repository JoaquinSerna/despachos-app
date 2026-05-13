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

function matchMaterial(nombreItem: string, materiales: any[]): any | null {
  const nombreNorm = normalizar(nombreItem)
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

// POST /api/recalcular-posiciones
// Body: { pedido_id: string } | { pedido_ids: string[] }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const admin = getAdmin()

    // Soporta recalcular uno o varios pedidos
    const ids: string[] = body.pedido_id
      ? [body.pedido_id]
      : Array.isArray(body.pedido_ids) ? body.pedido_ids : []

    if (ids.length === 0) {
      return NextResponse.json({ error: 'Falta pedido_id o pedido_ids' }, { status: 400 })
    }

    // Cargar materiales una sola vez
    const { data: materiales, error: matErr } = await admin.from('materiales').select('*')
    if (matErr) return NextResponse.json({ error: matErr.message }, { status: 500 })

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

      let posicionesTotal = 0
      let pesoTotal = 0
      const sinMatch: string[] = []

      for (const item of items) {
        const material = matchMaterial(item.nombre, materiales ?? [])
        if (!material || !material.cant_x_unid_log) {
          sinMatch.push(item.nombre)
          continue
        }
        const posiciones = Math.ceil(item.cantidad / material.cant_x_unid_log) * material.posiciones_x_unid_log
        const pesoUnitario = material.peso_kg_x_posicion / material.cant_x_unid_log
        posicionesTotal += posiciones
        pesoTotal += item.cantidad * pesoUnitario
      }

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
