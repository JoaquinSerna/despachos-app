'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { claveAlias, convertirABase, normalizarUnidad, type MaterialConv } from '../lib/remito-items'
import { fmtNum } from './OrdenesCompra'

export interface ItemRemito {
  id: string
  remito_id: string
  orden: number
  descripcion: string
  codigo_proveedor: string | null
  cantidad: number | null
  unidad: string | null
  unidad_original: string | null
  producto_id: number | null
  mapeo_origen: 'alias' | 'auto' | 'manual' | 'ninguno'
  mapeo_score: number | null
  sugerencias: { id: number; nombre: string; score: number; en_oc: boolean }[]
  cantidad_base: number | null
  unidad_base: string | null
  regla_conversion: string | null
}

interface Props {
  remito: any
  proveedorId: string | null
  userId: string | null
  puedeEd: boolean
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onItems: (items: ItemRemito[]) => void
  recargarKey?: number
}

const inputSt: React.CSSProperties = { padding: '7px 9px', borderRadius: 8, border: '1.5px solid #d6d6d6', fontSize: 13, background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' }
const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap', background: '#f9f9f9', color: '#254A96', fontSize: 12 }
const td: React.CSSProperties = { padding: '8px 10px', borderTop: '1px solid #f0f0f0', verticalAlign: 'top', fontSize: 13 }

const ORIGEN: Record<string, { icono: string; texto: string; color: string }> = {
  alias: { icono: '🧠', texto: 'Aprendido de una confirmación anterior', color: '#065f46' },
  auto: { icono: '✨', texto: 'Asignado automáticamente: confirmalo para que lo aprenda', color: '#92400e' },
  manual: { icono: '✔', texto: 'Confirmado por Compras', color: '#065f46' },
  ninguno: { icono: '❓', texto: 'Sin producto asignado', color: '#b91c1c' },
}

const escapar = (s: string) => s.replace(/[\\%_]/g, '\\$&')

function BuscadorProducto({ sugerencias, onElegir, onCerrar }: {
  sugerencias: ItemRemito['sugerencias']; onElegir: (p: { id: number; nombre: string }) => void; onCerrar: () => void
}) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<{ id: number; nombre: string }[]>([])
  useEffect(() => {
    const t = setTimeout(async () => {
      const palabras = q.trim().split(/\s+/).filter(Boolean)
      if (!palabras.length) { setRes([]); return }
      let query = supabase.from('productos_catalogo').select('id, nombre').eq('activo', true)
      for (const p of palabras) query = query.ilike('nombre', `%${escapar(p)}%`)
      const { data } = await query.order('nombre').limit(15)
      setRes((data ?? []) as any)
    }, 250)
    return () => clearTimeout(t)
  }, [q])
  return (
    <div style={{ position: 'absolute', zIndex: 60, background: '#fff', border: '1.5px solid #254A96', borderRadius: 10, padding: 8, width: 340, boxShadow: '0 8px 24px rgba(0,0,0,.2)' }}>
      {sugerencias.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: '#666', fontWeight: 700, marginBottom: 4 }}>SUGERENCIAS</div>
          {sugerencias.map(s => (
            <div key={s.id} onClick={() => onElegir(s)} style={{ padding: '6px 8px', cursor: 'pointer', fontSize: 13, borderRadius: 6 }}>
              {s.nombre} <span style={{ fontSize: 11, color: '#888' }}>{Math.round(s.score * 100)}%{s.en_oc ? ' · está en sus OC' : ''}</span>
            </div>
          ))}
        </>
      )}
      <div style={{ fontSize: 11, color: '#666', fontWeight: 700, margin: '6px 0 4px' }}>BUSCAR EN EL CATÁLOGO</div>
      <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Ej: cemento avellaneda 25" style={{ ...inputSt, width: '100%' }} />
      <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
        {res.map(p => <div key={p.id} onClick={() => onElegir(p)} style={{ padding: '6px 8px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f3f3f3' }}>{p.nombre} <span style={{ fontSize: 11, color: '#999' }}>#{p.id}</span></div>)}
        {q.trim() && res.length === 0 && <div style={{ padding: 8, fontSize: 12, color: '#999' }}>Sin resultados</div>}
      </div>
      <button onClick={onCerrar} style={{ ...inputSt, marginTop: 6, cursor: 'pointer', width: '100%' }}>Cerrar</button>
    </div>
  )
}

export default function ProductosRemito({ remito, proveedorId, userId, puedeEd, showToast, onItems, recargarKey }: Props) {
  const [items, setItems] = useState<ItemRemito[]>([])
  const [nombres, setNombres] = useState<Record<number, string>>({})
  const [cargando, setCargando] = useState(true)
  const [leyendo, setLeyendo] = useState(false)
  const [errorLectura, setErrorLectura] = useState(false)
  const [abierto, setAbierto] = useState<string | null>(null)
  const materiales = useRef(new Map<number, MaterialConv | null>())
  const yaLeyo = useRef<string | null>(null)

  const actualizar = (nuevos: ItemRemito[]) => { setItems(nuevos); onItems(nuevos) }

  const cargarNombres = useCallback(async (lista: ItemRemito[]) => {
    const ids = [...new Set(lista.map(i => i.producto_id).filter((x): x is number => x !== null))]
    const sugIds = lista.flatMap(i => i.sugerencias.map(s => s.id))
    const falta = [...new Set([...ids, ...sugIds])]
    if (!falta.length) return
    const { data } = await supabase.from('productos_catalogo').select('id, nombre').in('id', falta)
    setNombres(prev => ({ ...prev, ...Object.fromEntries((data ?? []).map((p: any) => [p.id, p.nombre])) }))
  }, [])

  const leer = useCallback(async (forzar: boolean) => {
    setLeyendo(true); setErrorLectura(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/leer-remito-items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) },
        body: JSON.stringify({ remito_id: remito.id, forzar }),
      })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error)
      actualizar(json.items as ItemRemito[])
      await cargarNombres(json.items)
    } catch (e: any) {
      setErrorLectura(true)
      showToast(e?.message || 'No se pudieron leer los productos', 'err')
    } finally { setLeyendo(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remito.id])

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCargando(true)
      const { data } = await supabase.from('proveedor_remito_items').select('*').eq('remito_id', remito.id).order('orden')
      if (!vivo) return
      const lista = (data ?? []) as ItemRemito[]
      actualizar(lista); await cargarNombres(lista)
      setCargando(false)
      if (!lista.length && remito.items_estado === 'pendiente' && puedeEd && (remito.fotos?.length ?? 0) > 0 && yaLeyo.current !== remito.id) {
        yaLeyo.current = remito.id
        leer(false)
      }
    })()
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remito.id])

  useEffect(() => {
    if (!recargarKey) return
    ;(async () => {
      const { data } = await supabase.from('proveedor_remito_items').select('*').eq('remito_id', remito.id).order('orden')
      const lista = (data ?? []) as ItemRemito[]
      actualizar(lista); await cargarNombres(lista)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recargarKey])

  const material = async (id: number | null): Promise<MaterialConv | null> => {
    if (id === null) return null
    if (materiales.current.has(id)) return materiales.current.get(id) ?? null
    const { data } = await supabase.from('materiales').select('id, unidad_base, unidad_logistica, cant_x_unid_log, peso_kg_x_posicion').eq('id', id).maybeSingle()
    materiales.current.set(id, (data as MaterialConv) ?? null)
    return (data as MaterialConv) ?? null
  }

  const guardarFila = async (it: ItemRemito, cambios: Partial<ItemRemito>) => {
    const nuevo = { ...it, ...cambios }
    const conv = nuevo.producto_id === null
      ? { cantidad_base: null, unidad_base: null, regla: 'sin producto asignado' }
      : convertirABase(nuevo.cantidad, nuevo.unidad ?? '', await material(nuevo.producto_id))
    const fila = { ...cambios, cantidad_base: conv.cantidad_base, unidad_base: conv.unidad_base, regla_conversion: conv.regla }
    const { error } = await supabase.from('proveedor_remito_items').update(fila).eq('id', it.id)
    if (error) { showToast('No se pudo guardar el cambio', 'err'); return }
    actualizar(items.map(x => x.id === it.id ? { ...nuevo, ...fila } as ItemRemito : x))
  }

  const aprender = async (descripcion: string, productoId: number) => {
    if (!proveedorId) return
    await supabase.from('producto_alias_proveedor').upsert(
      { proveedor_id: proveedorId, texto_norm: claveAlias(descripcion), producto_id: productoId, creado_por: userId },
      { onConflict: 'proveedor_id,texto_norm' },
    )
  }

  const elegirProducto = async (it: ItemRemito, p: { id: number; nombre: string }) => {
    setAbierto(null)
    setNombres(prev => ({ ...prev, [p.id]: p.nombre }))
    await guardarFila(it, { producto_id: p.id, mapeo_origen: 'manual', mapeo_score: null })
    await aprender(it.descripcion, p.id)
  }

  const confirmar = async (it: ItemRemito) => {
    if (it.producto_id === null) return
    await guardarFila(it, { mapeo_origen: 'manual' })
    await aprender(it.descripcion, it.producto_id)
  }

  const quitarProducto = (it: ItemRemito) => guardarFila(it, { producto_id: null, mapeo_origen: 'ninguno', mapeo_score: null })

  const eliminar = async (it: ItemRemito) => {
    const { error } = await supabase.from('proveedor_remito_items').delete().eq('id', it.id)
    if (error) { showToast('No se pudo eliminar', 'err'); return }
    actualizar(items.filter(x => x.id !== it.id))
  }

  const agregar = async () => {
    const { data, error } = await supabase.from('proveedor_remito_items')
      .insert({ remito_id: remito.id, orden: items.length, descripcion: 'Nuevo renglón', mapeo_origen: 'ninguno', regla_conversion: 'sin producto asignado' })
      .select('*').single()
    if (error || !data) { showToast('No se pudo agregar', 'err'); return }
    actualizar([...items, data as ItemRemito])
  }

  const mapeados = items.filter(i => i.producto_id !== null).length
  const sinFotos = (remito.fotos?.length ?? 0) === 0

  return (
    <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', flex: 1 }}>
          Productos del remito {items.length > 0 && <span style={{ color: '#254A96' }}>· {mapeados} de {items.length} con producto asignado</span>}
        </span>
        {puedeEd && !sinFotos && !leyendo && (
          <button onClick={() => { if (!items.length || window.confirm('Vuelve a leer el remito y reemplaza lo que hay (incluidas tus correcciones). ¿Seguir?')) leer(true) }}
            style={{ ...inputSt, cursor: 'pointer', fontWeight: 600 }}>{items.length ? '↻ Releer con IA' : '✨ Leer productos'}</button>
        )}
      </div>

      {(cargando || leyendo) && <div style={{ fontSize: 13, color: '#254A96', padding: '8px 0' }}>{leyendo ? 'Leyendo los productos del remito… puede tardar unos segundos.' : 'Cargando…'}</div>}
      {sinFotos && !cargando && <div style={{ fontSize: 13, color: '#999' }}>Este remito no tiene fotos para leer.</div>}
      {errorLectura && !leyendo && <div style={{ fontSize: 13, color: '#b91c1c', marginBottom: 8 }}>No se pudieron leer los productos. Podés reintentar, cargar los renglones a mano o, si ya sabés la OC, asociarla más abajo y cargar los productos desde ahí.</div>}

      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
            <thead><tr>{['Renglón del remito', 'Cantidad', 'Unidad', 'Producto del catálogo', 'En unidad base', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {items.map(it => {
                const o = ORIGEN[it.mapeo_origen] ?? ORIGEN.ninguno
                return (
                  <tr key={it.id}>
                    <td style={td}>
                      <input defaultValue={it.descripcion} disabled={!puedeEd} onBlur={e => e.target.value !== it.descripcion && guardarFila(it, { descripcion: e.target.value.trim() || it.descripcion })} style={{ ...inputSt, width: '100%', minWidth: 170 }} />
                      {it.codigo_proveedor && <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>cód. proveedor {it.codigo_proveedor}</div>}
                    </td>
                    <td style={td}><input type="number" defaultValue={it.cantidad ?? ''} disabled={!puedeEd} style={{ ...inputSt, width: 84 }}
                      onBlur={e => { const n = e.target.value === '' ? null : Number(e.target.value); if (n !== it.cantidad) guardarFila(it, { cantidad: n }) }} /></td>
                    <td style={td}><input defaultValue={it.unidad_original ?? it.unidad ?? ''} disabled={!puedeEd} style={{ ...inputSt, width: 70 }}
                      onBlur={e => { const u = e.target.value.trim(); if (u !== (it.unidad_original ?? '')) guardarFila(it, { unidad_original: u || null, unidad: normalizarUnidad(u) || null }) }} /></td>
                    <td style={{ ...td, position: 'relative', minWidth: 220 }}>
                      <span title={o.texto} style={{ color: o.color, marginRight: 6 }}>{o.icono}</span>
                      {it.producto_id !== null ? <b>{nombres[it.producto_id] ?? `#${it.producto_id}`}</b> : <span style={{ color: '#b91c1c' }}>Sin asignar</span>}
                      {puedeEd && (
                        <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          <button onClick={() => setAbierto(abierto === it.id ? null : it.id)} style={{ ...inputSt, padding: '3px 9px', cursor: 'pointer', fontSize: 12 }}>{it.producto_id === null ? 'Elegir producto' : 'Cambiar'}</button>
                          {it.mapeo_origen === 'auto' && <button onClick={() => confirmar(it)} style={{ ...inputSt, padding: '3px 9px', cursor: 'pointer', fontSize: 12, borderColor: '#059669', color: '#065f46' }}>✔ Confirmar</button>}
                          {it.producto_id !== null && <button onClick={() => quitarProducto(it)} style={{ ...inputSt, padding: '3px 9px', cursor: 'pointer', fontSize: 12 }}>Quitar</button>}
                        </div>
                      )}
                      {abierto === it.id && <BuscadorProducto sugerencias={it.sugerencias.map(s => ({ ...s, nombre: nombres[s.id] ?? s.nombre }))} onElegir={p => elegirProducto(it, p)} onCerrar={() => setAbierto(null)} />}
                    </td>
                    <td style={td}>
                      {it.cantidad_base !== null
                        ? <b title={it.regla_conversion ?? ''}>{fmtNum(it.cantidad_base)} {it.unidad_base}</b>
                        : <span style={{ fontSize: 11, color: '#b91c1c' }}>{it.regla_conversion ?? '—'}</span>}
                      {it.cantidad_base !== null && it.regla_conversion && !/^misma|^unidad gen/.test(it.regla_conversion) && <div style={{ fontSize: 11, color: '#888' }}>{it.regla_conversion}</div>}
                    </td>
                    <td style={td}>{puedeEd && <button onClick={() => eliminar(it)} title="Eliminar renglón" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#991b1b' }}>✕</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {puedeEd && !cargando && !leyendo && <button onClick={agregar} style={{ ...inputSt, marginTop: 8, cursor: 'pointer', fontSize: 12 }}>＋ Agregar renglón</button>}
    </div>
  )
}
