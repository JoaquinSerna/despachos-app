'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/app/supabase'
import { logAuditoria } from '@/app/lib/auditoria'
import { demandaPorDia, estadoLinea, fmtNum, type LineaDemanda, type PickingPedidoPrep, type ValidacionPrep } from '@/app/lib/prep-validacion'

// Faltantes: lo que el depósito declaró que NO tiene físicamente al validar la preparación.
// Reemplaza a la Verificación SD (que comparaba contra el stock importado). Acá se decide qué hacer:
//  · 🔄 pedir una transferencia a otra sucursal (entra al circuito de Transferencias), o
//  · ⏳ esperar que llegue mercadería (queda pendiente hasta que el depósito lo valide en Preparación).

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']
const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const hoyISO = () => new Date().toISOString().slice(0, 10)
const sumarDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const fmtDia = (iso: string) => { const [y, m, d] = iso.split('-'); return `${DOW[new Date(`${iso}T12:00:00`).getDay()]} ${d}/${m}/${y}` }

interface Faltante {
  v: ValidacionPrep
  linea: LineaDemanda
  falta: number
}

interface Props {
  rol: string
  userEmail: string
  userId: string
  userNombre: string
  miSucursal: string | null
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onIrATransferencias: () => void
}

export default function TabFaltantes({ rol, userEmail, userId, userNombre, miSucursal, showToast, onIrATransferencias }: Props) {
  const [desde, setDesde] = useState(hoyISO())
  const [hasta, setHasta] = useState(sumarDias(hoyISO(), 7))
  const [sucursal, setSucursal] = useState(miSucursal && SUCURSALES.includes(miSucursal) && rol === 'deposito' ? miSucursal : '')
  const [filtro, setFiltro] = useState<'sin_decidir' | 'decididos' | 'todos'>('todos')
  const [faltantes, setFaltantes] = useState<Faltante[]>([])
  const [cargando, setCargando] = useState(false)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<Faltante | null>(null)
  const [origen, setOrigen] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [fechaSol, setFechaSol] = useState('')
  const [notaTr, setNotaTr] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [esperando, setEsperando] = useState<{ id: string; nota: string } | null>(null)

  const puedeDecidir = rol === 'deposito' || rol === 'gerencia' || rol === 'admin_flota'

  const cargar = useCallback(async () => {
    setCargando(true); setError('')
    try {
      const params = new URLSearchParams({ fecha_desde: desde, fecha_hasta: hasta })
      if (sucursal) params.set('sucursal', sucursal)
      const [res, { data: vals, error: eVal }] = await Promise.all([
        fetch(`/api/picking-list?${params}`),
        (() => {
          let q = supabase.from('prep_validaciones').select('*').gt('faltante', 0).gte('fecha', desde).lte('fecha', hasta)
          if (sucursal) q = q.eq('sucursal', sucursal)
          return q
        })(),
      ])
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Error al cargar los pedidos')
      if (eVal) throw new Error('No se pudieron leer las validaciones')
      const pedidos: PickingPedidoPrep[] = json.pedidos_detalle ?? []
      const demandaCache = new Map<string, Map<string, Map<string, LineaDemanda>>>()
      const lista: Faltante[] = []
      for (const v of (vals ?? []) as ValidacionPrep[]) {
        if (!demandaCache.has(v.sucursal)) demandaCache.set(v.sucursal, demandaPorDia(pedidos, v.sucursal))
        const linea = demandaCache.get(v.sucursal)!.get(v.fecha)?.get(v.clave)
        if (!linea) continue // el pedido ya no está pendiente de preparar
        const e = estadoLinea(linea.cantidad, v)
        if (e.faltanteDeclarado <= 0) continue // ya se validó o dejó de hacer falta
        lista.push({ v, linea, falta: e.faltanteDeclarado })
      }
      lista.sort((a, b) => a.v.fecha.localeCompare(b.v.fecha) || a.v.sucursal.localeCompare(b.v.sucursal) || a.v.nombre.localeCompare(b.v.nombre, 'es'))
      setFaltantes(lista)
    } catch (e: any) { setError(e.message ?? 'Error al cargar') }
    setCargando(false)
  }, [desde, hasta, sucursal])
  useEffect(() => { cargar() }, [cargar])

  const visibles = useMemo(() => faltantes.filter(f =>
    filtro === 'todos' ? true : filtro === 'sin_decidir' ? !f.v.decision : !!f.v.decision), [faltantes, filtro])
  const sinDecidir = faltantes.filter(f => !f.v.decision).length

  function abrirTransferencia(f: Faltante) {
    setModal(f)
    setOrigen(''); setCantidad(String(f.falta)); setFechaSol(f.v.fecha)
    const lista = f.linea.pedidos.map(p => `NV ${p.nv} (${p.cliente}) x${fmtNum(p.cantidad)}`).join(' · ')
    setNotaTr(`Faltante en preparación del ${f.v.fecha}. ${lista}`)
  }

  async function pedirTransferencia() {
    if (!modal) return
    const cant = Number(cantidad)
    if (!origen) { showToast('Elegí la sucursal de origen', 'err'); return }
    if (!(cant > 0)) { showToast('Ingresá una cantidad válida', 'err'); return }
    setEnviando(true)
    try {
      const idNum = modal.v.codigo && /^\d+$/.test(modal.v.codigo) ? Number(modal.v.codigo) : null
      const crear = async (extra: { nv: string | null; cliente: string | null }, cantidadItem: number) => {
        const res = await fetch('/api/requerimientos', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo: 'abastecimiento', sucursal_origen: origen, sucursal_destino: modal.v.sucursal, estado: 'pendiente',
            fecha_req: hoyISO(), fecha_solicitada: fechaSol || null, solicitado_por: userEmail,
            nv: extra.nv, cliente: extra.cliente, notas: notaTr.trim() || null,
            items: [{ id_producto: idNum, nombre_producto: modal.v.nombre, cantidad_solicitada: cantidadItem }],
          }),
        })
        const j = await res.json()
        if (!res.ok || !j.id) throw new Error(j.error ?? 'No se pudo crear la transferencia')
        return j as { id: string; aprobada_automaticamente?: boolean; id_extra?: string | null }
      }
      // Una transferencia por cada venta (NV) afectada: se aprueba sola por lo que esa venta necesita.
      // Lo que sobra de la cantidad pedida va aparte, sin venta, y queda pendiente de aprobar.
      let resto = cant
      let primeraId = ''
      let aprobadas = 0
      let pendientes = 0
      for (const p of modal.linea.pedidos) {
        if (resto <= 0) break
        const asignar = Math.min(resto, p.cantidad)
        const j = await crear({ nv: String(p.nv), cliente: p.cliente }, asignar)
        resto -= asignar
        primeraId = primeraId || j.id
        if (j.aprobada_automaticamente) aprobadas++; else pendientes++
        if (j.id_extra) pendientes++
      }
      if (resto > 0) {
        const j = await crear({ nv: null, cliente: null }, resto)
        primeraId = primeraId || j.id
        pendientes++
      }
      const j = { id: primeraId }
      const { error } = await supabase.from('prep_validaciones').update({
        decision: 'transferencia', decision_nota: `${cant} desde ${origen}`, decision_req_id: j.id, decision_por: userId, decision_en: new Date().toISOString(),
      }).eq('id', modal.v.id)
      if (error) throw new Error('La transferencia se creó, pero no se pudo marcar la decisión')
      if (userId) logAuditoria(userId, userNombre, 'Pidió transferencia por faltante', 'Abastecimiento', { sucursal: modal.v.sucursal, fecha: modal.v.fecha, producto: modal.v.nombre, cantidad: cant, origen, requerimiento: j.id })
      showToast(`Transferencia desde ${origen}: ${aprobadas} aprobada${aprobadas !== 1 ? 's' : ''} automáticamente por tener venta${pendientes > 0 ? ` y ${pendientes} pendiente${pendientes !== 1 ? 's' : ''} de aprobar` : ''}`)
      setModal(null)
      await cargar()
    } catch (e: any) { showToast(e.message ?? 'Error', 'err') }
    setEnviando(false)
  }

  async function esperarMercaderia(f: Faltante, nota: string) {
    const { error } = await supabase.from('prep_validaciones').update({
      decision: 'esperar', decision_nota: nota.trim() || null, decision_req_id: null, decision_por: userId, decision_en: new Date().toISOString(),
    }).eq('id', f.v.id)
    if (error) { showToast('No se pudo guardar la decisión', 'err'); return }
    if (userId) logAuditoria(userId, userNombre, 'Decidió esperar mercadería', 'Abastecimiento', { sucursal: f.v.sucursal, fecha: f.v.fecha, producto: f.v.nombre, faltan: f.falta, nota: nota.trim() || null })
    setEsperando(null)
    showToast('Queda esperando mercadería')
    await cargar()
  }

  async function reabrir(f: Faltante) {
    const { error } = await supabase.from('prep_validaciones').update({
      decision: null, decision_nota: null, decision_req_id: null, decision_por: null, decision_en: null,
    }).eq('id', f.v.id)
    if (error) { showToast('No se pudo reabrir', 'err'); return }
    await cargar()
  }

  const chipSt = (on: boolean): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 16, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1.5px solid ${on ? '#254A96' : '#d6d6d6'}`, background: on ? '#254A96' : '#fff', color: on ? '#fff' : '#555',
  })
  const btn = (bg: string, fg: string, borde?: string): React.CSSProperties => ({
    padding: '7px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', background: bg, color: fg, border: borde ?? 'none', whiteSpace: 'nowrap',
  })

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto">
      <div className="mb-5">
        <h2 className="text-lg font-semibold mb-1" style={{ color: '#254A96' }}>Faltantes de preparación</h2>
        <p className="text-sm" style={{ color: '#6b7280' }}>
          Lo que el depósito declaró que <b>no tiene físicamente</b> al validar la preparación. Para cada faltante se pide una transferencia a otra sucursal o se espera que llegue la mercadería. Para decidir de dónde transferir, mirá el stock directo en el ERP.
        </p>
      </div>

      <div className="bg-white rounded-xl border p-4 mb-5" style={{ borderColor: '#e8edf8' }}>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Entrega desde</label>
            <input type="date" value={desde} onChange={e => setDesde(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Hasta</label>
            <input type="date" value={hasta} onChange={e => setHasta(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }} />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Sucursal</label>
            <select value={sucursal} onChange={e => setSucursal(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }}>
              <option value="">Todas</option>
              {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <button onClick={cargar} disabled={cargando} className="px-4 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-50" style={{ background: '#254A96' }}>{cargando ? '…' : '🔄 Actualizar'}</button>
        </div>
        <div className="flex flex-wrap gap-2 mt-3 items-center">
          <button onClick={() => setFiltro('todos')} style={chipSt(filtro === 'todos')}>Todos ({faltantes.length})</button>
          <button onClick={() => setFiltro('sin_decidir')} style={chipSt(filtro === 'sin_decidir')}>Sin decidir ({sinDecidir})</button>
          <button onClick={() => setFiltro('decididos')} style={chipSt(filtro === 'decididos')}>Ya decididos ({faltantes.length - sinDecidir})</button>
        </div>
      </div>

      {error && <div className="rounded-lg px-4 py-3 mb-4 text-sm" style={{ background: '#fde8e8', color: '#E52322' }}>{error}</div>}
      {!cargando && !error && visibles.length === 0 && (
        <div className="bg-white rounded-xl border p-8 text-center" style={{ borderColor: '#e8edf8' }}>
          <p className="text-sm" style={{ color: '#B9BBB7' }}>{faltantes.length === 0 ? 'No hay faltantes declarados para ese período. 👌' : 'No hay faltantes con ese filtro.'}</p>
        </div>
      )}

      <div className="space-y-3">
        {visibles.map(f => (
          <div key={f.v.id} className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: f.v.decision ? '#e8edf8' : '#fca5a5', borderLeftWidth: 4, borderLeftColor: f.v.decision === 'transferencia' ? '#0369a1' : f.v.decision === 'esperar' ? '#7c3aed' : '#E52322' }}>
            <div className="px-4 py-3 flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-0" style={{ minWidth: 220 }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold" style={{ color: '#1e1e1e' }}>{f.v.nombre}</span>
                  {f.v.codigo && <span className="font-mono text-xs" style={{ color: '#9ca3af' }}>#{f.v.codigo}</span>}
                </div>
                <div className="text-xs mt-1" style={{ color: '#6b7280' }}>
                  <b style={{ color: '#254A96' }}>{f.v.sucursal}</b> · entrega {fmtDia(f.v.fecha)} · pedido {fmtNum(f.linea.cantidad)} · validado {fmtNum(f.v.validada)}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {f.linea.pedidos.map((p, i) => (
                    <span key={i} className="text-xs rounded-full px-2 py-0.5" style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a' }}>NV {p.nv} · {p.cliente} · {fmtNum(p.cantidad)}</span>
                  ))}
                </div>
              </div>
              <div className="text-center shrink-0">
                <div className="text-2xl font-bold" style={{ color: '#E52322' }}>{fmtNum(f.falta)}</div>
                <div className="text-xs" style={{ color: '#9ca3af' }}>{f.linea.unidad} sin stock</div>
              </div>
            </div>
            <div className="px-4 py-2.5 flex flex-wrap items-center gap-2" style={{ background: '#fafbff', borderTop: '1px solid #f0f0f0' }}>
              {f.v.decision === 'transferencia' && (
                <>
                  <span className="text-xs font-semibold rounded-full px-2.5 py-1" style={{ background: '#e0f2fe', color: '#0369a1' }}>🔄 Transferencia pedida ({f.v.decision_nota})</span>
                  <button onClick={onIrATransferencias} style={btn('#fff', '#254A96', '1.5px solid #254A96')}>Ver en Transferencias</button>
                </>
              )}
              {f.v.decision === 'esperar' && (
                <span className="text-xs font-semibold rounded-full px-2.5 py-1" style={{ background: '#ede9fe', color: '#6d28d9' }}>⏳ Esperando mercadería{f.v.decision_nota ? ` — ${f.v.decision_nota}` : ''}</span>
              )}
              {puedeDecidir && !f.v.decision && (
                esperando?.id === f.v.id ? (
                  <span className="flex items-center gap-2 flex-wrap">
                    <input autoFocus value={esperando.nota} onChange={e => setEsperando({ id: f.v.id, nota: e.target.value })}
                      onKeyDown={e => { if (e.key === 'Enter') esperarMercaderia(f, esperando.nota) }}
                      placeholder="Nota (ej: llega el jueves)" className="border rounded-lg px-2.5 py-1.5 text-sm" style={{ borderColor: '#d6d6d6', minWidth: 220 }} />
                    <button onClick={() => esperarMercaderia(f, esperando.nota)} style={btn('#7c3aed', '#fff')}>Confirmar espera</button>
                    <button onClick={() => setEsperando(null)} style={btn('#fff', '#6b7280', '1px solid #d6d6d6')}>✕</button>
                  </span>
                ) : (
                  <>
                    <button onClick={() => abrirTransferencia(f)} style={btn('#1d4ed8', '#fff')}>🔄 Pedir transferencia</button>
                    <button onClick={() => setEsperando({ id: f.v.id, nota: '' })} style={btn('#fff', '#7c3aed', '1.5px solid #c4b5fd')}>⏳ Esperar mercadería</button>
                  </>
                )
              )}
              {puedeDecidir && f.v.decision && (
                <button onClick={() => reabrir(f)} style={{ ...btn('#fff', '#6b7280', '1px solid #d6d6d6'), marginLeft: 'auto' }}>Cambiar decisión</button>
              )}
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => !enviando && setModal(null)}>
          <div onClick={e => e.stopPropagation()} className="bg-white rounded-2xl p-5" style={{ width: '100%', maxWidth: 480, maxHeight: '92vh', overflowY: 'auto' }}>
            <h3 className="font-bold mb-1" style={{ color: '#254A96', fontSize: 17 }}>🔄 Pedir transferencia</h3>
            <p className="text-sm mb-3" style={{ color: '#6b7280' }}><b>{modal.v.nombre}</b> → destino <b>{modal.v.sucursal}</b></p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Transferir desde (origen) <span style={{ color: '#E52322' }}>*</span></label>
                <select value={origen} onChange={e => setOrigen(e.target.value)} className="w-full border rounded-xl px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }}>
                  <option value="">Seleccionar sucursal origen…</option>
                  {SUCURSALES.filter(s => s !== modal.v.sucursal).map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>Verificá en el ERP que esa sucursal tenga stock.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Cantidad</label>
                  <input type="number" min={1} value={cantidad} onChange={e => setCantidad(e.target.value)} className="w-full border rounded-xl px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Fecha solicitada</label>
                  <input type="date" value={fechaSol} onChange={e => setFechaSol(e.target.value)} className="w-full border rounded-xl px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Notas</label>
                <textarea value={notaTr} onChange={e => setNotaTr(e.target.value)} rows={3} className="w-full border rounded-xl px-3 py-2 text-sm" style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={pedirTransferencia} disabled={enviando || !origen} className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40" style={{ background: '#254A96' }}>{enviando ? 'Creando…' : '🔄 Crear transferencia'}</button>
              <button onClick={() => setModal(null)} disabled={enviando} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
