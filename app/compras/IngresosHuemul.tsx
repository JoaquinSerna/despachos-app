'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { coincideTexto } from '../lib/compras-utils'
import { fechaLocal } from '../lib/compras'
import SyncDrive from './SyncDrive'
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

// Estado de un remito de guardia respecto de Huemul: lo que dice el export + el check manual de quien carga en Huemul
export type EstadoHuemul = EstadoCruce | 'marcado' | 'marcado_no_figura' | 'espera_validacion'

export const ESTADO_HUEMUL: Record<EstadoHuemul, { label: string; corto: string; bg: string; fg: string }> = {
  espera_validacion: { label: '⏳ Esperando la validación de depósito · todavía no se carga', corto: 'Esperando validación de depósito', bg: '#f3f4f6', fg: '#4b5563' },
  marcado: { label: '🟡 Marcado como cargado · falta confirmar con el export', corto: 'Marcado, falta confirmar', bg: '#fefce8', fg: '#854d0e' },
  marcado_no_figura: { label: '⚠ Marcado como cargado, pero no figura en el export', corto: 'Marcado, no figura en el export', bg: '#fef2f2', fg: '#b91c1c' },
  cargado: { label: '✅ Cargado en Huemul', corto: 'Cargado', bg: '#ecfdf5', fg: '#065f46' },
  sin_cargar: { label: '❌ Sin cargar en Huemul', corto: 'Sin cargar', bg: '#fef2f2', fg: '#b91c1c' },
  posterior_al_export: { label: '⏳ Sin cargar · llegó después del último export', corto: 'Sin cargar (posterior al export)', bg: '#fffbeb', fg: '#92400e' },
  sin_numero: { label: '❓ Sin número: revisar a mano', corto: 'Sin número', bg: '#fffbeb', fg: '#92400e' },
}

const fmtFecha = (f: string | null) => (f ? f.split('-').reverse().join('/') : '—')
const fmtFechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const sumarDias = (f: string, d: number) => { const x = new Date(`${f}T12:00:00`); x.setDate(x.getDate() + d); return fechaLocal(x) }

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

// ── Cruce de remitos de guardia contra Huemul ──
// Devuelve, para cada remito, si está cargado en Huemul. `remitos` tiene que ser una lista estable (useMemo).
export function useCruceHuemul(remitos: RemitoGuardia[], refreshKey: number) {
  const [cruce, setCruce] = useState<Map<string, ResultadoCruce>>(new Map())
  const [ultima, setUltima] = useState<any | null>(null)
  const [cargando, setCargando] = useState(false)

  useEffect(() => {
    let vivo = true
    ;(async () => {
      setCargando(true)
      try {
        const { data: imp } = await supabase.from('huemul_importaciones').select('exportado_en, importado_en, archivo, ingresos, fecha_desde, fecha_hasta')
          .order('importado_en', { ascending: false }).limit(1)
        const u = imp?.[0] ?? null
        if (!vivo) return
        setUltima(u)
        if (!u) { setCruce(new Map()); return }
        // Lo que entró a guardia el día del export o después puede no estar todavía en el archivo
        const diaExport = u.exportado_en ? fechaLocal(new Date(u.exportado_en)) : null
        const limite = diaExport ? sumarDias(diaExport, -1) : null
        const numeros = [...new Set(remitos.map(r => parsearRemito(r.numero_remito).numero).filter((n): n is number => n !== null))]
        const huemul: any[] = []
        for (let i = 0; i < numeros.length; i += 300) {
          const { data, error } = await supabase.from('huemul_ingresos')
            .select('numero_ingreso, fecha, proveedor_id, proveedor_clave, punto_remito, nro_remito, sin_numero')
            .in('nro_remito', numeros.slice(i, i + 300))
          if (error) throw error
          huemul.push(...(data ?? []))
        }
        if (vivo) setCruce(cruzarRemitos(remitos, huemul, limite))
      } catch { if (vivo) setCruce(new Map()) }
      if (vivo) setCargando(false)
    })()
    return () => { vivo = false }
  }, [remitos, refreshKey])

  return { cruce, ultima, cargando }
}

// El export manda: si el remito figura ahí, está confirmado. Si no figura pero alguien lo marcó como cargado,
// queda "marcado" hasta el próximo export; si ese export salió después de la marca y no lo trae, se avisa.
export function estadoHuemulFinal(rem: any, res: ResultadoCruce | undefined, exportadoEn: string | null, hayExport: boolean): EstadoHuemul | undefined {
  if (!rem) return undefined
  if (res?.estado === 'cargado') return 'cargado'
  if (rem.huemul_cargado_en) {
    if (res?.estado === 'sin_numero' || !exportadoEn) return 'marcado'
    return new Date(exportadoEn) > new Date(rem.huemul_cargado_en) ? 'marcado_no_figura' : 'marcado'
  }
  if (!hayExport) return 'sin_cargar'
  return res?.estado
}

interface MarcaHuemul { por: string | null; en: string | null }

export function BadgeHuemul({ estado, ingresos, marca }: { estado: EstadoHuemul | undefined; ingresos?: number[]; marca?: MarcaHuemul }) {
  if (!estado) return <span style={{ color: '#B9BBB7' }}>—</span>
  const e = ESTADO_HUEMUL[estado]
  return (
    <>
      <span style={{ background: e.bg, color: e.fg, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{e.label}</span>
      {!!ingresos?.length && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Ingreso {ingresos.map(i => `#${i}`).join(' + ')}</div>}
      {marca?.en && (estado === 'marcado' || estado === 'marcado_no_figura') && (
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Marcó {marca.por ?? '—'} · {fmtFechaHora(marca.en)}</div>
      )}
    </>
  )
}

// "Lo cargué en Huemul": el que hace los ingresos en Huemul lo tilda; después el export lo confirma
export function CheckHuemul({ marcado, trabajando, onCambiar, grande }: { marcado: boolean; trabajando?: boolean; onCambiar: (valor: boolean) => void; grande?: boolean }) {
  return (
    <label onClick={e => e.stopPropagation()}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 4, cursor: trabajando ? 'wait' : 'pointer', fontSize: grande ? 15 : 12, fontWeight: 700, color: marcado ? '#854d0e' : '#254A96', opacity: trabajando ? 0.6 : 1 }}>
      <input type="checkbox" checked={marcado} disabled={trabajando} onChange={e => onCambiar(e.target.checked)}
        style={{ width: grande ? 22 : 17, height: grande ? 22 : 17, cursor: 'inherit' }} />
      Lo cargué en Huemul
    </label>
  )
}

// ── Importación del export de Huemul ──
export function ImportadorHuemul({ puedeEd, showToast, onImportado }: { puedeEd: boolean; showToast: (msg: string, tipo?: 'ok' | 'err') => void; onImportado: () => void }) {
  const [ultima, setUltima] = useState<any | null>(null)
  const [importando, setImportando] = useState(false)
  const [progreso, setProgreso] = useState('')
  const [resumen, setResumen] = useState<ResumenHuemul | null>(null)

  const cargarUltima = useCallback(async () => {
    const { data } = await supabase.from('huemul_importaciones').select('*').order('importado_en', { ascending: false }).limit(1)
    setUltima(data?.[0] ?? null)
  }, [])
  useEffect(() => { cargarUltima() }, [cargarUltima])

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
      onImportado()
    } catch (e: any) { showToast(e?.message || 'No se pudo importar el archivo', 'err') }
    setImportando(false); setProgreso('')
  }

  return (
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
        Export «Ingresos de Compras» (compras_ingreso_AAAAMMDD_HHMM.xlsx). Trae todo el histórico: al subir uno nuevo se actualizan los ingresos que ya estaban. Con él se marca qué remitos de guardia ya están cargados en Huemul.
      </div>
      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f0f0f0' }}>
        <SyncDrive puedeEd={puedeEd} showToast={showToast} mostrar="ingresos" onSincronizado={() => { cargarUltima(); onImportado() }} />
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
  )
}

// ── Ingresos de Huemul (lo que viene del export) ──
export function ListaIngresosHuemul({ showToast, refreshKey }: { showToast: (msg: string, tipo?: 'ok' | 'err') => void; refreshKey: number }) {
  const hoy = fechaLocal()
  const [desde, setDesde] = useState(sumarDias(hoy, -30))
  const [hasta, setHasta] = useState(hoy)
  const [sucursal, setSucursal] = useState('Todas')
  const [texto, setTexto] = useState('')
  const [filtroGuardia, setFiltroGuardia] = useState<'todos' | 'sin_remito'>('todos')
  const [ingresosH, setIngresosH] = useState<any[]>([])
  const [cargando, setCargando] = useState(false)

  const cargar = useCallback(async () => {
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

  useEffect(() => { cargar() }, [cargar, refreshKey])

  const filas = useMemo(() => ingresosH.filter(g => {
    if (filtroGuardia === 'sin_remito' && g.guardiaEstado !== 'no') return false
    return !texto.trim() || coincideTexto([g.proveedor, g.numero_remito, g.numero_ingreso, g.usuario].filter(Boolean).join(' '), texto)
  }), [ingresosH, filtroGuardia, texto])

  const exportar = () => {
    const cols = ['numero_ingreso', 'fecha', 'sucursal', 'deposito', 'proveedor', 'numero_remito', 'orden_compra', 'usuario', 'lineas', 'en_guardia']
    const lineas = [cols.join(';')]
    const etiqueta = { si: 'si', no: 'NO', anterior: 'anterior al uso de guardia', sin_numero: 'remito sin número' } as const
    for (const g of filas) {
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
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        <input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
        <input type="date" value={hasta} onChange={e => setHasta(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
        <select value={sucursal} onChange={e => setSucursal(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
          {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
        </select>
        <select value={filtroGuardia} onChange={e => setFiltroGuardia(e.target.value as any)} style={{ ...inputSt, width: 'auto' }}>
          <option value="todos">Con y sin remito en guardia</option>
          <option value="sin_remito">Sin remito en guardia</option>
        </select>
        <input value={texto} onChange={e => setTexto(e.target.value)} placeholder="🔍 Proveedor, remito, ingreso…" style={{ ...inputSt, flex: 1, minWidth: 180, width: 'auto' }} />
        <button onClick={exportar} disabled={!filas.length} style={{ ...btnLine, opacity: filas.length ? 1 : 0.5 }}>↓ CSV</button>
      </div>
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
            <thead><tr>{['Ingreso', 'Fecha', 'Sucursal', 'Proveedor', 'N° remito', 'OC', 'Cargó', 'Productos', 'Remito en guardia'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {filas.slice(0, 500).map(g => (
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
              {filas.length === 0 && <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: '#B9BBB7', padding: 28 }}>{cargando ? 'Cargando…' : 'Sin ingresos para los filtros elegidos. ¿Ya importaste el export de Huemul?'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {filas.length > 500 && <div style={{ fontSize: 12, color: '#6b7280' }}>Se muestran los primeros 500 de {filas.length.toLocaleString('es-AR')}. Acotá las fechas o descargá el CSV para verlos todos.</div>}
    </>
  )
}
