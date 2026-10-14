'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { coincideTexto } from '../lib/compras-utils'
import { fechaLocal } from '../lib/compras'
import { importarExcelHuemul, type ResumenHuemul } from '../lib/huemul-import'
import {
  claveProveedor, cruzarRemitos, exportadoEnDeNombre, mismoRemito, parsearRemito,
  type EstadoCruce, type RemitoGuardia, type ResultadoCruce,
} from '../lib/huemul-utils'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

const card: React.CSSProperties = { background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14 }
const inputSt: React.CSSProperties = { padding: '10px 12px', borderRadius: 10, border: '1.5px solid #d6d6d6', fontSize: 14, background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' }
const btnLine: React.CSSProperties = { padding: '8px 14px', borderRadius: 10, border: '1.5px solid #d6d6d6', background: '#fff', color: '#444', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const th: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap', background: '#f9f9f9', color: '#254A96' }
const td: React.CSSProperties = { padding: '10px 12px', borderTop: '1px solid #f0f0f0', verticalAlign: 'top', fontSize: 13 }

const ESTADO: Record<EstadoCruce, { label: string; bg: string; fg: string }> = {
  cargado: { label: '✅ Cargado en Huemul', bg: '#ecfdf5', fg: '#065f46' },
  sin_cargar: { label: '❌ Sin cargar', bg: '#fef2f2', fg: '#b91c1c' },
  sin_numero: { label: '❓ Sin número: revisar a mano', bg: '#fffbeb', fg: '#92400e' },
  posterior_al_export: { label: '⏳ Posterior al export', bg: '#f3f4f6', fg: '#6b7280' },
}

const fmtFecha = (f: string | null) => (f ? f.split('-').reverse().join('/') : '—')
const fmtFechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const sumarDias = (f: string, d: number) => { const x = new Date(`${f}T12:00:00`); x.setDate(x.getDate() + d); return fechaLocal(x) }
const diasDesde = (f: string) => Math.max(0, Math.round((Date.now() - new Date(`${f}T12:00:00`).getTime()) / 86400000))

const csvCell = (v: any) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function descargarCSV(contenido: string, nombre: string) {
  const blob = new Blob(['﻿' + contenido], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = nombre; a.click()
  URL.revokeObjectURL(url)
}

// Trae todas las filas de una consulta paginada (la API devuelve hasta 1000 por pedido)
async function leerTodo<T>(consulta: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const filas: T[] = []
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await consulta(desde, desde + 999)
    if (error) throw error
    filas.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return filas
}

interface Props {
  puedeEd: boolean
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}

type Vista = 'cruce' | 'huemul'

export default function IngresosHuemul({ puedeEd, showToast }: Props) {
  const hoy = fechaLocal()
  const [vista, setVista] = useState<Vista>('cruce')
  const [desde, setDesde] = useState(sumarDias(hoy, -30))
  const [hasta, setHasta] = useState(hoy)
  const [sucursal, setSucursal] = useState('Todas')
  const [texto, setTexto] = useState('')
  const [ultima, setUltima] = useState<any | null>(null)
  const [importando, setImportando] = useState(false)
  const [progreso, setProgreso] = useState('')
  const [resumen, setResumen] = useState<ResumenHuemul | null>(null)
  const [cargando, setCargando] = useState(false)

  // Vista 1: remitos de guardia y si están cargados en Huemul
  const [remitos, setRemitos] = useState<(RemitoGuardia & { sucursal: string; origen: string; ocs: number[] })[]>([])
  const [cruce, setCruce] = useState<Map<string, ResultadoCruce>>(new Map())
  const [filtroEstado, setFiltroEstado] = useState<'pendientes' | 'todos' | EstadoCruce>('pendientes')

  // Vista 2: ingresos de Huemul y si tienen remito en guardia
  const [ingresosH, setIngresosH] = useState<any[]>([])
  const [filtroGuardia, setFiltroGuardia] = useState<'todos' | 'sin_remito'>('todos')

  const cargarUltima = useCallback(async () => {
    const { data } = await supabase.from('huemul_importaciones').select('*').order('importado_en', { ascending: false }).limit(1)
    setUltima(data?.[0] ?? null)
  }, [])
  useEffect(() => { cargarUltima() }, [cargarUltima])

  // Los remitos que entraron a guardia el día del export (o después) todavía no pueden estar en el archivo
  const limiteJuzgable = useMemo(() => {
    const dia = ultima?.exportado_en ? fechaLocal(new Date(ultima.exportado_en)) : null
    return dia ? sumarDias(dia, -1) : null
  }, [ultima])

  const cargarCruce = useCallback(async () => {
    setCargando(true)
    try {
      const filas = await leerTodo<any>((a, b) => {
        let q = supabase.from('proveedor_remitos')
          .select('id, numero_remito, proveedor_remito_ocs(oc_id), proveedor_ingresos!inner(fecha, sucursal, origen, proveedor_id, proveedores(nombre))')
          .gte('proveedor_ingresos.fecha', desde).lte('proveedor_ingresos.fecha', hasta)
          .order('id').range(a, b)
        if (sucursal !== 'Todas') q = q.eq('proveedor_ingresos.sucursal', sucursal)
        return q
      })
      const lista = filas.map(r => {
        const ing = Array.isArray(r.proveedor_ingresos) ? r.proveedor_ingresos[0] : r.proveedor_ingresos
        const prov = Array.isArray(ing?.proveedores) ? ing.proveedores[0] : ing?.proveedores
        return {
          id: r.id as string, numero_remito: r.numero_remito as string, fecha: ing?.fecha as string,
          proveedor_id: (ing?.proveedor_id ?? null) as string | null, proveedor_nombre: (prov?.nombre ?? null) as string | null,
          sucursal: ing?.sucursal as string, origen: ing?.origen as string,
          ocs: ((r.proveedor_remito_ocs ?? []) as any[]).map(o => o.oc_id as number),
        }
      })
      const numeros = [...new Set(lista.map(r => parsearRemito(r.numero_remito).numero).filter((n): n is number => n !== null))]
      const huemul: any[] = []
      for (let i = 0; i < numeros.length; i += 300) {
        const { data, error } = await supabase.from('huemul_ingresos')
          .select('numero_ingreso, fecha, proveedor_id, proveedor_clave, punto_remito, nro_remito, sin_numero')
          .in('nro_remito', numeros.slice(i, i + 300))
        if (error) throw error
        huemul.push(...(data ?? []))
      }
      setRemitos(lista)
      setCruce(cruzarRemitos(lista, huemul, limiteJuzgable))
    } catch (e: any) { showToast(e?.message || 'No se pudo armar el cruce', 'err') }
    setCargando(false)
  }, [desde, hasta, sucursal, limiteJuzgable, showToast])

  const cargarHuemul = useCallback(async () => {
    setCargando(true)
    try {
      const filas = await leerTodo<any>((a, b) => {
        let q = supabase.from('huemul_ingresos').select('*').gte('fecha', desde).lte('fecha', hasta).order('numero_ingreso').order('linea').range(a, b)
        if (sucursal !== 'Todas') q = q.eq('sucursal', sucursal)
        return q
      })
      // Remitos de guardia (todos): para saber si cada ingreso de Huemul pasó por guardia
      const guardia = await leerTodo<any>((a, b) => supabase.from('proveedor_remitos')
        .select('id, numero_remito, proveedor_ingresos(fecha, proveedor_id, proveedores(nombre))').order('id').range(a, b))
      const porNumero = new Map<number, { punto: number | null; clave: string; proveedor_id: string | null }[]>()
      let primeraGuardia: string | null = null
      for (const g of guardia) {
        const ing = Array.isArray(g.proveedor_ingresos) ? g.proveedor_ingresos[0] : g.proveedor_ingresos
        const prov = Array.isArray(ing?.proveedores) ? ing.proveedores[0] : ing?.proveedores
        if (ing?.fecha && (!primeraGuardia || ing.fecha < primeraGuardia)) primeraGuardia = ing.fecha
        const p = parsearRemito(g.numero_remito)
        if (p.numero === null) continue
        porNumero.set(p.numero, [...(porNumero.get(p.numero) ?? []), { punto: p.punto, clave: claveProveedor(prov?.nombre), proveedor_id: ing?.proveedor_id ?? null }])
      }
      const agrupados = new Map<number, any>()
      for (const f of filas) {
        const g = agrupados.get(f.numero_ingreso) ?? { ...f, lineas: 0, productos: [] as string[] }
        g.lineas++
        if (f.descripcion) g.productos.push(f.descripcion)
        agrupados.set(f.numero_ingreso, g)
      }
      const lista = [...agrupados.values()].map(g => {
        let guardiaEstado: 'si' | 'no' | 'anterior' | 'sin_numero' = 'no'
        if (g.sin_numero) guardiaEstado = 'sin_numero'
        else if (!primeraGuardia || (g.fecha && g.fecha < primeraGuardia)) guardiaEstado = 'anterior'
        else {
          const cand = porNumero.get(g.nro_remito) ?? []
          const ok = cand.some(c => mismoRemito({ punto: c.punto, numero: g.nro_remito, sinNumero: false }, { punto: g.punto_remito, numero: g.nro_remito, sinNumero: false })
            && ((c.proveedor_id && c.proveedor_id === g.proveedor_id) || (c.clave && c.clave === g.proveedor_clave)))
          guardiaEstado = ok ? 'si' : 'no'
        }
        return { ...g, guardiaEstado }
      }).sort((a, b) => b.numero_ingreso - a.numero_ingreso)
      setIngresosH(lista)
    } catch (e: any) { showToast(e?.message || 'No se pudieron cargar los ingresos', 'err') }
    setCargando(false)
  }, [desde, hasta, sucursal, showToast])

  useEffect(() => { if (vista === 'cruce') cargarCruce() }, [vista, cargarCruce])
  useEffect(() => { if (vista === 'huemul') cargarHuemul() }, [vista, cargarHuemul])

  const importar = async (file: File | undefined) => {
    if (!file) return
    const exp = exportadoEnDeNombre(file.name)
    if (ultima?.exportado_en && exp && new Date(exp) < new Date(ultima.exportado_en)
      && !window.confirm(`Este archivo (${file.name}) es más viejo que el último importado. ¿Importarlo igual?`)) return
    setImportando(true); setResumen(null)
    try {
      const r = await importarExcelHuemul(file, setProgreso)
      setResumen(r)
      showToast('Ingresos de Huemul importados')
      await cargarUltima()
      if (vista === 'cruce') cargarCruce(); else cargarHuemul()
    } catch (e: any) { showToast(e?.message || 'No se pudo importar el archivo', 'err') }
    setImportando(false); setProgreso('')
  }

  // ── Vista 1 ──
  const conteo = useMemo(() => {
    const c: Record<EstadoCruce, number> = { cargado: 0, sin_cargar: 0, sin_numero: 0, posterior_al_export: 0 }
    for (const r of remitos) c[cruce.get(r.id)?.estado ?? 'sin_cargar']++
    return c
  }, [remitos, cruce])

  const filasCruce = useMemo(() => remitos.filter(r => {
    const e = cruce.get(r.id)?.estado ?? 'sin_cargar'
    if (filtroEstado === 'pendientes' ? !(e === 'sin_cargar' || e === 'sin_numero') : filtroEstado !== 'todos' && e !== filtroEstado) return false
    return !texto.trim() || coincideTexto([r.proveedor_nombre, r.numero_remito, r.sucursal].filter(Boolean).join(' '), texto)
  }).sort((a, b) => a.fecha.localeCompare(b.fecha)), [remitos, cruce, filtroEstado, texto])

  const exportarCruce = () => {
    const cols = ['fecha_guardia', 'sucursal', 'proveedor', 'origen', 'numero_remito', 'oc_asociadas', 'estado_huemul', 'ingresos_huemul', 'dias_desde_ingreso']
    const lineas = [cols.join(';')]
    for (const r of filasCruce) {
      const c = cruce.get(r.id)
      const f: Record<string, any> = {
        fecha_guardia: r.fecha, sucursal: r.sucursal, proveedor: r.proveedor_nombre, origen: r.origen, numero_remito: r.numero_remito,
        oc_asociadas: r.ocs.join(' + '), estado_huemul: ESTADO[c?.estado ?? 'sin_cargar'].label.replace(/^\S+\s/, ''),
        ingresos_huemul: (c?.ingresos ?? []).join(' + '), dias_desde_ingreso: diasDesde(r.fecha),
      }
      lineas.push(cols.map(k => csvCell(f[k])).join(';'))
    }
    descargarCSV(lineas.join('\n'), `remitos_vs_huemul_${desde}_a_${hasta}.csv`)
  }

  // ── Vista 2 ──
  const filasHuemul = useMemo(() => ingresosH.filter(g => {
    if (filtroGuardia === 'sin_remito' && g.guardiaEstado !== 'no') return false
    return !texto.trim() || coincideTexto([g.proveedor, g.numero_remito, g.numero_ingreso, g.usuario].filter(Boolean).join(' '), texto)
  }), [ingresosH, filtroGuardia, texto])

  const exportarHuemul = () => {
    const cols = ['numero_ingreso', 'fecha', 'sucursal', 'deposito', 'proveedor', 'numero_remito', 'orden_compra', 'usuario', 'lineas', 'en_guardia']
    const lineas = [cols.join(';')]
    const etiqueta = { si: 'si', no: 'NO', anterior: 'anterior al uso de guardia', sin_numero: 'remito sin número' } as const
    for (const g of filasHuemul) {
      const f: Record<string, any> = {
        numero_ingreso: g.numero_ingreso, fecha: g.fecha, sucursal: g.sucursal, deposito: g.deposito, proveedor: g.proveedor,
        numero_remito: g.numero_remito, orden_compra: g.compra, usuario: g.usuario, lineas: g.lineas, en_guardia: etiqueta[g.guardiaEstado as keyof typeof etiqueta],
      }
      lineas.push(cols.map(k => csvCell(f[k])).join(';'))
    }
    descargarCSV(lineas.join('\n'), `ingresos_huemul_${desde}_a_${hasta}.csv`)
  }

  return (
    <>
      {/* Importación */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#254A96' }}>Ingresos cargados en Huemul</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
              {ultima
                ? <>Último export: <b>{fmtFechaHora(ultima.exportado_en)}</b> · {ultima.ingresos?.toLocaleString('es-AR')} ingresos del {fmtFecha(ultima.fecha_desde)} al {fmtFecha(ultima.fecha_hasta)} · importado el {fmtFechaHora(ultima.importado_en)}</>
                : 'Todavía no se importó ningún export de Huemul.'}
            </div>
          </div>
          {puedeEd && (
            <label style={{ ...btnLine, background: '#254A96', color: '#fff', border: '1.5px solid #254A96', opacity: importando ? 0.6 : 1, cursor: importando ? 'wait' : 'pointer' }}>
              {importando ? 'Importando…' : '⬆ Importar export de Huemul (.xlsx)'}
              <input type="file" accept=".xlsx,.xls" disabled={importando} style={{ display: 'none' }}
                onChange={e => { importar(e.target.files?.[0]); e.target.value = '' }} />
            </label>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
          Usá el export «Ingresos de Compras» (compras_ingreso_AAAAMMDD_HHMM.xlsx). Trae todo el histórico: al subir uno nuevo se actualizan los ingresos que ya estaban.
        </div>
        {importando && progreso && <div style={{ fontSize: 13, color: '#254A96', marginTop: 8 }}>{progreso}</div>}
        {resumen && (
          <div style={{ marginTop: 10, background: '#ecfdf5', border: '1px solid #bbf7d0', color: '#065f46', borderRadius: 10, padding: '9px 11px', fontSize: 13 }}>
            Importadas <b>{resumen.filas.toLocaleString('es-AR')}</b> líneas de <b>{resumen.ingresos.toLocaleString('es-AR')}</b> ingresos
            ({resumen.nuevos.toLocaleString('es-AR')} nuevos, {resumen.actualizados.toLocaleString('es-AR')} actualizados) del {fmtFecha(resumen.fechaDesde)} al {fmtFecha(resumen.fechaHasta)}.
            {resumen.sinProveedor > 0 && <> {resumen.sinProveedor} proveedores de Huemul no están en la lista de proveedores de la app: esos ingresos se cruzan por nombre.</>}
          </div>
        )}
      </div>

      {/* Vistas */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {([['cruce', '🔎 Remitos de guardia sin cargar en Huemul'], ['huemul', '📋 Ingresos de Huemul']] as [Vista, string][]).map(([k, l]) => (
          <button key={k} onClick={() => setVista(k)} style={{
            flex: 1, padding: '10px 8px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
            border: vista === k ? '2px solid #254A96' : '1.5px solid #e0e0e0', background: vista === k ? '#eef2fb' : '#fff', color: vista === k ? '#254A96' : '#666',
          }}>{l}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
        <input type="date" value={hasta} onChange={e => setHasta(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
        <select value={sucursal} onChange={e => setSucursal(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
          {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
        </select>
        {vista === 'cruce' ? (
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value as any)} style={{ ...inputSt, width: 'auto' }}>
            <option value="pendientes">Para revisar (sin cargar y sin número)</option>
            <option value="sin_cargar">❌ Sin cargar</option>
            <option value="sin_numero">❓ Sin número</option>
            <option value="cargado">✅ Cargados</option>
            <option value="posterior_al_export">⏳ Posteriores al export</option>
            <option value="todos">Todos</option>
          </select>
        ) : (
          <select value={filtroGuardia} onChange={e => setFiltroGuardia(e.target.value as any)} style={{ ...inputSt, width: 'auto' }}>
            <option value="todos">Con y sin remito en guardia</option>
            <option value="sin_remito">Sin remito en guardia</option>
          </select>
        )}
        <input value={texto} onChange={e => setTexto(e.target.value)} placeholder="🔍 Proveedor, remito…" style={{ ...inputSt, flex: 1, minWidth: 180, width: 'auto' }} />
        <button onClick={vista === 'cruce' ? exportarCruce : exportarHuemul} disabled={vista === 'cruce' ? !filasCruce.length : !filasHuemul.length} style={btnLine}>↓ CSV</button>
      </div>

      {vista === 'cruce' && (
        <>
          {!ultima && (
            <div style={{ ...card, background: '#fffbeb', borderColor: '#fde68a', color: '#92400e', fontSize: 13 }}>
              Importá el export de Huemul para poder saber qué remitos quedaron sin cargar.
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            {([['Remitos de guardia', remitos.length, '#254A96'], ['Cargados en Huemul', conteo.cargado, '#065f46'], ['Sin cargar', conteo.sin_cargar, '#b91c1c'], ['Sin número', conteo.sin_numero, '#92400e'], ['Posteriores al export', conteo.posterior_al_export, '#6b7280']] as [string, number, string][]).map(([l, n, c]) => (
              <div key={l} style={{ flex: '1 1 130px', background: '#fff', border: '1px solid #e0e0e0', borderRadius: 14, padding: '12px 14px' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: c }}>{n.toLocaleString('es-AR')}</div><div style={{ fontSize: 12, color: '#777' }}>{l}</div>
              </div>
            ))}
          </div>
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                <thead><tr>{['Ingreso en guardia', 'Sucursal', 'Proveedor', 'N° remito', 'OC asociada', 'Huemul', 'Ingreso Huemul', 'Días'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {filasCruce.map(r => {
                    const c = cruce.get(r.id)
                    const e = ESTADO[c?.estado ?? 'sin_cargar']
                    return (
                      <tr key={r.id}>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtFecha(r.fecha)}</td>
                        <td style={td}>{r.sucursal}</td>
                        <td style={td}><b>{r.proveedor_nombre ?? '—'}</b></td>
                        <td style={td}><b>{r.numero_remito}</b></td>
                        <td style={td}>{r.ocs.length ? r.ocs.map(o => `OC ${o}`).join(' + ') : <span style={{ color: '#B9BBB7' }}>—</span>}</td>
                        <td style={td}><span style={{ background: e.bg, color: e.fg, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{e.label}</span></td>
                        <td style={td}>{c?.ingresos.length ? c.ingresos.map(i => `#${i}`).join(' + ') : <span style={{ color: '#B9BBB7' }}>—</span>}</td>
                        <td style={{ ...td, color: c?.estado === 'sin_cargar' && diasDesde(r.fecha) > 3 ? '#b91c1c' : '#666', fontWeight: c?.estado === 'sin_cargar' ? 700 : 400 }}>{diasDesde(r.fecha)}</td>
                      </tr>
                    )
                  })}
                  {filasCruce.length === 0 && <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#B9BBB7', padding: 28 }}>{cargando ? 'Cargando…' : filtroEstado === 'pendientes' && ultima ? 'No hay remitos pendientes de cargar en este período 👌' : 'Sin remitos para los filtros elegidos'}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            Un remito se considera cargado si Huemul tiene un ingreso del mismo proveedor con el mismo número (se ignoran los ceros). Los remitos «S/N» no se pueden cruzar solos. Los que entraron a guardia el día del export o después todavía no pueden estar en el archivo.
          </div>
        </>
      )}

      {vista === 'huemul' && (
        <>
          <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                <thead><tr>{['Ingreso', 'Fecha', 'Sucursal', 'Proveedor', 'N° remito', 'OC', 'Cargó', 'Productos', 'Remito en guardia'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {filasHuemul.slice(0, 500).map(g => (
                    <tr key={g.numero_ingreso}>
                      <td style={td}><b>#{g.numero_ingreso}</b></td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtFecha(g.fecha)}</td>
                      <td style={td}>{g.sucursal ?? <span style={{ color: '#B9BBB7' }}>{g.deposito ?? '—'}</span>}</td>
                      <td style={td}><b>{g.proveedor ?? '—'}</b></td>
                      <td style={td}>{g.numero_remito ?? '—'}</td>
                      <td style={td}>{g.compra ? `OC ${g.compra}` : '—'}</td>
                      <td style={td}>{g.usuario ?? '—'}</td>
                      <td style={{ ...td, maxWidth: 260 }} title={g.productos.join('\n')}>{g.lineas === 1 ? g.productos[0] : `${g.lineas} productos`}</td>
                      <td style={td}>
                        {g.guardiaEstado === 'si' && <span style={{ color: '#065f46', fontWeight: 700 }}>✅ Sí</span>}
                        {g.guardiaEstado === 'no' && <span style={{ color: '#b91c1c', fontWeight: 700 }}>⚠ No registrado</span>}
                        {g.guardiaEstado === 'anterior' && <span style={{ color: '#B9BBB7' }}>Anterior al uso de guardia</span>}
                        {g.guardiaEstado === 'sin_numero' && <span style={{ color: '#92400e' }}>Remito sin número</span>}
                      </td>
                    </tr>
                  ))}
                  {filasHuemul.length === 0 && <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: '#B9BBB7', padding: 28 }}>{cargando ? 'Cargando…' : ultima ? 'Sin ingresos para los filtros elegidos' : 'Importá el export de Huemul para ver los ingresos'}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          {filasHuemul.length > 500 && <div style={{ fontSize: 12, color: '#6b7280' }}>Se muestran los primeros 500 de {filasHuemul.length.toLocaleString('es-AR')}. Acotá las fechas o descargá el CSV para verlos todos.</div>}
        </>
      )}
    </>
  )
}
