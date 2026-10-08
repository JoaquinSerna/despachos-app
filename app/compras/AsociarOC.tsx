'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { compararConSaldo, normalizarUnidad, type EstadoCantidad } from '../lib/remito-items'
import { BadgeOC, fmtFechaOC, fmtNum, fmtPlata } from './OrdenesCompra'
import type { ItemRemito } from './ProductosRemito'

export interface CambiosOC { oc_ids: number[]; sin_oc: boolean }

interface Props {
  ing: any
  rem: any
  items: ItemRemito[]
  userId: string | null
  puedeEd: boolean
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onChanged: (cambios: CambiosOC) => void
  onItemsAgregados: () => void
}

const DIAS_RECIENTES = 120
const btn = (bg = '#254A96', fg = '#fff'): React.CSSProperties => ({ padding: '7px 14px', borderRadius: 9, border: 'none', background: bg, color: fg, fontWeight: 700, fontSize: 13, cursor: 'pointer' })
const btnLine: React.CSSProperties = { padding: '6px 12px', borderRadius: 9, border: '1.5px solid #d6d6d6', background: '#fff', color: '#444', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap', background: '#f9f9f9', color: '#254A96', fontSize: 12 }
const td: React.CSSProperties = { padding: '8px 10px', borderTop: '1px solid #f0f0f0', verticalAlign: 'top', fontSize: 13 }

const RESULTADO: Record<EstadoCantidad, { texto: string; bg: string; fg: string }> = {
  coincide: { texto: '✓ Coincide con el saldo', bg: '#ecfdf5', fg: '#065f46' },
  parcial: { texto: 'Entrega parcial', bg: '#eef2fb', fg: '#254A96' },
  excede: { texto: '⚠ Excede el saldo', bg: '#fef2f2', fg: '#b91c1c' },
  sin_dato: { texto: 'Sin cantidad convertida', bg: '#fffbeb', fg: '#92400e' },
}

const saldoDe = (i: any) => Math.max(Number(i.cantidad) - Number(i.cantidad_recibida), 0)
const itemsDe = (oc: any): any[] => oc.ordenes_compra_items ?? []

function TablaItemsOC({ oc }: { oc: any }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
      <thead><tr>{['Producto', 'Pedido', 'Recibido', 'Saldo'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {itemsDe(oc).map((i: any) => (
          <tr key={i.id}><td style={td}>{i.nombre_producto}</td><td style={td}>{fmtNum(i.cantidad)}</td><td style={td}>{fmtNum(i.cantidad_recibida)}</td><td style={{ ...td, fontWeight: 700 }}>{fmtNum(saldoDe(i))}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

export default function AsociarOC({ ing, rem, items, userId, puedeEd, showToast, onChanged, onItemsAgregados }: Props) {
  const ids: number[] = useMemo(() => (rem.proveedor_remito_ocs ?? []).map((x: any) => x.oc_id as number), [rem.proveedor_remito_ocs])
  const clave = ids.join(',')
  const [asociadas, setAsociadas] = useState<any[]>([])
  const [candidatas, setCandidatas] = useState<any[]>([])
  const [citada, setCitada] = useState<any | null>(null)
  const [ultimoImport, setUltimoImport] = useState<string | null | undefined>(undefined)
  const [verTodas, setVerTodas] = useState(false)
  const [expandida, setExpandida] = useState<number | null>(null)
  const [cargando, setCargando] = useState(true)
  const [seleccion, setSeleccion] = useState<Record<string, string>>({})
  const [unidades, setUnidades] = useState<Record<number, string>>({})
  const [agregando, setAgregando] = useState(false)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data: imp } = await supabase.from('ordenes_compra').select('importado_en').order('importado_en', { ascending: false }).limit(1)
    setUltimoImport(imp?.length ? imp[0].importado_en : null)

    if (ids.length) {
      const { data } = await supabase.from('ordenes_compra').select('*, ordenes_compra_items(*)').in('id', ids)
      setAsociadas(ids.map(id => (data ?? []).find((o: any) => o.id === id)).filter(Boolean))
    } else setAsociadas([])

    if (!rem.sin_oc) {
      if (ing.proveedor_id && ing.sucursal) {
        const { data } = await supabase.from('ordenes_compra').select('*, ordenes_compra_items(*)')
          .eq('proveedor_id', ing.proveedor_id).eq('sucursal', ing.sucursal).eq('estado', 'waiting_reception')
          .order('fecha_creacion', { ascending: false }).limit(80)
        setCandidatas(data ?? [])
      } else setCandidatas([])
      const n = (String(rem.oc_numero_leido ?? '').match(/\d{1,9}/) ?? [])[0]
      if (n) {
        const { data } = await supabase.from('ordenes_compra').select('*, ordenes_compra_items(*)').eq('id', Number(n)).maybeSingle()
        setCitada(data ?? null)
      } else setCitada(null)
    } else { setCandidatas([]); setCitada(null) }
    setCargando(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rem.id, clave, rem.sin_oc, rem.oc_numero_leido, ing.proveedor_id, ing.sucursal])

  useEffect(() => { cargar() }, [cargar])

  useEffect(() => {
    const productos = [...new Set(asociadas.flatMap(oc => itemsDe(oc).map(i => i.codigo_producto as number)).filter(Boolean))]
    if (!productos.length) { setUnidades({}); return }
    supabase.from('materiales').select('id, unidad_base').in('id', productos).then(({ data }) => {
      setUnidades(Object.fromEntries((data ?? []).map((m: any) => [m.id, m.unidad_base ?? ''])))
    })
  }, [asociadas])

  const idsRemito = useMemo(() => new Set(items.map(i => i.producto_id).filter((x): x is number => x !== null)), [items])

  // Productos del remito que ya cubre alguna OC asociada: sirve para sugerir la próxima OC solo por lo que falta cubrir
  const cubiertos = useMemo(() => new Set(asociadas.flatMap(oc => itemsDe(oc).filter(i => saldoDe(i) > 0).map(i => i.codigo_producto as number))), [asociadas])
  const pendientes = useMemo(() => [...idsRemito].filter(id => !cubiertos.has(id)), [idsRemito, cubiertos])
  const coincidencias = (oc: any) => {
    const conSaldo = new Set(itemsDe(oc).filter(i => saldoDe(i) > 0).map(i => i.codigo_producto))
    return pendientes.filter(id => conSaldo.has(id)).length
  }

  const ordenadas = useMemo(() => {
    const limite = Date.now() - DIAS_RECIENTES * 86400000
    return candidatas
      .filter(o => !ids.includes(o.id))
      .filter(o => verTodas || !o.fecha_creacion || new Date(o.fecha_creacion).getTime() >= limite || o.id === citada?.id)
      .sort((a, b) => (b.id === citada?.id ? 1 : 0) - (a.id === citada?.id ? 1 : 0) || coincidencias(b) - coincidencias(a) || (b.fecha_creacion ?? '').localeCompare(a.fecha_creacion ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatas, verTodas, citada, pendientes, clave])
  const ocultas = candidatas.filter(o => !ids.includes(o.id)).length - ordenadas.length

  const agregar = async (ocId: number) => {
    const { error } = await supabase.from('proveedor_remito_ocs').insert({ remito_id: rem.id, oc_id: ocId, asociada_por: userId })
    if (error) { showToast(error.code === '23505' ? 'Esa OC ya está asociada' : 'No se pudo asociar la OC', 'err'); return }
    if (rem.sin_oc) await supabase.from('proveedor_remitos').update({ sin_oc: false }).eq('id', rem.id)
    showToast(`Asociado a la OC ${ocId}`)
    onChanged({ oc_ids: [...ids, ocId], sin_oc: false })
  }

  const quitar = async (ocId: number) => {
    const { error } = await supabase.from('proveedor_remito_ocs').delete().eq('remito_id', rem.id).eq('oc_id', ocId)
    if (error) { showToast('No se pudo quitar la OC', 'err'); return }
    showToast(`OC ${ocId} quitada`)
    onChanged({ oc_ids: ids.filter(x => x !== ocId), sin_oc: false })
  }

  const marcarSinOC = async (valor: boolean) => {
    if (valor) await supabase.from('proveedor_remito_ocs').delete().eq('remito_id', rem.id)
    const { error } = await supabase.from('proveedor_remitos').update({ sin_oc: valor }).eq('id', rem.id)
    if (error) { showToast('No se pudo guardar', 'err'); return }
    showToast(valor ? 'Marcado como sin OC' : 'Marca «sin OC» quitada')
    onChanged({ oc_ids: valor ? [] : ids, sin_oc: valor })
  }

  // Productos de las OC asociadas con saldo que todavía no están en el remito: se pueden cargar a mano desde acá
  const disponibles = useMemo(() => {
    const yaEnRemito = new Set(items.map(i => i.producto_id))
    return asociadas.flatMap(oc => itemsDe(oc).filter(i => saldoDe(i) > 0 && !yaEnRemito.has(i.codigo_producto)).map(i => ({ oc, i, clave: `${oc.id}:${i.id}` })))
  }, [asociadas, items])
  const elegidos = disponibles.filter(d => seleccion[d.clave] !== undefined)

  const agregarDesdeOC = async () => {
    const filas = []
    for (const [k, d] of elegidos.entries()) {
      const cantidad = Number(String(seleccion[d.clave]).replace(',', '.'))
      if (!Number.isFinite(cantidad) || cantidad <= 0) { showToast(`Ingresá la cantidad de «${d.i.nombre_producto}»`, 'err'); return }
      const unidadBase = unidades[d.i.codigo_producto] || null
      filas.push({
        remito_id: rem.id, orden: items.length + k, descripcion: d.i.nombre_producto ?? `Producto #${d.i.codigo_producto}`,
        cantidad, unidad: normalizarUnidad(unidadBase) || null, unidad_original: unidadBase, producto_id: d.i.codigo_producto,
        mapeo_origen: 'manual', mapeo_score: null, sugerencias: [], cantidad_base: cantidad, unidad_base: unidadBase,
        regla_conversion: `cargado desde la OC ${d.oc.id}`,
      })
    }
    if (!filas.length) return
    setAgregando(true)
    const { error } = await supabase.from('proveedor_remito_items').insert(filas)
    if (error) { setAgregando(false); showToast('No se pudieron agregar los productos', 'err'); return }
    await supabase.from('proveedor_remitos').update({ items_estado: 'ok', items_leidos_en: new Date().toISOString() }).eq('id', rem.id)
    setAgregando(false); setSeleccion({})
    showToast(`${filas.length} producto${filas.length !== 1 ? 's' : ''} agregado${filas.length !== 1 ? 's' : ''} al remito`)
    onItemsAgregados()
  }

  const comparacion = useMemo(() => {
    if (!asociadas.length) return null
    const filas = [...idsRemito].map(pid => {
      const delRemito = items.filter(i => i.producto_id === pid)
      const sinConv = delRemito.some(i => i.cantidad_base === null)
      const trae = sinConv ? null : delRemito.reduce((s, i) => s + (i.cantidad_base ?? 0), 0)
      const enOCs = asociadas.map(oc => ({ oc, item: itemsDe(oc).find(i => i.codigo_producto === pid) })).filter(x => x.item)
      const pedido = enOCs.reduce((s, x) => s + Number(x.item.cantidad), 0)
      const recibido = enOCs.reduce((s, x) => s + Number(x.item.cantidad_recibida), 0)
      const saldo = enOCs.reduce((s, x) => s + saldoDe(x.item), 0)
      return {
        pid, nombre: enOCs[0]?.item.nombre_producto ?? null, ocs: enOCs.map(x => x.oc.id as number),
        pedido, recibido, saldo, trae, unidad: delRemito.find(i => i.unidad_base)?.unidad_base ?? '',
        resultado: enOCs.length ? compararConSaldo(trae, saldo) : null,
      }
    })
    const noVienen = asociadas.map(oc => ({ id: oc.id as number, n: itemsDe(oc).filter(i => saldoDe(i) > 0 && !idsRemito.has(i.codigo_producto)).length })).filter(x => x.n > 0)
    return { filas, sinProducto: items.filter(i => i.producto_id === null).length, noVienen }
  }, [asociadas, items, idsRemito])

  if (cargando) return <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14, fontSize: 13, color: '#666' }}>Cargando órdenes de compra…</div>

  const hayAsociadas = asociadas.length > 0

  return (
    <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>
        Órdenes de compra {hayAsociadas && <span style={{ color: '#254A96' }}>· {asociadas.length} asociada{asociadas.length !== 1 ? 's' : ''}</span>}
      </div>

      {rem.sin_oc && !hayAsociadas && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ background: '#f3f4f6', color: '#444', borderRadius: 10, padding: '3px 10px', fontSize: 13, fontWeight: 700 }}>Marcado «sin OC»</span>
          {puedeEd && <button style={btnLine} onClick={() => marcarSinOC(false)}>Quitar</button>}
        </div>
      )}

      {asociadas.map(oc => (
        <div key={oc.id} style={{ border: '1.5px solid #254A96', background: '#f7f9fe', borderRadius: 12, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>OC {oc.id} <BadgeOC estado={oc.estado} /></div>
              <div style={{ fontSize: 12, color: '#666' }}>{fmtFechaOC(oc.fecha_creacion)} · {oc.deposito ?? '—'} · {oc.comprado_por ?? '—'} · {fmtPlata(oc.total)}</div>
              {oc.proveedor_id && ing.proveedor_id && oc.proveedor_id !== ing.proveedor_id && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>⚠ Esta OC es de otro proveedor ({oc.proveedor_nombre}).</div>}
            </div>
            <button style={btnLine} onClick={() => setExpandida(expandida === oc.id ? null : oc.id)}>{expandida === oc.id ? 'Ocultar productos' : 'Ver productos'}</button>
            {puedeEd && <button style={btnLine} onClick={() => quitar(oc.id)}>Quitar</button>}
          </div>
          {expandida === oc.id && <TablaItemsOC oc={oc} />}
        </div>
      ))}

      {puedeEd && hayAsociadas && disponibles.length > 0 && (
        <details open={items.length === 0} style={{ marginTop: 10, border: '1.5px solid #d6d6d6', borderRadius: 12, padding: '8px 12px' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700, fontSize: 14, color: '#254A96' }}>
            Cargar productos desde la OC{items.length === 0 ? ' (el remito no tiene productos cargados)' : ''}
          </summary>
          <div style={{ fontSize: 12, color: '#666', margin: '6px 0 8px' }}>
            Elegí qué productos trae este remito y en qué cantidad (en la unidad base de cada producto). Se agregan al remito y quedan listos para comparar contra el saldo.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
              <thead><tr>{['', 'Producto', 'OC', 'Saldo', 'Cantidad que trae', 'Unidad'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {disponibles.map(d => {
                  const marcado = seleccion[d.clave] !== undefined
                  return (
                    <tr key={d.clave} style={{ background: marcado ? '#f0f7ff' : undefined }}>
                      <td style={td}>
                        <input type="checkbox" checked={marcado} onChange={e => setSeleccion(prev => {
                          const n = { ...prev }
                          if (e.target.checked) n[d.clave] = String(saldoDe(d.i)); else delete n[d.clave]
                          return n
                        })} />
                      </td>
                      <td style={td}>{d.i.nombre_producto}</td>
                      <td style={td}>OC {d.oc.id}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{fmtNum(saldoDe(d.i))}</td>
                      <td style={td}>
                        <input type="number" min={0} step="any" disabled={!marcado} value={seleccion[d.clave] ?? ''}
                          onChange={e => setSeleccion(prev => ({ ...prev, [d.clave]: e.target.value }))}
                          style={{ width: 100, padding: '6px 8px', borderRadius: 8, border: '1.5px solid #d6d6d6', fontSize: 13 }} />
                      </td>
                      <td style={td}>{unidades[d.i.codigo_producto] || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button style={btnLine} onClick={() => setSeleccion(Object.fromEntries(disponibles.map(d => [d.clave, String(saldoDe(d.i))])))}>Marcar todos con el saldo</button>
            {elegidos.length > 0 && <button style={btnLine} onClick={() => setSeleccion({})}>Desmarcar</button>}
            <button style={{ ...btn(), opacity: elegidos.length && !agregando ? 1 : 0.5 }} disabled={!elegidos.length || agregando} onClick={agregarDesdeOC}>
              {agregando ? 'Agregando…' : `Agregar ${elegidos.length || ''} al remito`}
            </button>
          </div>
        </details>
      )}

      {comparacion && (
        <div style={{ marginTop: 12 }}>
          {comparacion.filas.length === 0 ? (
            <div style={{ fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '8px 12px' }}>
              Para comparar cantidades, asigná los productos del remito en la sección de arriba o cargalos desde la OC con el panel de acá abajo.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
                <thead><tr>{['Producto', 'OC', 'Pedido', 'Recibido (ERP)', 'Saldo', 'Trae este remito', 'Resultado'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {comparacion.filas.map(f => (
                    <tr key={f.pid}>
                      <td style={td}>{f.nombre ?? <span style={{ color: '#b91c1c' }}>Producto #{f.pid}</span>}</td>
                      {f.ocs.length ? (
                        <>
                          <td style={td}>{f.ocs.map(id => `OC ${id}`).join(' + ')}</td>
                          <td style={td}>{fmtNum(f.pedido)}</td><td style={td}>{fmtNum(f.recibido)}</td><td style={{ ...td, fontWeight: 700 }}>{fmtNum(f.saldo)}</td>
                        </>
                      ) : (<td style={td} colSpan={4}><span style={{ color: '#b91c1c' }}>No está en ninguna de las OC asociadas</span></td>)}
                      <td style={{ ...td, fontWeight: 700 }}>{f.trae === null ? '—' : `${fmtNum(f.trae)} ${f.unidad}`}</td>
                      <td style={td}>{f.resultado
                        ? <span style={{ background: RESULTADO[f.resultado].bg, color: RESULTADO[f.resultado].fg, borderRadius: 10, padding: '2px 9px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{RESULTADO[f.resultado].texto}</span>
                        : <span style={{ background: '#fef2f2', color: '#b91c1c', borderRadius: 10, padding: '2px 9px', fontSize: 12, fontWeight: 700 }}>Fuera de las OC</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
            {comparacion.sinProducto > 0 && <div>⚠ {comparacion.sinProducto} renglón(es) del remito sin producto asignado no se comparan.</div>}
            {comparacion.noVienen.map(x => <div key={x.id}>OC {x.id}: {x.n} producto(s) con saldo no vienen en este remito.</div>)}
            {asociadas.length > 1 && <div>Si un producto está en más de una OC asociada, se compara contra la suma de sus saldos.</div>}
            <div>El «Recibido (ERP)» sale del último Excel importado: no incluye este remito hasta que se cargue la recepción en el ERP.</div>
          </div>
        </div>
      )}

      {!rem.sin_oc && (
        <div style={{ marginTop: hayAsociadas ? 14 : 0 }}>
          {ultimoImport === null && (
            <div style={{ fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 12px' }}>
              Todavía no se importaron órdenes de compra. Subí el Excel del ERP en la pestaña «Órdenes de compra» para poder asociar este remito.
            </div>
          )}
          {ultimoImport && (
            <div style={{ fontSize: hayAsociadas ? 13 : 12, color: hayAsociadas ? '#254A96' : '#888', fontWeight: hayAsociadas ? 700 : 400, marginBottom: 8 }}>
              {hayAsociadas ? '¿Trae productos de otra OC? Agregala acá.' : `OC importadas el ${new Date(ultimoImport).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}.`}
              {hayAsociadas && pendientes.length > 0 && <span style={{ color: '#92400e', fontWeight: 400 }}> Quedan {pendientes.length} producto(s) del remito sin cubrir por las OC asociadas.</span>}
            </div>
          )}

          {citada && !ids.includes(citada.id) && (
            <div style={{ border: '2px solid #059669', background: '#ecfdf5', borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 800, color: '#065f46' }}>El remito cita la OC {citada.id}</div>
              <div style={{ fontSize: 12, color: '#065f46' }}>{citada.proveedor_nombre} · {fmtFechaOC(citada.fecha_creacion)} · {citada.sucursal ?? citada.deposito} · <BadgeOC estado={citada.estado} /></div>
              {citada.proveedor_id && ing.proveedor_id && citada.proveedor_id !== ing.proveedor_id && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>⚠ Es de otro proveedor distinto al del ingreso.</div>}
              {citada.sucursal && citada.sucursal !== ing.sucursal && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>⚠ Es de otra sucursal ({citada.sucursal}).</div>}
              {puedeEd && <button style={{ ...btn('#059669'), marginTop: 8 }} onClick={() => agregar(citada.id)}>✔ Asociar a la OC {citada.id}</button>}
            </div>
          )}

          {ordenadas.length === 0 && ultimoImport && (
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>No hay {hayAsociadas ? 'otras ' : ''}OC abiertas de este proveedor para {ing.sucursal}{ocultas > 0 ? ' en los últimos 120 días' : ''}.</div>
          )}
          {ordenadas.filter(o => o.id !== citada?.id).map(o => {
            const co = coincidencias(o)
            return (
              <div key={o.id} style={{ border: '1.5px solid #e0e0e0', borderRadius: 12, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <b>OC {o.id}</b> <span style={{ fontSize: 12, color: '#666' }}>· {fmtFechaOC(o.fecha_creacion)} · {o.comprado_por ?? '—'} · {fmtPlata(o.total)}</span>
                    {pendientes.length > 0 && <div style={{ fontSize: 12, color: co > 0 ? '#065f46' : '#999', fontWeight: co > 0 ? 700 : 400 }}>
                      {hayAsociadas ? `cubre ${co} de los ${pendientes.length} productos que faltan` : `${co} de ${pendientes.length} productos del remito están en esta OC con saldo`}
                    </div>}
                    {o.observaciones && <div style={{ fontSize: 12, color: '#888' }}>📝 {o.observaciones}</div>}
                  </div>
                  <button style={btnLine} onClick={() => setExpandida(expandida === o.id ? null : o.id)}>{expandida === o.id ? 'Ocultar productos' : 'Ver productos'}</button>
                  {puedeEd && <button style={btn()} onClick={() => agregar(o.id)}>{hayAsociadas ? 'Agregar' : 'Asociar'}</button>}
                </div>
                {expandida === o.id && <TablaItemsOC oc={o} />}
              </div>
            )
          })}
          {ocultas > 0 && !verTodas && <button style={btnLine} onClick={() => setVerTodas(true)}>Ver {ocultas} OC más antiguas</button>}
          {puedeEd && !hayAsociadas && <div style={{ marginTop: 10 }}><button style={btnLine} onClick={() => marcarSinOC(true)}>Este remito no tiene OC</button></div>}
        </div>
      )}
    </div>
  )
}
