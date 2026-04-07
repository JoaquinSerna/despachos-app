'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const TODAS_LAS_CARDS = [
  { href: '/despachos',      icon: '📦', titulo: 'Nueva solicitud',    descripcion: 'Cargar solicitud de despacho',       disponible: true,  roles: ['gerencia','ruteador','comercial'] },
  { href: '/flota-base',     icon: '⚙️', titulo: 'Flota base',         descripcion: 'Camiones, posiciones y choferes habituales', disponible: true, roles: ['gerencia','admin_flota'] },
  { href: '/flota',          icon: '🚛', titulo: 'Flota del día',      descripcion: 'Configurar camiones y choferes',     disponible: true,  roles: ['gerencia','admin_flota'] },
  { href: '/programacion',   icon: '📅', titulo: 'Programación',       descripcion: 'Asignar pedidos a camiones',         disponible: true,  roles: ['gerencia','ruteador'] },
  { href: '/ruteo',          icon: '🗺️', titulo: 'Ruteo',              descripcion: 'Ver recorridos del día',             disponible: true,  roles: ['gerencia','admin_flota','ruteador'] },
  { href: '/confirmaciones', icon: '📞', titulo: 'Confirmaciones',     descripcion: 'Confirmar horarios con clientes',    disponible: true,  roles: ['gerencia','confirmador'] },
  { href: '/usuarios',       icon: '👥', titulo: 'Usuarios',            descripcion: 'Gestión de usuarios y permisos',    disponible: true,  roles: ['gerencia'] },
  { href: '/fin-del-dia',    icon: '🌙', titulo: 'Fin del día',         descripcion: 'Reprogramar pedidos no entregados',  disponible: true,  roles: ['gerencia','ruteador','admin_flota'] },
  { href: '/metricas',       icon: '📊', titulo: 'Métricas',            descripcion: 'Ocupación de flota y tiempos de ruta', disponible: true, roles: ['gerencia','ruteador','admin_flota'] },
  { href: '/carga-masiva',   icon: '📥', titulo: 'Carga masiva',        descripcion: 'Importar solicitudes desde PDF',       disponible: true,  roles: ['gerencia'] },
  { href: '/borrado-masivo', icon: '🗑️', titulo: 'Eliminación masiva',  descripcion: 'Eliminar pedidos de prueba',            disponible: true,  roles: ['gerencia'] },
]
 
const ESTADO_COLOR: Record<string, string> = {
  pendiente:  'bg-yellow-100 text-yellow-700',
  programado: 'bg-blue-100 text-blue-700',
  en_camino:  'bg-purple-100 text-purple-700',
  entregado:  'bg-green-100 text-green-700',
  cancelado:  'bg-red-100 text-red-700',
}
 
const ESTADO_LABEL: Record<string, string> = {
  pendiente: 'Pendiente', programado: 'Programado', en_camino: 'En camino', entregado: 'Entregado', cancelado: 'Cancelado',
}
 
interface PedidoReciente {
  id: string; nv: string; cliente: string; sucursal: string; estado: string; fecha_entrega: string; vuelta: number
}
 
export default function Dashboard() {
  const [usuario, setUsuario] = useState<any>(null)
  const [rolUsuario, setRolUsuario] = useState<string>('')
  const [nombreUsuario, setNombreUsuario] = useState<string>('')
  const [stats, setStats] = useState({ pendientes: 0, hoy: 0, enCamino: 0, entregadosHoy: 0 })
  const [recientes, setRecientes] = useState<PedidoReciente[]>([])
  const [cargando, setCargando] = useState(true)
  const [verificando, setVerificando] = useState(true)
  const [modalPassword, setModalPassword] = useState(false)
  const [nuevaPassword, setNuevaPassword] = useState('')
  const [cambiandoPass, setCambiandoPass] = useState(false)
  const [toastPass, setToastPass] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [vistaActiva, setVistaActiva] = useState<'reciente' | 'misPedidos'>('reciente')
  const [misPedidosPropio, setMisPedidosPropio] = useState<PedidoReciente[]>([])
  const [pedidoReprogDash, setPedidoReprogDash] = useState<PedidoReciente | null>(null)
  const [reprogFechaDash, setReprogFechaDash] = useState('')
  const [reprogVueltaDash, setReprogVueltaDash] = useState(1)
  const [reprogMotivoDash, setReprogMotivoDash] = useState('')
  const [toastDash, setToastDash] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [refrescando, setRefrescando] = useState(false)
  const [ultimaActualizacion, setUltimaActualizacion] = useState<Date | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const usuarioRef = useRef<{ id: string; rol: string } | null>(null)
  const router = useRouter()

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToastDash({ msg, tipo }); setTimeout(() => setToastDash(null), 3000)
  }

  const cambiarPassword = async () => {
    if (nuevaPassword.length < 6) { setToastPass({ msg: 'Mínimo 6 caracteres', tipo: 'err' }); return }
    setCambiandoPass(true)
    const { error } = await supabase.auth.updateUser({ password: nuevaPassword })
    if (error) {
      setToastPass({ msg: error.message, tipo: 'err' })
    } else {
      setToastPass({ msg: 'Contraseña actualizada', tipo: 'ok' })
      setTimeout(() => { setModalPassword(false); setNuevaPassword(''); setToastPass(null) }, 1500)
    }
    setCambiandoPass(false)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }

      const { data: userData } = await supabase
        .from('usuarios')
        .select('rol, nombre')
        .eq('id', user.id)
        .single()

      if (userData?.rol === 'chofer') { router.push('/ruteo'); return }
      if (userData?.rol === 'confirmador') { router.push('/confirmaciones'); return }

      setUsuario(user)
      setRolUsuario(userData?.rol ?? '')
      setNombreUsuario(userData?.nombre ?? user.email?.split('@')[0] ?? 'usuario')
      setVerificando(false)
      const rol = userData?.rol ?? ''
      usuarioRef.current = { id: user.id, rol }
      cargarDatos(user.id, rol)
      cargarMisPedidosPropio(user.id)
      // Auto-refresh cada 10 minutos
      intervalRef.current = setInterval(() => {
        cargarDatos(user.id, rol)
        cargarMisPedidosPropio(user.id)
      }, 10 * 60 * 1000)
    })
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [])

  const cargarMisPedidosPropio = async (uid: string) => {
    const { data } = await supabase.from('pedidos')
      .select('id,nv,cliente,sucursal,estado,fecha_entrega,vuelta')
      .eq('vendedor_id', uid)
      .order('created_at', { ascending: false })
      .limit(50)
    setMisPedidosPropio(data ?? [])
  }

  const handleReprogramarDashboard = async (p: PedidoReciente, fecha: string, vuelta: number, motivo: string) => {
    const nota = `⚡ Reprogramado desde ${p.fecha_entrega} V${p.vuelta}${motivo ? ` — ${motivo}` : ''}`
    const res = await fetch('/api/pedidos', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, fecha_entrega: fecha, vuelta, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: nota })
    })
    const data = await res.json()
    if (!res.ok) { showToast(`Error: ${data.error}`, 'err'); return }
    setPedidoReprogDash(null)
    cargarMisPedidosPropio(usuario.id)
    showToast(`Pedido de ${p.cliente} reprogramado`)
  }

  const handleCancelarDashboard = async (p: PedidoReciente) => {
    const res = await fetch('/api/pedidos', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id })
    })
    const data = await res.json()
    if (!res.ok) { showToast(`Error: ${data.error}`, 'err'); return }
    cargarMisPedidosPropio(usuario.id)
    showToast(`Pedido de ${p.cliente} eliminado`)
  }

  const cargarDatos = async (userId: string, rol: string) => {
    const hoy = new Date().toISOString().split('T')[0]
    const filtrarPorVendedor = (q: any) => rol === 'comercial' ? q.eq('vendedor_id', userId) : q

    const [{ count: p }, { count: h }, { count: e }, { count: ed }, { data: r }] = await Promise.all([
      filtrarPorVendedor(supabase.from('pedidos').select('*', { count: 'exact', head: true }).eq('estado', 'pendiente')),
      filtrarPorVendedor(supabase.from('pedidos').select('*', { count: 'exact', head: true }).eq('fecha_entrega', hoy)),
      filtrarPorVendedor(supabase.from('pedidos').select('*', { count: 'exact', head: true }).eq('estado', 'en_camino')),
      filtrarPorVendedor(supabase.from('pedidos').select('*', { count: 'exact', head: true }).eq('estado', 'entregado').eq('fecha_entrega', hoy)),
      filtrarPorVendedor(supabase.from('pedidos').select('id,nv,cliente,sucursal,estado,fecha_entrega,vuelta').order('created_at', { ascending: false }).limit(10)),
    ])
    setStats({ pendientes: p || 0, hoy: h || 0, enCamino: e || 0, entregadosHoy: ed || 0 })
    setRecientes(r || [])
    setCargando(false)
    setUltimaActualizacion(new Date())
  }

  const refrescar = async () => {
    if (!usuarioRef.current) return
    setRefrescando(true)
    await cargarDatos(usuarioRef.current.id, usuarioRef.current.rol)
    await cargarMisPedidosPropio(usuarioRef.current.id)
    setRefrescando(false)
  }
 
  if (!usuario || cargando || verificando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )
 
  const hora = new Date().getHours()
  const saludo = hora < 12 ? 'Buenos días' : hora < 18 ? 'Buenas tardes' : 'Buenas noches'
  const cards = TODAS_LAS_CARDS.filter(c => !rolUsuario || c.roles.includes(rolUsuario))
 
  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toastDash && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toastDash.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toastDash.tipo === 'ok' ? '✓' : '✕'} {toastDash.msg}
        </div>
      )}

      {/* Modal reprogramar */}
      {pedidoReprogDash && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <h3 className="font-semibold text-sm mb-1" style={{ color: '#254A96' }}>📅 Reprogramar entrega</h3>
            <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>{pedidoReprogDash.cliente}</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva fecha</label>
                <input type="date" value={reprogFechaDash}
                  min={(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0] })()}
                  onChange={e => setReprogFechaDash(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Vuelta</label>
                <select value={reprogVueltaDash} onChange={e => setReprogVueltaDash(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                  {[1, 2, 3, 4].map(v => <option key={v} value={v}>Vuelta {v}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Motivo</label>
                <input type="text" value={reprogMotivoDash} onChange={e => setReprogMotivoDash(e.target.value)}
                  placeholder="Ej: lluvia, cliente no disponible"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button disabled={!reprogFechaDash}
                onClick={() => handleReprogramarDashboard(pedidoReprogDash, reprogFechaDash, reprogVueltaDash, reprogMotivoDash)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: '#254A96' }}>Confirmar</button>
              <button onClick={() => setPedidoReprogDash(null)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal cambiar contraseña */}
      {modalPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base" style={{ color: '#254A96' }}>Cambiar contraseña</h3>
              <button onClick={() => { setModalPassword(false); setNuevaPassword(''); setToastPass(null) }}
                className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva contraseña</label>
              <input type="password" value={nuevaPassword} onChange={e => setNuevaPassword(e.target.value)}
                className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} placeholder="Mínimo 6 caracteres"
                onKeyDown={e => e.key === 'Enter' && cambiarPassword()} />
            </div>
            {toastPass && (
              <p className="text-xs rounded-lg px-3 py-2 font-medium"
                style={{ background: toastPass.tipo === 'ok' ? '#d1fae5' : '#fde8e8', color: toastPass.tipo === 'ok' ? '#065f46' : '#E52322' }}>
                {toastPass.tipo === 'ok' ? '✓' : '✕'} {toastPass.msg}
              </p>
            )}
            <button onClick={cambiarPassword} disabled={cambiandoPass || nuevaPassword.length < 6}
              className="w-full py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: '#254A96' }}>
              {cambiandoPass ? 'Guardando...' : 'Actualizar contraseña'}
            </button>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-7xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0" style={{ background: '#254A96' }}>C</div>
            <div className="hidden sm:block">
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Construyo al Costo</span>
              <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Despachos</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs hidden md:block" style={{ color: '#B9BBB7' }}>{usuario.email}</span>
            <button onClick={() => setModalPassword(true)}
              className="text-xs px-3 py-1.5 rounded-lg font-medium"
              style={{ background: '#e8edf8', color: '#254A96' }}>
              🔑 Cambiar clave
            </button>
            <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium"
              style={{ background: '#fde8e8', color: '#E52322' }}>
              Salir
            </button>
          </div>
        </div>
      </nav>
 
      <main className="max-w-7xl mx-auto px-4 md:px-6 py-6 md:py-8">
 
        {/* Saludo */}
        <div className="mb-6">
          <h2 className="text-xl md:text-2xl font-semibold" style={{ color: '#254A96' }}>{saludo}, {nombreUsuario} 👋</h2>
          <p className="text-sm mt-0.5" style={{ color: '#B9BBB7' }}>
            {new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </div>
 
        {/* Stats */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs" style={{ color: '#B9BBB7' }}>
            {ultimaActualizacion ? `Actualizado ${ultimaActualizacion.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
          <button onClick={refrescar} disabled={refrescando}
            className="text-xs px-3 py-1.5 rounded-lg font-medium border flex items-center gap-1.5 disabled:opacity-50"
            style={{ borderColor: '#e8edf8', color: '#254A96', background: '#fff' }}>
            <span className={refrescando ? 'animate-spin inline-block' : ''}>↻</span>
            {refrescando ? 'Actualizando...' : 'Actualizar'}
          </button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: 'Pendientes', value: stats.pendientes, emoji: '⏳', bg: '#fff8e1', color: '#b45309' },
            { label: 'Entregas hoy', value: stats.hoy, emoji: '📅', bg: '#e8edf8', color: '#254A96' },
            { label: 'En camino', value: stats.enCamino, emoji: '🚚', bg: '#f3e8ff', color: '#7c3aed' },
            { label: 'Entregados hoy', value: stats.entregadosHoy, emoji: '✅', bg: '#d1fae5', color: '#065f46' },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0" style={{ background: s.bg }}>{s.emoji}</div>
              <div>
                <p className="text-2xl font-bold leading-none" style={{ color: s.color }}>{s.value}</p>
                <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>{s.label}</p>
              </div>
            </div>
          ))}
        </div>
 
        {/* Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
 
          {/* Módulos */}
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#B9BBB7' }}>Módulos</p>
            <div className="space-y-2">
              {cards.map(card => (
                <button key={card.href} onClick={() => card.disponible && router.push(card.href)}
                  disabled={!card.disponible}
                  className="w-full bg-white rounded-xl p-4 flex items-center gap-4 shadow-sm text-left transition-all disabled:opacity-50"
                  style={{ borderLeft: `4px solid ${card.disponible ? '#254A96' : '#B9BBB7'}` }}
                  onMouseEnter={e => { if (card.disponible) (e.currentTarget as HTMLElement).style.transform = 'translateX(2px)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateX(0)' }}
                >
                  <span className="text-2xl">{card.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm" style={{ color: '#254A96' }}>{card.titulo}</span>
                      {!card.disponible && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100" style={{ color: '#B9BBB7' }}>Próximamente</span>
                      )}
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>{card.descripcion}</p>
                  </div>
                  {card.disponible && <span className="text-lg" style={{ color: '#B9BBB7' }}>›</span>}
                </button>
              ))}
            </div>
          </div>
 
          {/* Actividad / Mis pedidos */}
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              {(['reciente', 'misPedidos'] as const).map(v => (
                <button key={v} onClick={() => setVistaActiva(v)}
                  className="text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-lg transition-colors"
                  style={{ background: vistaActiva === v ? '#254A96' : 'transparent', color: vistaActiva === v ? 'white' : '#B9BBB7' }}>
                  {v === 'reciente' ? 'Actividad reciente' : 'Mis pedidos'}
                </button>
              ))}
            </div>

            {vistaActiva === 'reciente' ? (
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                {recientes.length === 0 ? (
                  <div className="p-12 text-center">
                    <div className="text-4xl mb-3">📭</div>
                    <p className="text-sm" style={{ color: '#B9BBB7' }}>No hay pedidos cargados todavía</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
                          {['Cliente', 'NV', 'Sucursal', 'Entrega', 'Estado'].map(h => (
                            <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {recientes.map((p, i) => (
                          <tr key={p.id} style={{ borderBottom: '1px solid #f9f9f9', background: i % 2 === 0 ? 'white' : '#fdfdfd' }}>
                            <td className="px-4 py-3 font-medium max-w-[140px] truncate" style={{ color: '#1a1a1a' }}>{p.cliente}</td>
                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: '#B9BBB7' }}>{p.nv}</td>
                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: '#B9BBB7' }}>{p.sucursal}</td>
                            <td className="px-4 py-3 whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                              {new Date(p.fecha_entrega + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
                              <span className="ml-1 text-xs">V{p.vuelta}</span>
                            </td>
                            <td className="px-4 py-3">
                              <span className={`text-xs px-2 py-1 rounded-full font-medium whitespace-nowrap ${ESTADO_COLOR[p.estado] ?? 'bg-gray-100 text-gray-500'}`}>
                                {ESTADO_LABEL[p.estado] ?? p.estado}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                {misPedidosPropio.length === 0 ? (
                  <div className="p-12 text-center">
                    <div className="text-4xl mb-3">📭</div>
                    <p className="text-sm" style={{ color: '#B9BBB7' }}>No cargaste pedidos todavía</p>
                  </div>
                ) : (
                  <div className="divide-y" style={{ borderColor: '#f9f9f9' }}>
                    {misPedidosPropio.map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
                          <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                            {new Date(p.fecha_entrega + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })} · V{p.vuelta} · {p.sucursal}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${ESTADO_COLOR[p.estado] ?? 'bg-gray-100 text-gray-500'}`}>
                            {ESTADO_LABEL[p.estado] ?? p.estado}
                          </span>
                          {['pendiente', 'programado'].includes(p.estado) && (
                            <>
                              <button
                                onClick={() => { setPedidoReprogDash(p); setReprogFechaDash(''); setReprogVueltaDash(1); setReprogMotivoDash('') }}
                                className="text-xs px-2.5 py-1 rounded-lg font-medium"
                                style={{ background: '#fef3c7', color: '#b45309' }}>
                                📅 Reprog.
                              </button>
                              <button
                                onClick={() => handleCancelarDashboard(p)}
                                className="text-xs px-2.5 py-1 rounded-lg font-medium"
                                style={{ background: '#fde8e8', color: '#E52322' }}>
                                Cancelar
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}