// Validación física de la preparación: el depósito confirma, día por día y producto por producto,
// que tiene lo que hay que despachar. Se usa en Preparación y en Faltantes.

export interface PickingItemPrep { nombre: string; cantidad: number; unidad: string; codigo_material?: string | null }
export interface PickingPedidoPrep {
  id?: string; estado?: string
  nv: string | number; cliente: string; sucursal: string; fecha_entrega: string
  items: PickingItemPrep[]
}

// Solo se valida lo que todavía no salió del depósito
export const ESTADOS_A_PREPARAR = ['pendiente', 'programado']

export interface LineaDemanda {
  clave: string
  nombre: string
  codigo: string | null
  unidad: string
  cantidad: number
  pedidos: { nv: string | number; cliente: string; cantidad: number }[]
}

export interface ValidacionPrep {
  id: string
  sucursal: string
  fecha: string
  clave: string
  nombre: string
  codigo: string | null
  unidad: string | null
  validada: number
  faltante: number
  validado_por: string | null
  validado_en: string | null
  decision: 'transferencia' | 'esperar' | null
  decision_nota: string | null
  decision_req_id: string | null
  decision_por: string | null
  decision_en: string | null
}

const norm = (s: string) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Mismo producto = mismo nombre (con su forma, derecho/doblado) y misma unidad
export const clavePrep = (nombre: string, unidad: string) => `${norm(nombre)}|${norm(unidad || 'u')}`

// Demanda de una sucursal agrupada por día de entrega: fecha → clave → línea
export function demandaPorDia(pedidos: PickingPedidoPrep[], sucursal: string): Map<string, Map<string, LineaDemanda>> {
  const dias = new Map<string, Map<string, LineaDemanda>>()
  for (const ped of pedidos) {
    if (ped.sucursal !== sucursal) continue
    if (ped.estado && !ESTADOS_A_PREPARAR.includes(ped.estado)) continue
    if (!dias.has(ped.fecha_entrega)) dias.set(ped.fecha_entrega, new Map())
    const dia = dias.get(ped.fecha_entrega)!
    for (const it of ped.items) {
      const unidad = it.unidad || 'u'
      const clave = clavePrep(it.nombre, unidad)
      if (!dia.has(clave)) dia.set(clave, { clave, nombre: it.nombre, codigo: it.codigo_material ?? null, unidad, cantidad: 0, pedidos: [] })
      const linea = dia.get(clave)!
      linea.cantidad += it.cantidad
      linea.pedidos.push({ nv: ped.nv, cliente: ped.cliente, cantidad: it.cantidad })
    }
  }
  return dias
}

// Estado de una línea: cuánto falta validar (solo la diferencia si ya había una validación)
export function estadoLinea(requerida: number, v?: ValidacionPrep | null) {
  const validada = v?.validada ?? 0
  const diferencia = Math.max(0, requerida - validada)
  const faltanteDeclarado = v && diferencia > 0 ? Math.min(v.faltante, diferencia) : 0
  return { validada, diferencia, faltanteDeclarado, completa: diferencia === 0 && requerida > 0 }
}

export const fmtNum = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 2 })
