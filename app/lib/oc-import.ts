import { supabase } from '../supabase'
import { cuitValido, normalizarCuit } from './compras-utils'
import { leerExcelOC, type OCFila } from './oc-utils'

export interface ResumenImport {
  ocs: number
  nuevas: number
  actualizadas: number
  items: number
  ignoradas: number
  sinSucursal: number
  proveedoresCreados: string[]
}

const lote = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// Lee el export de compras del ERP y lo sube a la base: OC regulares con sus ítems.
// Reimportar es seguro: las OC se actualizan por número y sus ítems se reemplazan.
export async function importarExcelOC(file: File, onProgreso: (texto: string) => void): Promise<ResumenImport> {
  onProgreso('Leyendo el archivo…')
  const XLSX = await import('xlsx')
  const { ocs, items, ignoradas } = leerExcelOC(XLSX, await file.arrayBuffer())
  if (!ocs.length) throw new Error('El archivo no tiene órdenes de compra regulares.')

  const { data: { user } } = await supabase.auth.getUser()

  // 1) Proveedores: se vinculan por nombre y, si no, por CUIT; los que no existen se crean
  onProgreso('Vinculando proveedores…')
  const { data: provs, error: eProv } = await supabase.from('proveedores').select('id, nombre, cuit, estado, fusionado_en')
  if (eProv) throw eProv
  const porId = new Map((provs ?? []).map(p => [p.id as string, p]))
  const resolver = (p: any) => (p && p.estado === 'fusionado' && p.fusionado_en ? porId.get(p.fusionado_en) ?? p : p)
  const porNombre = new Map<string, any>()
  const porCuit = new Map<string, any[]>()
  for (const p of provs ?? []) {
    if (p.estado !== 'fusionado') porNombre.set(String(p.nombre).trim().toLowerCase(), p)
    if (p.cuit && p.estado !== 'fusionado') porCuit.set(p.cuit, [...(porCuit.get(p.cuit) ?? []), p])
  }
  const buscar = (o: OCFila) => {
    const n = (o.proveedor_nombre ?? '').trim().toLowerCase()
    if (n && porNombre.has(n)) return resolver(porNombre.get(n))
    const c = normalizarCuit(o.cuit_raw)
    const candidatos = c ? porCuit.get(c) ?? [] : []
    return candidatos.length === 1 ? resolver(candidatos[0]) : null
  }

  const proveedoresCreados: string[] = []
  const faltantes = new Map<string, OCFila>()
  for (const o of ocs) {
    if (!buscar(o) && o.proveedor_nombre) faltantes.set(o.proveedor_nombre.trim().toLowerCase(), o)
  }
  for (const o of faltantes.values()) {
    const cuit = normalizarCuit(o.cuit_raw)
    const valido = !!cuit && cuitValido(cuit)
    const { data, error } = await supabase.from('proveedores').insert({
      nombre: (o.proveedor_nombre as string).trim(), cuit: valido ? cuit : null, estado: valido ? 'aprobado' : 'revisar',
      notas: 'Creado desde la importación de OC' + (o.cuit_raw && !valido ? ` (CUIT del ERP: ${o.cuit_raw})` : ''),
      creado_por: user?.id ?? null,
    }).select('id, nombre, cuit, estado, fusionado_en').single()
    if (!error && data) {
      porNombre.set(data.nombre.trim().toLowerCase(), data)
      porId.set(data.id, data)
      proveedoresCreados.push(data.nombre)
    }
  }

  // 2) Órdenes de compra
  const ahora = new Date().toISOString()
  const filas = ocs.map(o => {
    const cuit = normalizarCuit(o.cuit_raw)
    return {
      id: o.id, estado: o.estado, proveedor_id: buscar(o)?.id ?? null, proveedor_nombre: o.proveedor_nombre,
      cuit, deposito: o.deposito, sucursal: o.sucursal, numero_factura: o.numero_factura, total: o.total,
      comprado_por: o.comprado_por, observaciones: o.observaciones, fecha_creacion: o.fecha_creacion,
      fecha_actualizacion: o.fecha_actualizacion, importado_en: ahora,
    }
  })

  let existentes = 0
  for (const ids of lote(filas.map(f => f.id), 500)) {
    const { data } = await supabase.from('ordenes_compra').select('id').in('id', ids)
    existentes += data?.length ?? 0
  }

  let hechas = 0
  for (const parte of lote(filas, 400)) {
    const { error } = await supabase.from('ordenes_compra').upsert(parte, { onConflict: 'id' })
    if (error) throw error
    hechas += parte.length
    onProgreso(`Guardando órdenes de compra… ${hechas} de ${filas.length}`)
  }

  // 3) Ítems: se reemplazan por OC para reflejar cambios de cantidades recibidas
  const itemsPorOC = new Map<number, typeof items>()
  for (const it of items) itemsPorOC.set(it.oc_id, [...(itemsPorOC.get(it.oc_id) ?? []), it])
  let itemsHechos = 0
  for (const ids of lote(filas.map(f => f.id), 100)) {
    const { error: eDel } = await supabase.from('ordenes_compra_items').delete().in('oc_id', ids)
    if (eDel) throw eDel
    const nuevos = ids.flatMap(id => itemsPorOC.get(id) ?? [])
    for (const parte of lote(nuevos, 1000)) {
      const { error } = await supabase.from('ordenes_compra_items').insert(parte)
      if (error) throw error
    }
    itemsHechos += nuevos.length
    onProgreso(`Guardando productos de las OC… ${itemsHechos} de ${items.length}`)
  }

  return {
    ocs: filas.length, nuevas: filas.length - existentes, actualizadas: existentes, items: items.length,
    ignoradas, sinSucursal: ocs.filter(o => !o.sucursal).length, proveedoresCreados,
  }
}
