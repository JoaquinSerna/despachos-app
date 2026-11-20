'use client'

// Taller: carga rápida de lubricantes, aceites, agua y urea por unidad + Excel de consumo
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

const MOTIVOS = [
  { key: 'service', label: 'Por service', color: '#059669', bg: '#ecfdf5' },
  { key: 'consumo', label: 'Consumo', color: '#254A96', bg: '#eef2fb' },
  { key: 'auxilio', label: 'Auxilio', color: '#d97706', bg: '#fffbeb' },
] as const
type Motivo = typeof MOTIVOS[number]['key']
const labelMotivo = (k: string) => MOTIVOS.find(m => m.key === k)?.label ?? k

const FAMILIAS = [
  { key: 'aceite', label: 'Aceite / lubricante' },
  { key: 'urea', label: 'Urea' },
  { key: 'agua', label: 'Agua' },
]

// Colores de las etiquetas, como en la planilla de consumos
const COLOR_PROD: Record<string, { bg: string; fg: string }> = {
  '15W40': { bg: '#dcebd2', fg: '#3a5a2a' }, 'H68': { bg: '#dce9fb', fg: '#254A96' }, 'H46': { bg: '#d8efe9', fg: '#1f6b5a' },
  '80W90': { bg: '#cfe3fb', fg: '#254A96' }, '5W30': { bg: '#cfe6c9', fg: '#2f5a28' }, '75W90': { bg: '#c9cde8', fg: '#33407a' },
  'ATF': { bg: '#d4e0d4', fg: '#37503a' }, 'SAE10W': { bg: '#93b6e0', fg: '#1f3f73' }, '10W40': { bg: '#aab0e0', fg: '#2f3a80' },
  'SAE30': { bg: '#e8e8e8', fg: '#444' }, 'REFRIGERANTE': { bg: '#a50e0e', fg: '#fff' }, 'DOT': { bg: '#fbe9b0', fg: '#7a5a00' },
  'UREA': { bg: '#d6f0fb', fg: '#0b5f80' }, 'AGUA': { bg: '#e0f2fe', fg: '#075985' },
}
const colorDe = (p: string) => COLOR_PROD[p] ?? { bg: '#eee', fg: '#444' }

interface Prod { id: string; nombre: string; familia: string; orden: number; activo: boolean }
interface Carga {
  id: string; created_at: string; fecha: string; sucursal: string; unidad_codigo: string; unidad_externa: boolean
  dominio: string | null; producto: string; familia: string; litros: number; motivo: string
  mecanico: string | null; observacion: string | null; registrado_por: string | null
}
interface EquipoLite { codigo: string; tipo: string; activo: boolean }

const pad = (n: number) => String(n).padStart(2, '0')
const fechaLocal = (d: Date = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const fmtFecha = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
const fmtL = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')
const hhmm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }

// Semana ISO (la misma numeración que usa la planilla)
function semanaISO(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const dia = dt.getUTCDay() || 7
  dt.setUTCDate(dt.getUTCDate() + 4 - dia)
  const inicio = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1))
  return Math.ceil(((dt.getTime() - inicio.getTime()) / 86400000 + 1) / 7)
}

const card: React.CSSProperties = { background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: '16px', marginBottom: 14 }
const labelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }
const inputSt: React.CSSProperties = { width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #d6d6d6', fontSize: 15, background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit' }
const btnPrimary: React.CSSProperties = { width: '100%', padding: 15, borderRadius: 12, border: 'none', background: '#254A96', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer' }

export default function Lubricantes({ vista, sucursal, esAdmin, puedeEd, userId, camiones, equipos, mecanicos, showToast }: {
  vista: 'nuevo' | 'actividad'
  sucursal: string; esAdmin: boolean; puedeEd: boolean; userId: string | null
  camiones: string[]; equipos: EquipoLite[]; mecanicos: string[]
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [prods, setProds] = useState<Prod[]>([])
  const [dominios, setDominios] = useState<Record<string, string>>({})

  const cargarBase = useCallback(async () => {
    const [{ data: p }, { data: d }] = await Promise.all([
      supabase.from('taller_lubricantes_prod').select('*').eq('activo', true).order('orden').order('nombre'),
      supabase.from('taller_dominios').select('unidad_codigo, dominio'),
    ])
    setProds((p ?? []) as Prod[])
    const mapa: Record<string, string> = {}
    for (const r of (d ?? []) as any[]) mapa[r.unidad_codigo] = r.dominio
    setDominios(mapa)
  }, [])
  useEffect(() => { cargarBase() }, [cargarBase])

  return vista === 'nuevo'
    ? <FormCarga sucursal={sucursal} puedeEd={puedeEd} userId={userId} camiones={camiones} equipos={equipos} mecanicos={mecanicos}
        prods={prods} dominios={dominios} recargarBase={cargarBase} showToast={showToast} />
    : <Actividad sucursal={sucursal} esAdmin={esAdmin} prods={prods} dominios={dominios} showToast={showToast} />
}

// ───────────────────────────── FORMULARIO ─────────────────────────────
function FormCarga({ sucursal, puedeEd, userId, camiones, equipos, mecanicos, prods, dominios, recargarBase, showToast }: {
  sucursal: string; puedeEd: boolean; userId: string | null
  camiones: string[]; equipos: EquipoLite[]; mecanicos: string[]
  prods: Prod[]; dominios: Record<string, string>; recargarBase: () => Promise<void>
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [fecha, setFecha] = useState(fechaLocal())
  const [unidad, setUnidad] = useState('')
  const [busca, setBusca] = useState('')
  const [lista, setLista] = useState(false)
  const [externa, setExterna] = useState(false)
  const [extPref, setExtPref] = useState('')
  const [extNum, setExtNum] = useState('')
  const [dominio, setDominio] = useState('')
  const [producto, setProducto] = useState('')
  const [litros, setLitros] = useState('')
  const [motivo, setMotivo] = useState<Motivo | ''>('')
  const [mecanico, setMecanico] = useState('')
  const [obs, setObs] = useState('')
  const [otroOn, setOtroOn] = useState(false)
  const [otroNombre, setOtroNombre] = useState('')
  const [otroFamilia, setOtroFamilia] = useState('aceite')
  const [guardando, setGuardando] = useState(false)
  const [hoy, setHoy] = useState<Carga[]>([])

  const unidadFinal = externa ? (extPref && extNum ? `${extPref}-${extNum}` : '') : unidad
  // Al elegir una unidad se completa su dominio si ya lo tenemos
  useEffect(() => { if (unidadFinal) setDominio(dominios[unidadFinal] ?? '') }, [unidadFinal, dominios])

  const cargarHoy = useCallback(async () => {
    const { data } = await supabase.from('taller_lubricantes').select('*')
      .eq('fecha', fecha).eq('sucursal', sucursal).order('created_at', { ascending: false }).limit(30)
    setHoy((data ?? []) as Carga[])
  }, [fecha, sucursal])
  useEffect(() => { cargarHoy() }, [cargarHoy])

  const agregarProducto = async () => {
    const nombre = otroNombre.trim().toUpperCase()
    if (!nombre) { showToast('Escribí el nombre del producto', 'err'); return }
    const { error } = await supabase.from('taller_lubricantes_prod').insert({ nombre, familia: otroFamilia, orden: 100 + prods.length })
    if (error && !/duplicate|unique/i.test(error.message)) { showToast(error.message, 'err'); return }
    await recargarBase()
    setProducto(nombre); setOtroOn(false); setOtroNombre('')
    showToast(`${nombre} agregado a la lista`)
  }

  const guardar = async () => {
    const l = Number(litros.replace(',', '.'))
    if (!unidadFinal) { showToast('Elegí la unidad', 'err'); return }
    if (!producto) { showToast('Elegí el producto', 'err'); return }
    if (!l || l <= 0) { showToast('Indicá los litros', 'err'); return }
    if (!motivo) { showToast('Elegí si es por service, consumo o auxilio', 'err'); return }
    setGuardando(true)
    const prod = prods.find(p => p.nombre === producto)
    const dom = dominio.trim().toUpperCase()
    const { error } = await supabase.from('taller_lubricantes').insert({
      fecha, sucursal, unidad_codigo: unidadFinal, unidad_externa: externa, dominio: dom || null,
      producto, familia: prod?.familia ?? 'aceite', litros: l, motivo, mecanico: mecanico || null,
      observacion: obs.trim() || null, registrado_por: userId,
    })
    if (error) { setGuardando(false); showToast(error.message, 'err'); return }
    if (dom && dominios[unidadFinal] !== dom) {
      await supabase.from('taller_dominios').upsert({ unidad_codigo: unidadFinal, dominio: dom })
      recargarBase()
    }
    setGuardando(false)
    showToast(`${fmtL(l)} L de ${producto} cargados a ${unidadFinal}`)
    // Se deja la unidad, la fecha y el motivo para cargar rápido otro producto a la misma unidad
    setProducto(''); setLitros(''); setObs('')
    cargarHoy()
  }

  if (!puedeEd) return <div style={card}><p style={{ margin: 0, fontSize: 14, color: '#777' }}>Tu usuario no puede cargar lubricantes.</p></div>

  return (
    <>
      <div style={card}>
        <label style={labelSt}>Fecha</label>
        <input type="date" value={fecha} max={fechaLocal()} onChange={e => setFecha(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
      </div>

      <div style={card}>
        <label style={labelSt}>Unidad</label>
        {!externa ? (
          <div style={{ position: 'relative' }}>
            <input value={busca} autoComplete="off"
              onChange={e => { setBusca(e.target.value); setUnidad(''); setLista(true) }}
              onFocus={() => setLista(true)} onBlur={() => setTimeout(() => setLista(false), 150)}
              placeholder="Escribí una o dos letras de la unidad (ej: CA, 52, SA)…"
              style={{ ...inputSt, fontWeight: unidad ? 800 : 500, borderColor: unidad ? '#059669' : '#d6d6d6' }} />
            {lista && !unidad && (() => {
              const q = busca.trim().toLowerCase().replace(/[\s-]+/g, '')
              const coincide = (c: string) => !q || c.toLowerCase().replace(/[\s-]+/g, '').includes(q)
              const grupos = [
                { label: '🚛 Camiones', lista: camiones.filter(coincide) },
                { label: '🏗️ Otros equipos', lista: equipos.filter(e => e.activo && coincide(e.codigo)).map(e => e.codigo) },
              ].filter(g => g.lista.length > 0)
              return (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 20, marginTop: 4, maxHeight: 260, overflowY: 'auto', background: '#fff', border: '1.5px solid #d6d6d6', borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,.12)' }}>
                  {grupos.length === 0 && <div style={{ padding: '10px 12px', fontSize: 13, color: '#999' }}>Sin coincidencias. Si no está en la lista, tildá "otra empresa" abajo.</div>}
                  {grupos.map(g => (
                    <div key={g.label}>
                      <div style={{ padding: '6px 12px', fontSize: 11, fontWeight: 700, color: '#254A96', background: '#f4f6fb' }}>{g.label}</div>
                      {g.lista.map(c => (
                        <div key={c} onMouseDown={e => { e.preventDefault(); setUnidad(c); setBusca(c); setLista(false) }}
                          style={{ padding: '10px 12px', fontSize: 15, fontWeight: 700, cursor: 'pointer', borderTop: '1px solid #f3f3f3' }}>{c}</div>
                      ))}
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input value={extPref} onChange={e => setExtPref(e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6))}
              placeholder="MX" aria-label="Tipo de equipo" style={{ ...inputSt, flex: '0 0 96px', width: 96, textAlign: 'center', textTransform: 'uppercase', fontWeight: 700 }} />
            <span style={{ fontSize: 22, fontWeight: 700, color: '#999' }}>-</span>
            <input value={extNum} onChange={e => setExtNum(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric"
              placeholder="12" aria-label="Número" style={{ ...inputSt, flex: '1 1 100px', fontWeight: 700 }} />
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 14, color: '#555', cursor: 'pointer' }}>
          <input type="checkbox" checked={externa} onChange={e => setExterna(e.target.checked)} />
          Es de otra empresa o un equipo que no está en la lista
        </label>
        {unidadFinal && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Dominio (patente){dominios[unidadFinal] ? '' : ' — se guarda para la próxima'}</div>
            <input value={dominio} onChange={e => setDominio(e.target.value.toUpperCase())} placeholder="Ej: AG701TI (si no tiene, dejalo vacío)"
              style={{ ...inputSt, textTransform: 'uppercase', fontWeight: 700 }} />
          </div>
        )}
      </div>

      <div style={card}>
        <label style={labelSt}>Producto</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {prods.map(p => {
            const c = colorDe(p.nombre); const on = producto === p.nombre
            return (
              <button key={p.id} onClick={() => setProducto(p.nombre)}
                style={{ padding: '10px 14px', borderRadius: 20, fontSize: 14, fontWeight: 700, cursor: 'pointer', background: c.bg, color: c.fg,
                  border: `2.5px solid ${on ? '#254A96' : 'transparent'}`, boxShadow: on ? '0 0 0 2px #cfd9f0' : 'none' }}>{p.nombre}</button>
            )
          })}
          <button onClick={() => setOtroOn(o => !o)}
            style={{ padding: '10px 14px', borderRadius: 20, fontSize: 14, fontWeight: 600, cursor: 'pointer', background: '#fff', color: '#555', border: '1.5px dashed #bbb' }}>➕ Otro</button>
        </div>
        {otroOn && (
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input value={otroNombre} onChange={e => setOtroNombre(e.target.value)} placeholder="Nombre del producto (ej: 15W50)" style={{ ...inputSt, flex: '1 1 180px', width: 'auto' }} />
            <select value={otroFamilia} onChange={e => setOtroFamilia(e.target.value)} style={{ ...inputSt, flex: '0 0 auto', width: 'auto' }}>
              {FAMILIAS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
            <button onClick={agregarProducto} style={{ padding: '10px 16px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
          </div>
        )}
      </div>

      <div style={card}>
        <label style={labelSt}>Litros</label>
        <input value={litros} onChange={e => setLitros(e.target.value.replace(/[^0-9.,]/g, ''))} inputMode="decimal" placeholder="Ej: 18 o 4,5"
          style={{ ...inputSt, fontSize: 22, fontWeight: 800, maxWidth: 220 }} />
      </div>

      <div style={card}>
        <label style={labelSt}>Motivo</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {MOTIVOS.map(m => (
            <button key={m.key} onClick={() => setMotivo(m.key)}
              style={{ padding: '14px 6px', borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                border: `2px solid ${motivo === m.key ? m.color : '#e0e0e0'}`, background: motivo === m.key ? m.bg : '#fff', color: motivo === m.key ? m.color : '#666' }}>{m.label}</button>
          ))}
        </div>
      </div>

      <div style={card}>
        <label style={labelSt}>Mecánico (opcional)</label>
        <select value={mecanico} onChange={e => setMecanico(e.target.value)} style={inputSt}>
          <option value="">—</option>
          {mecanicos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <label style={{ ...labelSt, marginTop: 14 }}>Observación (opcional)</label>
        <input value={obs} onChange={e => setObs(e.target.value)} placeholder="Ej: faltante de agua en el radiador" style={inputSt} />
      </div>

      <button onClick={guardar} disabled={guardando} style={{ ...btnPrimary, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando…' : '✓ Guardar carga'}</button>

      {hoy.length > 0 && (
        <div style={{ ...card, marginTop: 18 }}>
          <label style={labelSt}>Cargas del {fmtFecha(fecha)} — {sucursal}</label>
          {hoy.map(c => {
            const col = colorDe(c.producto)
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid #f3f3f3', fontSize: 14, flexWrap: 'wrap' }}>
                <b style={{ minWidth: 64 }}>{c.unidad_codigo}</b>
                <span style={{ padding: '2px 10px', borderRadius: 12, background: col.bg, color: col.fg, fontWeight: 700, fontSize: 13 }}>{c.producto}</span>
                <span style={{ fontWeight: 800 }}>{fmtL(Number(c.litros))} L</span>
                <span style={{ color: '#777', fontSize: 12 }}>{labelMotivo(c.motivo)} · {hhmm(c.created_at)}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// ───────────────────────────── ACTIVIDAD + EXCEL ─────────────────────────────
function Actividad({ sucursal, esAdmin, prods, dominios, showToast }: {
  sucursal: string; esAdmin: boolean; prods: Prod[]; dominios: Record<string, string>
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [dia, setDia] = useState(fechaLocal())
  const [cargas, setCargas] = useState<Carga[]>([])
  const [cargando, setCargando] = useState(false)
  const [desde, setDesde] = useState(() => { const d = new Date(); d.setDate(1); return fechaLocal(d) })
  const [hasta, setHasta] = useState(fechaLocal())
  const [expSuc, setExpSuc] = useState(sucursal)
  const [exportando, setExportando] = useState(false)
  useEffect(() => { setExpSuc(sucursal) }, [sucursal])

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data } = await supabase.from('taller_lubricantes').select('*').eq('fecha', dia).eq('sucursal', sucursal).order('created_at')
    setCargas((data ?? []) as Carga[])
    setCargando(false)
  }, [dia, sucursal])
  useEffect(() => { cargar() }, [cargar])

  const eliminar = async (c: Carga) => {
    if (!confirm(`¿Borrar la carga de ${fmtL(Number(c.litros))} L de ${c.producto} a ${c.unidad_codigo}?`)) return
    const { error } = await supabase.from('taller_lubricantes').delete().eq('id', c.id)
    if (error) { showToast(error.message, 'err'); return }
    showToast('Carga borrada'); cargar()
  }

  const totales = useMemo(() => {
    const t: Record<string, number> = {}
    for (const c of cargas) t[c.producto] = (t[c.producto] ?? 0) + Number(c.litros)
    return Object.entries(t).sort((a, b) => b[1] - a[1])
  }, [cargas])

  const exportar = async () => {
    if (!desde || !hasta) { showToast('Indicá el rango de fechas', 'err'); return }
    setExportando(true)
    try {
      let q = supabase.from('taller_lubricantes').select('*').gte('fecha', desde).lte('fecha', hasta).order('fecha').order('created_at')
      if (expSuc !== 'Todas') q = q.eq('sucursal', expSuc)
      const { data, error } = await q
      if (error) throw error
      const filas = (data ?? []) as Carga[]
      if (!filas.length) { showToast('Sin cargas en ese rango', 'err'); return }

      // Acumulados como en la planilla: semanal por unidad+producto, mensual por unidad (separando aceites, urea y agua)
      const semana: Record<string, { litros: number; n: number }> = {}
      const mensual: Record<string, number> = {}
      const kSem = (c: Carga) => `${c.unidad_codigo}|${c.producto}|${c.fecha.slice(0, 4)}-${semanaISO(c.fecha)}`
      for (const c of filas) {
        const s = semana[kSem(c)] ?? { litros: 0, n: 0 }
        s.litros += Number(c.litros); s.n += 1; semana[kSem(c)] = s
      }
      const cab = ['FECHA', 'SUCURSAL', 'CODIGO', 'DOMINIO', 'LUBRICANTE', 'LITROS', 'SEMANA N°', 'LITROS DURANTE LA SEMANA', 'PROMEDIO SEMANAL', 'MES', 'CONSUMO MENSUAL', 'AÑO', 'OBSERVACIONES', 'TIPO', 'MECANICO', 'NOTA']
      const aoa: (string | number)[][] = [cab]
      for (const c of filas) {
        const l = Number(c.litros)
        const km = `${c.unidad_codigo}|${c.familia}|${c.fecha.slice(0, 7)}`
        mensual[km] = (mensual[km] ?? 0) + l
        const s = semana[kSem(c)]
        aoa.push([
          fmtFecha(c.fecha), c.sucursal, c.unidad_codigo, c.dominio || dominios[c.unidad_codigo] || c.unidad_codigo, c.producto, l,
          semanaISO(c.fecha), Math.round(s.litros * 100) / 100, Math.round((s.litros / s.n) * 100) / 100,
          Number(c.fecha.slice(5, 7)), Math.round(mensual[km] * 100) / 100, Number(c.fecha.slice(0, 4)),
          labelMotivo(c.motivo), FAMILIAS.find(f => f.key === c.familia)?.label ?? c.familia, c.mecanico ?? '', c.observacion ?? '',
        ])
      }
      // Hoja resumen: litros por unidad y producto en el rango
      const porUnidad: Record<string, Record<string, number>> = {}
      const usados = new Set<string>()
      for (const c of filas) {
        porUnidad[c.unidad_codigo] = porUnidad[c.unidad_codigo] ?? {}
        porUnidad[c.unidad_codigo][c.producto] = (porUnidad[c.unidad_codigo][c.producto] ?? 0) + Number(c.litros)
        usados.add(c.producto)
      }
      const orden = [...prods.map(p => p.nombre).filter(n => usados.has(n)), ...[...usados].filter(n => !prods.some(p => p.nombre === n))]
      const resumen: (string | number)[][] = [['CODIGO', 'DOMINIO', ...orden, 'TOTAL']]
      for (const u of Object.keys(porUnidad).sort()) {
        const tot = orden.reduce((s, p) => s + (porUnidad[u][p] ?? 0), 0)
        resumen.push([u, dominios[u] || u, ...orden.map(p => Math.round((porUnidad[u][p] ?? 0) * 100) / 100 || ''), Math.round(tot * 100) / 100])
      }

      const XLSX = await import('xlsx')
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet(aoa)
      ws['!cols'] = [12, 11, 10, 11, 14, 8, 10, 14, 12, 6, 14, 7, 14, 20, 16, 34].map(wch => ({ wch }))
      ws['!autofilter'] = { ref: `A1:P${aoa.length}` }
      XLSX.utils.book_append_sheet(wb, ws, 'Consumo')
      const wr = XLSX.utils.aoa_to_sheet(resumen)
      wr['!cols'] = resumen[0].map((_, i) => ({ wch: i === 0 ? 10 : 12 }))
      XLSX.utils.book_append_sheet(wb, wr, 'Resumen por unidad')
      XLSX.writeFile(wb, `consumo_lubricantes_${desde}_a_${hasta}.xlsx`)
      showToast(`${filas.length} cargas exportadas`)
    } catch (err: any) {
      showToast(err?.message || 'Error al exportar', 'err')
    } finally { setExportando(false) }
  }

  return (
    <>
      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: '#254A96' }}>🛢️ Lubricantes del día — {sucursal}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {cargando && <span style={{ fontSize: 12, color: '#999' }}>Cargando…</span>}
            <input type="date" value={dia} onChange={e => setDia(e.target.value)}
              style={{ border: '1px solid #e8edf8', borderRadius: 8, padding: '5px 8px', fontSize: 13, color: '#254A96', fontWeight: 600 }} />
          </div>
        </div>
        {totales.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '10px 16px', background: '#f9fafb', fontSize: 13, color: '#444' }}>
            <span><b>{cargas.length}</b> carga{cargas.length !== 1 ? 's' : ''}:</span>
            {totales.map(([p, l]) => { const c = colorDe(p); return <span key={p} style={{ padding: '1px 9px', borderRadius: 10, background: c.bg, color: c.fg, fontWeight: 700 }}>{p} {fmtL(l)} L</span> })}
          </div>
        )}
        {cargas.length === 0 ? (
          <p style={{ textAlign: 'center', padding: '28px 16px', fontSize: 13, color: '#B9BBB7' }}>{cargando ? 'Cargando…' : 'Sin cargas registradas para esta fecha'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9f9f9', color: '#254A96', textAlign: 'left' }}>
                  {['Hora', 'Unidad', 'Dominio', 'Producto', 'Litros', 'Motivo', 'Mecánico', ''].map(h => <th key={h} style={{ padding: '8px 10px', fontWeight: 700 }}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {cargas.map(c => { const col = colorDe(c.producto); return (
                  <tr key={c.id} style={{ borderTop: '1px solid #f3f3f3' }}>
                    <td style={{ padding: '8px 10px', color: '#777' }}>{hhmm(c.created_at)}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 800 }}>{c.unidad_codigo}</td>
                    <td style={{ padding: '8px 10px', color: '#666' }}>{c.dominio || dominios[c.unidad_codigo] || ''}</td>
                    <td style={{ padding: '8px 10px' }}><span style={{ padding: '2px 10px', borderRadius: 12, background: col.bg, color: col.fg, fontWeight: 700 }}>{c.producto}</span></td>
                    <td style={{ padding: '8px 10px', fontWeight: 800 }}>{fmtL(Number(c.litros))}</td>
                    <td style={{ padding: '8px 10px' }}>{labelMotivo(c.motivo)}</td>
                    <td style={{ padding: '8px 10px', color: '#666' }}>{c.mecanico ?? ''}</td>
                    <td style={{ padding: '8px 10px' }}>{esAdmin && <button onClick={() => eliminar(c)} title="Borrar" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 15 }}>🗑</button>}</td>
                  </tr>
                ) })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <label style={labelSt}>Exportar Excel de consumo</label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div><div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Desde</div><input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={{ ...inputSt, width: 'auto', padding: '8px 10px' }} /></div>
          <div><div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Hasta</div><input type="date" value={hasta} onChange={e => setHasta(e.target.value)} style={{ ...inputSt, width: 'auto', padding: '8px 10px' }} /></div>
          {esAdmin && (
            <div><div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Sucursal</div>
              <select value={expSuc} onChange={e => setExpSuc(e.target.value)} style={{ ...inputSt, width: 'auto', padding: '8px 10px' }}>
                {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          )}
          <button onClick={exportar} disabled={exportando}
            style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: exportando ? 0.6 : 1 }}>
            {exportando ? 'Exportando…' : '↓ Exportar Excel'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
          Mismas columnas que la planilla de consumos (semana, litros de la semana, promedio semanal, consumo mensual por unidad), más la hoja "Resumen por unidad". La urea y el agua se acumulan aparte de los aceites.
        </div>
      </div>
    </>
  )
}
