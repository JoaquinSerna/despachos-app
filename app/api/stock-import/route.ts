import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Mapeo columnas del Excel → sucursales de la app
const COL_SUCURSAL: Record<string, string> = {
  'stock_cac_guernica':              'Guernica',
  'stock_cac_la_plata_-_deposito_520': 'LP520',
  'stock_cac_la_plata_-_139':        'LP139',
  'stock_cac_canuelas':              'Cañuelas',
  'stock_cac_costa_atlantica':       'Pinamar',
}

// POST /api/stock-import — recibe el Excel de stock y lo importa
export async function POST(req: NextRequest) {
  const admin = getAdmin()
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    if (!file) return NextResponse.json({ error: 'No se recibió archivo' }, { status: 400 })

    const buffer = await file.arrayBuffer()
    const wb = XLSX.read(buffer, { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const rows: any[] = XLSX.utils.sheet_to_json(ws)

    if (!rows.length) return NextResponse.json({ error: 'El archivo está vacío' }, { status: 400 })

    // Normalizar columnas: lowercase, sin acentos (ñ→n, á→a, etc.), sin espacios ni paréntesis
    const normalize = (s: string) =>
      s.toLowerCase()
       .normalize('NFD').replace(/[̀-ͯ]/g, '') // elimina diacríticos: ñ→n, á→a…
       .replace(/\s+/g, '_')
       .replace(/[()]/g, '')
    const rows_norm = rows.map(r => {
      const out: any = {}
      for (const [k, v] of Object.entries(r)) out[normalize(k)] = v
      return out
    })

    // Construir registros: un row por (producto × sucursal)
    const now = new Date().toISOString()
    const records: any[] = []
    for (const row of rows_norm) {
      const id_producto = Number(row['id'])
      const nombre = String(row['nombre'] ?? '')
      const tipo = String(row['tipo'] ?? '')
      const categoria = String(row['categoria'] ?? '')
      const subcategoria = String(row['subcategoria'] ?? '')
      if (!id_producto || !nombre) continue

      for (const [col, sucursal] of Object.entries(COL_SUCURSAL)) {
        const cantidad = Number(row[col] ?? 0)
        records.push({ id_producto, nombre, tipo, categoria, subcategoria, sucursal, cantidad, actualizado_en: now })
      }
    }

    // Borrar stock anterior e insertar el nuevo (full replace)
    await admin.from('stock_sucursal').delete().neq('id', '00000000-0000-0000-0000-000000000000')

    // Insertar en lotes de 500
    let inserted = 0
    for (let i = 0; i < records.length; i += 500) {
      const { error } = await admin.from('stock_sucursal').insert(records.slice(i, i + 500))
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      inserted += Math.min(500, records.length - i)
    }

    return NextResponse.json({
      success: true,
      productos: rows_norm.length,
      registros: inserted,
      actualizado_en: now,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET /api/stock-import?producto_id=X&sucursal=Y — consultar stock de un producto
export async function GET(req: NextRequest) {
  const admin = getAdmin()
  const { searchParams } = new URL(req.url)
  const id_producto = searchParams.get('id_producto')
  const nombre = searchParams.get('nombre') ?? ''

  if (id_producto) {
    const { data } = await admin
      .from('stock_sucursal')
      .select('id_producto, nombre, sucursal, cantidad, actualizado_en')
      .eq('id_producto', parseInt(id_producto))
      .order('cantidad', { ascending: false })
    return NextResponse.json(data ?? [])
  }

  if (nombre) {
    // Búsqueda parcial por nombre
    const { data } = await admin
      .from('stock_sucursal')
      .select('id_producto, nombre, sucursal, cantidad, actualizado_en')
      .ilike('nombre', `%${nombre}%`)
      .gt('cantidad', 0)
      .order('cantidad', { ascending: false })
      .limit(50)
    return NextResponse.json(data ?? [])
  }

  // Devolver fecha del último import
  const { data } = await admin
    .from('stock_sucursal')
    .select('actualizado_en')
    .order('actualizado_en', { ascending: false })
    .limit(1)
  return NextResponse.json({ ultimo_import: data?.[0]?.actualizado_en ?? null })
}
