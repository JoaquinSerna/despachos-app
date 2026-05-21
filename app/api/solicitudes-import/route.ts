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

const SUCURSAL_MAP: Record<string, string> = {
  'la plata - 520': 'LP520',
  'la plata 520':   'LP520',
  'la plata - 139': 'LP139',
  'la plata 139':   'LP139',
  'guernica':       'Guernica',
  'cañuelas':       'Cañuelas',
  'canuelas':       'Cañuelas',
  'pinamar':        'Pinamar',
  'costa atlantica': 'Pinamar',
}

function normalizeSucursal(s: string) {
  return SUCURSAL_MAP[s?.toLowerCase()?.trim()] ?? s
}

function parseDate(val: any): string | null {
  if (val == null || val === '') return null
  try {
    // JS Date object (cellDates: true)
    if (val instanceof Date) {
      if (isNaN(val.getTime())) return null
      // Usar componentes locales para evitar desfase por timezone
      const y = val.getFullYear()
      const m = String(val.getMonth() + 1).padStart(2, '0')
      const d = String(val.getDate()).padStart(2, '0')
      return `${y}-${m}-${d}`
    }
    // Objeto fecha de XLSX ({ y, m, d, H, M, S })
    if (typeof val === 'object' && 'y' in val && 'm' in val && 'd' in val) {
      return `${val.y}-${String(val.m).padStart(2,'0')}-${String(val.d).padStart(2,'0')}`
    }
    // Serial numérico de Excel
    if (typeof val === 'number' && val > 0) {
      const d = XLSX.SSF.parse_date_code(val)
      if (d?.y > 1900) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`
    }
    if (typeof val === 'string') {
      const s = val.trim().replace(/^["']|["']$/g, '') // quitar comillas si las hay
      if (!s) return null

      // Formato DD/MM/YYYY o DD-MM-YYYY (argentino)
      const dmyMatch = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/)
      if (dmyMatch) {
        const [, d, m, y] = dmyMatch
        return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`
      }

      // Formato YYYY-DD-MM o YYYY/DD/MM (ERP export: año-día-mes — ¡invertido!)
      // El ERP exporta con día en segunda posición y mes en tercera
      const ydmMatch = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/)
      if (ydmMatch) {
        const [, y, dia, mes] = ydmMatch
        return `${y}-${mes.padStart(2,'0')}-${dia.padStart(2,'0')}`
      }

      // Fallback genérico
      const d = new Date(s)
      if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      }
    }
    return null
  } catch { return null }
}

// POST /api/solicitudes-import
// Recibe el Excel de solicitudes de despacho exportado del sistema ERP
// Cruza con pedidos existentes en la app y devuelve:
// - pedidos ya cargados (por NV o id_solicitud)
// - pedidos solo en el Excel (no cargados por vendedor)
export async function POST(req: NextRequest) {
  const admin = getAdmin()
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const soloAnalizar = formData.get('solo_analizar') === 'true'

    if (!file) return NextResponse.json({ error: 'No se recibió archivo' }, { status: 400 })

    const buffer = await file.arrayBuffer()
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true })

    // Leer hoja de solicitudes
    const ws = wb.Sheets['Solicitudes de Despacho'] ?? wb.Sheets[wb.SheetNames[0]]
    const rows: any[] = XLSX.utils.sheet_to_json(ws)

    if (!rows.length) return NextResponse.json({ error: 'Hoja de solicitudes vacía' }, { status: 400 })

    // Debug: devolver info de la primera fila para diagnosticar fechas
    const primeraFila = rows[0]
    const fechaRaw = primeraFila['fecha_despacho']
    const fechaDebug = {
      valor: fechaRaw,
      tipo: typeof fechaRaw,
      esDate: fechaRaw instanceof Date,
      parseado: parseDate(fechaRaw),
    }

    // Normalizar las solicitudes del Excel
    const solicitudes = rows.map(r => ({
      id: Number(r['id']),
      fecha_despacho: parseDate(r['fecha_despacho']),
      horario: String(r['horario_entrega'] ?? ''),
      prioridad: String(r['prioridad'] ?? ''),
      estado: String(r['estado'] ?? ''),
      id_venta: Number(r['id_venta'] ?? 0),
      cliente: String(r['cliente'] ?? ''),
      destino: String(r['destino_de_venta'] ?? ''),
      direccion: String(r['direccion_obra'] ?? ''),
      latitud: r['latitud'] ? Number(r['latitud']) : null,
      longitud: r['longitud'] ? Number(r['longitud']) : null,
      sucursal: normalizeSucursal(String(r['sucursal'] ?? '')),
    })).filter(s => s.id > 0)

    // Cruzar con pedidos existentes en la app (por nv)
    const nvs = solicitudes.map(s => String(s.id_venta)).filter(Boolean)
    const { data: pedidosExistentes } = await admin
      .from('pedidos')
      .select('nv')
      .in('nv', nvs)

    const nvsEnApp = new Set((pedidosExistentes ?? []).map((p: any) => String(p.nv)))

    const cargados = solicitudes.filter(s => nvsEnApp.has(String(s.id_venta)))
    const noCargados = solicitudes.filter(s => !nvsEnApp.has(String(s.id_venta)))

    // Si no es solo análisis, guardar en tabla solicitudes_importadas
    if (!soloAnalizar) {
      // Upsert por id
      const toUpsert = solicitudes.map(s => ({
        ...s,
        importado_en: new Date().toISOString(),
      }))
      for (let i = 0; i < toUpsert.length; i += 500) {
        await admin.from('solicitudes_importadas').upsert(toUpsert.slice(i, i + 500), { onConflict: 'id' })
      }
    }

    // Leer items si la hoja existe
    let itemsCount = 0
    if (!soloAnalizar && wb.Sheets['items_solicitudes']) {
      const wsItems = wb.Sheets['items_solicitudes']
      const itemRows: any[] = XLSX.utils.sheet_to_json(wsItems)
      itemsCount = itemRows.length
      const toUpsert = itemRows.map(r => ({
        id_solicitud: Number(r['id_solicitud']),
        id_venta: Number(r['id_venta']),
        id_producto: Number(r['id_producto']),
        nombre_producto: String(r['nombre_producto'] ?? ''),
        tipo: String(r['tipo'] ?? ''),
        categoria: String(r['categoria'] ?? ''),
        subcategoria: String(r['subcategoria'] ?? ''),
        cantidad_solicitada: Number(r['cantidad_solicitada'] ?? 0),
        cantidad_entregada: Number(r['cantidad_entregada'] ?? 0),
        hojas_de_ruta: String(r['hojas_de_ruta'] ?? ''),
      }))
      for (let i = 0; i < toUpsert.length; i += 500) {
        await admin.from('solicitudes_importadas_items').upsert(toUpsert.slice(i, i + 500))
      }
    }

    return NextResponse.json({
      success: true,
      total: solicitudes.length,
      cargados_en_app: cargados.length,
      no_cargados: noCargados.length,
      items: itemsCount,
      solicitudes_sin_cargar: noCargados.slice(0, 200),
      _debug_fecha: fechaDebug, // temporal para diagnosticar formato de fecha
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// GET /api/solicitudes-import — listar solicitudes importadas no cargadas en app
export async function GET(req: NextRequest) {
  const admin = getAdmin()
  const { searchParams } = new URL(req.url)
  const fecha = searchParams.get('fecha') ?? ''
  const sucursal = searchParams.get('sucursal') ?? ''

  let query = admin
    .from('solicitudes_importadas')
    .select('*')
    .order('fecha_despacho', { ascending: false })
    .limit(500)

  if (fecha) query = query.eq('fecha_despacho', fecha)
  if (sucursal) query = query.eq('sucursal', sucursal)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Cruzar con pedidos existentes
  const nvs = (data ?? []).map((s: any) => String(s.id_venta)).filter(Boolean)
  const { data: pedidos } = nvs.length > 0
    ? await admin.from('pedidos').select('nv').in('nv', nvs)
    : { data: [] }

  const nvsEnApp = new Set((pedidos ?? []).map((p: any) => String(p.nv)))

  const result = (data ?? []).map((s: any) => ({
    ...s,
    cargado_en_app: nvsEnApp.has(String(s.id_venta)),
  }))

  return NextResponse.json(result)
}
