import { createClient } from '@supabase/supabase-js'

// La IA lee las NV desde el PDF y a veces transcribe mal un número (ej. "X 30 KG" → "X 50 KG").
// Acá se valida cada producto contra el catálogo (productos_catalogo, el mismo código del ERP):
//  · si el nombre está en el catálogo → se le agrega su código (id_producto)
//  · si no está pero hay UN solo producto igual salvo por los números → se corrige al nombre del catálogo
//    (queda marcado en corregido_desde para que se vea y se revise)
//  · si no hay forma → queda como vino, marcado sin_catalogo

interface Catalogo { id: number; nombre: string; activo: boolean; clave: string; palabras: string; numeros: string }

const clave = (n: string) => (n ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\s*\d+\s*[.)-]\s*/, '').replace(/[^a-z0-9]/g, '')
// Palabras (sin los números sueltos) y números sueltos, por separado
function partes(n: string) {
  const toks = (n ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^\s*\d+\s*[.)-]\s*/, '').split(/[^a-z0-9]+/).filter(Boolean)
  return { palabras: toks.filter(t => !/^\d+$/.test(t)).sort().join(' '), numeros: toks.filter(t => /^\d+$/.test(t)).length }
}

async function cargarCatalogo(): Promise<Catalogo[]> {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } })
  const lista: Catalogo[] = []
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from('productos_catalogo').select('id, nombre, activo').order('id').range(from, from + 999)
    for (const c of data ?? []) {
      if (!c.nombre) continue
      const p = partes(c.nombre)
      lista.push({ id: c.id, nombre: c.nombre, activo: c.activo !== false, clave: clave(c.nombre), palabras: p.palabras, numeros: String(p.numeros) })
    }
    if (!data || data.length < 1000) break
  }
  return lista
}

export async function ajustarProductosACatalogo<T extends { descripcion?: any }>(productos: T[]): Promise<(T & { id_producto?: number | null; corregido_desde?: string; sin_catalogo?: boolean })[]> {
  let catalogo: Catalogo[] = []
  try { catalogo = await cargarCatalogo() } catch { return productos }
  if (!catalogo.length) return productos
  const porClave = new Map<string, Catalogo[]>()
  for (const c of catalogo) { if (!porClave.has(c.clave)) porClave.set(c.clave, []); porClave.get(c.clave)!.push(c) }
  const preferir = (l: Catalogo[]) => l.find(c => c.activo) ?? l[0]

  return productos.map(p => {
    const desc = typeof p.descripcion === 'string' ? p.descripcion : ''
    if (!desc) return p
    const exacto = porClave.get(clave(desc))
    if (exacto?.length) return { ...p, id_producto: preferir(exacto).id }
    const { palabras, numeros } = partes(desc)
    const parecidos = catalogo.filter(c => c.palabras === palabras && c.numeros === String(numeros) && c.clave !== clave(desc))
    const activos = parecidos.filter(c => c.activo)
    const unico = activos.length === 1 ? activos[0] : parecidos.length === 1 ? parecidos[0] : null
    if (unico) return { ...p, descripcion: unico.nombre.toUpperCase(), id_producto: unico.id, corregido_desde: desc }
    return { ...p, sin_catalogo: true }
  })
}
