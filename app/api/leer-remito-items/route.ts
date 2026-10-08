import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import {
  claveAlias, convertirABase, decidirMapeo, mejoresCoincidencias, normalizarUnidad,
  type Candidato, type MaterialConv,
} from '../../lib/remito-items'

export const maxDuration = 60

const MODELO = 'claude-sonnet-5-5'
const ROLES_PERMITIDOS = ['gerencia', 'admin_flota', 'compras']
const BUCKET = 'compras-remitos'

const PROMPT = `Estas son las hojas de un REMITO que un proveedor entrega a Construyo al Costo (CAC).
Extraé SOLO el detalle de productos (los renglones) y devolvé únicamente un JSON, sin texto adicional ni markdown:
{"items":[{"descripcion":"...","codigo_proveedor":"..." o null,"cantidad":número o null,"unidad":"..." o null}]}
Reglas:
- Una entrada por renglón del detalle, en el orden en que aparecen.
- "descripcion": copiala tal como está impresa; no la traduzcas, no la completes ni la corrijas.
- "codigo_proveedor": el código o artículo del proveedor si el renglón lo trae.
- "cantidad": número con punto decimal (ej. 12.4). Si no se lee con seguridad, null; nunca adivines.
- "unidad": la unidad tal como figura (UN, BOL, TN, KG, PAL, M, etc.), o null si no figura.
- No incluyas totales, subtotales, transporte, flete, observaciones ni datos del encabezado.
- Si hay varias hojas, unilas en una sola lista sin repetir renglones.`

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

async function paginar<T>(consulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const filas: T[] = []
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await consulta(desde, desde + 999)
    if (error) throw error
    filas.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return filas
}

export async function POST(req: NextRequest) {
  const admin = getAdmin()
  let remitoId = ''
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 401 })
    const { data: { user }, error: authErr } = await admin.auth.getUser(token)
    if (authErr || !user) return NextResponse.json({ ok: false, error: 'Token inválido' }, { status: 401 })
    const { data: perfil } = await admin.from('usuarios').select('rol').eq('id', user.id).single()
    if (!ROLES_PERMITIDOS.includes(perfil?.rol ?? '')) return NextResponse.json({ ok: false, error: 'Sin permiso' }, { status: 403 })

    const body = await req.json()
    remitoId = String(body?.remito_id ?? '')
    const forzar = body?.forzar === true
    if (!remitoId) return NextResponse.json({ ok: false, error: 'Falta el remito' }, { status: 400 })

    const { data: remito } = await admin.from('proveedor_remitos')
      .select('id, fotos, items_estado, proveedor_ingresos(proveedor_id)').eq('id', remitoId).single()
    if (!remito) return NextResponse.json({ ok: false, error: 'Remito no encontrado' }, { status: 404 })

    if (remito.items_estado === 'ok' && !forzar) {
      const { data: existentes } = await admin.from('proveedor_remito_items').select('*').eq('remito_id', remitoId).order('orden')
      return NextResponse.json({ ok: true, items: existentes ?? [], cache: true })
    }
    const fotos: string[] = remito.fotos ?? []
    if (!fotos.length) return NextResponse.json({ ok: false, error: 'El remito no tiene fotos' }, { status: 400 })
    const ing: any = Array.isArray(remito.proveedor_ingresos) ? remito.proveedor_ingresos[0] : remito.proveedor_ingresos
    const proveedorId: string | null = ing?.proveedor_id ?? null

    // 1) Imágenes
    const imagenes: any[] = []
    for (const path of fotos.slice(0, 4)) {
      const { data: blob, error } = await admin.storage.from(BUCKET).download(path)
      if (error || !blob) throw new Error('No se pudo descargar una foto del remito')
      const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64')
      imagenes.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })
    }

    // 2) Lectura con visión
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const respuesta = await anthropic.messages.create({
      model: MODELO,
      max_tokens: 4096,
      messages: [{ role: 'user', content: [...imagenes, { type: 'text', text: PROMPT }] }],
    })
    const crudo = respuesta.content[0]?.type === 'text' ? respuesta.content[0].text : ''
    const leidos: any[] = JSON.parse(crudo.replace(/```json|```/g, '').trim()).items ?? []

    // 3) Universo de productos: alias aprendidos, productos de las OC del proveedor y catálogo activo
    const aliasMap = new Map<string, number>()
    const candidatosOC: Candidato[] = []
    if (proveedorId) {
      const { data: alias } = await admin.from('producto_alias_proveedor').select('texto_norm, producto_id').eq('proveedor_id', proveedorId)
      for (const a of alias ?? []) aliasMap.set(a.texto_norm, a.producto_id)
      const itemsOC = await paginar<any>((d, h) => admin.from('ordenes_compra_items')
        .select('codigo_producto, nombre_producto, ordenes_compra!inner(proveedor_id)')
        .eq('ordenes_compra.proveedor_id', proveedorId).not('codigo_producto', 'is', null).range(d, h))
      for (const i of itemsOC) if (i.nombre_producto) candidatosOC.push({ id: i.codigo_producto, nombre: i.nombre_producto })
    }
    const catalogo = (await paginar<any>((d, h) => admin.from('productos_catalogo').select('id, nombre').eq('activo', true).order('id').range(d, h)))
      .map(p => ({ id: p.id as number, nombre: p.nombre as string }))
    const nombrePorId = new Map<number, string>()
    for (const p of catalogo) nombrePorId.set(p.id, p.nombre)
    for (const p of candidatosOC) if (!nombrePorId.has(p.id)) nombrePorId.set(p.id, p.nombre)

    // 4) Mapeo de cada renglón
    const filas = leidos.map((it, i) => {
      const descripcion = String(it?.descripcion ?? '').trim()
      const cantidad = typeof it?.cantidad === 'number' && Number.isFinite(it.cantidad) ? it.cantidad : null
      const unidadOriginal = typeof it?.unidad === 'string' && it.unidad.trim() ? it.unidad.trim() : null
      let productoId: number | null = null
      let origen: 'alias' | 'auto' | 'ninguno' = 'ninguno'
      let score: number | null = null

      const aliasHit = aliasMap.get(claveAlias(descripcion))
      const sugOC = mejoresCoincidencias(descripcion, candidatosOC)
      const sugCat = mejoresCoincidencias(descripcion, catalogo)
      if (aliasHit) { productoId = aliasHit; origen = 'alias'; score = 1 }
      else {
        const elegidoOC = decidirMapeo(sugOC)
        const elegidoCat = elegidoOC ? null : decidirMapeo(sugCat, 0.85, 0.1)
        const elegido = elegidoOC ?? elegidoCat
        if (elegido) { productoId = elegido.id; origen = 'auto'; score = elegido.score }
      }
      const idsOC = new Set(candidatosOC.map(c => c.id))
      const sugerencias = [...sugOC, ...sugCat]
        .filter((s, idx, arr) => arr.findIndex(x => x.id === s.id) === idx)
        .sort((a, b) => b.score - a.score).slice(0, 3)
        .map(s => ({ id: s.id, nombre: s.nombre, score: s.score, en_oc: idsOC.has(s.id) }))

      return {
        remito_id: remitoId, orden: i, descripcion: descripcion || '(sin descripción)',
        codigo_proveedor: typeof it?.codigo_proveedor === 'string' && it.codigo_proveedor.trim() ? it.codigo_proveedor.trim() : null,
        cantidad, unidad: normalizarUnidad(unidadOriginal) || null, unidad_original: unidadOriginal,
        producto_id: productoId, mapeo_origen: origen, mapeo_score: score, sugerencias,
        cantidad_base: null as number | null, unidad_base: null as string | null, regla_conversion: null as string | null,
      }
    })

    // 5) Conversión a unidad base
    const idsMapeados = [...new Set(filas.map(f => f.producto_id).filter((x): x is number => x !== null))]
    const materiales = new Map<number, MaterialConv>()
    if (idsMapeados.length) {
      const { data: mats } = await admin.from('materiales')
        .select('id, unidad_base, unidad_logistica, cant_x_unid_log, peso_kg_x_posicion').in('id', idsMapeados)
      for (const m of mats ?? []) materiales.set(m.id, m as MaterialConv)
    }
    for (const f of filas) {
      if (f.producto_id === null) { f.regla_conversion = 'sin producto asignado'; continue }
      const c = convertirABase(f.cantidad, f.unidad ?? '', materiales.get(f.producto_id) ?? null)
      f.cantidad_base = c.cantidad_base; f.unidad_base = c.unidad_base; f.regla_conversion = c.regla
    }

    // 6) Guardar (reemplaza lo anterior)
    await admin.from('proveedor_remito_items').delete().eq('remito_id', remitoId)
    if (filas.length) {
      const { error } = await admin.from('proveedor_remito_items').insert(filas)
      if (error) throw error
    }
    await admin.from('proveedor_remitos').update({ items_estado: 'ok', items_leidos_en: new Date().toISOString() }).eq('id', remitoId)
    const { data: guardados } = await admin.from('proveedor_remito_items').select('*').eq('remito_id', remitoId).order('orden')
    return NextResponse.json({ ok: true, items: guardados ?? [] })
  } catch (e: any) {
    console.error('leer-remito-items error:', e?.message)
    if (remitoId) await admin.from('proveedor_remitos').update({ items_estado: 'error' }).eq('id', remitoId)
    return NextResponse.json({ ok: false, error: 'No se pudieron leer los productos del remito' }, { status: 500 })
  }
}
