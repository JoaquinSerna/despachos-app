'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { coincideTexto } from '../lib/compras-utils'
import { importarExcelOC, type ResumenImport } from '../lib/oc-import'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

export const ESTADO_OC: Record<string, { label: string; bg: string; fg: string }> = {
  waiting_reception: { label: 'Esperando recepción', bg: '#fffbeb', fg: '#92400e' },
  confirmed: { label: 'Confirmada', bg: '#ecfdf5', fg: '#065f46' },
  cancelled: { label: 'Cancelada', bg: '#f3f4f6', fg: '#6b7280' },
  draft: { label: 'Borrador', bg: '#f3f4f6', fg: '#6b7280' },
}

const card: React.CSSProperties = { background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14 }
const inputSt: React.CSSProperties = { padding: '10px 12px', borderRadius: 10, border: '1.5px solid #d6d6d6', fontSize: 14, background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' }
const th: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap', background: '#f9f9f9', color: '#254A96' }
const td: React.CSSProperties = { padding: '10px 12px', borderTop: '1px solid #f0f0f0', verticalAlign: 'top', fontSize: 13 }

export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 }))
export const fmtPlata = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }))
export const fmtFechaOC = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

export function BadgeOC({ estado }: { estado: string }) {
  const e = ESTADO_OC[estado] ?? { label: estado, bg: '#f3f4f6', fg: '#6b7280' }
  return <span style={{ background: e.bg, color: e.fg, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{e.label}</span>
}

interface Props {
  puedeEd: boolean
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onImportado: () => void
}

export default function OrdenesCompra({ puedeEd, showToast, onImportado }: Props) {
  const [ultimo, setUltimo] = useState<{ importado_en: string; total: number } | null>(null)
  const [estado, setEstado] = useState('waiting_reception')
  const [sucursal, setSucursal] = useState('Todas')
  const [texto, setTexto] = useState('')
  const [lista, setLista] = useState<any[]>([])
  const [cargando, setCargando] = useState(false)
  const [importando, setImportando] = useState(false)
  const [progreso, setProgreso] = useState('')
  const [resumen, setResumen] = useState<ResumenImport | null>(null)
  const [detalle, setDetalle] = useState<any | null>(null)

  const cargarUltimo = useCallback(async () => {
    const { data } = await supabase.from('ordenes_compra').select('importado_en').order('importado_en', { ascending: false }).limit(1)
    const { count } = await supabase.from('ordenes_compra').select('id', { count: 'exact', head: true })
    setUltimo(data?.length ? { importado_en: data[0].importado_en, total: count ?? 0 } : null)
  }, [])

  const cargarLista = useCallback(async () => {
    setCargando(true)
    let q = supabase.from('ordenes_compra')
      .select('*, proveedores(nombre), ordenes_compra_items(cantidad, cantidad_recibida)')
      .order('fecha_creacion', { ascending: false }).limit(300)
    if (estado !== 'todos') q = q.eq('estado', estado)
    if (sucursal !== 'Todas') q = q.eq('sucursal', sucursal)
    if (/^\d+$/.test(texto.trim())) q = q.eq('id', Number(texto.trim()))
    const { data } = await q
    setLista(data ?? [])
    setCargando(false)
  }, [estado, sucursal, texto])

  useEffect(() => { cargarUltimo() }, [cargarUltimo])
  useEffect(() => { cargarLista() }, [cargarLista])

  const importar = async (file: File | null) => {
    if (!file) return
    setImportando(true); setResumen(null)
    try {
      const r = await importarExcelOC(file, setProgreso)
      setResumen(r)
      showToast(`Importación lista: ${r.ocs} órdenes de compra`)
      await Promise.all([cargarUltimo(), cargarLista()])
      onImportado()
    } catch (e: any) {
      showToast(e?.message || 'No se pudo importar el archivo', 'err')
    } finally { setImportando(false); setProgreso('') }
  }

  const abrirDetalle = async (oc: any) => {
    const { data } = await supabase.from('ordenes_compra_items').select('*').eq('oc_id', oc.id).order('id')
    setDetalle({ ...oc, items: data ?? [] })
  }

  const filtradas = texto.trim() && !/^\d+$/.test(texto.trim())
    ? lista.filter(o => coincideTexto(`${o.proveedores?.nombre ?? ''} ${o.proveedor_nombre ?? ''} ${o.observaciones ?? ''}`, texto))
    : lista

  return (
    <>
      {puedeEd && (
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Importar órdenes de compra del ERP</div>
          <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
            Subí el Excel de compras exportado del ERP (hojas «compras» e «items_compras»). Solo se cargan las compras regulares; las actualizaciones de costo se ignoran.
            Podés reimportar cuando quieras: las OC se actualizan por número y los proveedores nuevos se crean solos.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ background: importando ? '#9ca3af' : '#254A96', color: '#fff', padding: '10px 18px', borderRadius: 10, fontWeight: 700, fontSize: 14, cursor: importando ? 'default' : 'pointer' }}>
              {importando ? 'Importando…' : '📥 Elegir Excel e importar'}
              <input type="file" accept=".xlsx,.xls" disabled={importando} style={{ display: 'none' }}
                onChange={e => { importar(e.target.files?.[0] ?? null); e.target.value = '' }} />
            </label>
            {importando && <span style={{ fontSize: 13, color: '#254A96' }}>{progreso}</span>}
            <span style={{ fontSize: 13, color: '#666' }}>
              {ultimo ? `Datos al ${new Date(ultimo.importado_en).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })} · ${ultimo.total} OC cargadas` : 'Todavía no se importó ningún archivo'}
            </span>
          </div>
          {resumen && (
            <div style={{ marginTop: 12, background: '#ecfdf5', border: '1px solid #bbf7d0', color: '#065f46', borderRadius: 10, padding: '10px 14px', fontSize: 13, lineHeight: 1.6 }}>
              <b>Importación terminada.</b> {resumen.ocs} órdenes de compra ({resumen.nuevas} nuevas, {resumen.actualizadas} actualizadas) con {resumen.items} productos.
              {' '}Se ignoraron {resumen.ignoradas} actualizaciones de costo.
              {resumen.sinSucursal > 0 && <> {resumen.sinSucursal} OC son de depósitos que no son sucursales de la app (obra, Tucumán, Pilar).</>}
              {resumen.proveedoresCreados.length > 0 && <div>Proveedores nuevos creados ({resumen.proveedoresCreados.length}): {resumen.proveedoresCreados.slice(0, 12).join(', ')}{resumen.proveedoresCreados.length > 12 ? '…' : ''}. Revisalos en la pestaña Proveedores.</div>}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={estado} onChange={e => setEstado(e.target.value)} style={inputSt}>
          <option value="waiting_reception">Esperando recepción</option><option value="confirmed">Confirmadas</option>
          <option value="cancelled">Canceladas</option><option value="draft">Borradores</option><option value="todos">Todas</option>
        </select>
        <select value={sucursal} onChange={e => setSucursal(e.target.value)} style={inputSt}>
          {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
        </select>
        <input value={texto} onChange={e => setTexto(e.target.value)} placeholder="🔍 N° de OC o proveedor…" style={{ ...inputSt, flex: 1, minWidth: 200 }} />
      </div>

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
            <thead><tr>{['OC', 'Fecha', 'Proveedor', 'Sucursal', 'Estado', 'Total', 'Productos con saldo', 'Factura'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {filtradas.map(o => {
                const its: any[] = o.ordenes_compra_items ?? []
                const conSaldo = its.filter(i => Number(i.cantidad) > Number(i.cantidad_recibida)).length
                return (
                  <tr key={o.id} onClick={() => abrirDetalle(o)} style={{ cursor: 'pointer' }}>
                    <td style={td}><b>{o.id}</b></td>
                    <td style={td}>{fmtFechaOC(o.fecha_creacion)}</td>
                    <td style={td}>{o.proveedores?.nombre ?? o.proveedor_nombre ?? '—'}</td>
                    <td style={td}>{o.sucursal ?? <span style={{ color: '#aaa' }}>{o.deposito ?? '—'}</span>}</td>
                    <td style={td}><BadgeOC estado={o.estado} /></td>
                    <td style={td}>{fmtPlata(o.total)}</td>
                    <td style={td}>{conSaldo} de {its.length}</td>
                    <td style={td}>{o.numero_factura ?? '—'}</td>
                  </tr>
                )
              })}
              {filtradas.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#B9BBB7', padding: 28 }}>{cargando ? 'Cargando…' : ultimo ? 'Sin órdenes de compra para esos filtros' : 'Importá el Excel del ERP para ver las órdenes de compra'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {lista.length >= 300 && <div style={{ fontSize: 12, color: '#999' }}>Se muestran las 300 más recientes; usá los filtros para acotar.</div>}

      {detalle && (
        <div onClick={() => setDetalle(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, overflowY: 'auto', padding: '24px 14px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#f4f4f3', maxWidth: 760, margin: '0 auto', borderRadius: 18, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 18, fontWeight: 800 }}>OC {detalle.id} · {detalle.proveedores?.nombre ?? detalle.proveedor_nombre}</div>
                <div style={{ fontSize: 13, color: '#666' }}>{fmtFechaOC(detalle.fecha_creacion)} · {detalle.deposito ?? '—'} · comprada por {detalle.comprado_por ?? '—'} · <BadgeOC estado={detalle.estado} /></div>
                {detalle.observaciones && <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>📝 {detalle.observaciones}</div>}
              </div>
              <button onClick={() => setDetalle(null)} style={{ ...inputSt, cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
                  <thead><tr>{['Producto', 'Pedido', 'Recibido', 'Saldo'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {detalle.items.map((i: any) => {
                      const saldo = Number(i.cantidad) - Number(i.cantidad_recibida)
                      return (
                        <tr key={i.id}>
                          <td style={td}>{i.nombre_producto}<div style={{ fontSize: 11, color: '#999' }}>cód. {i.codigo_producto ?? '—'}</div></td>
                          <td style={td}>{fmtNum(i.cantidad)}</td><td style={td}>{fmtNum(i.cantidad_recibida)}</td>
                          <td style={{ ...td, fontWeight: 700, color: saldo > 0 ? '#92400e' : '#065f46' }}>{fmtNum(Math.max(saldo, 0))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
