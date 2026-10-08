'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { compararConSaldo, type EstadoCantidad } from '../lib/remito-items'
import { BadgeOC, fmtFechaOC, fmtNum, fmtPlata } from './OrdenesCompra'
import type { ItemRemito } from './ProductosRemito'

interface Props {
  ing: any
  rem: any
  items: ItemRemito[]
  userId: string | null
  puedeEd: boolean
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onChanged: (cambios: { oc_id: number | null; sin_oc: boolean }) => void
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

function TablaItemsOC({ oc }: { oc: any }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
      <thead><tr>{['Producto', 'Pedido', 'Recibido', 'Saldo'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
      <tbody>
        {(oc.ordenes_compra_items ?? []).map((i: any) => (
          <tr key={i.id}><td style={td}>{i.nombre_producto}</td><td style={td}>{fmtNum(i.cantidad)}</td><td style={td}>{fmtNum(i.cantidad_recibida)}</td><td style={{ ...td, fontWeight: 700 }}>{fmtNum(saldoDe(i))}</td></tr>
        ))}
      </tbody>
    </table>
  )
}

export default function AsociarOC({ ing, rem, items, userId, puedeEd, showToast, onChanged }: Props) {
  const [actual, setActual] = useState<any | null>(null)
  const [candidatas, setCandidatas] = useState<any[]>([])
  const [citada, setCitada] = useState<any | null>(null)
  const [ultimoImport, setUltimoImport] = useState<string | null | undefined>(undefined)
  const [verTodas, setVerTodas] = useState(false)
  const [expandida, setExpandida] = useState<number | null>(null)
  const [cargando, setCargando] = useState(true)

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data: imp } = await supabase.from('ordenes_compra').select('importado_en').order('importado_en', { ascending: false }).limit(1)
    setUltimoImport(imp?.length ? imp[0].importado_en : null)

    if (rem.oc_id) {
      const { data } = await supabase.from('ordenes_compra').select('*, ordenes_compra_items(*)').eq('id', rem.oc_id).maybeSingle()
      setActual(data ?? null); setCandidatas([]); setCitada(null)
    } else {
      setActual(null)
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
    }
    setCargando(false)
  }, [rem.id, rem.oc_id, rem.oc_numero_leido, ing.proveedor_id, ing.sucursal])

  useEffect(() => { cargar() }, [cargar])

  const idsRemito = useMemo(() => new Set(items.map(i => i.producto_id).filter((x): x is number => x !== null)), [items])
  const coincidencias = (oc: any) => {
    const conSaldo = new Set((oc.ordenes_compra_items ?? []).filter((i: any) => saldoDe(i) > 0).map((i: any) => i.codigo_producto))
    return [...idsRemito].filter(id => conSaldo.has(id)).length
  }

  const ordenadas = useMemo(() => {
    const limite = Date.now() - DIAS_RECIENTES * 86400000
    return candidatas
      .filter(o => verTodas || !o.fecha_creacion || new Date(o.fecha_creacion).getTime() >= limite || o.id === citada?.id)
      .sort((a, b) => (b.id === citada?.id ? 1 : 0) - (a.id === citada?.id ? 1 : 0) || coincidencias(b) - coincidencias(a) || (b.fecha_creacion ?? '').localeCompare(a.fecha_creacion ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatas, verTodas, citada, idsRemito])
  const ocultas = candidatas.length - ordenadas.length

  const guardar = async (cambios: { oc_id: number | null; sin_oc: boolean }, mensaje: string) => {
    const quita = cambios.oc_id === null && !cambios.sin_oc
    const { error } = await supabase.from('proveedor_remitos').update({
      ...cambios, oc_asociada_por: quita ? null : userId, oc_asociada_en: quita ? null : new Date().toISOString(),
    }).eq('id', rem.id)
    if (error) { showToast('No se pudo guardar la asociación', 'err'); return }
    showToast(mensaje); onChanged(cambios)
  }

  const comparacion = useMemo(() => {
    if (!actual) return null
    const ocItems: any[] = actual.ordenes_compra_items ?? []
    const filas = [...idsRemito].map(pid => {
      const delRemito = items.filter(i => i.producto_id === pid)
      const sinConv = delRemito.some(i => i.cantidad_base === null)
      const trae = sinConv ? null : delRemito.reduce((s, i) => s + (i.cantidad_base ?? 0), 0)
      const ocItem = ocItems.find(i => i.codigo_producto === pid)
      return { pid, nombre: ocItem?.nombre_producto ?? null, ocItem, trae, unidad: delRemito.find(i => i.unidad_base)?.unidad_base ?? '' }
    })
    return { filas, sinProducto: items.filter(i => i.producto_id === null).length, noVienen: ocItems.filter(i => saldoDe(i) > 0 && !idsRemito.has(i.codigo_producto)).length }
  }, [actual, items, idsRemito])

  if (cargando) return <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14, fontSize: 13, color: '#666' }}>Cargando órdenes de compra…</div>

  return (
    <div style={{ background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 10 }}>Orden de compra</div>

      {rem.sin_oc && !actual && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ background: '#f3f4f6', color: '#444', borderRadius: 10, padding: '3px 10px', fontSize: 13, fontWeight: 700 }}>Marcado «sin OC»</span>
          {puedeEd && <button style={btnLine} onClick={() => guardar({ oc_id: null, sin_oc: false }, 'Asociación quitada')}>Quitar</button>}
        </div>
      )}

      {actual && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 16, fontWeight: 800 }}>OC {actual.id} <BadgeOC estado={actual.estado} /></div>
              <div style={{ fontSize: 12, color: '#666' }}>{fmtFechaOC(actual.fecha_creacion)} · {actual.deposito ?? '—'} · {actual.comprado_por ?? '—'} · {fmtPlata(actual.total)}</div>
              {actual.proveedor_id && ing.proveedor_id && actual.proveedor_id !== ing.proveedor_id && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>⚠ Esta OC es de otro proveedor ({actual.proveedor_nombre}).</div>}
            </div>
            {puedeEd && <button style={btnLine} onClick={() => guardar({ oc_id: null, sin_oc: false }, 'Asociación quitada')}>Quitar asociación</button>}
          </div>

          {comparacion && (
            <div style={{ marginTop: 12 }}>
              {comparacion.filas.length === 0 ? (
                <div style={{ fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '8px 12px' }}>
                  Para comparar cantidades, asigná los productos del remito en la sección de arriba.
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                    <thead><tr>{['Producto', 'Pedido', 'Recibido (ERP)', 'Saldo', 'Trae este remito', 'Resultado'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                    <tbody>
                      {comparacion.filas.map(f => {
                        const r = f.ocItem ? compararConSaldo(f.trae, saldoDe(f.ocItem)) : null
                        return (
                          <tr key={f.pid}>
                            <td style={td}>{f.nombre ?? <span style={{ color: '#b91c1c' }}>Producto #{f.pid}</span>}</td>
                            {f.ocItem ? (<><td style={td}>{fmtNum(f.ocItem.cantidad)}</td><td style={td}>{fmtNum(f.ocItem.cantidad_recibida)}</td><td style={{ ...td, fontWeight: 700 }}>{fmtNum(saldoDe(f.ocItem))}</td></>) : (<td style={td} colSpan={3}><span style={{ color: '#b91c1c' }}>No está en esta OC</span></td>)}
                            <td style={{ ...td, fontWeight: 700 }}>{f.trae === null ? '—' : `${fmtNum(f.trae)} ${f.unidad}`}</td>
                            <td style={td}>{r ? <span style={{ background: RESULTADO[r].bg, color: RESULTADO[r].fg, borderRadius: 10, padding: '2px 9px', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>{RESULTADO[r].texto}</span> : <span style={{ background: '#fef2f2', color: '#b91c1c', borderRadius: 10, padding: '2px 9px', fontSize: 12, fontWeight: 700 }}>Fuera de la OC</span>}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ fontSize: 12, color: '#666', marginTop: 6 }}>
                {comparacion.sinProducto > 0 && <div>⚠ {comparacion.sinProducto} renglón(es) del remito sin producto asignado no se comparan.</div>}
                {comparacion.noVienen > 0 && <div>{comparacion.noVienen} producto(s) de la OC con saldo no vienen en este remito.</div>}
                <div>El «Recibido (ERP)» sale del último Excel importado: no incluye este remito hasta que se cargue la recepción en el ERP.</div>
              </div>
            </div>
          )}
          <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', fontSize: 13, color: '#254A96' }}>Ver todos los productos de la OC</summary><TablaItemsOC oc={actual} /></details>
        </>
      )}

      {!actual && !rem.sin_oc && (
        <>
          {ultimoImport === null && (
            <div style={{ fontSize: 13, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 12px' }}>
              Todavía no se importaron órdenes de compra. Subí el Excel del ERP en la pestaña «Órdenes de compra» para poder asociar este remito.
            </div>
          )}
          {ultimoImport && <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>OC importadas el {new Date(ultimoImport).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}.</div>}

          {citada && (
            <div style={{ border: '2px solid #059669', background: '#ecfdf5', borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <div style={{ fontWeight: 800, color: '#065f46' }}>El remito cita la OC {citada.id}</div>
              <div style={{ fontSize: 12, color: '#065f46' }}>{citada.proveedor_nombre} · {fmtFechaOC(citada.fecha_creacion)} · {citada.sucursal ?? citada.deposito} · <BadgeOC estado={citada.estado} /></div>
              {citada.proveedor_id && ing.proveedor_id && citada.proveedor_id !== ing.proveedor_id && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>⚠ Es de otro proveedor distinto al del ingreso.</div>}
              {citada.sucursal && citada.sucursal !== ing.sucursal && <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>⚠ Es de otra sucursal ({citada.sucursal}).</div>}
              {puedeEd && <button style={{ ...btn('#059669'), marginTop: 8 }} onClick={() => guardar({ oc_id: citada.id, sin_oc: false }, `Asociado a la OC ${citada.id}`)}>✔ Asociar a la OC {citada.id}</button>}
            </div>
          )}

          {ordenadas.length === 0 && ultimoImport && (
            <div style={{ fontSize: 13, color: '#666', marginBottom: 8 }}>No hay OC abiertas de este proveedor para {ing.sucursal}{ocultas > 0 ? ' en los últimos 120 días' : ''}.</div>
          )}
          {ordenadas.filter(o => o.id !== citada?.id).map(o => {
            const co = coincidencias(o)
            return (
              <div key={o.id} style={{ border: '1.5px solid #e0e0e0', borderRadius: 12, padding: 10, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <b>OC {o.id}</b> <span style={{ fontSize: 12, color: '#666' }}>· {fmtFechaOC(o.fecha_creacion)} · {o.comprado_por ?? '—'} · {fmtPlata(o.total)}</span>
                    {idsRemito.size > 0 && <div style={{ fontSize: 12, color: co > 0 ? '#065f46' : '#999', fontWeight: co > 0 ? 700 : 400 }}>{co} de {idsRemito.size} productos del remito están en esta OC con saldo</div>}
                    {o.observaciones && <div style={{ fontSize: 12, color: '#888' }}>📝 {o.observaciones}</div>}
                  </div>
                  <button style={btnLine} onClick={() => setExpandida(expandida === o.id ? null : o.id)}>{expandida === o.id ? 'Ocultar productos' : 'Ver productos'}</button>
                  {puedeEd && <button style={btn()} onClick={() => guardar({ oc_id: o.id, sin_oc: false }, `Asociado a la OC ${o.id}`)}>Asociar</button>}
                </div>
                {expandida === o.id && <TablaItemsOC oc={o} />}
              </div>
            )
          })}
          {ocultas > 0 && !verTodas && <button style={btnLine} onClick={() => setVerTodas(true)}>Ver {ocultas} OC más antiguas</button>}
          {puedeEd && <div style={{ marginTop: 10 }}><button style={btnLine} onClick={() => guardar({ oc_id: null, sin_oc: true }, 'Marcado como sin OC')}>Este remito no tiene OC</button></div>}
        </>
      )}
    </div>
  )
}
