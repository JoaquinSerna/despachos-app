import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { importarOCConCliente } from '../../lib/oc-import'
import { importarHuemulConCliente } from '../../lib/huemul-import'
import { exportadoEnDeNombre } from '../../lib/huemul-utils'

export const maxDuration = 60

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

// Misma clave que usa el script del stock (STOCK_IMPORT_SECRET); COMPRAS_SYNC_SECRET es opcional y también vale.
function autorizado(req: NextRequest): boolean {
  const enviada = req.headers.get('x-cron-secret')
  if (!enviada) return false
  return [process.env.STOCK_IMPORT_SECRET, process.env.COMPRAS_SYNC_SECRET].some(s => !!s && s === enviada)
}

type Tipo = 'oc' | 'ingresos'

// compras_ingreso_20261014_0600.xlsx → ingresos de Huemul; compras_20261014_0609.xlsx → órdenes de compra.
// Si el nombre no alcanza, se mira qué hojas trae el archivo.
function tipoDeArchivo(nombre: string, buffer: ArrayBuffer): Tipo | null {
  const n = nombre.toLowerCase()
  if (/compras_ingreso/.test(n)) return 'ingresos'
  if (/^compras_(export_)?\d{8}/.test(n)) return 'oc'
  const wb = XLSX.read(buffer, { type: 'array', bookSheets: true })
  const hojas = wb.SheetNames.map(h => h.toLowerCase())
  if (hojas.includes('compras') && hojas.includes('items_compras')) return 'oc'
  if (hojas.some(h => h.includes('ingresos'))) return 'ingresos'
  return null
}

// POST /api/compras-sync — recibe un export de Huemul (órdenes de compra o ingresos) y lo importa.
// Header obligatorio: x-cron-secret. Cuerpo: multipart con el campo "file".
export async function POST(req: NextRequest) {
  if (!autorizado(req)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  try {
    const archivo = (await req.formData()).get('file') as File | null
    if (!archivo) return NextResponse.json({ error: 'No se recibió archivo' }, { status: 400 })
    const buffer = await archivo.arrayBuffer()
    const tipo = tipoDeArchivo(archivo.name, buffer)
    if (!tipo) return NextResponse.json({ error: `No se reconoce el tipo de archivo: ${archivo.name}` }, { status: 400 })

    const db = getAdmin()
    const sinProgreso = () => {}

    if (tipo === 'oc') {
      const r = await importarOCConCliente(db, XLSX, buffer, null, sinProgreso)
      return NextResponse.json({ success: true, tipo, archivo: archivo.name, ...r })
    }

    // Ingresos: si llega un export más viejo que el último importado, se ignora (no pisa datos nuevos)
    const exportado = exportadoEnDeNombre(archivo.name)
    if (exportado) {
      const { data: ultima } = await db.from('huemul_importaciones').select('exportado_en').not('exportado_en', 'is', null)
        .order('exportado_en', { ascending: false }).limit(1)
      if (ultima?.[0]?.exportado_en && new Date(exportado) < new Date(ultima[0].exportado_en)) {
        return NextResponse.json({ success: true, tipo, archivo: archivo.name, omitido: true, motivo: 'Ya hay un export más nuevo importado' })
      }
    }
    const r = await importarHuemulConCliente(db, XLSX, buffer, archivo.name, null, sinProgreso)
    return NextResponse.json({ success: true, tipo, ...r })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Error al importar' }, { status: 500 })
  }
}

// GET /api/compras-sync — cuándo fue la última importación de cada tipo (sirve para revisar que el script anda)
export async function GET(req: NextRequest) {
  if (!autorizado(req)) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  const db = getAdmin()
  const [{ data: oc }, { data: ing }] = await Promise.all([
    db.from('ordenes_compra').select('importado_en').order('importado_en', { ascending: false }).limit(1),
    db.from('huemul_importaciones').select('archivo, exportado_en, importado_en, ingresos').order('importado_en', { ascending: false }).limit(1),
  ])
  return NextResponse.json({
    ordenes_compra: { ultima_importacion: oc?.[0]?.importado_en ?? null },
    ingresos: ing?.[0] ?? null,
  })
}
