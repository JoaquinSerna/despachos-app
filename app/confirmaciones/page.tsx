'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

interface Pedido {
  id: string
  nv: string
  cliente: string
  telefono: string | null
  direccion: string
  sucursal: string
  fecha_entrega: string
  vuelta: number
  estado: string
  camion_id: string | null
  confirmado_cliente: boolean
}

const VUELTA_LABEL: Record<number, string> = {
  1: 'V1 · 8:00–10:00hs',
  2: 'V2 · 10:00–12:00hs',
  3: 'V3 · 13:00–15:00hs',
  4: 'V4 · 15:00–17:00hs',
}

function hoy() { return new Date().toISOString().split('T')[0] }

function formatFecha(f: string) {
  return new Date(f + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' })
}

export default function ConfirmacionesPage() {
  const router = useRouter()
  const [usuario, setUsuario] = useState<any>(null)
  const [nombreUsuario, setNombreUsuario] = useState('')
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [cargando, setCargando] = useState(true)
  const [confirmando, setConfirmando] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [soloSinConfirmar, setSoloSinConfirmar] = useState(false)
  const [editDirecciones, setEditDirecciones] = useState<Record<string, string>>({})

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }

      const { data: userData } = await supabase
        .from('usuarios')
        .select('nombre, rol')
        .eq('id', user.id)
        .single()

      if (!['confirmador', 'gerencia'].includes(userData?.rol)) {
        router.push('/dashboard')
        return
      }

      setUsuario(user)
      setNombreUsuario(userData?.nombre ?? user.email ?? '')
      cargarPedidos()
    })
  }, [])

  const cargarPedidos = async () => {
    setCargando(true)
    // Traer pedidos programados desde hoy en adelante
    const { data, error } = await supabase
      .from('pedidos')
      .select('id,nv,cliente,telefono,direccion,sucursal,fecha_entrega,vuelta,estado,camion_id,confirmado_cliente')
      .eq('estado', 'programado')
      .gte('fecha_entrega', hoy())
      .order('fecha_entrega')
      .order('vuelta')
      .order('cliente')

    if (error) { showToast('Error al cargar pedidos', 'err'); setCargando(false); return }
    setPedidos(data ?? [])
    setCargando(false)
  }

  const confirmarCliente = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const { error } = await supabase
      .from('pedidos')
      .update({ confirmado_cliente: true })
      .eq('id', pedidoId)

    if (error) {
      showToast('Error al confirmar', 'err')
    } else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, confirmado_cliente: true } : p))
      showToast('Cliente confirmado ✓')
    }
    setConfirmando(null)
  }

  const guardarDireccion = async (pedidoId: string, valor: string) => {
    const original = pedidos.find(p => p.id === pedidoId)?.direccion ?? ''
    if (valor.trim() === original.trim()) return
    const { error } = await supabase.from('pedidos').update({ direccion: valor.trim() }).eq('id', pedidoId)
    if (error) {
      showToast('Error al guardar dirección', 'err')
    } else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, direccion: valor.trim() } : p))
      setEditDirecciones(prev => { const n = { ...prev }; delete n[pedidoId]; return n })
      showToast('Dirección actualizada ✓')
    }
  }

  const desconfirmarCliente = async (pedidoId: string) => {
    setConfirmando(pedidoId)
    const { error } = await supabase
      .from('pedidos')
      .update({ confirmado_cliente: false })
      .eq('id', pedidoId)

    if (error) {
      showToast('Error', 'err')
    } else {
      setPedidos(prev => prev.map(p => p.id === pedidoId ? { ...p, confirmado_cliente: false } : p))
    }
    setConfirmando(null)
  }

  // Agrupar por fecha
  const pedidosFiltrados = soloSinConfirmar ? pedidos.filter(p => !p.confirmado_cliente) : pedidos
  const porFecha: Record<string, Pedido[]> = {}
  pedidosFiltrados.forEach(p => {
    if (!porFecha[p.fecha_entrega]) porFecha[p.fecha_entrega] = []
    porFecha[p.fecha_entrega].push(p)
  })

  const totalConfirmados = pedidos.filter(p => p.confirmado_cliente).length
  const totalPendientes = pedidos.filter(p => !p.confirmado_cliente).length

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/dashboard')}
              className="text-xs px-2 py-1.5 rounded-lg font-medium shrink-0"
              style={{ background: '#e8edf8', color: '#254A96' }}>← Volver</button>
            <div className="w-px h-5 bg-gray-200 hidden sm:block" />
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Confirmaciones</span>
              <span className="text-xs ml-2 hidden sm:inline" style={{ color: '#B9BBB7' }}>{nombreUsuario}</span>
            </div>
          </div>
          <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
            className="text-xs px-3 py-1.5 rounded-lg font-medium"
            style={{ background: '#fde8e8', color: '#E52322' }}>
            Salir
          </button>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 py-5">

        {/* Stats rápidas */}
        <div className="grid grid-cols-2 gap-3 mb-5">
          <div className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: '#d1fae5' }}>✅</div>
            <div>
              <p className="text-2xl font-bold leading-none" style={{ color: '#065f46' }}>{totalConfirmados}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Confirmados</p>
            </div>
          </div>
          <div className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl" style={{ background: '#fff8e1' }}>📞</div>
            <div>
              <p className="text-2xl font-bold leading-none" style={{ color: '#b45309' }}>{totalPendientes}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Pendientes de llamar</p>
            </div>
          </div>
        </div>

        {/* Filtro */}
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>
            Pedidos programados
          </p>
          <button
            onClick={() => setSoloSinConfirmar(!soloSinConfirmar)}
            className="text-xs px-3 py-1.5 rounded-lg font-medium transition-colors"
            style={{
              background: soloSinConfirmar ? '#254A96' : '#f4f4f3',
              color: soloSinConfirmar ? 'white' : '#666'
            }}>
            {soloSinConfirmar ? '📞 Solo sin confirmar' : 'Todos'}
          </button>
        </div>

        {/* Lista por fecha */}
        {Object.keys(porFecha).length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <p className="text-4xl mb-3">{soloSinConfirmar ? '🎉' : '📭'}</p>
            <p className="font-medium text-sm" style={{ color: '#254A96' }}>
              {soloSinConfirmar ? '¡Todos los clientes están confirmados!' : 'No hay pedidos programados'}
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(porFecha).map(([fecha, pedidosDia]) => (
              <div key={fecha}>
                {/* Header fecha */}
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                  <span className="text-xs font-semibold px-3 py-1 rounded-full capitalize"
                    style={{ background: '#e8edf8', color: '#254A96' }}>
                    {formatFecha(fecha)}
                  </span>
                  <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                </div>

                <div className="space-y-2">
                  {pedidosDia.map(pedido => (
                    <div key={pedido.id}
                      className="bg-white rounded-xl shadow-sm overflow-hidden"
                      style={{ border: `2px solid ${pedido.confirmado_cliente ? '#d1fae5' : '#f0f0f0'}` }}>
                      <div className="px-4 py-3 flex items-center justify-between"
                        style={{ background: pedido.confirmado_cliente ? '#f0fdf4' : 'white' }}>
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 text-white"
                            style={{ background: pedido.confirmado_cliente ? '#10b981' : '#254A96' }}>
                            {pedido.confirmado_cliente ? '✓' : '📞'}
                          </div>
                          <div className="min-w-0">
                            <p className="font-semibold text-sm truncate" style={{ color: '#1a1a1a' }}>{pedido.cliente}</p>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                                style={{ background: '#e8edf8', color: '#254A96' }}>
                                {VUELTA_LABEL[pedido.vuelta] ?? `V${pedido.vuelta}`}
                              </span>
                              {pedido.camion_id && (
                                <span className="text-xs" style={{ color: '#B9BBB7' }}>🚛 {pedido.camion_id}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <span className="text-xs px-2 py-1 rounded-full font-medium shrink-0 ml-2"
                          style={pedido.confirmado_cliente
                            ? { background: '#d1fae5', color: '#065f46' }
                            : { background: '#fff8e1', color: '#b45309' }}>
                          {pedido.confirmado_cliente ? 'Confirmado' : 'Sin confirmar'}
                        </span>
                      </div>

                      <div className="px-4 py-3 space-y-2" style={{ borderTop: '1px solid #f4f4f3' }}>
                        <div className="flex items-start gap-2">
                          <span className="text-xs mt-1.5">📍</span>
                          <input
                            type="text"
                            value={editDirecciones[pedido.id] ?? pedido.direccion}
                            onChange={e => setEditDirecciones(prev => ({ ...prev, [pedido.id]: e.target.value }))}
                            onBlur={e => guardarDireccion(pedido.id, e.target.value)}
                            className="flex-1 text-sm rounded-lg px-2 py-1 focus:outline-none focus:ring-2"
                            style={{ color: '#1a1a1a', background: '#f9fafb', border: '1px solid #e8edf8', focusRingColor: '#254A96' } as any}
                          />
                        </div>
                        {pedido.telefono && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs">📱</span>
                            <a href={`tel:${pedido.telefono}`}
                              className="text-sm font-medium"
                              style={{ color: '#254A96' }}>
                              {pedido.telefono}
                            </a>
                          </div>
                        )}

                        {!pedido.confirmado_cliente ? (
                          <button
                            onClick={() => confirmarCliente(pedido.id)}
                            disabled={confirmando === pedido.id}
                            className="w-full mt-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                            style={{ background: '#254A96' }}>
                            {confirmando === pedido.id ? 'Guardando...' : '📞 Confirmé con el cliente'}
                          </button>
                        ) : (
                          <button
                            onClick={() => desconfirmarCliente(pedido.id)}
                            disabled={confirmando === pedido.id}
                            className="w-full mt-1 py-2 rounded-xl text-xs font-medium disabled:opacity-50"
                            style={{ background: '#f4f4f3', color: '#B9BBB7' }}>
                            {confirmando === pedido.id ? '...' : 'Deshacer confirmación'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
