import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { normalizarCuit, normalizarRemito, remitoIgual } from './compras-utils'

export const BUCKET_REMITOS = 'compras-remitos'
export const MAX_FOTOS_REMITO = 4
export const MAX_REMITOS = 5

export interface ProveedorLite { id: string; nombre: string; cuit: string | null; estado: string }
export interface FotoItem { file: File; preview: string }

export interface RemitoDraft {
  key: string
  fotos: FotoItem[]
  numero: string
  leido: string | null
  ocr: 'idle' | 'leyendo' | 'ok' | 'error'
  cuit: string | null
  razon: string | null
  fecha: string | null
  oc: string | null
}

export const nuevoRemito = (): RemitoDraft => ({
  key: crypto.randomUUID(), fotos: [], numero: '', leido: null, ocr: 'idle', cuit: null, razon: null, fecha: null, oc: null,
})

export function fechaLocal(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export const comprimirFoto = (file: File): Promise<File> =>
  new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX_PX = 1800
      let { width, height } = img
      if (width > MAX_PX || height > MAX_PX) {
        if (width > height) { height = Math.round(height * MAX_PX / width); width = MAX_PX }
        else { width = Math.round(width * MAX_PX / height); height = MAX_PX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
      canvas.toBlob(blob => {
        resolve(blob ? new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }) : file)
      }, 'image/jpeg', 0.85)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })

export async function cargarProveedores(): Promise<ProveedorLite[]> {
  const { data } = await supabase.from('proveedores')
    .select('id, nombre, cuit, estado').neq('estado', 'fusionado').order('nombre')
  return (data ?? []) as ProveedorLite[]
}

export function useProveedores() {
  const [lista, setLista] = useState<ProveedorLite[]>([])
  const recargar = useCallback(async () => { setLista(await cargarProveedores()) }, [])
  useEffect(() => { recargar() }, [recargar])
  return { lista, recargar }
}

export async function crearProveedor(
  nombre: string, cuitTexto: string, aprobado: boolean, userId: string | null,
): Promise<{ proveedor?: ProveedorLite; existente?: ProveedorLite; error?: string }> {
  const n = nombre.trim().replace(/\s+/g, ' ')
  if (!n) return { error: 'Ingresá el nombre del proveedor' }
  let cuit: string | null = null
  if (cuitTexto.trim()) {
    cuit = normalizarCuit(cuitTexto)
    if (!cuit) return { error: 'El CUIT debe tener 11 dígitos' }
    const { data: dup } = await supabase.from('proveedores').select('id, nombre, cuit, estado').eq('cuit', cuit).neq('estado', 'fusionado').limit(1)
    if (dup && dup.length) return { existente: dup[0] as ProveedorLite }
  }
  const { data: igual } = await supabase.from('proveedores').select('id, nombre, cuit, estado').ilike('nombre', n.replace(/[\\%_]/g, '\\$&')).neq('estado', 'fusionado').limit(1)
  if (igual && igual.length) return { existente: igual[0] as ProveedorLite }
  const { data, error } = await supabase.from('proveedores')
    .insert({ nombre: n, cuit, estado: aprobado ? 'aprobado' : 'pendiente', creado_por: userId })
    .select('id, nombre, cuit, estado').single()
  if (error || !data) return { error: error?.message ?? 'No se pudo crear el proveedor' }
  return { proveedor: data as ProveedorLite }
}

export interface DatosRemitoLeido {
  numero_remito: string | null
  cuit_emisor: string | null
  razon_social_emisor: string | null
  fecha: string | null
  orden_compra: string | null
  confianza: string | null
}

// Devuelve null si la lectura falla: el guardia siempre puede tipear el número a mano.
export async function leerRemitoOCR(file: File): Promise<DatosRemitoLeido | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/leer-remito', {
      method: 'POST', body: fd,
      headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.ok ? (json.datos as DatosRemitoLeido) : null
  } catch { return null }
}

export async function buscarRemitoDuplicado(
  proveedorId: string, numero: string,
): Promise<{ fecha: string; sucursal: string } | null> {
  const { data } = await supabase.from('proveedor_remitos')
    .select('id, proveedor_ingresos!inner(fecha, sucursal, proveedor_id)')
    .eq('numero_remito', normalizarRemito(numero).valor)
    .eq('proveedor_ingresos.proveedor_id', proveedorId)
    .limit(1)
  const fila: any = data?.[0]
  if (!fila) return null
  const ing = Array.isArray(fila.proveedor_ingresos) ? fila.proveedor_ingresos[0] : fila.proveedor_ingresos
  return { fecha: ing.fecha, sucursal: ing.sucursal }
}

export interface GuardarIngresoParams {
  userId: string | null
  sucursal: string
  origen: 'externo' | 'propio'
  proveedor: ProveedorLite
  patente?: string
  chofer?: string
  camionCodigo?: string
  guardiaEventoId?: string
  fotosCamion: FotoItem[]
  remitos: RemitoDraft[]
  observacion?: string
}

async function subirFotos(fotos: FotoItem[], prefijo: string): Promise<string[]> {
  const paths: string[] = []
  for (let i = 0; i < fotos.length; i++) {
    const path = `${prefijo}_${i}.jpg`
    const { error } = await supabase.storage.from(BUCKET_REMITOS).upload(path, fotos[i].file, { contentType: 'image/jpeg' })
    if (error) throw error
    paths.push(path)
  }
  return paths
}

export async function guardarIngresoProveedor(p: GuardarIngresoParams): Promise<string> {
  const ingresoId = crypto.randomUUID()
  const fotosCamion = await subirFotos(p.fotosCamion, `${ingresoId}/camion`)
  const filas = []
  for (const r of p.remitos) {
    const id = crypto.randomUUID()
    const numero = normalizarRemito(r.numero).valor
    filas.push({
      id, ingreso_id: ingresoId, numero_remito: numero,
      numero_remito_leido: r.leido,
      remito_corregido: r.leido ? !remitoIgual(numero, r.leido) : false,
      cuit_leido: r.cuit, proveedor_leido: r.razon,
      fecha_remito: r.fecha && /^\d{4}-\d{2}-\d{2}$/.test(r.fecha) ? r.fecha : null,
      oc_numero_leido: r.oc,
      ocr_estado: r.ocr === 'ok' ? 'ok' : r.ocr === 'error' ? 'error' : 'omitido',
      fotos: await subirFotos(r.fotos, `${ingresoId}/${id}`),
    })
  }
  const { error } = await supabase.from('proveedor_ingresos').insert({
    id: ingresoId, fecha: fechaLocal(), hora_ingreso: new Date().toISOString(), sucursal: p.sucursal,
    origen: p.origen, proveedor_id: p.proveedor.id, patente: p.patente?.trim() || null,
    chofer: p.chofer?.trim() || null, camion_codigo: p.camionCodigo || null,
    guardia_evento_id: p.guardiaEventoId || null, fotos_camion: fotosCamion,
    observacion: p.observacion?.trim() || null, registrado_por: p.userId,
  })
  if (error) throw error
  const { error: e2 } = await supabase.from('proveedor_remitos').insert(filas)
  if (e2) {
    await supabase.from('proveedor_ingresos').delete().eq('id', ingresoId)
    throw e2
  }
  return ingresoId
}

export async function eliminarIngreso(ingresoId: string): Promise<boolean> {
  const { error } = await supabase.from('proveedor_ingresos').delete().eq('id', ingresoId)
  return !error
}

export async function firmarFotos(paths: string[]): Promise<string[]> {
  if (!paths.length) return []
  const { data } = await supabase.storage.from(BUCKET_REMITOS).createSignedUrls(paths, 3600)
  return (data ?? []).map(d => d.signedUrl).filter(Boolean) as string[]
}

export function validarRemitos(remitos: RemitoDraft[]): string | null {
  if (!remitos.length) return 'Cargá al menos un remito'
  for (let i = 0; i < remitos.length; i++) {
    if (!remitos[i].fotos.length) return `El remito ${i + 1} necesita al menos una foto`
    if (!remitos[i].numero.trim()) return `Confirmá el número del remito ${i + 1}`
  }
  const nums = remitos.map(r => normalizarRemito(r.numero).valor)
  const repetido = nums.find((n, i) => nums.indexOf(n) !== i)
  return repetido ? `El número ${repetido} está repetido en este ingreso` : null
}

// Avisa si ese proveedor ya tiene registrado el mismo remito; false = el usuario canceló.
export async function confirmarDuplicados(proveedor: ProveedorLite, remitos: RemitoDraft[]): Promise<boolean> {
  for (const r of remitos) {
    const dup = await buscarRemitoDuplicado(proveedor.id, r.numero)
    if (dup) {
      const [y, m, d] = dup.fecha.split('-')
      const seguir = window.confirm(`El remito ${normalizarRemito(r.numero).valor} de ${proveedor.nombre} ya fue registrado el ${d}/${m}/${y} (${dup.sucursal}).\n\n¿Registrar igual?`)
      if (!seguir) return false
    }
  }
  return true
}
