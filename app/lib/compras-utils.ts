export const ROLES_COMPRAS_ADMIN = ['gerencia', 'admin_flota', 'compras']

export function soloDigitos(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

export function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function coincideTexto(texto: string, consulta: string): boolean {
  const t = sinAcentos(texto)
  return sinAcentos(consulta).split(/\s+/).filter(Boolean).every(p => t.includes(p))
}

export function cuitValido(c: string): boolean {
  if (!/^\d{11}$/.test(c)) return false
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const resto = pesos.reduce((s, p, i) => s + p * Number(c[i]), 0) % 11
  const dv = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto
  return dv === Number(c[10]) || (resto === 1 && Number(c[10]) === 4)
}

// Devuelve 11 dígitos o null si el texto no tiene la forma de un CUIT.
export function normalizarCuit(s: string | null | undefined): string | null {
  const d = soloDigitos(s)
  return d.length === 11 ? d : null
}

export function formatCuit(c: string | null | undefined): string {
  const d = soloDigitos(c)
  return d.length === 11 ? `${d.slice(0, 2)}-${d.slice(2, 10)}-${d[10]}` : (c ?? '')
}

// Remito argentino: punto de venta (4-5 dígitos) + número (8 dígitos). Normaliza a "0001-00012345".
export function normalizarRemito(raw: string): { valor: string; formatoOk: boolean } {
  const limpio = (raw ?? '').trim()
  const corridas = limpio.match(/\d+/g) ?? []
  let valor = limpio
  if (corridas.length === 1) {
    const d = corridas[0]
    if (d.length === 12) valor = `${d.slice(0, 4)}-${d.slice(4)}`
    else if (d.length === 13) valor = `${d.slice(0, 5)}-${d.slice(5)}`
    else valor = d
  } else if (corridas.length === 2) {
    valor = `${corridas[0].padStart(4, '0')}-${corridas[1].padStart(8, '0')}`
  }
  return { valor, formatoOk: /^\d{4,5}-\d{8}$/.test(valor) }
}

export function remitoIgual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return normalizarRemito(a).valor === normalizarRemito(b).valor
}
