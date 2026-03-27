'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { logAuditoria } from '../lib/auditoria'

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
  orden_entrega: number | null
  latitud: number | null
  longitud: number | null
  telefono: string | null
  items?: { nombre: string; cantidad: number; unidad: string }[]
}

interface CamionDisponible {
  codigo: string
  tipo_unidad: string
  sucursal: string
}

const VUELTA_LABEL: Record<number, string> = {
  1: '8:00 – 10:00hs',
  2: '10:00 – 12:00hs',
  3: '13:00 – 15:00hs',
  4: '15:00 – 17:00hs',
}

function hoy() { return new Date().toISOString().split('T')[0] }

export default function RuteoPage() {
  const router = useRouter()
  const [usuario, setUsuario] = useState<any>(null)
  const [datosUsuario, setDatosUsuario] = useState<{ nombre: string; rol: string } | null>(null)
  const [camionSeleccionado, setCamionSeleccionado] = useState<string | null>(null)
  const [camionesDisponibles, setCamionesDisponibles] = useState<CamionDisponible[]>([])
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [fecha, setFecha] = useState(hoy())
  const [vueltaActiva, setVueltaActiva] = useState<number | null>(null)
  const [cargando, setCargando] = useState(true)
  const [cargandoPedidos, setCargandoPedidos] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)

  // Modal de confirmación
  const [modalPedido, setModalPedido] = useState<Pedido | null>(null)
  const [nota, setNota] = useState('')
  const [foto, setFoto] = useState<File | null>(null)
  const [fotoPreview, setFotoPreview] = useState<string | null>(null)
  const [confirmando, setConfirmando] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      setUsuario(user)

      const { data: userData } = await supabase
        .from('usuarios')
        .select('nombre, rol, camion_codigo')
        .eq('id', user.id)
        .single()

      if (!['chofer', 'gerencia', 'admin_flota', 'ruteador'].includes(userData?.rol)) {
        router.push('/dashboard')
        return
      }

      setDatosUsuario({ nombre: userData?.nombre ?? user.email ?? 'Chofer', rol: userData?.rol ?? '' })

      // Si es chofer, buscar el camión asignado para HOY en flota_dia
      if (userData?.rol === 'chofer') {
        const { data: asignacion } = await supabase
          .from('flota_dia')
          .select('camion_codigo')
          .eq('fecha', hoy())
          .eq('chofer_id', user.id)
          .single()
        if (asignacion?.camion_codigo) {
          setCamionSeleccionado(asignacion.camion_codigo)
        }
      }

      setCargando(false)
    })
  }, [])

  useEffect(() => {
    cargarCamionesDisponibles()
  }, [fecha])

  useEffect(() => {
    if (camionSeleccionado) cargarPedidos()
  }, [camionSeleccionado, fecha])

  const cargarCamionesDisponibles = async () => {
    // Traer camiones que tienen pedidos programados para esta fecha
    const { data: pedidosData } = await supabase
      .from('pedidos')
      .select('camion_id')
      .eq('fecha_entrega', fecha)
      .in('estado', ['programado', 'en_camino', 'entregado'])
      .not('camion_id', 'is', null)

    const codigos = [...new Set((pedidosData ?? []).map((p: any) => p.camion_id))]

    if (codigos.length === 0) {
      setCamionesDisponibles([])
      return
    }

    const { data: camionesData } = await supabase
      .from('camiones_flota')
      .select('codigo, tipo_unidad, sucursal')
      .in('codigo', codigos)
      .order('codigo')

    setCamionesDisponibles(camionesData ?? [])
  }

  const cargarPedidos = async () => {
    if (!camionSeleccionado) return
    setCargandoPedidos(true)

    const { data } = await supabase
      .from('pedidos')
      .select('*, items:pedido_items(nombre, cantidad, unidad)')
      .eq('fecha_entrega', fecha)
      .eq('camion_id', camionSeleccionado)
      .in('estado', ['programado', 'en_camino', 'entregado'])
      .order('vuelta')
      .order('orden_entrega', { ascending: true, nullsFirst: false })

    const todosPedidos = data ?? []
    setPedidos(todosPedidos)

    const vueltas = [...new Set(todosPedidos.map(p => p.vuelta))].sort()
    const vueltaPendiente = vueltas.find(v =>
      todosPedidos.some(p => p.vuelta === v && p.estado !== 'entregado')
    )
    setVueltaActiva(vueltaPendiente ?? vueltas[0] ?? null)
    setCargandoPedidos(false)
  }

  const seleccionarCamion = (codigo: string) => {
    // Solo los choferes tienen un camión fijo; gerencia/ruteador seleccionan para monitoreo
    // sin modificar su perfil en la base de datos
    setCamionSeleccionado(codigo)
  }

  const abrirRecorridoCompleto = () => {
    const paradas = pedidosVuelta
      .filter(p => p.estado !== 'entregado' && p.latitud && p.longitud)
      .sort((a, b) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))

    if (paradas.length === 0) return

    const construirUrl = (origin: string) => {
      const destination = `${paradas[paradas.length - 1].latitud},${paradas[paradas.length - 1].longitud}`
      const waypoints = paradas.slice(0, -1).map(p => `${p.latitud},${p.longitud}`).join('|')
      let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`
      if (waypoints) url += `&waypoints=${waypoints}`
      window.open(url, '_blank')
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => construirUrl(`${pos.coords.latitude},${pos.coords.longitude}`),
        () => construirUrl('') // si deniega permisos, Maps usa ubicación actual automáticamente
      )
    } else {
      construirUrl('')
    }
  }

  const abrirMaps = (pedido: Pedido) => {
    if (pedido.latitud && pedido.longitud) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${pedido.latitud},${pedido.longitud}`, '_blank')
    } else {
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pedido.direccion)}`, '_blank')
    }
  }

  const handleFoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFoto(file)
    const reader = new FileReader()
    reader.onload = () => setFotoPreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const confirmarEntrega = async () => {
    if (!modalPedido) return
    setConfirmando(true)

    const formData = new FormData()
    formData.append('pedido_id', modalPedido.id)
    if (nota) formData.append('nota', nota)
    if (foto) formData.append('foto', foto)

    const res = await fetch('/api/confirmar-entrega', { method: 'POST', body: formData })
    const data = await res.json()

    if (data.success) {
      showToast('Entrega confirmada')
      if (usuario && datosUsuario) {
        await logAuditoria(usuario.id, datosUsuario.nombre, 'Confirmó entrega', 'Ruteo', {
          pedido_id: modalPedido.id,
          nv: modalPedido.nv,
          cliente: modalPedido.cliente,
          camion: camionSeleccionado,
          con_nota: !!nota,
          con_foto: !!foto,
        })
      }
      setPedidos(prev => prev.map(p =>
        p.id === modalPedido.id ? { ...p, estado: 'entregado' } : p
      ))
      setModalPedido(null)
      setNota('')
      setFoto(null)
      setFotoPreview(null)
    } else {
      showToast('Error al confirmar', 'err')
    }
    setConfirmando(false)
  }

  const pedidosVuelta = pedidos.filter(p => p.vuelta === vueltaActiva)
  const vueltas = [...new Set(pedidos.map(p => p.vuelta))].sort()
  const entregadosVuelta = pedidosVuelta.filter(p => p.estado === 'entregado').length
  const totalVuelta = pedidosVuelta.length

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Modal confirmar entrega */}
      {modalPedido && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#254A96' }}>Confirmar entrega</h3>
                <p className="text-sm mt-0.5" style={{ color: '#B9BBB7' }}>{modalPedido.cliente}</p>
              </div>
              <button onClick={() => { setModalPedido(null); setNota(''); setFoto(null); setFotoPreview(null) }}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="rounded-xl p-3 text-sm" style={{ background: '#f4f4f3' }}>
              <p className="font-medium" style={{ color: '#1a1a1a' }}>{modalPedido.direccion}</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Nota de entrega (opcional)</label>
              <textarea value={nota} onChange={e => setNota(e.target.value)} rows={2}
                className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}
                placeholder="Ej: Dejé en portería, firmó el encargado..." />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Foto de entrega (opcional)</label>
              {fotoPreview ? (
                <div className="relative">
                  <img src={fotoPreview} alt="Foto" className="w-full h-40 object-cover rounded-xl" />
                  <button onClick={() => { setFoto(null); setFotoPreview(null) }}
                    className="absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs"
                    style={{ background: '#E52322' }}>✕</button>
                </div>
              ) : (
                <button onClick={() => fileRef.current?.click()}
                  className="w-full border-2 border-dashed rounded-xl py-6 text-center"
                  style={{ borderColor: '#e8edf8' }}>
                  <p className="text-2xl mb-1">📷</p>
                  <p className="text-sm" style={{ color: '#B9BBB7' }}>Tocar para sacar foto</p>
                </button>
              )}
              <input ref={fileRef} type="file" accept="image/*" capture="environment"
                onChange={handleFoto} className="hidden" />
            </div>
            <button onClick={confirmarEntrega} disabled={confirmando}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: '#254A96' }}>
              {confirmando ? 'Confirmando...' : '✓ Confirmar entrega'}
            </button>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {datosUsuario?.rol !== 'chofer' && (
              <button onClick={() => router.push('/dashboard')}
                className="text-xs px-2 py-1.5 rounded-lg font-medium"
                style={{ background: '#e8edf8', color: '#254A96' }}>
                ← Volver
              </button>
            )}
            <div>
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>
                {datosUsuario?.rol === 'chofer' ? 'Mis entregas' : 'Ruteo'}
              </span>
              {/* Solo roles no-chofer pueden deseleccionar el camión */}
              {camionSeleccionado && datosUsuario?.rol !== 'chofer' && (
                <button onClick={() => setCamionSeleccionado(null)}
                  className="text-xs ml-2 px-2 py-0.5 rounded-full"
                  style={{ background: '#e8edf8', color: '#254A96' }}>
                  {camionSeleccionado} ✕
                </button>
              )}
              {/* Chofer: mostrar su camión sin opción de cambiar */}
              {camionSeleccionado && datosUsuario?.rol === 'chofer' && (
                <span className="text-xs ml-2 px-2 py-0.5 rounded-full font-medium"
                  style={{ background: '#e8edf8', color: '#254A96' }}>
                  🚛 {camionSeleccionado}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* El chofer siempre ve el día de hoy, no puede cambiar fecha */}
            {datosUsuario?.rol !== 'chofer' && (
              <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                className="border rounded-lg px-2 py-1 text-xs focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            )}
            <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
              className="text-xs px-2 py-1.5 rounded-lg" style={{ background: '#fde8e8', color: '#E52322' }}>
              Salir
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-4 py-4">

        {/* Sin camión seleccionado */}
        {!camionSeleccionado && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            {datosUsuario?.rol === 'chofer' ? (
              /* Chofer sin asignación: mensaje claro, sin lista */
              <div className="text-center py-8">
                <p className="text-5xl mb-4">🚛</p>
                <h2 className="font-semibold text-base mb-2" style={{ color: '#254A96' }}>
                  No tenés camión asignado para hoy
                </h2>
                <p className="text-sm" style={{ color: '#B9BBB7' }}>
                  Contactá al administrador de flota para que te asigne un camión.
                </p>
              </div>
            ) : (
              /* Otros roles: pueden elegir cualquier camión */
              <>
                <h2 className="font-semibold text-base mb-1" style={{ color: '#254A96' }}>¿Qué camión querés ver?</h2>
                <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>
                  {new Date(fecha + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' })}
                </p>
                {camionesDisponibles.length === 0 ? (
                  <div className="text-center py-8" style={{ color: '#B9BBB7' }}>
                    <p className="text-3xl mb-3">🚛</p>
                    <p className="text-sm">No hay camiones con entregas programadas para esta fecha</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {camionesDisponibles.map(c => (
                      <button key={c.codigo} onClick={() => seleccionarCamion(c.codigo)}
                        className="w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all text-left"
                        style={{ borderColor: '#e8edf8' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = '#254A96'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = '#e8edf8'}>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm"
                            style={{ background: '#254A96' }}>
                            🚛
                          </div>
                          <div>
                            <p className="font-bold text-sm" style={{ color: '#254A96' }}>{c.codigo}</p>
                            <p className="text-xs" style={{ color: '#B9BBB7' }}>{c.tipo_unidad} · {c.sucursal}</p>
                          </div>
                        </div>
                        <span style={{ color: '#B9BBB7' }}>›</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Vista de pedidos */}
        {camionSeleccionado && (
          <>
            {cargandoPedidos ? (
              <div className="flex justify-center py-20">
                <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
              </div>
            ) : (
              <>
                {/* Progreso */}
                {totalVuelta > 0 && (
                  <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-semibold" style={{ color: '#254A96' }}>
                        Vuelta {vueltaActiva} — {vueltaActiva ? VUELTA_LABEL[vueltaActiva] : ''}
                      </span>
                      <span className="text-sm font-bold" style={{ color: entregadosVuelta === totalVuelta ? '#065f46' : '#254A96' }}>
                        {entregadosVuelta}/{totalVuelta}
                      </span>
                    </div>
                    <div className="w-full rounded-full h-2" style={{ background: '#f0f0f0' }}>
                      <div className="h-2 rounded-full transition-all" style={{
                        width: `${totalVuelta > 0 ? (entregadosVuelta / totalVuelta) * 100 : 0}%`,
                        background: entregadosVuelta === totalVuelta ? '#10b981' : '#254A96'
                      }} />
                    </div>
                  </div>
                )}

                {/* Tabs de vuelta */}
                {vueltas.length > 1 && (
                  <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
                    {vueltas.map(v => {
                      const entregados = pedidos.filter(p => p.vuelta === v && p.estado === 'entregado').length
                      const total = pedidos.filter(p => p.vuelta === v).length
                      return (
                        <button key={v} onClick={() => setVueltaActiva(v)}
                          className="px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap shrink-0"
                          style={{ background: vueltaActiva === v ? '#254A96' : '#f4f4f3', color: vueltaActiva === v ? 'white' : '#666' }}>
                          V{v} <span className="text-xs opacity-70 ml-1">{entregados}/{total}</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Botón recorrido completo */}
                {pedidosVuelta.filter(p => p.estado !== 'entregado' && p.latitud && p.longitud).length > 0 && (
                  <button onClick={abrirRecorridoCompleto}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold mb-4"
                    style={{ background: '#254A96', color: 'white' }}>
                    🗺️ Ver recorrido completo en Maps
                  </button>
                )}

                {/* Lista de pedidos */}
                {pedidosVuelta.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20" style={{ color: '#B9BBB7' }}>
                    <div className="text-5xl mb-4">📦</div>
                    <p className="font-medium">No hay entregas para esta fecha</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {pedidosVuelta.map((pedido, idx) => {
                      const entregado = pedido.estado === 'entregado'
                      return (
                        <div key={pedido.id}
                          className="bg-white rounded-xl shadow-sm overflow-hidden"
                          style={{ opacity: entregado ? 0.7 : 1, border: `2px solid ${entregado ? '#d1fae5' : '#f0f0f0'}` }}>
                          <div className="px-4 py-3 flex items-center justify-between"
                            style={{ background: entregado ? '#f0fdf4' : 'white', borderBottom: '1px solid #f4f4f3' }}>
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                                style={{ background: entregado ? '#10b981' : '#254A96' }}>
                                {entregado ? '✓' : (pedido.orden_entrega ?? idx + 1)}
                              </div>
                              <div>
                                <p className="font-semibold text-sm" style={{ color: '#254A96' }}>{pedido.cliente}</p>
                                <p className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</p>
                              </div>
                            </div>
                            <span className="text-xs px-2 py-1 rounded-full font-medium"
                              style={entregado ? { background: '#d1fae5', color: '#065f46' } : { background: '#e8edf8', color: '#254A96' }}>
                              {entregado ? 'Entregado' : 'Pendiente'}
                            </span>
                          </div>
                          <div className="px-4 py-3 space-y-3">
                            <div>
                              <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>Dirección</p>
                              <p className="text-sm font-medium" style={{ color: '#1a1a1a' }}>{pedido.direccion}</p>
                            </div>
                            {pedido.items && pedido.items.length > 0 && (
                              <div className="rounded-lg p-2.5 space-y-1" style={{ background: '#f4f4f3' }}>
                                {pedido.items.map((item, i) => (
                                  <div key={i} className="flex justify-between text-xs" style={{ color: '#666' }}>
                                    <span>{item.nombre}</span>
                                    <span className="font-medium ml-2 shrink-0">{item.cantidad} {item.unidad}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {pedido.notas && !entregado && (
                              <p className="text-xs rounded-lg px-3 py-2" style={{ background: '#fff8e1', color: '#b45309' }}>
                                ⚠️ {pedido.notas}
                              </p>
                            )}
                            {!entregado && (
                              <div className="flex gap-2 pt-1">
                                <button onClick={() => abrirMaps(pedido)}
                                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border"
                                  style={{ borderColor: '#e8edf8', color: '#254A96', background: '#f9f9f9' }}>
                                  🗺️ Abrir Maps
                                </button>
                                <button onClick={() => setModalPedido(pedido)}
                                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white"
                                  style={{ background: '#254A96' }}>
                                  ✓ Confirmar
                                </button>
                              </div>
                            )}
                            {entregado && pedido.notas && (
                              <p className="text-xs" style={{ color: '#B9BBB7' }}>Nota: {pedido.notas}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}