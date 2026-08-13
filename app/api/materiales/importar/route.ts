import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface FilaImport {
  descripcion_pdf: string
  nombre: string
  categoria: string
  subcategoria: string | null
  tipo_carga: string
  unidad_base: string
  unidad_logistica: string
  cant_x_unid_log: number
  posiciones_x_unid_log: number
  peso_kg_x_posicion: number
  notas: string | null
}

export async function POST(req: NextRequest) {
  const { rows } = await req.json() as { rows: FilaImport[] }
  if (!rows?.length) return NextResponse.json({ error: 'Sin filas' }, { status: 400 })

  let creados = 0, vinculados = 0
  const errores: string[] = []

  for (const row of rows) {
    if (!row.nombre?.trim() || !row.categoria?.trim()) {
      errores.push(`Fila sin nombre/categoría: "${row.descripcion_pdf}"`)
      continue
    }

    const { data: mat, error: matErr } = await supabaseAdmin
      .from('materiales')
      .insert({
        nombre: row.nombre.trim(),
        categoria: row.categoria.trim(),
        subcategoria: row.subcategoria?.trim() || null,
        tipo_carga: row.tipo_carga || 'complementario',
        unidad_base: row.unidad_base || 'u',
        unidad_logistica: row.unidad_logistica || 'u',
        cant_x_unid_log: row.cant_x_unid_log || 1,
        posiciones_x_unid_log: row.posiciones_x_unid_log || 1,
        peso_kg_x_posicion: row.peso_kg_x_posicion || 0,
        notas: row.notas?.trim() || null,
      })
      .select('id')
      .single()

    if (matErr) {
      errores.push(`Error creando "${row.nombre}": ${matErr.message}`)
      continue
    }

    creados++

    if (row.descripcion_pdf?.trim()) {
      // La celda puede tener varias variantes separadas por "; " — resolverlas todas
      const variantes = row.descripcion_pdf.split(';').map((v: string) => v.trim()).filter(Boolean)
      for (const variante of variantes) {
        const { error: aliasErr } = await supabaseAdmin
          .from('material_aliases')
          .update({ material_id: mat.id, resuelto: true })
          .eq('descripcion_pdf', variante)
          .eq('resuelto', false)
        if (!aliasErr) vinculados++
      }
    }
  }

  return NextResponse.json({ creados, vinculados, errores })
}
