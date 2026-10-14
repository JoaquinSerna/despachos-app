// Recorrido de un camión en el día: arranca en flota_dia.sucursal (vuelta 1) y puede
// cambiar de sucursal las veces que haga falta (cambios_sucursal, ordenados por vuelta).
export interface CambioSucursal { desde_vuelta: number; sucursal: string }

interface FilaFlotaDia {
  sucursal: string
  cambios_sucursal?: unknown
  sucursal_extra?: string | null
  sucursal_extra_desde_vuelta?: number | null
}

export function cambiosDeFila(f: FilaFlotaDia): CambioSucursal[] {
  const crudos = Array.isArray(f.cambios_sucursal) ? f.cambios_sucursal : []
  let cambios = crudos
    .map((c: any) => ({ desde_vuelta: Number(c?.desde_vuelta), sucursal: String(c?.sucursal ?? '') }))
    .filter(c => Number.isInteger(c.desde_vuelta) && c.desde_vuelta >= 2 && c.sucursal)
  // Filas viejas, guardadas con el único cambio del esquema anterior
  if (cambios.length === 0 && f.sucursal_extra) {
    cambios = [{ desde_vuelta: f.sucursal_extra_desde_vuelta ?? 2, sucursal: f.sucursal_extra }]
  }
  return cambios.sort((a, b) => a.desde_vuelta - b.desde_vuelta)
}

// [{desde_vuelta: 1, sucursal: 'Guernica'}, {desde_vuelta: 2, sucursal: 'Cañuelas'}, ...]
export function tramosDeFila(f: FilaFlotaDia): CambioSucursal[] {
  return [{ desde_vuelta: 1, sucursal: f.sucursal }, ...cambiosDeFila(f)]
}

export function sucursalEnVuelta(tramos: CambioSucursal[], vuelta: number): string {
  let actual = tramos[0]?.sucursal ?? ''
  for (const t of tramos) if (t.desde_vuelta <= vuelta) actual = t.sucursal
  return actual
}

// ¿El camión pasa por esta sucursal en algún momento del día?
export const filaIncluyeSucursal = (f: FilaFlotaDia, sucursal: string) =>
  tramosDeFila(f).some(t => t.sucursal === sucursal)

export const resumenTramos = (tramos: CambioSucursal[]) =>
  tramos.map(t => `${t.sucursal} V${t.desde_vuelta}+`).join(' → ')
