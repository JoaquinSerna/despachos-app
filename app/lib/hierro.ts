// Hierro redondo de construcción que se puede entregar derecho o doblado.
// Quedan afuera: perfiles, mallas, alambres, clavos, chapas, hierro 4,2 mm, etc.
export const DIAMETROS_HIERRO_FORMA = [6, 8, 10, 12, 16, 20, 25, 32]
export type FormaHierro = 'derecho' | 'doblado'

export const FORMAS_HIERRO: { valor: FormaHierro; etiqueta: string }[] = [
  { valor: 'derecho', etiqueta: 'Derecho' },
  { valor: 'doblado', etiqueta: 'Doblado' },
]

const EXCLUIR = /malla|alambre|clavo|bul[oó]n|perfil|[aá]ngulo|chapa|tubo|ca[ñn]o|planch|pletina|tejido/i

// "1.HIERRO 6MM X 12", "Hierro 25 mm x 12 m", "HIERRO 8 (OBRA POSE)" → diámetro; null si no corresponde
export function diametroHierroConForma(nombre: string | null | undefined): number | null {
  if (!nombre) return null
  const n = nombre.replace(/^\s*\d+\s*[.)-]\s*/, '')
  if (!/\bhierro\b/i.test(n) || EXCLUIR.test(n)) return null
  const m = n.match(/hierro\D{0,12}?(\d+(?:[.,]\d+)?)/i)
  if (!m) return null
  const d = parseFloat(m[1].replace(',', '.'))
  return DIAMETROS_HIERRO_FORMA.includes(d) ? d : null
}

export const requiereFormaHierro = (nombre: string | null | undefined) => diametroHierroConForma(nombre) !== null

// Línea de pedido leída de la NV: se mira lo que dice el PDF y el nombre del producto del maestro
export const esHierroDeForma = (p: { descripcion?: string; material?: { nombre?: string } | null } | null | undefined) =>
  requiereFormaHierro(p?.descripcion) || requiereFormaHierro(p?.material?.nombre)
