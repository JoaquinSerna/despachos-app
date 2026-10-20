'use client'

import { useEffect, useMemo, useState } from 'react'
import type { jsPDF as JsPDFType } from 'jspdf'

// Consolidado de transferencias: junta las solicitudes pendientes que van de una misma sucursal a otra
// y arma el listado total de materiales a mover, con el detalle de qué NV pidió cada cantidad.

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

interface ReqItem { id: string; id_producto: number | null; nombre_producto: string; cantidad_solicitada: number; cantidad_aprobada: number | null; notas: string | null }
interface Req {
  id: string; nv: string | null; cliente: string | null; sucursal_origen: string; sucursal_destino: string
  estado: string; fecha_solicitada: string | null; fecha_req: string; notas: string | null; requerimiento_items: ReqItem[]
}
interface Aporte { reqId: string; nv: string | null; cliente: string | null; fecha: string | null; cantidad: number; estado: string }
interface Producto { clave: string; id_producto: number | null; nombre: string; total: number; aportes: Aporte[] }
interface Ruta { origen: string; destino: string; solicitudes: number; productos: Producto[]; fechaMin: string | null }

const ESTADOS: { key: string; label: string }[] = [
  { key: 'pendiente', label: 'Pendiente' },
  { key: 'conf_stock', label: 'Stock confirmado' },
  { key: 'preparacion', label: 'En preparación' },
]

const fmtFecha = (iso: string | null | undefined) => { if (!iso) return '—'; const [y, m, d] = iso.slice(0, 10).split('-'); return `${d}/${m}/${y}` }
const nf = (n: number) => n.toLocaleString('es-AR')
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export default function TabConsolidado() {
  const [reqs, setReqs] = useState<Req[]>([])
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState('')
  const [origen, setOrigen] = useState('')
  const [destino, setDestino] = useState('')
  const [estados, setEstados] = useState<string[]>(['pendiente', 'conf_stock', 'preparacion'])
  const [buscar, setBuscar] = useState('')
  const [abiertos, setAbiertos] = useState<Record<string, boolean>>({})

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
  }, [])

  const rutas: Ruta[] = useMemo(() => {
    const q = norm(buscar.trim())
    const mapa = new Map<string, Ruta & { prods: Map<string, Producto> }>()
    for (const r of reqs) {
      if (!estados.includes(r.estado)) continue
      if (origen && r.sucursal_origen !== origen) continue
      if (destino && r.sucursal_destino !== destino) continue
      const k = `${r.sucursal_origen}→${r.sucursal_destino}`
      if (!mapa.has(k)) mapa.set(k, { origen: r.sucursal_origen, destino: r.sucursal_destino, solicitudes: 0, productos: [], fechaMin: null, prods: new Map() })
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
        p.aportes.push({ reqId: r.id, nv: r.nv, cliente: r.cliente, fecha: r.fecha_solicitada, cantidad: cant, estado: r.estado })
        aporto = true
      }
      if (aporto) {
        ruta.solicitudes++
        if (r.fecha_solicitada && (!ruta.fechaMin || r.fecha_solicitada < ruta.fechaMin)) ruta.fechaMin = r.fecha_solicitada
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
  }, [reqs, estados, origen, destino, buscar])

  const toggleEstado = (k: string) => setEstados(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])
  const claveRuta = (r: Ruta) => `${r.origen}→${r.destino}`
  const etiquetaAporte = (a: Aporte) => a.nv ? `NV ${a.nv}${a.cliente ? ` · ${a.cliente}` : ''}` : 'Sin NV (reposición)'

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
            'NV': a.nv ?? 'Sin NV', 'Cliente': a.cliente ?? '', 'Entrega solicitada': a.fecha ? fmtFecha(a.fecha) : '', 'Estado': ESTADOS.find(e => e.key === a.estado)?.label ?? a.estado })
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
            doc.text(`   ${nf(a.cantidad)}  ·  ${etiquetaAporte(a)}${a.fecha ? `  ·  entrega ${fmtFecha(a.fecha)}` : ''}`, ML, y)
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
          Une las solicitudes pendientes entre las mismas dos sucursales y suma los materiales a mover. Debajo de cada producto se ve qué NV pidió cada cantidad y para qué fecha.
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

      {error && <div className="rounded-lg px-4 py-3 mb-4 text-sm" style={{ background: '#fde8e8', color: '#E52322' }}>{error}</div>}
      {cargando && <div className="text-sm text-center py-10" style={{ color: '#B9BBB7' }}>Cargando solicitudes…</div>}
      {!cargando && !error && rutas.length === 0 && (
        <div className="bg-white rounded-xl border p-8 text-center" style={{ borderColor: '#e8edf8' }}>
          <p className="text-sm" style={{ color: '#B9BBB7' }}>No hay transferencias pendientes con esos filtros.</p>
        </div>
      )}

      {rutas.map(r => (
        <div key={claveRuta(r)} className="bg-white rounded-xl border overflow-hidden mb-5" style={{ borderColor: '#e8edf8' }}>
          <div className="px-4 py-3 flex flex-wrap items-center justify-between gap-2" style={{ background: '#e8edf8' }}>
            <span className="font-bold" style={{ color: '#254A96', fontSize: 16 }}>{r.origen} → {r.destino}</span>
            <span className="text-xs" style={{ color: '#254A96' }}>
              {r.solicitudes} solicitud{r.solicitudes !== 1 ? 'es' : ''} · {r.productos.length} producto{r.productos.length !== 1 ? 's' : ''}
              {r.fechaMin && <> · primera entrega solicitada <b>{fmtFecha(r.fechaMin)}</b></>}
            </span>
          </div>
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
                              {a.fecha && <span style={{ color: '#6b7280' }}>📅 entrega {fmtFecha(a.fecha)}</span>}
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
