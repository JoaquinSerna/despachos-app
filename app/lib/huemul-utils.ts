// Lectura del export de ingresos de Huemul (compras_ingreso_AAAAMMDD_HHMM.xlsx) y cruce con los
// remitos que registró guardia. Sin dependencias de la app: se puede probar solo.

export const DEPOSITO_HUEMUL_A_SUCURSAL: Record<string, string> = {
  'CAC GUERNICA': 'Guernica',
  'CAC LA PLATA - DEPOSITO 520': 'LP520',
  'CAC LA PLATA - 139': 'LP139',
  'CAC CAÑUELAS': 'Cañuelas',
  'CAC COSTA ATLANTICA': 'Pinamar',
}

export interface RemitoParseado { punto: number | null; numero: number | null; sinNumero: boolean }

// Los remitos llegan como "0002-02680217", "00001-00000425", "0001-0037428", "38008",
// "remito manual N°74", "B - 39179", "S/N" o "24092026 sn". Se reduce a punto de venta + número.
export function parsearRemito(raw: unknown): RemitoParseado {
  const s = String(raw ?? '').trim()
  const sinNumero: RemitoParseado = { punto: null, numero: null, sinNumero: true }
  if (!s || /(^|[^a-z0-9])s\s*\/?\s*n([^a-z0-9]|$)/i.test(s) || /sin\s*n[uú]m/i.test(s)) return sinNumero
  const m = s.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (m) {
    const punto = parseInt(m[1], 10), numero = parseInt(m[2], 10)
    return Number.isFinite(numero) ? { punto: Number.isFinite(punto) ? punto : null, numero, sinNumero: false } : sinNumero
  }
  const d = s.match(/\d+/g)
  if (!d) return sinNumero
  const numero = parseInt(d[d.length - 1], 10)
  return Number.isFinite(numero) ? { punto: null, numero, sinNumero: false } : sinNumero
}

// Dos remitos son el mismo si tienen el mismo número y, cuando ambos traen punto de venta, el mismo punto.
export function mismoRemito(a: RemitoParseado, b: RemitoParseado): boolean {
  if (a.numero === null || b.numero === null || a.numero !== b.numero) return false
  return a.punto === null || b.punto === null || a.punto === b.punto
}

const SUFIJOS_SOCIEDAD = new Set(['sa', 'srl', 'sas', 'sacif', 'saic', 'sacifia', 'ltda', 'cia'])

// "ARIDOS DE VILLA CONSTITUCIÓN S.A." y "Aridos de Villa Constitucion SA" dan la misma clave
export function claveProveedor(nombre: unknown): string {
  return String(nombre ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(t => t.length > 1 && !SUFIJOS_SOCIEDAD.has(t))
    .join(' ')
}

// Fecha del ERP (hora argentina) como AAAA-MM-DD
export function fechaHuemul(v: unknown): string | null {
  let d: Date | null = null
  if (v instanceof Date) d = v
  else if (typeof v === 'number' && v > 20000) d = new Date(Math.round((v - 25569) * 86400000))
  else if (typeof v === 'string' && v.trim()) {
    const dm = v.trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})/)
    if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`
    const t = new Date(v)
    d = isNaN(t.getTime()) ? null : t
  }
  if (!d || isNaN(d.getTime())) return null
  const ar = new Date(d.getTime() - 3 * 3600 * 1000)
  return ar.toISOString().slice(0, 10)
}

// compras_ingreso_20261005_0600.xlsx → 2026-10-05 06:00 (hora argentina)
export function exportadoEnDeNombre(nombre: string): string | null {
  const m = nombre.match(/(\d{4})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00-03:00` : null
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || !v.trim()) return null
  const n = Number(v.trim().replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
const txt = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

export interface IngresoHuemulFila {
  numero_ingreso: number
  linea: number
  numero_remito: string | null
  punto_remito: number | null
  nro_remito: number | null
  sin_numero: boolean
  numero_factura: string | null
  fecha: string | null
  acopio: boolean
  codigo_producto: number | null
  descripcion: string | null
  proveedor: string | null
  proveedor_clave: string
  cantidad: number | null
  precio_unitario: number | null
  precio_total: number | null
  usuario: string | null
  deposito: string | null
  sucursal: string | null
  compra: number | null
}

const COLUMNAS = ['numero_ingreso', 'numero_remito', 'fecha', 'proveedor', 'cantidad', 'deposito', 'compra']

export function leerExcelIngresos(XLSX: any, buffer: ArrayBuffer): IngresoHuemulFila[] {
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const filas: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, { defval: null })
  if (!filas.length || !COLUMNAS.every(c => c in filas[0])) {
    throw new Error('No se reconocen las columnas. ¿Es el export «Ingresos de Compras» de Huemul (compras_ingreso_…xlsx)?')
  }
  const lineaPorIngreso = new Map<number, number>()
  const out: IngresoHuemulFila[] = []
  for (const f of filas) {
    const ingreso = num(f.numero_ingreso)
    if (ingreso === null) continue
    const linea = (lineaPorIngreso.get(ingreso) ?? 0) + 1
    lineaPorIngreso.set(ingreso, linea)
    const r = parsearRemito(f.numero_remito)
    const deposito = txt(f.deposito)
    out.push({
      numero_ingreso: ingreso, linea,
      numero_remito: txt(f.numero_remito), punto_remito: r.punto, nro_remito: r.numero, sin_numero: r.sinNumero,
      numero_factura: txt(f.numero_factura), fecha: fechaHuemul(f.fecha),
      acopio: String(f.acopio ?? '').trim().toUpperCase() === 'SI',
      codigo_producto: num(f.codigo_producto), descripcion: txt(f.descripcion),
      proveedor: txt(f.proveedor), proveedor_clave: claveProveedor(f.proveedor),
      cantidad: num(f.cantidad), precio_unitario: num(f.precio_unitario), precio_total: num(f.precio_total),
      usuario: txt(f.usuario), deposito, sucursal: deposito ? DEPOSITO_HUEMUL_A_SUCURSAL[deposito.toUpperCase()] ?? null : null,
      compra: num(f.compra),
    })
  }
  return out
}

// ── Cruce: remitos de guardia vs. ingresos de Huemul ──
export interface RemitoGuardia {
  id: string
  numero_remito: string
  fecha: string                 // fecha del ingreso en guardia (AAAA-MM-DD)
  proveedor_id: string | null
  proveedor_nombre: string | null
}

export interface HuemulParaCruce {
  numero_ingreso: number
  fecha: string | null
  proveedor_id: string | null
  proveedor_clave: string | null
  punto_remito: number | null
  nro_remito: number | null
  sin_numero: boolean
}

export type EstadoCruce = 'cargado' | 'sin_cargar' | 'sin_numero' | 'posterior_al_export'

export interface ResultadoCruce {
  estado: EstadoCruce
  ingresos: number[]            // números de ingreso de Huemul que lo cubren
}

// exportadoEn: AAAA-MM-DD del export. Lo que entró a guardia después no se puede juzgar todavía.
export function cruzarRemitos(
  remitos: RemitoGuardia[],
  huemul: HuemulParaCruce[],
  exportadoEn: string | null,
): Map<string, ResultadoCruce> {
  const porNumero = new Map<number, HuemulParaCruce[]>()
  for (const h of huemul) {
    if (h.nro_remito === null) continue
    porNumero.set(h.nro_remito, [...(porNumero.get(h.nro_remito) ?? []), h])
  }
  const res = new Map<string, ResultadoCruce>()
  for (const r of remitos) {
    const p = parsearRemito(r.numero_remito)
    if (p.sinNumero) { res.set(r.id, { estado: 'sin_numero', ingresos: [] }); continue }
    const clave = claveProveedor(r.proveedor_nombre)
    const candidatos = (porNumero.get(p.numero as number) ?? []).filter(h =>
      mismoRemito(p, { punto: h.punto_remito, numero: h.nro_remito, sinNumero: false }) &&
      ((r.proveedor_id && h.proveedor_id === r.proveedor_id) || (clave && h.proveedor_clave === clave)))
    const ingresos = [...new Set(candidatos.map(h => h.numero_ingreso))]
    // Si no está y entró a guardia después del export, todavía no puede estar: se marca aparte pero sigue pendiente
    const estado: EstadoCruce = ingresos.length ? 'cargado' : exportadoEn && r.fecha > exportadoEn ? 'posterior_al_export' : 'sin_cargar'
    res.set(r.id, { estado, ingresos })
  }
  return res
}
