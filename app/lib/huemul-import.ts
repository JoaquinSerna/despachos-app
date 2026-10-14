import { supabase } from '../supabase'
import { claveProveedor, exportadoEnDeNombre, leerExcelIngresos } from './huemul-utils'

export interface ResumenHuemul {
  archivo: string
  filas: number
  ingresos: number
  nuevos: number
  actualizados: number
  sinProveedor: number
  exportadoEn: string | null
  fechaDesde: string | null
  fechaHasta: string | null
}

const lote = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// Lee el export «Ingresos de Compras» de Huemul y lo sube a la base.
// Reimportar es seguro: cada ingreso que viene en el archivo reemplaza al que ya estaba guardado
// (el export trae todo el histórico, así que alcanza con subir el más nuevo).
// `db` es el cliente de Supabase: el del usuario (desde la pantalla) o el de servicio (desde la API automática).
export async function importarHuemulConCliente(
  db: any, XLSX: any, buffer: ArrayBuffer, nombreArchivo: string, usuarioId: string | null, onProgreso: (texto: string) => void,
): Promise<ResumenHuemul> {
  onProgreso('Leyendo el archivo…')
  const filas = leerExcelIngresos(XLSX, buffer)
  if (!filas.length) throw new Error('El archivo no tiene ingresos.')

  const user = { id: usuarioId }

  // Proveedor de la app: primero el de la orden de compra del ingreso; si no, por nombre
  onProgreso('Vinculando proveedores…')
  const { data: provs, error: eProv } = await db.from('proveedores').select('id, nombre, estado, fusionado_en')
  if (eProv) throw eProv
  const porId = new Map((provs ?? []).map((p: any) => [p.id as string, p]))
  const resolver = (p: any) => (p && p.estado === 'fusionado' && p.fusionado_en ? porId.get(p.fusionado_en) ?? p : p)
  const porClave = new Map<string, string>()
  for (const p of provs ?? []) {
    if (p.estado === 'fusionado') continue
    const k = claveProveedor(p.nombre)
    if (k && !porClave.has(k)) porClave.set(k, p.id)
  }
  const compras = [...new Set(filas.map(f => f.compra).filter((c): c is number => c !== null))]
  const provDeOC = new Map<number, string>()
  for (const ids of lote(compras, 500)) {
    const { data } = await db.from('ordenes_compra').select('id, proveedor_id').in('id', ids)
    for (const o of data ?? []) if (o.proveedor_id) provDeOC.set(o.id as number, resolver(porId.get(o.proveedor_id as string))?.id ?? (o.proveedor_id as string))
  }
  const proveedorId = (f: (typeof filas)[number]) =>
    (f.compra !== null ? provDeOC.get(f.compra) : undefined) ?? porClave.get(f.proveedor_clave) ?? null

  const fechas = filas.map(f => f.fecha).filter((x): x is string => !!x).sort()
  const ingresos = [...new Set(filas.map(f => f.numero_ingreso))]

  let existentes = 0
  for (const ids of lote(ingresos, 500)) {
    const { data } = await db.from('huemul_ingresos').select('numero_ingreso').in('numero_ingreso', ids)
    existentes += new Set((data ?? []).map((r: any) => r.numero_ingreso as number)).size
  }

  const { data: imp, error: eImp } = await db.from('huemul_importaciones').insert({
    archivo: nombreArchivo, exportado_en: exportadoEnDeNombre(nombreArchivo), importado_por: user?.id ?? null,
    filas: filas.length, ingresos: ingresos.length, fecha_desde: fechas[0] ?? null, fecha_hasta: fechas.at(-1) ?? null,
  }).select('id').single()
  if (eImp) throw eImp

  const ahora = new Date().toISOString()
  const porIngreso = new Map<number, typeof filas>()
  for (const f of filas) porIngreso.set(f.numero_ingreso, [...(porIngreso.get(f.numero_ingreso) ?? []), f])

  let hechos = 0
  for (const ids of lote(ingresos, 150)) {
    const { error: eDel } = await db.from('huemul_ingresos').delete().in('numero_ingreso', ids)
    if (eDel) throw eDel
    const nuevas = ids.flatMap(id => porIngreso.get(id) ?? []).map(f => ({
      ...f, proveedor_id: proveedorId(f), importacion_id: imp.id, importado_en: ahora,
    }))
    for (const parte of lote(nuevas, 500)) {
      const { error } = await db.from('huemul_ingresos').insert(parte)
      if (error) throw error
    }
    hechos += ids.length
    onProgreso(`Guardando ingresos… ${hechos} de ${ingresos.length}`)
  }

  return {
    archivo: nombreArchivo, filas: filas.length, ingresos: ingresos.length,
    nuevos: ingresos.length - existentes, actualizados: existentes,
    sinProveedor: new Set(filas.filter(f => !proveedorId(f)).map(f => f.proveedor_clave)).size,
    exportadoEn: exportadoEnDeNombre(nombreArchivo), fechaDesde: fechas[0] ?? null, fechaHasta: fechas.at(-1) ?? null,
  }
}

export async function importarExcelHuemul(file: File, onProgreso: (texto: string) => void): Promise<ResumenHuemul> {
  onProgreso('Leyendo el archivo…')
  const XLSX = await import('xlsx')
  const { data: { user } } = await supabase.auth.getUser()
  return importarHuemulConCliente(supabase, XLSX, await file.arrayBuffer(), file.name, user?.id ?? null, onProgreso)
}
