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

// POST /api/productos-catalogo — importar catálogo desde Excel
// Excel esperado: id, codigo_sku, nombre, activo (True/False), descripcion, marca,
//                tipo, categoria, subcategoria, unidad_medida, unidad_venta,
//                codigo_transporte, posiciones_camion
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

    // Normalizar nombres de columna
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '_').replace(/[()]/g, '')
    const rows_norm = rows.map(r => {
      const out: any = {}
      for (const [k, v] of Object.entries(r)) out[norm(k)] = v
      return out
    })

    // Helper para parsear activo: acepta True/False/1/0/'true'/'false'
    function parseActivo(val: any): boolean {
      if (typeof val === 'boolean') return val
      if (typeof val === 'number') return val !== 0
      if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1'
      return true // default activo
    }

    // Debug: ver qué columnas y valores tiene la primera fila
    const primeraFila = rows_norm[0] ?? {}
    const colsEncontradas = Object.keys(primeraFila)
    const tieneId = 'id' in primeraFila
    const tieneNombre = 'nombre' in primeraFila
    const tieneActivo = 'activo' in primeraFila

    const now = new Date().toISOString()
    const records = rows_norm
      .filter(r => r['id'] && r['nombre'])
      .map(r => ({
        id:                  Number(r['id']),
        codigo_sku:          String(r['codigo_sku'] ?? ''),
        nombre:              String(r['nombre'] ?? '').trim(),
        activo:              parseActivo(r['activo']),
        descripcion:         String(r['descripcion'] ?? ''),
        marca:               String(r['marca'] ?? ''),
        tipo:                String(r['tipo'] ?? ''),
        categoria:           String(r['categoria'] ?? ''),
        subcategoria:        String(r['subcategoria'] ?? ''),
        unidad_medida:       String(r['unidad_medida'] ?? ''),
        unidad_venta:        String(r['unidad_venta'] ?? ''),
        codigo_transporte:   String(r['codigo_transporte'] ?? ''),
        posiciones_camion:   r['posiciones_camion'] != null ? Number(r['posiciones_camion']) : null,
        importado_en:        now,
      }))

    if (!records.length) {
      return NextResponse.json({
        error: 'No se encontraron productos válidos (se requiere columna id y nombre)',
        _debug: { totalFilas: rows_norm.length, columnas: colsEncontradas.slice(0, 20), tieneId, tieneNombre, tieneActivo, primeraFila: Object.fromEntries(Object.entries(primeraFila).slice(0, 5)) },
      }, { status: 400 })
    }

    // Upsert en lotes de 500
    let imported = 0
    for (let i = 0; i < records.length; i += 500) {
      const { error } = await admin
        .from('productos_catalogo')
        .upsert(records.slice(i, i + 500), { onConflict: 'id' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      imported += Math.min(500, records.length - i)
    }

    const inactivos = records.filter(r => !r.activo).length
    return NextResponse.json({
      success: true, total: imported, activos: imported - inactivos, inactivos, importado_en: now,
      _debug: { columnas: colsEncontradas.slice(0, 20), tieneId, tieneNombre, tieneActivo },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET /api/productos-catalogo?ids=1,2,3
// Devuelve { id, nombre, activo } para verificar estado de productos
// Sin parámetros → devuelve stats del catálogo (total, inactivos, ultimo_import)
export async function GET(req: NextRequest) {
  const admin = getAdmin()
  const { searchParams } = new URL(req.url)
  const ids = searchParams.get('ids')

  if (ids) {
    const idList = ids.split(',').map(Number).filter(n => n > 0)
    if (!idList.length) return NextResponse.json([])
    const { data, error } = await admin
      .from('productos_catalogo')
      .select('id, nombre, activo, categoria, subcategoria')
      .in('id', idList)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json(data ?? [])
  }

  const codigo = searchParams.get('codigo')
  if (codigo) {
    const trimmed = codigo.trim()
    const numId = parseInt(trimmed, 10)

    // Si es numérico → buscar por id (código de ERP)
    if (!isNaN(numId) && String(numId) === trimmed) {
      const { data } = await admin
        .from('productos_catalogo')
        .select('id, codigo_sku, nombre, activo, descripcion, categoria, subcategoria')
        .eq('id', numId)
        .limit(1)
      return NextResponse.json(data?.[0] ?? null)
    }

    // Si es texto → buscar por codigo_sku (case-insensitive)
    const { data } = await admin
      .from('productos_catalogo')
      .select('id, codigo_sku, nombre, activo, descripcion, categoria, subcategoria')
      .ilike('codigo_sku', trimmed)
      .limit(1)
    return NextResponse.json(data?.[0] ?? null)
  }

  // Stats
  const { count: total } = await admin
    .from('productos_catalogo')
    .select('*', { count: 'exact', head: true })
  const { count: inactivos } = await admin
    .from('productos_catalogo')
    .select('*', { count: 'exact', head: true })
    .eq('activo', false)
  const { data: last } = await admin
    .from('productos_catalogo')
    .select('importado_en')
    .order('importado_en', { ascending: false })
    .limit(1)

  return NextResponse.json({
    total: total ?? 0,
    inactivos: inactivos ?? 0,
    ultimo_import: last?.[0]?.importado_en ?? null,
  })
}
