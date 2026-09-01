// Franjas horarias de entrega y sus cutoffs
// cutoffDiaOffset: días relativos a la fecha de entrega
// cutoffHora/cutoffMin: hora límite en ese día (hora local Argentina)
export interface Franja {
  vuelta: number
  label: string
  horario: string
  cutoffDiaOffset: number
  cutoffHora: number
  cutoffMin: number
}

export const FRANJAS: Franja[] = [
  { vuelta: 1, label: 'Vuelta 1', horario: '8 a 10hs',         cutoffDiaOffset: -1, cutoffHora: 14, cutoffMin: 0 },
  { vuelta: 2, label: 'Vuelta 2', horario: '10 a 12hs',        cutoffDiaOffset:  0, cutoffHora:  6, cutoffMin: 0 },
  { vuelta: 3, label: 'Vuelta 3', horario: '13 a 15hs',        cutoffDiaOffset:  0, cutoffHora:  9, cutoffMin: 0 },
  { vuelta: 4, label: 'Vuelta 4', horario: 'después de las 16hs', cutoffDiaOffset: 0, cutoffHora: 12, cutoffMin: 0 },
]

/** Devuelve true si el cutoff de esa franja ya pasó para la fecha dada */
export function vultaCerrada(fechaEntrega: string, franja: Franja): boolean {
  const ahora = new Date()
  const [anio, mes, dia] = fechaEntrega.split('-').map(Number)
  const cutoff = new Date(anio, mes - 1, dia + franja.cutoffDiaOffset, franja.cutoffHora, franja.cutoffMin, 0)
  return ahora >= cutoff
}

/** Devuelve qué números de vuelta están cerrados para una fecha dada */
export function vueltasCerradasPara(fechaEntrega: string): number[] {
  if (!fechaEntrega) return []
  return FRANJAS.filter(f => vultaCerrada(fechaEntrega, f)).map(f => f.vuelta)
}
