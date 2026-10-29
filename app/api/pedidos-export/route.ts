import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createHash, timingSafeEqual } from 'crypto'

// GET /api/pedidos-export?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
// Solo lectura. Devuelve, por cada pedido programado, la sucursal desde la que realmente sale
// (la de Omega), vinculada por SD. Lo consume el Tablero de Abastecimiento.
// Autenticación: header x-api-secret = variable de entorno DESPACHOS_PEDIDOS_SECRET.

const MAX_FILAS = 20000
const PAGINA = 1000
const ZONA = 'America/Argentina/Buenos_Aires'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Comparación en tiempo constante (se comparan hashes para que el largo no filtre información)
function secretoValido(enviado: string | null): boolean {
  const esperado = process.env.DESPACHOS_PEDIDOS_SECRET
  if (!esperado || !enviado) return false
  const a = createHash('sha256').update(enviado).digest()
  const b = createHash('sha256').update(esperado).digest()
  return timingSafeEqual(a, b)
}

const fechaArg = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const sumarDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const esFecha = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T12:00:00Z`).getTime())

// Argentina no tiene horario de verano: el desfase es siempre -03:00
function ahoraArg(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
  const g = (t: string) => p.find(x => x.type === t)?.value ?? '00'
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}-03:00`
}

export async function GET(req: NextRequest) {
  const noCache = { 'Cache-Control': 'no-store' }
  if (!secretoValido(req.headers.get('x-api-secret'))) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401, headers: noCache })
  }

  const { searchParams } = new URL(req.url)
  const hoy = fechaArg(new Date())
  const desde = searchParams.get('desde') ?? sumarDias(hoy, -45)
  const hasta = searchParams.get('hasta') ?? sumarDias(hoy, 30)
  if (!esFecha(desde) || !esFecha(hasta)) {
    return NextResponse.json({ error: 'desde y hasta deben tener formato AAAA-MM-DD' }, { status: 400, headers: noCache })
  }
  if (desde > hasta) {
    return NextResponse.json({ error: 'desde no puede ser posterior a hasta' }, { status: 400, headers: noCache })
  }

  const admin = getAdmin()
  // Misma consulta que la hoja "Pedidos" del export Excel: por fecha de entrega, sin cancelados
  const filas: any[] = []
  let truncado = false
  for (let desdeFila = 0; ; desdeFila += PAGINA) {
    const { data, error } = await admin.from('pedidos')
      .select('id, nv, id_despacho, sucursal, fecha_entrega, vuelta, camion_id, estado, tipo, created_at')
      .gte('fecha_entrega', desde).lte('fecha_entrega', hasta)
      .neq('estado', 'cancelado')
      .order('fecha_entrega').order('sucursal').order('id')
      .range(desdeFila, desdeFila + PAGINA - 1)
    if (error) return NextResponse.json({ error: 'No se pudieron leer los pedidos' }, { status: 500, headers: noCache })
    filas.push(...(data ?? []))
    if (!data || data.length < PAGINA) break
    if (filas.length >= MAX_FILAS) { truncado = true; break }
  }

  // Solo los campos que necesita el tablero; sin cliente, dirección, coordenadas ni notas
  const pedidos = filas.map(p => {
    const nvNum = p.nv != null && /^\d+$/.test(String(p.nv).trim()) ? Number(p.nv) : null
    return {
      sd: p.id_despacho != null && String(p.id_despacho).trim() !== '' ? String(p.id_despacho).trim() : null,
      nv: nvNum,
      sucursal: p.sucursal ?? null,
      fecha: p.fecha_entrega,
      vuelta: p.vuelta === 0 || p.vuelta == null ? 'Sin asignar' : `V${p.vuelta}`,
      camion: p.camion_id ?? null,
      estado: p.estado,
      tipo: p.tipo === 'retiro' ? 'retiro' : 'entrega',
      creadoEn: p.created_at ?? null,
    }
  })

  return NextResponse.json(
    { generadoEn: ahoraArg(), desde, hasta, total: pedidos.length, truncado, pedidos },
    { headers: noCache }
  )
}
