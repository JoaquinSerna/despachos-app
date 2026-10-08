// Lógica pura (sin dependencias) para leer productos de remitos: texto, mapeo al catálogo, unidades y conversión.

export function sinAcentosLower(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

const STOP = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'en', 'con', 'para', 'por', 'a', 'x', 'nro', 'n', 'art', 'cod',
  'codigo', 'un', 'una', 'ud', 'u', 'p', 'c', 's', 'sa', 'srl', 'c/u', 'cu',
])

const UNIDAD_MEDIDA: Record<string, string> = {
  mts: 'm', mt: 'm', m: 'm', mm: 'mm', cm: 'cm', kgs: 'kg', kg: 'kg', kilos: 'kg', kilo: 'kg',
  lts: 'l', lt: 'l', l: 'l', cc: 'cc', gr: 'g', g: 'g', tn: 'tn', m2: 'm2', m3: 'm3', pulg: 'pulg',
}

export function normalizarTexto(s: string): string {
  let t = sinAcentosLower(s ?? '')
  t = t.replace(/[ø⌀"”]/g, ' ')
  t = t.replace(/(\d),(\d)/g, '$1.$2')
  t = t.replace(/(^|[^a-z])x(?=\d)/g, '$1x ').replace(/(\d)x(?=\d)/g, '$1 x ')
  t = t.replace(/(\d+(?:\.\d+)?)\s*(mts|mt|mm|cm|m2|m3|m|kgs|kg|kilos|kilo|lts|lt|cc|gr|tn|pulg|l|g)(?![a-z0-9])/g,
    (_m, n: string, u: string) => `${n}${UNIDAD_MEDIDA[u] ?? u}`)
  t = t.replace(/[^a-z0-9.]+/g, ' ').replace(/(^|\s)\.+|\.+(\s|$)/g, ' ')
  return t.replace(/\s+/g, ' ').trim()
}

export function tokensProducto(s: string): string[] {
  return normalizarTexto(s).split(' ').filter(t => t && !STOP.has(t))
}

const tieneDigito = (t: string) => /\d/.test(t)
const numKey = (t: string) => (t.match(/^\d+(?:\.\d+)?/) ?? [''])[0]
const unidadDe = (t: string) => t.replace(/^\d+(?:\.\d+)?/, '')
const peso = (t: string) => (tieneDigito(t) ? 2 : 1)

export function puntuar(textoRemito: string, nombreCandidato: string): number {
  const a = tokensProducto(textoRemito)
  const b = tokensProducto(nombreCandidato)
  if (!a.length || !b.length) return 0
  const wa = a.reduce((s, t) => s + peso(t), 0)
  const wb = b.reduce((s, t) => s + peso(t), 0)
  const usados = new Set<number>()
  let inter = 0
  let numeroCoincide = false
  for (const t of a) {
    const j = b.findIndex((u, i) => !usados.has(i) && (
      t === u || (tieneDigito(t) && tieneDigito(u) && numKey(t) === numKey(u) && (unidadDe(t) === unidadDe(u) || !unidadDe(t) || !unidadDe(u)))
    ))
    if (j >= 0) {
      usados.add(j); inter += peso(t)
      if (tieneDigito(t)) numeroCoincide = true
    }
  }
  if (!inter) return 0
  const r = inter / wa
  const p = inter / wb
  let score = (2 * p * r) / (p + r)
  if (a.some(tieneDigito) && b.some(tieneDigito) && !numeroCoincide) score *= 0.5
  return Math.round(score * 1000) / 1000
}

export interface Candidato { id: number; nombre: string }
export interface Sugerencia { id: number; nombre: string; score: number }

export function mejoresCoincidencias(texto: string, candidatos: Candidato[], max = 3, minimo = 0.3): Sugerencia[] {
  const porId = new Map<number, Sugerencia>()
  for (const c of candidatos) {
    const score = puntuar(texto, c.nombre)
    if (score < minimo) continue
    const previo = porId.get(c.id)
    if (!previo || score > previo.score) porId.set(c.id, { id: c.id, nombre: c.nombre, score })
  }
  return Array.from(porId.values()).sort((x, y) => y.score - x.score).slice(0, max)
}

// Mapea solo si el mejor candidato es claro: puntaje alto y buena ventaja sobre el segundo.
export function decidirMapeo(sugs: Sugerencia[], umbral = 0.72, margen = 0.08): Sugerencia | null {
  if (!sugs.length || sugs[0].score < umbral) return null
  if (sugs.length > 1 && sugs[0].score - sugs[1].score < margen) return null
  return sugs[0]
}

export function claveAlias(texto: string): string {
  return tokensProducto(texto).join(' ')
}

// ── Unidades y conversión ───────────────────────────────────────────────────────────────────

const SINONIMOS_UNIDAD: Record<string, string> = {
  tn: 'tn', tns: 'tn', ton: 'tn', tons: 'tn', tonelada: 'tn', toneladas: 'tn',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogramo: 'kg', kilogramos: 'kg',
  pallet: 'pallet', pallets: 'pallet', palet: 'pallet', palets: 'pallet', pal: 'pallet', plt: 'pallet', tarima: 'pallet',
  un: 'unidad', u: 'unidad', und: 'unidad', unid: 'unidad', uni: 'unidad', unidad: 'unidad', unidades: 'unidad', uds: 'unidad', ud: 'unidad',
  bol: 'bolsa', bolsa: 'bolsa', bolsas: 'bolsa', bls: 'bolsa',
  bolson: 'bolson', bolsones: 'bolson',
  barra: 'barra', barras: 'barra', br: 'barra',
  rollo: 'rollo', rollos: 'rollo', rol: 'rollo',
  m: 'metro', mt: 'metro', mts: 'metro', metro: 'metro', metros: 'metro', ml: 'metro',
  lata: 'lata', latas: 'lata', balde: 'balde', baldes: 'balde', caja: 'caja', cajas: 'caja',
  hoja: 'hoja', hojas: 'hoja', plancha: 'plancha', planchas: 'plancha', chapa: 'chapa', chapas: 'chapa',
  tambor: 'tambor', tambores: 'tambor', manga: 'manga', mangas: 'manga', camion: 'camion', camiones: 'camion',
}

export function normalizarUnidad(raw: string | null | undefined): string {
  const t = sinAcentosLower(raw ?? '').replace(/[^a-z0-9]/g, '')
  if (!t) return ''
  return SINONIMOS_UNIDAD[t] ?? t
}

export interface MaterialConv {
  id: number
  unidad_base: string | null
  unidad_logistica: string | null
  cant_x_unid_log: number | null
  peso_kg_x_posicion: number | null
}

// Peso teórico por barra de 12 m (acero 7.850 kg/m³): el maestro lo tiene redondeado al kilo y distorsiona la conversión.
export const HIERRO_KG_BARRA: Record<number, number> = {
  2422: 1.31, // ø4,2
  28: 2.67, // ø6
  29: 4.74, // ø8
  30: 7.41, // ø10
  9: 10.67, // ø12
  10: 18.96, // ø16
  34: 29.63, // ø20
  35: 46.3, // ø25
}

export function pesoUnitarioKg(m: MaterialConv): number | null {
  if (HIERRO_KG_BARRA[m.id]) return HIERRO_KG_BARRA[m.id]
  const peso = Number(m.peso_kg_x_posicion)
  const cant = Number(m.cant_x_unid_log)
  return peso > 0 && cant > 0 ? peso / cant : null
}

export interface ResultadoConversion { cantidad_base: number | null; unidad_base: string | null; regla: string }

const redondear = (n: number) => Math.round(n * 100) / 100

export function convertirABase(cantidad: number | null, unidadRaw: string, m: MaterialConv | null): ResultadoConversion {
  if (cantidad === null || !Number.isFinite(cantidad)) return { cantidad_base: null, unidad_base: m?.unidad_base ?? null, regla: 'sin cantidad' }
  if (!m) return { cantidad_base: null, unidad_base: null, regla: 'producto sin datos de conversión' }
  const unidad = normalizarUnidad(unidadRaw)
  const ub = normalizarUnidad(m.unidad_base)
  const ul = normalizarUnidad(m.unidad_logistica)
  const base = m.unidad_base ?? null

  if (!unidad) return { cantidad_base: redondear(cantidad), unidad_base: base, regla: 'sin unidad: se asume la unidad base' }
  if (unidad === ub) return { cantidad_base: redondear(cantidad), unidad_base: base, regla: 'misma unidad que la base' }

  if (unidad === 'tn' || unidad === 'kg') {
    const kg = unidad === 'tn' ? cantidad * 1000 : cantidad
    if (ub === 'kg') return { cantidad_base: redondear(kg), unidad_base: base, regla: `${unidad} → kg` }
    if (ub === 'tn') return { cantidad_base: redondear(kg / 1000), unidad_base: base, regla: `${unidad} → tn` }
    const pu = pesoUnitarioKg(m)
    if (pu) return { cantidad_base: redondear(kg / pu), unidad_base: base, regla: `${redondear(kg)} kg ÷ ${redondear(pu)} kg por ${base ?? 'unidad'}` }
    return { cantidad_base: null, unidad_base: base, regla: 'falta el peso del producto para convertir' }
  }

  if (unidad === ul && Number(m.cant_x_unid_log) > 0) {
    const f = Number(m.cant_x_unid_log)
    return { cantidad_base: redondear(cantidad * f), unidad_base: base, regla: `${unidad} × ${f} ${base ?? ''}` }
  }

  if (unidad === 'unidad') return { cantidad_base: redondear(cantidad), unidad_base: base, regla: 'unidad genérica = unidad base' }
  return { cantidad_base: null, unidad_base: base, regla: `no se sabe convertir «${unidadRaw}» a ${base ?? 'la unidad base'}` }
}

// Compara lo que trae el remito contra el saldo de la OC. Tolerancia de ±5%.
export type EstadoCantidad = 'coincide' | 'parcial' | 'excede' | 'sin_dato'
export function compararConSaldo(recibido: number | null, saldo: number, tolerancia = 0.05): EstadoCantidad {
  if (recibido === null || !Number.isFinite(recibido)) return 'sin_dato'
  if (saldo <= 0) return recibido > 0 ? 'excede' : 'coincide'
  if (recibido > saldo * (1 + tolerancia)) return 'excede'
  if (recibido >= saldo * (1 - tolerancia)) return 'coincide'
  return 'parcial'
}
