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
  { vuelta: 1, label: 'Vuelta 1', horario: '',                    cutoffDiaOffset: -1, cutoffHora: 14, cutoffMin: 0 },
  { vuelta: 2, label: 'Vuelta 2', horario: '',                    cutoffDiaOffset:  0, cutoffHora:  6, cutoffMin: 0 },
  { vuelta: 3, label: 'Vuelta 3', horario: '',                    cutoffDiaOffset:  0, cutoffHora: 10, cutoffMin: 0 },
  { vuelta: 4, label: 'Vuelta 4', horario: 'después de las 16hs', cutoffDiaOffset:  0, cutoffHora: 13, cutoffMin: 0 },
]

/** Devuelve true si el cutoff de esa franja ya pasó para la fecha dada */
export function vultaCerrada(fechaEntrega: string, franja: Franja): boolean {
  const ahora = new Date()
  const [anio, mes, dia] = fechaEntrega.split('-').map(Number)
  const cutoff = new Date(anio, mes - 1, dia + franja.cutoffDiaOffset, franja.cutoffHora, franja.cutoffMin, 0)
  return ahora >= cutoff
}

/** Devuelve true si la fecha cae en sábado */
export function esSabado(fechaEntrega: string): boolean {
  if (!fechaEntrega) return false
  return new Date(fechaEntrega + 'T12:00:00').getDay() === 6
}

// V3 y V4 no están disponibles los sábados
const VUELTAS_BLOQUEADAS_SABADO = [3, 4]

/** Devuelve qué números de vuelta están cerrados para una fecha dada */
export function vueltasCerradasPara(fechaEntrega: string): number[] {
  if (!fechaEntrega) return []
  const cerradasHorario = FRANJAS.filter(f => vultaCerrada(fechaEntrega, f)).map(f => f.vuelta)
  const cerradasSabado = esSabado(fechaEntrega) ? VUELTAS_BLOQUEADAS_SABADO : []
  return [...new Set([...cerradasHorario, ...cerradasSabado])]
}
