'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/app/supabase'

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface Pedido {
  id: string
  nv: string
  cliente: string
  direccion: string
  sucursal: string
  vuelta: number
  estado: string
  estado_pago: string
  peso_total_kg: number | null
  notas: string | null
  camion_id: string | null
  items?: { nombre: string; cantidad: number; unidad: string }[]
}

interface Camion {
  codigo: string
  sucursal: string
  tipo_unidad: string
  posiciones_total: number
  tonelaje_max_kg: number
  grua_hidraulica: boolean
  volcador: boolean
}

interface ColumnaKanban {
  camion: Camion
  pedidos: Pedido[]
  pesoTotal: number
}

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas']

const VUELTAS = [
  { num: 1, label: 'Vuelta 1', horario: '8:00 – 10:00' },
  { num: 2, label: 'Vuelta 2', horario: '10:00 – 12:00' },
  { num: 3, label: 'Vuelta 3', horario: '13:00 – 15:00' },
  { num: 4, label: 'Vuelta 4', horario: '15:00 – 17:00' },
]

const ESTADO_PAGO_COLOR: Record<string, string> = {
  cobrado:          'bg-green-100 text-green-800',
  cuenta_corriente: 'bg-blue-100 text-blue-800',
  pendiente_cobro:  'bg-yellow-100 text-yellow-800',
  provisorio:       'bg-orange-100 text-orange-800',
}

const ESTADO_PAGO_LABEL: Record<string, string> = {
  cobrado:          'Cobrado',
  cuenta_corriente: 'Cta. Cte.',
  pendiente_cobro:  'Pend.',
  provisorio:       'Provis.',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function hoy(): string {
  return new Date().toISOString().split('T')[0]
}

function pesoColumna(pedidos: Pedido[]): number {
  return pedidos.reduce((acc, p) => acc + (p.peso_total_kg ?? 0), 0)
}

function pctCapacidad(peso: number, max: number): number {
  if (max === 0) return 0
  return Math.min(100, Math.round((peso / max) * 100))
}

function colorBarra(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 70) return 'bg-yellow-400'
  return 'bg-green-500'
}

// ─── Sugerencia automática ────────────────────────────────────────────────────
function sugerirAsignacion(
  pedidosSinAsignar: Pedido[],
  camiones: Camion[],
  pedidosYaAsignados: Pedido[]
): Record<string, string | null> {
  const pesoAcumulado: Record<string, number> = {}
  camiones.forEach(c => {
    const yaAsignados = pedidosYaAsignados
      .filter(p => p.camion_id === c.codigo)
      .reduce((acc, p) => acc + (p.peso_total_kg ?? 0), 0)
    pesoAcumulado[c.codigo] = yaAsignados
  })

  const asignaciones: Record<string, string | null> = {}
  const ordenados = [...pedidosSinAsignar].sort(
    (a, b) => (b.peso_total_kg ?? 0) - (a.peso_total_kg ?? 0)
  )

  for (const pedido of ordenados) {
    const peso = pedido.peso_total_kg ?? 0

    // Elige el camión más lleno que todavía aguante el pedido
    // → llena de a un camión antes de pasar al siguiente
    const candidato = camiones
      .filter(c => (c.tonelaje_max_kg - pesoAcumulado[c.codigo]) >= peso)
      .sort((a, b) => {
        const restA = a.tonelaje_max_kg - pesoAcumulado[a.codigo]
        const restB = b.tonelaje_max_kg - pesoAcumulado[b.codigo]
        return restA - restB // ← ascendente: menos espacio restante primero
      })[0]

    if (candidato) {
      asignaciones[pedido.id] = candidato.codigo
      pesoAcumulado[candidato.codigo] += peso
    } else {
      asignaciones[pedido.id] = null
    }
  }

  return asignaciones
}

// ─── Card de pedido ───────────────────────────────────────────────────────────
function PedidoCard({
  pedido,
  onDragStart,
}: {
  pedido: Pedido
  onDragStart: (e: React.DragEvent, pedido: Pedido) => void
}) {
  const [expandido, setExpandido] = useState(false)

  return (
    <div
      draggable
      onDragStart={e => onDragStart(e, pedido)}
      className="bg-white border border-gray-200 rounded-lg p-3 mb-2 cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition-shadow select-none"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <span className="font-semibold text-sm text-gray-900 leading-tight">{pedido.cliente}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 ${ESTADO_PAGO_COLOR[pedido.estado_pago] ?? 'bg-gray-100 text-gray-600'}`}>
          {ESTADO_PAGO_LABEL[pedido.estado_pago] ?? pedido.estado_pago}
        </span>
      </div>
      <p className="text-xs text-gray-500 mb-2 leading-tight">{pedido.direccion}</p>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">NV {pedido.nv}</span>
        {pedido.peso_total_kg != null && (
          <span className="text-xs font-medium text-gray-600">{pedido.peso_total_kg} kg</span>
        )}
      </div>

      {/* Productos */}
      {pedido.items && pedido.items.length > 0 && (
        <div>
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); setExpandido(!expandido) }}
            className="text-xs text-blue-500 hover:text-blue-700 mt-1"
          >
            {expandido ? '▲ Ocultar productos' : `▼ ${pedido.items.length} producto${pedido.items.length > 1 ? 's' : ''}`}
          </button>
          {expandido && (
            <div className="mt-2 space-y-1">
              {pedido.items.map((item, i) => (
                <div key={i} className="flex justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                  <span className="leading-tight">{item.nombre}</span>
                  <span className="shrink-0 ml-2 font-medium">{item.cantidad} {item.unidad}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {pedido.notas && (
        <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1 mt-2 leading-tight">{pedido.notas}</p>
      )}
    </div>
  )
}

// ─── Columna de camión ────────────────────────────────────────────────────────
function ColumnaCamion({
  columna,
  sinAsignar = false,
  onDrop,
  onDragOver,
  onDragLeave,
  onDragStart,
  isDragOver,
}: {
  columna: ColumnaKanban
  sinAsignar?: boolean
  onDrop: (e: React.DragEvent, camionCodigo: string | null) => void
  onDragOver: (e: React.DragEvent, camionCodigo: string | null) => void
  onDragLeave: () => void
  onDragStart: (e: React.DragEvent, pedido: Pedido) => void
  isDragOver: boolean
}) {
  const { camion, pedidos, pesoTotal } = columna
  const pct = sinAsignar ? 0 : pctCapacidad(pesoTotal, camion.tonelaje_max_kg)
  const dropTarget = sinAsignar ? null : camion.codigo

  return (
    <div
      onDrop={e => onDrop(e, dropTarget)}
      onDragOver={e => onDragOver(e, dropTarget)}
      onDragLeave={onDragLeave}
      className={`flex flex-col rounded-xl border-2 transition-colors min-w-[220px] w-[220px] shrink-0 ${
        isDragOver
          ? 'border-blue-400 bg-blue-50'
          : sinAsignar
          ? 'border-dashed border-gray-300 bg-gray-50'
          : 'border-gray-200 bg-gray-50'
      }`}
    >
      <div className={`p-3 rounded-t-xl ${sinAsignar ? '' : 'bg-white border-b border-gray-200'}`}>
        {sinAsignar ? (
          <div className="text-center py-1">
            <p className="text-sm font-semibold text-gray-500">Sin asignar</p>
            <p className="text-xs text-gray-400">{pedidos.length} pedidos</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-1">
              <span className="font-bold text-sm text-gray-900">{camion.codigo}</span>
              <div className="flex gap-1">
                {camion.grua_hidraulica && (
                  <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full">Grúa</span>
                )}
                {camion.volcador && (
                  <span className="text-xs bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded-full">Volc.</span>
                )}
              </div>
            </div>
            <p className="text-xs text-gray-500 mb-2">{camion.tipo_unidad}</p>
            <div className="w-full bg-gray-200 rounded-full h-1.5 mb-1">
              <div
                className={`h-1.5 rounded-full transition-all ${colorBarra(pct)}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span>{Math.round(pesoTotal)} kg</span>
              <span className={pct >= 90 ? 'text-red-600 font-semibold' : ''}>
                {pct}% / {camion.tonelaje_max_kg} kg
              </span>
            </div>
          </>
        )}
      </div>

      <div className="p-2 flex-1 overflow-y-auto max-h-[440px]">
        {pedidos.length === 0 ? (
          <div className="text-center py-8 text-xs text-gray-400">
            {sinAsignar ? 'Todos asignados ✓' : 'Arrastrá pedidos acá'}
          </div>
        ) : (
          pedidos.map(p => (
            <PedidoCard key={p.id} pedido={p} onDragStart={onDragStart} />
          ))
        )}
      </div>
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────────────────────────
export default function ProgramacionPage() {
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
  const [cerrado, setCerrado] = useState(false)

  const dragPedido = useRef<Pedido | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  useEffect(() => {
    const ahora = new Date()
    const fechaTarget = new Date(fecha + 'T00:00:00')
    const esMañana = fechaTarget > ahora
    const despuesDeCierre = ahora.getHours() >= 14
    setCerrado(esMañana && despuesDeCierre)
  }, [fecha])

  useEffect(() => {
    cargarDatos()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fecha, sucursal, vueltaActiva])

  async function cargarDatos() {
    setCargando(true)
    setConfirmado(false)

    const { data: pedidosData } = await supabase
  .from('pedidos')
  .select(`
    *,
    items:pedido_items(nombre, cantidad, unidad)
  `)
  .eq('fecha_entrega', fecha)
  .eq('sucursal', sucursal)
  .eq('vuelta', vueltaActiva)
  .in('estado', ['pendiente', 'programado'])
  .order('cliente')

    const { data: flotaData } = await supabase
      .from('flota_dia')
      .select('camion_codigo')
      .eq('fecha', fecha)
      .eq('sucursal', sucursal)
      .eq('activo', true)

    const codigos = (flotaData ?? []).map((f: { camion_codigo: string }) => f.camion_codigo)

    const { data: camionesData } = codigos.length > 0
      ? await supabase.from('camiones_flota').select('*').in('codigo', codigos).eq('activo', true)
      : { data: [] }

    const todosPedidos = pedidosData ?? []
    const todosCamiones = camionesData ?? []

    setPedidos(todosPedidos)
    setCamiones(todosCamiones)
    construirColumnas(todosPedidos, todosCamiones)
    setCargando(false)
  }

  function construirColumnas(todosPedidos: Pedido[], todosCamiones: Camion[]) {
    const cols: ColumnaKanban[] = todosCamiones.map(c => {
      const asignados = todosPedidos.filter(p => p.camion_id === c.codigo)
      return { camion: c, pedidos: asignados, pesoTotal: pesoColumna(asignados) }
    })
    setSinAsignar(todosPedidos.filter(p => !p.camion_id))
    setColumnas(cols)
  }

  function handleSugerir() {
    const pendientes = pedidos.filter(p => !p.camion_id)
    if (pendientes.length === 0) return
    const yaAsignados = pedidos.filter(p => p.camion_id)
    const asignaciones = sugerirAsignacion(pendientes, camiones, yaAsignados)
    const actualizados = pedidos.map(p => ({
      ...p,
      camion_id: p.id in asignaciones ? asignaciones[p.id] : p.camion_id,
    }))
    setPedidos(actualizados)
    construirColumnas(actualizados, camiones)
  }

  function handleDragStart(e: React.DragEvent, pedido: Pedido) {
    dragPedido.current = pedido
    e.dataTransfer.effectAllowed = 'move'
  }

  function handleDragOver(e: React.DragEvent, camionCodigo: string | null) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(camionCodigo ?? 'sin_asignar')
  }

  function handleDrop(e: React.DragEvent, camionCodigo: string | null) {
    e.preventDefault()
    setDragOver(null)
    if (!dragPedido.current) return
    const pedidoId = dragPedido.current.id
    dragPedido.current = null
    const actualizados = pedidos.map(p =>
      p.id === pedidoId ? { ...p, camion_id: camionCodigo } : p
    )
    setPedidos(actualizados)
    construirColumnas(actualizados, camiones)
  }

  async function handleConfirmar() {
    setGuardando(true)
    const asignados = pedidos.filter(p => p.camion_id)
    const sinCamion = pedidos.filter(p => !p.camion_id)

    await Promise.all([
      ...asignados.map(p =>
        supabase.from('pedidos').update({ camion_id: p.camion_id, estado: 'programado' }).eq('id', p.id)
      ),
      ...sinCamion.map(p =>
        supabase.from('pedidos').update({ camion_id: null, estado: 'pendiente' }).eq('id', p.id)
      ),
    ])

    setGuardando(false)
    setConfirmado(true)
  }

  function handleLimpiar() {
    const limpiados = pedidos.map(p => ({ ...p, camion_id: null }))
    setPedidos(limpiados)
    construirColumnas(limpiados, camiones)
    setConfirmado(false)
  }

  const totalAsignados = pedidos.filter(p => p.camion_id).length
  const totalSinAsignar = pedidos.length - totalAsignados

  return (
    <div className="min-h-screen bg-gray-100">

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-screen-2xl mx-auto">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div>
              <h1 className="text-xl font-bold text-gray-900">Programación de despachos</h1>
              <p className="text-sm text-gray-500">Asignación de pedidos a camiones</p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <input
                type="date"
                value={fecha}
                onChange={e => { setFecha(e.target.value); setConfirmado(false) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <select
                value={sucursal}
                onChange={e => { setSucursal(e.target.value); setConfirmado(false) }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* Tabs de vuelta */}
          <div className="flex gap-1 mt-4 flex-wrap">
            {VUELTAS.map(v => (
              <button
                key={v.num}
                onClick={() => setVueltaActiva(v.num)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  vueltaActiva === v.num
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {v.label}
                <span className="ml-1 text-xs opacity-70">{v.horario}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Barra de acciones */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <div className="max-w-screen-2xl mx-auto flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-6">
            <span className="text-sm text-gray-500">
              Total: <strong className="text-gray-900">{pedidos.length}</strong>
            </span>
            <span className="text-sm text-gray-500">
              Asignados: <strong className="text-green-600">{totalAsignados}</strong>
            </span>
            <span className="text-sm text-gray-500">
              Sin asignar:{' '}
              <strong className={totalSinAsignar > 0 ? 'text-red-500' : 'text-gray-400'}>
                {totalSinAsignar}
              </strong>
            </span>
            {cerrado && (
              <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full font-medium">
                ⏰ Cierre pasado (14hs)
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLimpiar}
              disabled={cargando || guardando}
              className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              Limpiar
            </button>
            <button
              onClick={handleSugerir}
              disabled={cargando || guardando || totalSinAsignar === 0}
              className="px-4 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-40 transition-colors"
            >
              ✦ Sugerir asignación
            </button>
            <button
              onClick={handleConfirmar}
              disabled={cargando || guardando || totalAsignados === 0 || confirmado}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-40 ${
                confirmado
                  ? 'bg-green-100 text-green-700 cursor-default'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {guardando ? 'Guardando…' : confirmado ? '✓ Programación confirmada' : 'Confirmar programación'}
            </button>
          </div>
        </div>
      </div>

      {/* Kanban */}
      <div className="p-6 max-w-screen-2xl mx-auto">
        {cargando ? (
          <div className="flex items-center justify-center py-24 text-gray-400 text-sm">
            Cargando…
          </div>
        ) : pedidos.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <div className="text-5xl mb-4">📦</div>
            <p className="text-lg font-medium">No hay pedidos para esta fecha y sucursal</p>
            <p className="text-sm mt-1">Cambiá la fecha, la sucursal o la vuelta</p>
          </div>
        ) : camiones.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <div className="text-5xl mb-4">🚛</div>
            <p className="text-lg font-medium">No hay camiones configurados para esta fecha</p>
            <a href="/flota" className="mt-3 text-sm text-blue-600 hover:underline">
              Ir a Flota del día →
            </a>
          </div>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            <ColumnaCamion
              sinAsignar
              columna={{
                camion: { codigo: '', sucursal, tipo_unidad: '', posiciones_total: 0, tonelaje_max_kg: 0, grua_hidraulica: false, volcador: false },
                pedidos: sinAsignar,
                pesoTotal: 0,
              }}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={() => setDragOver(null)}
              onDragStart={handleDragStart}
              isDragOver={dragOver === 'sin_asignar'}
            />

            <div className="w-px bg-gray-300 self-stretch mx-1 shrink-0" />

            {columnas.map(col => (
              <ColumnaCamion
                key={col.camion.codigo}
                columna={col}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={() => setDragOver(null)}
                onDragStart={handleDragStart}
                isDragOver={dragOver === col.camion.codigo}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}