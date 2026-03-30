'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/app/supabase'

interface Pedido {
  id: string; nv: string; cliente: string; direccion: string; sucursal: string
  fecha_entrega: string; vuelta: number; estado: string; estado_pago: string; peso_total_kg: number | null
  notas: string | null; camion_id: string | null; orden_entrega: number | null
  latitud: number | null; longitud: number | null
  items?: { nombre: string; cantidad: number; unidad: string }[]
}
interface Camion {
  codigo: string; sucursal: string; tipo_unidad: string
  posiciones_total: number; tonelaje_max_kg: number
  grua_hidraulica: boolean; volcador: boolean
}
interface ColumnaKanban { camion: Camion; pedidos: Pedido[]; pesoTotal: number }

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']
const VUELTAS = [
  { num: 1, label: 'V1', horario: '8:00–10:00' },
  { num: 2, label: 'V2', horario: '10:00–12:00' },
  { num: 3, label: 'V3', horario: '13:00–15:00' },
  { num: 4, label: 'V4', horario: '15:00–17:00' },
]
const PAGO_COLOR: Record<string, string> = {
  cobrado: 'bg-green-100 text-green-800', cuenta_corriente: 'bg-blue-100 text-blue-800',
  pendiente_cobro: 'bg-yellow-100 text-yellow-800', provisorio: 'bg-orange-100 text-orange-800',
}
const PAGO_LABEL: Record<string, string> = {
  cobrado: 'Cobrado', cuenta_corriente: 'Cta. Cte.', pendiente_cobro: 'Pend.', provisorio: 'Provis.',
}

function hoy() { return new Date().toISOString().split('T')[0] }
function pesoColumna(ps: Pedido[]) { return ps.reduce((a, p) => a + (p.peso_total_kg ?? 0), 0) }
function pct(peso: number, max: number) { return max === 0 ? 0 : Math.min(100, Math.round(peso / max * 100)) }
function colorBarra(p: number) { return p >= 90 ? '#E52322' : p >= 70 ? '#f59e0b' : '#10b981' }

function sugerirAsignacion(sin: Pedido[], camiones: Camion[], ya: Pedido[]): Record<string, string | null> {
  const acum: Record<string, number> = {}
  camiones.forEach(c => { acum[c.codigo] = ya.filter(p => p.camion_id === c.codigo).reduce((a, p) => a + (p.peso_total_kg ?? 0), 0) })
  const asigs: Record<string, string | null> = {}
  for (const p of [...sin].sort((a, b) => (b.peso_total_kg ?? 0) - (a.peso_total_kg ?? 0))) {
    const peso = p.peso_total_kg ?? 0
    const c = camiones.filter(c => c.tonelaje_max_kg - acum[c.codigo] >= peso)
      .sort((a, b) => (a.tonelaje_max_kg - acum[a.codigo]) - (b.tonelaje_max_kg - acum[b.codigo]))[0]
    if (c) { asigs[p.id] = c.codigo; acum[c.codigo] += peso } else asigs[p.id] = null
  }
  return asigs
}

function PedidoCard({ pedido, onDragStart, onCancelar, onCambiarVuelta, onReprogramar }: {
  pedido: Pedido
  onDragStart: (e: React.DragEvent, p: Pedido) => void
  onCancelar: (id: string) => void
  onCambiarVuelta: (id: string, vuelta: number) => void
  onReprogramar: (id: string, fecha: string, vuelta: number, motivo: string) => void
}) {
  const [expandido, setExpandido] = useState(false)
  const [modo, setModo] = useState<'normal' | 'vuelta' | 'reprog'>('normal')
  const [reprogFecha, setReprogFecha] = useState('')
  const [reprogVuelta, setReprogVuelta] = useState(1)
  const [reprogMotivo, setReprogMotivo] = useState('')
  const mananaStr = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0] })()
  const esReprogramado = pedido.notas?.startsWith('⚡')
  return (
    <div draggable onDragStart={e => onDragStart(e, pedido)}
      className="bg-white rounded-lg p-3 mb-2 cursor-grab active:cursor-grabbing select-none hover:shadow-md transition-shadow"
      style={{ border: `1px solid ${esReprogramado ? '#fbbf24' : '#f0f0f0'}` }}>
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-semibold text-xs leading-tight" style={{ color: '#254A96' }}>{pedido.cliente}</span>
        <div className="flex items-center gap-1 shrink-0">
          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${PAGO_COLOR[pedido.estado_pago] ?? 'bg-gray-100 text-gray-600'}`}>
            {PAGO_LABEL[pedido.estado_pago] ?? pedido.estado_pago}
          </span>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); if (confirm(`¿Cancelar pedido de ${pedido.cliente}?`)) onCancelar(pedido.id) }}
            title="Cancelar pedido"
            className="w-4 h-4 flex items-center justify-center rounded hover:bg-red-50 transition-colors"
            style={{ color: '#E52322', fontSize: '10px', lineHeight: 1 }}>
            ✕
          </button>
        </div>
      </div>
      <p className="text-xs mb-1.5 leading-tight" style={{ color: '#B9BBB7' }}>{pedido.direccion}</p>
      <div className="flex justify-between items-center">
        <span className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</span>
        {pedido.peso_total_kg != null && <span className="text-xs font-semibold" style={{ color: '#254A96' }}>{pedido.peso_total_kg} kg</span>}
      </div>
      {modo === 'reprog' ? (
        <div className="mt-2 p-2.5 rounded-lg" style={{ background: '#f4f4f3' }}>
          <p className="text-xs font-medium mb-2" style={{ color: '#254A96' }}>📅 Reprogramar entrega</p>
          <div className="space-y-1.5">
            <input type="date" value={reprogFecha} min={mananaStr}
              onChange={e => setReprogFecha(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8' }} />
            <select value={reprogVuelta} onChange={e => setReprogVuelta(parseInt(e.target.value))}
              onMouseDown={e => e.stopPropagation()}
              className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8' }}>
              {[1, 2, 3, 4].map(v => <option key={v} value={v}>Vuelta {v}</option>)}
            </select>
            <input type="text" value={reprogMotivo}
              onChange={e => setReprogMotivo(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              placeholder="Motivo (ej: lluvia, cliente no disponible)"
              className="w-full text-xs border rounded px-2 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8' }} />
          </div>
          <div className="flex gap-1.5 mt-2">
            <button disabled={!reprogFecha}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); onReprogramar(pedido.id, reprogFecha, reprogVuelta, reprogMotivo); setModo('normal') }}
              className="flex-1 text-xs py-1.5 rounded font-medium text-white disabled:opacity-40"
              style={{ background: '#254A96' }}>Confirmar</button>
            <button onMouseDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setModo('normal') }}
              className="text-xs px-2 py-1.5 rounded"
              style={{ background: '#e8edf8', color: '#666' }}>×</button>
          </div>
        </div>
      ) : modo === 'vuelta' ? (
        <div className="mt-2 flex items-center gap-1.5">
          <select
            onMouseDown={e => e.stopPropagation()}
            onChange={e => { onCambiarVuelta(pedido.id, parseInt(e.target.value)); setModo('normal') }}
            defaultValue=""
            className="text-xs border rounded px-2 py-1 flex-1 focus:outline-none"
            style={{ borderColor: '#e8edf8' }}>
            <option value="" disabled>Mover a vuelta...</option>
            {[1, 2, 3, 4].filter(v => v !== pedido.vuelta).map(v => (
              <option key={v} value={v}>Vuelta {v}</option>
            ))}
          </select>
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setModo('normal') }}
            className="text-xs" style={{ color: '#B9BBB7' }}>×</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-1.5">
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setModo('vuelta') }}
            className="text-xs hover:underline" style={{ color: '#B9BBB7' }}>
            V{pedido.vuelta} · cambiar
          </button>
          <span style={{ color: '#e0e0e0' }}>|</span>
          <button onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setModo('reprog'); setReprogFecha(''); setReprogVuelta(1); setReprogMotivo('') }}
            className="text-xs hover:underline" style={{ color: '#f59e0b' }}>
            📅 reprogramar
          </button>
        </div>
      )}
      {pedido.items && pedido.items.length > 0 && (
        <div className="mt-1.5">
          <button onMouseDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setExpandido(!expandido) }}
            className="text-xs font-medium" style={{ color: '#254A96' }}>
            {expandido ? '▲ Ocultar' : `▼ ${pedido.items.length} producto${pedido.items.length > 1 ? 's' : ''}`}
          </button>
          {expandido && (
            <div className="mt-1.5 space-y-1">
              {pedido.items.map((item, i) => (
                <div key={i} className="flex justify-between text-xs rounded px-2 py-1" style={{ background: '#f4f4f3', color: '#666' }}>
                  <span>{item.nombre}</span>
                  <span className="shrink-0 ml-2 font-medium">{item.cantidad} {item.unidad}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {pedido.notas && <p className="text-xs rounded px-2 py-1 mt-1.5 leading-tight" style={{ background: esReprogramado ? '#fef3c7' : '#fff8e1', color: '#b45309' }}>{pedido.notas}</p>}
    </div>
  )
}

function ColumnaCamion({ columna, sinAsignar = false, onDrop, onDragOver, onDragLeave, onDragStart, isDragOver, onCancelar, onCambiarVuelta, onReprogramar }: {
  columna: ColumnaKanban; sinAsignar?: boolean
  onDrop: (e: React.DragEvent, cod: string | null) => void
  onDragOver: (e: React.DragEvent, cod: string | null) => void
  onDragLeave: () => void; onDragStart: (e: React.DragEvent, p: Pedido) => void; isDragOver: boolean
  onCancelar: (id: string) => void
  onCambiarVuelta: (id: string, vuelta: number) => void
  onReprogramar: (id: string, fecha: string, vuelta: number, motivo: string) => void
}) {
  const { camion, pedidos, pesoTotal } = columna
  const p = sinAsignar ? 0 : pct(pesoTotal, camion.tonelaje_max_kg)
  return (
    <div onDrop={e => onDrop(e, sinAsignar ? null : camion.codigo)}
      onDragOver={e => onDragOver(e, sinAsignar ? null : camion.codigo)}
      onDragLeave={onDragLeave}
      className="flex flex-col rounded-xl min-w-[210px] w-[210px] shrink-0 transition-all"
      style={{
        border: `2px ${sinAsignar ? 'dashed' : 'solid'} ${isDragOver ? '#254A96' : '#f0f0f0'}`,
        background: isDragOver ? '#e8edf8' : '#f9f9f9',
        boxShadow: isDragOver ? '0 0 0 3px rgba(37,74,150,0.12)' : 'none',
      }}>
      <div className="p-3 rounded-t-xl" style={{ background: sinAsignar ? 'transparent' : 'white', borderBottom: sinAsignar ? 'none' : '1px solid #f0f0f0' }}>
        {sinAsignar ? (
          <div className="text-center py-1">
            <p className="text-sm font-semibold" style={{ color: '#B9BBB7' }}>Sin asignar</p>
            <p className="text-xs" style={{ color: '#B9BBB7' }}>{pedidos.length} pedidos</p>
          </div>
        ) : (
          <>
            <div className="flex justify-between items-center mb-1">
              <span className="font-bold text-sm" style={{ color: '#254A96' }}>{camion.codigo}</span>
              <div className="flex gap-1">
                {camion.grua_hidraulica && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#e8edf8', color: '#254A96' }}>Grúa</span>}
                {camion.volcador && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#fef3c7', color: '#d97706' }}>Volc.</span>}
              </div>
            </div>
            <p className="text-xs mb-2" style={{ color: '#B9BBB7' }}>{camion.tipo_unidad}</p>
            <div className="w-full rounded-full h-1.5 mb-1" style={{ background: '#f0f0f0' }}>
              <div className="h-1.5 rounded-full transition-all" style={{ width: `${p}%`, background: colorBarra(p) }} />
            </div>
            <div className="flex justify-between text-xs" style={{ color: '#B9BBB7' }}>
              <span>{Math.round(pesoTotal)} kg</span>
              <span style={{ color: p >= 90 ? '#E52322' : '#B9BBB7', fontWeight: p >= 90 ? 600 : 400 }}>{p}% · {camion.tonelaje_max_kg} kg</span>
            </div>
          </>
        )}
      </div>
      <div className="p-2 flex-1 overflow-y-auto max-h-[420px]">
        {pedidos.length === 0
          ? <div className="text-center py-8 text-xs" style={{ color: '#B9BBB7' }}>{sinAsignar ? 'Todos asignados ✓' : 'Arrastrá pedidos acá'}</div>
          : pedidos.map(p => <PedidoCard key={p.id} pedido={p} onDragStart={onDragStart} onCancelar={onCancelar} onCambiarVuelta={onCambiarVuelta} onReprogramar={onReprogramar} />)}
      </div>
    </div>
  )
}
const DEPOSITOS: Record<string, { lat: number; lng: number }> = {
  'LP520':    { lat: -34.9205, lng: -57.9536 },
  'LP139':    { lat: -34.9205, lng: -57.9536 },
  'Guernica': { lat: -35.0647, lng: -58.3731 },
  'Cañuelas': { lat: -35.0511, lng: -58.7613 },
  'Pinamar':  { lat: -37.1097, lng: -56.8621 },
}

function calcularOrdenRuta(pedidos: Pedido[], sucursal: string): Record<string, number> {
  const deposito = DEPOSITOS[sucursal] ?? { lat: -34.9205, lng: -57.9536 }
  const conCoords = pedidos.filter(p => p.latitud && p.longitud)
  const sinCoords = pedidos.filter(p => !p.latitud || !p.longitud)

  const ordenados: Pedido[] = []
  const restantes = [...conCoords]
  let latActual = deposito.lat
  let lngActual = deposito.lng

  while (restantes.length > 0) {
    let minDist = Infinity
    let minIdx = 0
    restantes.forEach((p, i) => {
      const d = Math.pow((p.latitud ?? 0) - latActual, 2) + Math.pow((p.longitud ?? 0) - lngActual, 2)
      if (d < minDist) { minDist = d; minIdx = i }
    })
    const siguiente = restantes.splice(minIdx, 1)[0]
    ordenados.push(siguiente)
    latActual = siguiente.latitud!
    lngActual = siguiente.longitud!
  }

  const todos = [...ordenados, ...sinCoords]
  const resultado: Record<string, number> = {}
  todos.forEach((p, i) => { resultado[p.id] = i + 1 })
  return resultado
}
export default function ProgramacionPage() {
  const router = useRouter()
  const [fecha, setFecha] = useState(hoy())
  const [sucursal, setSucursal] = useState('LP520')
  const [vueltaActiva, setVueltaActiva] = useState(1)
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [camiones, setCamiones] = useState<Camion[]>([])
  const [columnas, setColumnas] = useState<ColumnaKanban[]>([])
  const [sinAsignar, setSinAsignar] = useState<Pedido[]>([])
  const [cargando, setCargando] = useState(false)
  const [guardando, setGuardando] = useState(false)
  const [confirmado, setConfirmado] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const dragPedido = useRef<Pedido | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => { setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000) }

  useEffect(() => { cargarDatos() }, [fecha, sucursal, vueltaActiva])

  async function cargarDatos() {
    setCargando(true); setConfirmado(false)
    const { data: pd } = await supabase.from('pedidos')
      .select('*, items:pedido_items(nombre, cantidad, unidad)')
      .eq('fecha_entrega', fecha).eq('sucursal', sucursal).eq('vuelta', vueltaActiva)
      .in('estado', ['pendiente', 'programado']).order('cliente')
    const { data: fd } = await supabase.from('flota_dia').select('camion_codigo').eq('fecha', fecha).eq('sucursal', sucursal).eq('activo', true)
    const codigos = (fd ?? []).map((f: any) => f.camion_codigo)
    const { data: cd } = codigos.length > 0 ? await supabase.from('camiones_flota').select('*').in('codigo', codigos).eq('activo', true) : { data: [] }
    const todos = pd ?? []; const cams = cd ?? []
    setPedidos(todos); setCamiones(cams); construirColumnas(todos, cams); setCargando(false)
  }

  function construirColumnas(todos: Pedido[], cams: Camion[]) {
    setColumnas(cams.map(c => { const ps = todos.filter(p => p.camion_id === c.codigo); return { camion: c, pedidos: ps, pesoTotal: pesoColumna(ps) } }))
    setSinAsignar(todos.filter(p => !p.camion_id))
  }

  function handleSugerir() {
    const sin = pedidos.filter(p => !p.camion_id)
    if (!sin.length) return
    const asigs = sugerirAsignacion(sin, camiones, pedidos.filter(p => p.camion_id))
    const act = pedidos.map(p => ({ ...p, camion_id: p.id in asigs ? asigs[p.id] : p.camion_id }))
    setPedidos(act); construirColumnas(act, camiones)
  }

  function handleDrop(e: React.DragEvent, cod: string | null) {
    e.preventDefault(); setDragOver(null)
    if (!dragPedido.current) return
    const id = dragPedido.current.id; dragPedido.current = null
    const act = pedidos.map(p => p.id === id ? { ...p, camion_id: cod } : p)
    setPedidos(act); construirColumnas(act, camiones)
  }

  async function handleConfirmar() {
    setGuardando(true)

    const asignados = pedidos.filter(p => p.camion_id)
    const sinCamion = pedidos.filter(p => !p.camion_id)

    const porCamion: Record<string, Pedido[]> = {}
    asignados.forEach(p => {
      if (!porCamion[p.camion_id!]) porCamion[p.camion_id!] = []
      porCamion[p.camion_id!].push(p)
    })

    const ordenes: Record<string, number> = {}
    Object.entries(porCamion).forEach(([, pedidosCamion]) => {
      const orden = calcularOrdenRuta(pedidosCamion, sucursal)
      Object.assign(ordenes, orden)
    })

    try {
      const resultados = await Promise.all([
        ...asignados.map(p =>
          supabase.from('pedidos').update({
            camion_id: p.camion_id,
            estado: 'programado',
            orden_entrega: ordenes[p.id] ?? null,
          }).eq('id', p.id)
        ),
        ...sinCamion.map(p =>
          supabase.from('pedidos').update({
            camion_id: null,
            estado: 'pendiente',
            orden_entrega: null,
          }).eq('id', p.id)
        ),
      ])

      const errores = resultados.filter(r => r.error)
      if (errores.length > 0) {
        console.error('Errores al confirmar:', errores.map(r => r.error))
        showToast(`Error al guardar: ${errores[0].error?.message ?? 'error desconocido'}`, 'err')
      } else {
        setConfirmado(true)
        showToast('Programación confirmada')
      }
    } catch (e: any) {
      showToast(`Error inesperado: ${e.message}`, 'err')
    } finally {
      setGuardando(false)
    }
  }

  async function handleCancelar(id: string) {
    const { error } = await supabase.from('pedidos').update({ estado: 'cancelado' }).eq('id', id)
    if (error) { showToast('Error al cancelar', 'err'); return }
    const act = pedidos.filter(p => p.id !== id)
    setPedidos(act); construirColumnas(act, camiones)
    showToast('Pedido cancelado')
  }

  async function handleCambiarVuelta(id: string, nuevaVuelta: number) {
    const { error } = await supabase.from('pedidos').update({ vuelta: nuevaVuelta, camion_id: null, estado: 'pendiente' }).eq('id', id)
    if (error) { showToast('Error al cambiar vuelta', 'err'); return }
    const act = pedidos.filter(p => p.id !== id)
    setPedidos(act); construirColumnas(act, camiones)
    showToast(`Pedido movido a Vuelta ${nuevaVuelta}`)
  }

  async function handleReprogramar(id: string, fecha: string, vuelta: number, motivo: string) {
    const pedido = pedidos.find(p => p.id === id)
    if (!pedido) return
    const nota = `⚡ Reprogramado desde ${pedido.fecha_entrega} V${pedido.vuelta}${motivo ? ` — ${motivo}` : ''}`
    const notaFinal = pedido.notas ? `${pedido.notas} | ${nota}` : nota
    const { error } = await supabase.from('pedidos').update({
      fecha_entrega: fecha, vuelta, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: notaFinal
    }).eq('id', id)
    if (error) { showToast('Error al reprogramar', 'err'); return }
    const act = pedidos.filter(p => p.id !== id)
    setPedidos(act); construirColumnas(act, camiones)
    showToast(`Pedido de ${pedido.cliente} reprogramado para el ${fecha}`)
  }

  const totalAsig = pedidos.filter(p => p.camion_id).length
  const totalSin = pedidos.length - totalAsig

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-screen-2xl mx-auto px-4 md:px-6">
          <div className="h-14 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <button onClick={() => router.push('/dashboard')} className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg shrink-0"
                style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</button>
              <div className="hidden sm:block">
                <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Programación</span>
                <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Asignación de pedidos a camiones</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input type="date" value={fecha} onChange={e => { setFecha(e.target.value); setConfirmado(false) }}
                className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              <select value={sucursal} onChange={e => { setSucursal(e.target.value); setConfirmado(false) }}
                className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-1.5 pb-3 flex-wrap">
            {VUELTAS.map(v => (
              <button key={v.num} onClick={() => setVueltaActiva(v.num)}
                className="px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ background: vueltaActiva === v.num ? '#254A96' : '#f4f4f3', color: vueltaActiva === v.num ? 'white' : '#666' }}>
                {v.label} <span className="text-xs opacity-70">{v.horario}</span>
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Barra acciones */}
      <div className="bg-white border-b px-4 md:px-6 py-2.5" style={{ borderColor: '#f0f0f0' }}>
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-5 text-sm" style={{ color: '#B9BBB7' }}>
            <span>Total: <strong style={{ color: '#254A96' }}>{pedidos.length}</strong></span>
            <span>Asignados: <strong style={{ color: '#10b981' }}>{totalAsig}</strong></span>
            <span>Sin asignar: <strong style={{ color: totalSin > 0 ? '#E52322' : '#B9BBB7' }}>{totalSin}</strong></span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { const l = pedidos.map(p => ({ ...p, camion_id: null })); setPedidos(l); construirColumnas(l, camiones); setConfirmado(false) }}
              disabled={cargando || guardando}
              className="px-3 py-2 text-sm rounded-lg border transition-colors disabled:opacity-40"
              style={{ borderColor: '#e8edf8', color: '#666' }}>Limpiar</button>
            <button onClick={handleSugerir} disabled={cargando || guardando || totalSin === 0}
              className="px-4 py-2 text-sm font-medium rounded-lg text-white transition-colors disabled:opacity-40"
              style={{ background: '#7c3aed' }}>✦ Sugerir</button>
            <button onClick={handleConfirmar} disabled={cargando || guardando || totalAsig === 0 || confirmado}
              className="px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-40"
              style={{ background: confirmado ? '#d1fae5' : '#254A96', color: confirmado ? '#065f46' : 'white' }}>
              {guardando ? 'Guardando…' : confirmado ? '✓ Confirmado' : 'Confirmar'}
            </button>
          </div>
        </div>
      </div>

      {/* Kanban */}
      <div className="p-4 md:p-6 max-w-screen-2xl mx-auto">
        {cargando ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : pedidos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
            <div className="text-5xl mb-4">📦</div>
            <p className="font-medium">No hay pedidos para esta fecha y sucursal</p>
            <p className="text-sm mt-1">Cambiá la fecha, la sucursal o la vuelta</p>
          </div>
        ) : camiones.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
            <div className="text-5xl mb-4">🚛</div>
            <p className="font-medium">No hay camiones configurados para esta fecha</p>
            <button onClick={() => router.push('/flota')} className="mt-3 text-sm font-medium" style={{ color: '#254A96' }}>Ir a Flota del día →</button>
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-4">
            <ColumnaCamion sinAsignar
              columna={{ camion: { codigo: '', sucursal, tipo_unidad: '', posiciones_total: 0, tonelaje_max_kg: 0, grua_hidraulica: false, volcador: false }, pedidos: sinAsignar, pesoTotal: 0 }}
              onDrop={handleDrop}
              onDragOver={(e, cod) => { e.preventDefault(); setDragOver(cod ?? 'sin_asignar') }}
              onDragLeave={() => setDragOver(null)}
              onDragStart={(e, p) => { dragPedido.current = p; e.dataTransfer.effectAllowed = 'move' }}
              isDragOver={dragOver === 'sin_asignar'}
              onCancelar={handleCancelar}
              onCambiarVuelta={handleCambiarVuelta}
              onReprogramar={handleReprogramar} />
            <div className="w-px shrink-0 self-stretch" style={{ background: '#e8edf8' }} />
            {columnas.map(col => (
              <ColumnaCamion key={col.camion.codigo} columna={col}
                onDrop={handleDrop}
                onDragOver={(e, cod) => { e.preventDefault(); setDragOver(cod ?? 'sin_asignar') }}
                onDragLeave={() => setDragOver(null)}
                onDragStart={(e, p) => { dragPedido.current = p; e.dataTransfer.effectAllowed = 'move' }}
                isDragOver={dragOver === col.camion.codigo}
                onCancelar={handleCancelar}
                onCambiarVuelta={handleCambiarVuelta}
                onReprogramar={handleReprogramar} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}