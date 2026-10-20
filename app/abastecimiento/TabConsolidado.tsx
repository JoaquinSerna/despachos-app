'use client'

import { useEffect, useMemo, useState } from 'react'
import type { jsPDF as JsPDFType } from 'jspdf'
import { supabase } from '@/app/supabase'

// Consolidado de transferencias: junta las solicitudes pendientes que van de una misma sucursal a otra
// y arma el listado total de materiales a mover, con el detalle de qué NV pidió cada cantidad.

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

interface ReqItem { id: string; id_producto: number | null; nombre_producto: string; cantidad_solicitada: number; cantidad_aprobada: number | null; notas: string | null }
interface Req {
  id: string; nv: string | null; cliente: string | null; sucursal_origen: string; sucursal_destino: string
  estado: string; fecha_solicitada: string | null; fecha_req: string; notas: string | null; requerimiento_items: ReqItem[]
}
interface PedidoNV { fecha: string | null; estado: string }
interface Aporte { reqId: string; nv: string | null; cliente: string | null; fecha: string | null; fuente: 'pedido' | 'solicitud' | null; pedidoEstado: string | null; cantidad: number; estado: string }
interface Producto { clave: string; id_producto: number | null; nombre: string; total: number; aportes: Aporte[] }
interface Ruta { origen: string; destino: string; solicitudes: number; productos: Producto[]; fechaMin: string | null; enPreparacion: Req[]; otras: number }

// Solo entran al consolidado las solicitudes ya aprobadas; las pendientes todavía no se preparan
const ESTADOS: { key: string; label: string }[] = [
  { key: 'conf_stock', label: 'Aprobada' },
  { key: 'preparacion', label: 'En preparación' },
]

const fmtFecha = (iso: string | null | undefined) => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}` }
const nf = (n: number) => n.toLocaleString('es-AR')
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

const PEDIDO_ACTIVO = ['pendiente', 'programado', 'en_camino']
const hoyISO = () => new Date().toISOString().slice(0, 10)

// Si la NV tiene varios pedidos (reprogramados, separados), se toma el próximo pedido todavía activo
function elegirPedido(lista: { fecha_entrega: string | null; estado: string }[]): PedidoNV | null {
  if (!lista.length) return null
  const activos = lista.filter(p => PEDIDO_ACTIVO.includes(p.estado) && p.fecha_entrega).sort((a, b) => a.fecha_entrega!.localeCompare(b.fecha_entrega!))
  const hoy = hoyISO()
  const elegido = activos.find(p => p.fecha_entrega! >= hoy) ?? activos[activos.length - 1]
    ?? [...lista].filter(p => p.fecha_entrega).sort((a, b) => b.fecha_entrega!.localeCompare(a.fecha_entrega!))[0]
  return elegido ? { fecha: elegido.fecha_entrega, estado: elegido.estado } : null
}

export default function TabConsolidado({ rol, showToast }: { rol: string; showToast: (msg: string, tipo?: 'ok' | 'err') => void }) {
  const [reqs, setReqs] = useState<Req[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [origen, setOrigen] = useState('')
  const [destino, setDestino] = useState('')
  const [estados, setEstados] = useState<string[]>(['conf_stock', 'preparacion'])
  const [buscar, setBuscar] = useState('')
  const [abiertos, setAbiertos] = useState<Record<string, boolean>>({})
  const [pedidosNV, setPedidosNV] = useState<Record<string, PedidoNV | null>>({})
  const [recarga, setRecarga] = useState(0)
  const [camiones, setCamiones] = useState<string[]>([])
  const [transito, setTransito] = useState<Ruta | null>(null)
  const [nViaje, setNViaje] = useState('')
  const [vehiculo, setVehiculo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const puedeMover = rol === 'deposito' || rol === 'gerencia'

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCargando(true); setError('')
      try {
        const res = await fetch('/api/requerimientos?tab=pendientes')
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Error al cargar')
        if (vivo) setReqs(Array.isArray(json) ? json : [])
      } catch (e: any) { if (vivo) setError(e.message) }
      if (vivo) setCargando(false)
    })()
    return () => { vivo = false }
  }, [recarga])

  // Fecha de entrega del pedido de cada NV (la solicitud muchas veces no trae fecha propia)
  useEffect(() => {
    const nvs = [...new Set(reqs.map(r => r.nv).filter((n): n is string => !!n && !!n.trim()))]
    if (!nvs.length) { setPedidosNV({}); return }
    let vivo = true
    ;(async () => {
      const por: Record<string, { fecha_entrega: string | null; estado: string }[]> = {}
      for (let i = 0; i < nvs.length; i += 200) {
        const { data } = await supabase.from('pedidos').select('nv, estado, fecha_entrega').in('nv', nvs.slice(i, i + 200))
        for (const p of (data ?? []) as any[]) { const k = String(p.nv); (por[k] ??= []).push({ fecha_entrega: p.fecha_entrega, estado: p.estado }) }
      }
      if (!vivo) return
      const mapa: Record<string, PedidoNV | null> = {}
      for (const nv of nvs) mapa[nv] = elegirPedido(por[nv] ?? [])
      setPedidosNV(mapa)
    })()
    return () => { vivo = false }
  }, [reqs])

  useEffect(() => {
    supabase.from('camiones_flota').select('codigo').order('codigo').then(({ data }) => setCamiones((data ?? []).map((c: any) => c.codigo)))
  }, [])

  // Solicitudes sin aprobar que quedan afuera del consolidado (con los mismos filtros de ruta)
  const sinAprobar = useMemo(() => reqs.filter(r => r.estado === 'pendiente'
    && (!origen || r.sucursal_origen === origen) && (!destino || r.sucursal_destino === destino)
    && (r.requerimiento_items ?? []).some(it => Number(it.cantidad_aprobada ?? it.cantidad_solicitada ?? 0) > 0)).length, [reqs, origen, destino])

  const rutas: Ruta[] = useMemo(() => {
    const q = norm(buscar.trim())
    const mapa = new Map<string, Ruta & { prods: Map<string, Producto> }>()
    for (const r of reqs) {
      if (!estados.includes(r.estado)) continue
      if (origen && r.sucursal_origen !== origen) continue
      if (destino && r.sucursal_destino !== destino) continue
      const k = `${r.sucursal_origen}→${r.sucursal_destino}`
      if (!mapa.has(k)) mapa.set(k, { origen: r.sucursal_origen, destino: r.sucursal_destino, solicitudes: 0, productos: [], fechaMin: null, enPreparacion: [], otras: 0, prods: new Map() })
      const ruta = mapa.get(k)!
      let aporto = false
      for (const it of r.requerimiento_items ?? []) {
        if (q && !norm(`${it.nombre_producto} ${it.id_producto ?? ''}`).includes(q)) continue
        const cant = Number(it.cantidad_aprobada ?? it.cantidad_solicitada ?? 0)
        if (!(cant > 0)) continue
        const clave = it.id_producto != null ? `id:${it.id_producto}` : `n:${norm(it.nombre_producto)}`
        if (!ruta.prods.has(clave)) ruta.prods.set(clave, { clave, id_producto: it.id_producto, nombre: it.nombre_producto, total: 0, aportes: [] })
        const p = ruta.prods.get(clave)!
        p.total += cant
        const ped = r.nv ? pedidosNV[r.nv] : null
        const fecha = ped?.fecha ?? r.fecha_solicitada ?? null
        p.aportes.push({ reqId: r.id, nv: r.nv, cliente: r.cliente, fecha, fuente: ped?.fecha ? 'pedido' : r.fecha_solicitada ? 'solicitud' : null,
          pedidoEstado: ped?.estado ?? null, cantidad: cant, estado: r.estado })
        aporto = true
      }
      if (aporto) {
        ruta.solicitudes++
        if (r.estado === 'preparacion') ruta.enPreparacion.push(r); else ruta.otras++
        const f = (r.nv ? pedidosNV[r.nv]?.fecha : null) ?? r.fecha_solicitada
        if (f && (!ruta.fechaMin || f < ruta.fechaMin)) ruta.fechaMin = f
      }
    }
    return [...mapa.values()]
      .map(({ prods, ...r }) => ({
        ...r,
        productos: [...prods.values()]
          .map(p => ({ ...p, aportes: p.aportes.sort((a, b) => (a.fecha ?? '9999').localeCompare(b.fecha ?? '9999')) }))
          .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      }))
      .filter(r => r.productos.length > 0)
      .sort((a, b) => a.origen.localeCompare(b.origen) || a.destino.localeCompare(b.destino))
  }, [reqs, estados, origen, destino, buscar, pedidosNV])

  const toggleEstado = (k: string) => setEstados(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])
  const claveRuta = (r: Ruta) => `${r.origen}→${r.destino}`
  const textoFecha = (a: Aporte) => a.nv && !a.fecha ? '⚠ sin fecha (la NV no tiene pedido cargado)'
    : !a.fecha ? '' : `${a.fuente === 'pedido' ? 'entrega del pedido' : 'entrega solicitada'} ${fmtFecha(a.fecha)}`
  const etiquetaAporte = (a: Aporte) => a.nv ? `NV ${a.nv}${a.cliente ? ` · ${a.cliente}` : ''}` : 'Sin NV (reposición)'

  async function marcarEnTransito() {
    if (!transito) return
    setEnviando(true)
    let ok = 0
    const fallos: string[] = []
    for (const r of transito.enPreparacion) {
      try {
        const res = await fetch('/api/requerimientos', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: r.id, estado: 'en_transito', n_viaje: nViaje.trim() || null, cod_vehiculo: vehiculo.trim() || null }),
        })
        const j = await res.json()
        if (!j.success) throw new Error(j.error ?? 'error')
        ok++
      } catch { fallos.push(r.nv ? `NV ${r.nv}` : r.id.slice(0, 6)) }
    }
    setEnviando(false)
    if (fallos.length) showToast(`${ok} en tránsito. No se pudieron pasar: ${fallos.join(', ')}`, 'err')
    else showToast(`${ok} solicitud${ok !== 1 ? 'es' : ''} en tránsito (${transito.origen} → ${transito.destino})`)
    setTransito(null); setNViaje(''); setVehiculo('')
    setRecarga(x => x + 1)
  }

  async function exportarExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const totales: Record<string, string | number>[] = []
    const detalle: Record<string, string | number>[] = []
    for (const r of rutas) {
      for (const p of r.productos) {
        totales.push({ 'Origen': r.origen, 'Destino': r.destino, 'ID Producto': p.id_producto ?? '', 'Producto': p.nombre, 'Cantidad total': p.total, 'Solicitudes': p.aportes.length })
        for (const a of p.aportes) {
          detalle.push({ 'Origen': r.origen, 'Destino': r.destino, 'ID Producto': p.id_producto ?? '', 'Producto': p.nombre, 'Cantidad': a.cantidad,
            'NV': a.nv ?? 'Sin NV', 'Cliente': a.cliente ?? '', 'Fecha de entrega': a.fecha ? fmtFecha(a.fecha) : '', 'Origen de la fecha': a.fuente === 'pedido' ? 'Pedido de la NV' : a.fuente === 'solicitud' ? 'Solicitud' : '', 'Estado': ESTADOS.find(e => e.key === a.estado)?.label ?? a.estado })
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(totales), 'Consolidado')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalle), 'Detalle por NV')
    XLSX.writeFile(wb, `consolidado-transferencias-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  async function descargarPDF() {
    const { jsPDF } = await import('jspdf') as { jsPDF: typeof JsPDFType }
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const ML = 14; const PH = 297; const MB = 14
    let y = 0
    const nueva = () => { doc.addPage(); y = 14 }
    const asegurar = (h: number) => { if (y + h > PH - MB) nueva() }

    doc.setFillColor(37, 74, 150); doc.rect(0, 0, 210, 20, 'F')
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15)
    doc.text('Consolidado de transferencias', ML, 12)
    doc.setFontSize(9); doc.setFont('helvetica', 'normal')
    doc.text(new Date().toLocaleDateString('es-AR'), 196, 12, { align: 'right' })
    y = 28

    for (const r of rutas) {
      asegurar(16)
      doc.setFillColor(232, 237, 248); doc.rect(ML - 2, y - 5, 186, 8, 'F')
      doc.setTextColor(37, 74, 150); doc.setFont('helvetica', 'bold'); doc.setFontSize(11)
      doc.text(`${r.origen} → ${r.destino}`, ML, y)
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
      doc.text(`${r.solicitudes} solicitud${r.solicitudes !== 1 ? 'es' : ''} · ${r.productos.length} producto${r.productos.length !== 1 ? 's' : ''}${r.fechaMin ? ` · primera entrega ${fmtFecha(r.fechaMin)}` : ''}`, 196, y, { align: 'right' })
      y += 7
      for (const p of r.productos) {
        asegurar(7 + (p.aportes.length > 1 || p.aportes[0]?.nv ? p.aportes.length * 4.5 : 0))
        doc.setTextColor(30, 30, 30); doc.setFont('helvetica', 'bold'); doc.setFontSize(10)
        const nombre = doc.splitTextToSize(p.nombre, 150)[0] as string
        doc.text(nombre, ML, y)
        doc.text(nf(p.total), 196, y, { align: 'right' })
        y += 4.5
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(90, 90, 90)
        if (p.aportes.length > 1 || p.aportes[0]?.nv) {
          for (const a of p.aportes) {
            asegurar(4.5)
            doc.text(`   ${nf(a.cantidad)}  ·  ${etiquetaAporte(a)}${textoFecha(a) ? `  ·  ${textoFecha(a)}` : ''}`, ML, y)
            y += 4
          }
        }
        y += 1.5
      }
      y += 5
    }
    doc.save(`consolidado-transferencias-${new Date().toISOString().slice(0, 10)}.pdf`)
  }

  const chip = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 16, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1.5px solid ${on ? '#254A96' : '#d6d6d6'}`, background: on ? '#254A96' : '#fff', color: on ? '#fff' : '#555',
  })

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="mb-5">
        <h2 className="text-lg font-semibold mb-1" style={{ color: '#254A96' }}>Consolidado de transferencias</h2>
        <p className="text-sm" style={{ color: '#6b7280' }}>
          Une las solicitudes aprobadas entre las mismas dos sucursales y suma los materiales a mover. Debajo de cada producto se ve qué NV pidió cada cantidad y para qué fecha.
        </p>
      </div>

      <div className="bg-white rounded-xl border p-4 mb-5" style={{ borderColor: '#e8edf8' }}>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Origen</label>
            <select value={origen} onChange={e => setOrigen(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }}>
              <option value="">Todas</option>{SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Destino</label>
            <select value={destino} onChange={e => setDestino(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }}>
              <option value="">Todas</option>{SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex-1" style={{ minWidth: 160 }}>
            <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Buscar producto</label>
            <input value={buscar} onChange={e => setBuscar(e.target.value)} placeholder="Nombre o ID" className="border rounded-lg px-3 py-2 text-sm w-full" style={{ borderColor: '#e8edf8' }} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          <span className="text-xs font-medium" style={{ color: '#666' }}>Estados:</span>
          {ESTADOS.map(e => <button key={e.key} onClick={() => toggleEstado(e.key)} style={chip(estados.includes(e.key))}>{e.label}</button>)}
          <div className="flex-1" />
          {rutas.length > 0 && (
            <>
              <button onClick={descargarPDF} className="px-4 py-2 text-sm font-medium rounded-lg" style={{ background: '#e8edf8', color: '#254A96' }}>⬇ PDF</button>
              <button onClick={exportarExcel} className="px-4 py-2 text-sm font-medium rounded-lg" style={{ background: '#d1fae5', color: '#065f46' }}>⬇ Excel</button>
            </>
          )}
        </div>
      </div>

      {sinAprobar > 0 && (
        <div className="rounded-lg px-4 py-2.5 mb-4 text-sm" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' }}>
          ⏳ Hay <b>{sinAprobar}</b> solicitud{sinAprobar !== 1 ? 'es' : ''} pendiente{sinAprobar !== 1 ? 's' : ''} de aprobar que no se incluye{sinAprobar !== 1 ? 'n' : ''} acá. Se aprueban o rechazan en la pestaña Transferencias.
        </div>
      )}
      {error && <div className="rounded-lg px-4 py-3 mb-4 text-sm" style={{ background: '#fde8e8', color: '#E52322' }}>{error}</div>}
      {cargando && <div className="text-sm text-center py-10" style={{ color: '#B9BBB7' }}>Cargando solicitudes…</div>}
      {!cargando && !error && rutas.length === 0 && (
        <div className="bg-white rounded-xl border p-8 text-center" style={{ borderColor: '#e8edf8' }}>
          <p className="text-sm" style={{ color: '#B9BBB7' }}>No hay solicitudes aprobadas con esos filtros.</p>
        </div>
      )}

      {transito && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => !enviando && setTransito(null)}>
          <div onClick={e => e.stopPropagation()} className="bg-white rounded-2xl p-5" style={{ width: '100%', maxWidth: 460 }}>
            <h3 className="font-bold mb-1" style={{ color: '#254A96', fontSize: 17 }}>Marcar en tránsito — {transito.origen} → {transito.destino}</h3>
            <p className="text-sm mb-3" style={{ color: '#6b7280' }}>
              Se van a pasar <b>{transito.enPreparacion.length}</b> solicitud{transito.enPreparacion.length !== 1 ? 'es' : ''} a "En tránsito" con el mismo viaje y vehículo:
            </p>
            <div className="text-xs mb-3 rounded-lg p-2" style={{ background: '#f4f6fb', color: '#444', maxHeight: 110, overflowY: 'auto' }}>
              {transito.enPreparacion.map(r => <div key={r.id}>{r.nv ? `NV ${r.nv}` : 'Sin NV'}{r.cliente ? ` · ${r.cliente}` : ''} — {r.requerimiento_items?.length ?? 0} producto{(r.requerimiento_items?.length ?? 0) !== 1 ? 's' : ''}</div>)}
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4">
              <div>
                <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>N° Viaje (ERP)</label>
                <input value={nViaje} onChange={e => setNViaje(e.target.value)} placeholder="ej: 1360" className="w-full border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="text-xs font-medium block mb-0.5" style={{ color: '#254A96' }}>Vehículo</label>
                <input value={vehiculo} onChange={e => setVehiculo(e.target.value)} list="camiones-consolidado" placeholder="Código o texto libre" className="w-full border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: '#e8edf8' }} />
                <datalist id="camiones-consolidado">{camiones.map(c => <option key={c} value={c} />)}</datalist>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setTransito(null)} disabled={enviando} className="flex-1 px-4 py-2.5 text-sm font-medium rounded-lg border" style={{ borderColor: '#d6d6d6', color: '#555' }}>Cancelar</button>
              <button onClick={marcarEnTransito} disabled={enviando} className="flex-1 px-4 py-2.5 text-sm font-semibold rounded-lg text-white disabled:opacity-60" style={{ background: '#1d4ed8' }}>{enviando ? 'Pasando…' : '🚚 Pasar a en tránsito'}</button>
            </div>
          </div>
        </div>
      )}

      {rutas.map(r => (
        <div key={claveRuta(r)} className="bg-white rounded-xl border overflow-hidden mb-5" style={{ borderColor: '#e8edf8' }}>
          <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2" style={{ background: '#e8edf8' }}>
            <span className="font-bold" style={{ color: '#254A96', fontSize: 16 }}>{r.origen} → {r.destino}</span>
            <span className="text-xs" style={{ color: '#254A96' }}>
              {r.solicitudes} solicitud{r.solicitudes !== 1 ? 'es' : ''} · {r.productos.length} producto{r.productos.length !== 1 ? 's' : ''}
              {r.fechaMin && <> · primera entrega <b>{fmtFecha(r.fechaMin)}</b></>}
            </span>
          </div>
          {puedeMover && (
            <div className="px-4 py-2 flex flex-wrap items-center gap-3" style={{ background: '#f9fafc', borderTop: '1px solid #e8edf8' }}>
              <button onClick={() => { setTransito(r); setNViaje(''); setVehiculo('') }} disabled={r.enPreparacion.length === 0}
                className="px-4 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-40" style={{ background: '#1d4ed8' }}>
                🚚 Marcar en tránsito ({r.enPreparacion.length})
              </button>
              <span className="text-xs" style={{ color: '#6b7280' }}>
                {r.enPreparacion.length === 0 ? 'Ninguna está en preparación todavía.' : 'Pasa a en tránsito todas las solicitudes de esta ruta que están en preparación.'}
                {r.otras > 0 && r.enPreparacion.length > 0 && <> Las otras {r.otras} todavía no están en preparación y no se tocan.</>}
              </span>
            </div>
          )}
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#f9fafc' }}>
                <th className="text-left px-4 py-2 text-xs font-semibold" style={{ color: '#666' }}>Material</th>
                <th className="text-right px-4 py-2 text-xs font-semibold" style={{ color: '#666' }}>Total a mover</th>
              </tr>
            </thead>
            <tbody>
              {r.productos.map(p => {
                const k = `${claveRuta(r)}|${p.clave}`
                const hayNV = p.aportes.some(a => a.nv)
                const abierto = abiertos[k] ?? (p.aportes.length > 1 || hayNV)
                return (
                  <tr key={p.clave} style={{ borderTop: '1px solid #f0f0f0', verticalAlign: 'top' }}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-start gap-2 flex-wrap">
                        <span style={{ color: '#1e1e1e', fontWeight: 600 }}>{p.nombre}</span>
                        {p.id_producto != null && <span className="text-xs" style={{ color: '#B9BBB7' }}>#{p.id_producto}</span>}
                        {p.aportes.length > 1 && (
                          <span className="text-xs font-bold rounded-full px-2 py-0.5" style={{ background: '#ede9fe', color: '#6d28d9' }}>{p.aportes.length} solicitudes unidas</span>
                        )}
                        {hayNV && (
                          <button onClick={() => setAbiertos(prev => ({ ...prev, [k]: !abierto }))} className="text-xs underline" style={{ color: '#254A96', background: 'none', border: 'none', cursor: 'pointer' }}>
                            {abierto ? 'ocultar detalle' : 'ver detalle'}
                          </button>
                        )}
                      </div>
                      {abierto && (
                        <div className="mt-1.5 space-y-1">
                          {p.aportes.map((a, i) => (
                            <div key={i} className="flex flex-wrap items-center gap-2 text-xs" style={{ color: '#555' }}>
                              <span className="font-bold" style={{ color: '#254A96', minWidth: 36 }}>{nf(a.cantidad)}</span>
                              {a.nv
                                ? <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' }}>NV {a.nv}{a.cliente ? ` · ${a.cliente}` : ''}</span>
                                : <span style={{ color: '#9ca3af' }}>Sin NV (reposición)</span>}
                              {textoFecha(a) && <span style={{ color: a.nv && !a.fecha ? '#b45309' : '#6b7280' }}>📅 {textoFecha(a).replace('⚠ ', '')}{a.pedidoEstado && !PEDIDO_ACTIVO.includes(a.pedidoEstado) ? ' (pedido ya ' + a.pedidoEstado.replace('_', ' ') + ')' : ''}</span>}
                              {a.estado !== 'pendiente' && <span style={{ color: '#9ca3af' }}>· {ESTADOS.find(e => e.key === a.estado)?.label ?? a.estado}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-bold" style={{ color: '#254A96', fontSize: 16, whiteSpace: 'nowrap' }}>{nf(p.total)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
