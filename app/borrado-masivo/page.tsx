'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../supabase'
import { logAuditoria } from '../lib/auditoria'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']
const ESTADOS = ['pendiente', 'programado', 'en_camino', 'entregado', 'cancelado']

const ESTADO_COLOR: Record<string, string> = {
  pendiente: 'bg-yellow-100 text-yellow-700',
  programado: 'bg-blue-100 text-blue-700',
  en_camino: 'bg-purple-100 text-purple-700',
  entregado: 'bg-green-100 text-green-700',
  cancelado: 'bg-red-100 text-red-700',
}

interface Pedido {
  id: string; nv: string; cliente: string; direccion: string
  sucursal: string; fecha_entrega: string; vuelta: number
  estado: string; peso_total_kg: number | null; notas: string | null
}

export default function BorradoMasivoPage() {
  const router = useRouter()
  const [user, setUser] = useState<any>(null)
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set())
  const [cargando, setCargando] = useState(false)
  const [borrando, setBorrando] = useState(false)
  const [confirmar, setConfirmar] = useState(false)
  const [resultado, setResultado] = useState<{ borrados: number; errores: any[] } | null>(null)
  const [error, setError] = useState('')

  // Filtros
  const [filtroFecha, setFiltroFecha] = useState('')
  const [filtroSucursal, setFiltroSucursal] = useState('')
  const [filtroEstado, setFiltroEstado] = useState('')
  const [filtroTexto, setFiltroTexto] = useState('')

  const [userNombre, setUserNombre] = useState('')
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      supabase.from('usuarios').select('rol, nombre').eq('id', user.id).single().then(({ data: u }) => {
        if (u?.rol !== 'gerencia') { router.push('/'); return }
        setUser(user)
        setUserNombre(u?.nombre ?? '')
      })
    })
  }, [])

  async function buscarPedidos() {
    if (!filtroFecha && !filtroSucursal && !filtroEstado && !filtroTexto) {
      setError('Aplicá al menos un filtro antes de buscar')
      return
    }
    setError('')
    setCargando(true)
    setSeleccionados(new Set())
    setResultado(null)

    let q = supabase.from('pedidos').select('id, nv, cliente, direccion, sucursal, fecha_entrega, vuelta, estado, peso_total_kg, notas')
      .order('fecha_entrega', { ascending: false }).order('cliente').limit(500)

    if (filtroFecha) q = q.eq('fecha_entrega', filtroFecha)
    if (filtroSucursal) q = q.eq('sucursal', filtroSucursal)
    if (filtroEstado) q = q.eq('estado', filtroEstado)
    if (filtroTexto) q = q.ilike('cliente', `%${filtroTexto}%`)

    const { data, error: err } = await q
    if (err) setError(err.message)
    else setPedidos(data ?? [])
    setCargando(false)
  }

  function toggleTodos() {
    if (seleccionados.size === pedidos.length) {
      setSeleccionados(new Set())
    } else {
      setSeleccionados(new Set(pedidos.map(p => p.id)))
    }
  }

  function toggleUno(id: string) {
    const s = new Set(seleccionados)
    if (s.has(id)) s.delete(id)
    else s.add(id)
    setSeleccionados(s)
  }

  async function ejecutarBorrado() {
    if (seleccionados.size === 0) return
    setBorrando(true)
    setConfirmar(false)
    const ids = Array.from(seleccionados)
    const errores: any[] = []
    let borrados = 0

    for (const id of ids) {
      const res = await fetch('/api/pedidos', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      const data = await res.json()
      if (data.success) {
        borrados++
      } else {
        errores.push({ id, error: data.error })
      }
    }

    setResultado({ borrados, errores })
    if (user && borrados > 0) {
      const borradosNvs = pedidos.filter(p => seleccionados.has(p.id) && !errores.some(e => e.id === p.id)).map(p => p.nv)
      logAuditoria(user.id, userNombre, 'Borrado masivo de pedidos', 'Borrado Masivo', { sucursal: filtroSucursal, fecha: filtroFecha, cantidad: borrados, nvs: borradosNvs })
    }
    setPedidos(prev => prev.filter(p => !seleccionados.has(p.id) || errores.some(e => e.id === p.id)))
    setSeleccionados(new Set())
    setBorrando(false)
  }

  const todosSeleccionados = pedidos.length > 0 && seleccionados.size === pedidos.length
  const algunoSeleccionado = seleccionados.size > 0

  if (!user) return null

  return (
    <div className="min-h-screen" style={{ background: '#f4f4f3' }}>
      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => router.push('/')} className="text-sm hover:underline" style={{ color: '#254A96' }}>← Volver</button>
          <div>
            <h1 className="text-xl font-bold" style={{ color: '#1a1a1a' }}>🗑️ Eliminación masiva</h1>
            <p className="text-sm" style={{ color: '#B9BBB7' }}>Buscá y eliminá pedidos del sistema</p>
          </div>
        </div>

        {/* Advertencia */}
        <div className="rounded-xl p-4 mb-5 flex gap-3 items-start" style={{ background: '#fde8e8', border: '1px solid #fca5a5' }}>
          <span className="text-lg">⚠️</span>
          <div>
            <p className="text-sm font-semibold" style={{ color: '#E52322' }}>Esta acción es irreversible</p>
            <p className="text-xs mt-0.5" style={{ color: '#b91c1c' }}>Los pedidos eliminados no se pueden recuperar. Usá esta función solo para limpiar datos de prueba.</p>
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-white rounded-xl p-5 mb-4 shadow-sm">
          <h2 className="text-sm font-semibold mb-3" style={{ color: '#254A96' }}>Filtros de búsqueda</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div>
              <label className="text-xs mb-1 block" style={{ color: '#666' }}>Fecha entrega</label>
              <input type="date" value={filtroFecha} onChange={e => setFiltroFecha(e.target.value)}
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: '#666' }}>Sucursal</label>
              <select value={filtroSucursal} onChange={e => setFiltroSucursal(e.target.value)}
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="">Todas</option>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: '#666' }}>Estado</label>
              <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                <option value="">Todos</option>
                {ESTADOS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: '#666' }}>Cliente (contiene)</label>
              <input type="text" value={filtroTexto} onChange={e => setFiltroTexto(e.target.value)}
                placeholder="Buscar cliente..."
                className="w-full text-sm border rounded-lg px-3 py-2 focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
          </div>
          {error && <p className="text-xs mt-3" style={{ color: '#E52322' }}>{error}</p>}
          <button onClick={buscarPedidos} disabled={cargando}
            className="mt-4 px-5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: '#254A96' }}>
            {cargando ? 'Buscando...' : '🔍 Buscar pedidos'}
          </button>
        </div>

        {/* Resultado de búsqueda */}
        {pedidos.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: '1px solid #f0f0f0' }}>
              <div className="flex items-center gap-3">
                <input type="checkbox" checked={todosSeleccionados} onChange={toggleTodos}
                  className="w-4 h-4 rounded" />
                <span className="text-sm" style={{ color: '#666' }}>
                  {pedidos.length} pedido{pedidos.length !== 1 ? 's' : ''} encontrado{pedidos.length !== 1 ? 's' : ''}
                  {algunoSeleccionado && <span className="font-semibold" style={{ color: '#254A96' }}> · {seleccionados.size} seleccionado{seleccionados.size !== 1 ? 's' : ''}</span>}
                </span>
              </div>
              {algunoSeleccionado && (
                <button onClick={() => setConfirmar(true)}
                  className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white"
                  style={{ background: '#E52322' }}>
                  🗑️ Eliminar {seleccionados.size} pedido{seleccionados.size !== 1 ? 's' : ''}
                </button>
              )}
            </div>

            {/* Lista */}
            <div className="divide-y" style={{ borderColor: '#f0f0f0' }}>
              {pedidos.map(p => (
                <div key={p.id} onClick={() => toggleUno(p.id)}
                  className="flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                  style={{ background: seleccionados.has(p.id) ? '#f0f4ff' : undefined }}>
                  <input type="checkbox" checked={seleccionados.has(p.id)} onChange={() => toggleUno(p.id)}
                    onClick={e => e.stopPropagation()} className="w-4 h-4 rounded shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold truncate" style={{ color: '#254A96' }}>{p.cliente}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ESTADO_COLOR[p.estado] ?? 'bg-gray-100 text-gray-600'}`}>{p.estado}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: '#e8edf8', color: '#254A96' }}>{p.sucursal}</span>
                    </div>
                    <p className="text-xs truncate mt-0.5" style={{ color: '#B9BBB7' }}>{p.direccion}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-medium" style={{ color: '#666' }}>{p.fecha_entrega} · V{p.vuelta}</p>
                    <p className="text-xs" style={{ color: '#B9BBB7' }}>NV {p.nv}</p>
                    {p.peso_total_kg != null && <p className="text-xs font-semibold" style={{ color: '#254A96' }}>{p.peso_total_kg} kg</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {pedidos.length === 0 && !cargando && resultado === null && (
          <div className="text-center py-12" style={{ color: '#B9BBB7' }}>
            <p className="text-4xl mb-3">🔍</p>
            <p className="text-sm">Aplicá filtros y buscá pedidos para eliminar</p>
          </div>
        )}

        {/* Resultado borrado */}
        {resultado && (
          <div className="rounded-xl p-4 mt-4" style={{ background: resultado.errores.length === 0 ? '#dcfce7' : '#fef3c7', border: `1px solid ${resultado.errores.length === 0 ? '#86efac' : '#fcd34d'}` }}>
            <p className="text-sm font-semibold" style={{ color: resultado.errores.length === 0 ? '#15803d' : '#b45309' }}>
              ✅ {resultado.borrados} pedido{resultado.borrados !== 1 ? 's' : ''} eliminado{resultado.borrados !== 1 ? 's' : ''}
              {resultado.errores.length > 0 && ` · ⚠️ ${resultado.errores.length} con error`}
            </p>
            {resultado.errores.length > 0 && (
              <ul className="mt-2 text-xs space-y-0.5" style={{ color: '#b45309' }}>
                {resultado.errores.map((e, i) => <li key={i}>ID {e.id}: {e.error}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Modal confirmación */}
      {confirmar && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <div className="bg-white rounded-2xl p-6 mx-4 max-w-sm w-full shadow-2xl">
            <h3 className="text-lg font-bold mb-2" style={{ color: '#E52322' }}>⚠️ Confirmar eliminación</h3>
            <p className="text-sm mb-4" style={{ color: '#444' }}>
              Vas a eliminar <strong>{seleccionados.size} pedido{seleccionados.size !== 1 ? 's' : ''}</strong> de forma permanente.
              Esta acción <strong>no se puede deshacer</strong>.
            </p>
            <div className="flex gap-3">
              <button onClick={ejecutarBorrado}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white"
                style={{ background: '#E52322' }}>
                Sí, eliminar
              </button>
              <button onClick={() => setConfirmar(false)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold"
                style={{ background: '#f4f4f3', color: '#666' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay */}
      {borrando && (
        <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: 'rgba(0,0,0,0.4)' }}>
          <div className="bg-white rounded-2xl p-6 text-center shadow-2xl">
            <div className="animate-spin text-3xl mb-3">⏳</div>
            <p className="text-sm font-medium" style={{ color: '#254A96' }}>Eliminando pedidos...</p>
          </div>
        </div>
      )}
    </div>
  )
}
