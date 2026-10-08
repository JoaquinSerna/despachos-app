// Depósito del ERP -> sucursal de la app. Los depósitos que no figuran (Tucumán, Pilar, obra) quedan sin sucursal.
export const DEPOSITO_A_SUCURSAL: Record<string, string> = {
  'CAC GUERNICA': 'Guernica',
  'CAC LA PLATA - DEPOSITO 520': 'LP520',
  'CAC LA PLATA - 139': 'LP139',
  'CAC CAÑUELAS': 'Cañuelas',
  'CAC COSTA ATLANTICA': 'Pinamar',
}

export function sucursalDeDeposito(deposito: unknown): string | null {
  const d = String(deposito ?? '').trim().toUpperCase()
  return DEPOSITO_A_SUCURSAL[d] ?? null
}

export function textoOC(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

export function numeroOC(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const n = Number(v.trim().replace(',', '.'))
  return v.trim() !== '' && Number.isFinite(n) ? n : null
}

// El ERP exporta "DD-MM-YYYY HH:mm:ss" (hora argentina). También acepta Date y fechas seriales de Excel.
export function fechaERP(v: unknown): string | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === 'number' && v > 20000) return new Date(Math.round((v - 25569) * 86400000)).toISOString()
  const m = String(v ?? '').trim().match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!m) return null
  const [, d, mo, y, h = '00', mi = '00', s = '00'] = m
  return `${y}-${mo}-${d}T${h}:${mi}:${s}-03:00`
}

// Convierte una hoja (matriz de filas) en objetos, buscando la fila de encabezados que contiene `clave`.
// El export de ítems trae una fila de aviso arriba, por eso no se asume que sea la primera.
export function filasDesdeHoja(aoa: unknown[][], clave: string): Record<string, unknown>[] {
  const idx = aoa.findIndex(r => Array.isArray(r) && r.some(c => String(c ?? '').trim() === clave))
  if (idx === -1) return []
  const cab = aoa[idx].map(c => String(c ?? '').trim())
  return aoa.slice(idx + 1)
    .filter(r => Array.isArray(r) && r.some(c => c !== null && c !== undefined && String(c).trim() !== ''))
    .map(r => Object.fromEntries(cab.map((k, i) => [k, r[i] ?? null])))
}

export interface OCFila {
  id: number
  estado: string
  proveedor_nombre: string | null
  cuit_raw: string | null
  deposito: string | null
  sucursal: string | null
  numero_factura: string | null
  total: number | null
  comprado_por: string | null
  observaciones: string | null
  fecha_creacion: string | null
  fecha_actualizacion: string | null
}

export interface OCItemFila {
  oc_id: number
  codigo_producto: number | null
  nombre_producto: string | null
  marca: string | null
  cantidad: number
  cantidad_recibida: number
  costo_unitario: number | null
}

// Lee el export del ERP (hojas `compras` e `items_compras`). Se descartan las "actualizaciones de costo".
export function leerExcelOC(XLSX: any, buffer: ArrayBuffer): { ocs: OCFila[]; items: OCItemFila[]; ignoradas: number } {
  const wb = XLSX.read(buffer, { type: 'array' })
  const hojaCompras = wb.Sheets['compras']
  const hojaItems = wb.Sheets['items_compras']
  if (!hojaCompras || !hojaItems) throw new Error('El archivo no tiene las hojas «compras» e «items_compras» del export del ERP.')
  const aoa = (h: any) => XLSX.utils.sheet_to_json(h, { header: 1, defval: null, raw: true }) as unknown[][]
  const compras = filasDesdeHoja(aoa(hojaCompras), 'id')
  const itemsRaw = filasDesdeHoja(aoa(hojaItems), 'id_compra')
  if (!compras.length || !('estado' in compras[0]) || !('proveedor' in compras[0])) {
    throw new Error('No se reconocen las columnas de la hoja «compras». ¿Es el export de compras del ERP?')
  }

  const regulares = compras.filter(r => textoOC(r.tipo) === 'regular' && numeroOC(r.id) !== null)
  const ocs: OCFila[] = regulares.map(r => ({
    id: numeroOC(r.id) as number,
    estado: textoOC(r.estado) ?? 'desconocido',
    proveedor_nombre: textoOC(r.proveedor),
    cuit_raw: textoOC(r.cuit_proveedor),
    deposito: textoOC(r.deposito),
    sucursal: sucursalDeDeposito(r.deposito),
    numero_factura: textoOC(r.numero_factura),
    total: numeroOC(r.total),
    comprado_por: textoOC(r.comprado_por),
    observaciones: textoOC(r.observaciones),
    fecha_creacion: fechaERP(r.fecha_creacion),
    fecha_actualizacion: fechaERP(r.fecha_actualizacion),
  }))

  const ids = new Set(ocs.map(o => o.id))
  const items: OCItemFila[] = []
  for (const r of itemsRaw) {
    const ocId = numeroOC(r.id_compra)
    const cantidad = numeroOC(r.cantidad)
    if (ocId === null || cantidad === null || !ids.has(ocId)) continue
    items.push({
      oc_id: ocId,
      codigo_producto: numeroOC(r.codigo_producto),
      nombre_producto: textoOC(r.nombre_producto),
      marca: textoOC(r.marca),
      cantidad,
      cantidad_recibida: numeroOC(r.cantidad_recibida) ?? 0,
      costo_unitario: numeroOC(r.costo_unitario),
    })
  }
  return { ocs, items, ignoradas: compras.length - regulares.length }
}
