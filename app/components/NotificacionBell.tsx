'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter, usePathname } from 'next/navigation'

function hoy() { return new Date().toISOString().split('T')[0] }
function hace30Dias() {
  const d = new Date(); d.setDate(d.getDate() - 30)
  return d.toISOString().split('T')[0]
}

interface PedidoPendiente {
  id: string
  cliente: string
  sucursal_origen: string
  created_at: string
}

interface PedidoRechazado {
  id: string
  nv: string
  cliente: string
  fecha_entrega: string
  notas: string | null
}

// Pages where the fixed overlay should NOT appear (either not logged-in or has inline bell)
const HIDDEN_PATHS = ['/', '/dashboard']

interface Props {
  mode?: 'fixed' | 'inline'
}

const ROLES_LOGISTICA = ['gerencia', 'admin_flota', 'ruteador', 'confirmador', 'deposito']

export default function NotificacionBell({ mode = 'fixed' }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [count, setCount] = useState(0)
  const [pedidos, setPedidos] = useState<PedidoPendiente[]>([])
  const [rechazados, setRechazados] = useState<PedidoRechazado[]>([])
  const [open, setOpen] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [rol, setRol] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const esComercial = rol === 'comercial'
  const esLogistica = rol !== null && ROLES_LOGISTICA.includes(rol)

  // Close dropdown on outside click
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // Track auth state and fetch role
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      setLoggedIn(true)
      setUserId(user.id)
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      setRol(data?.rol ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_, session) => {
      if (!session?.user) { setLoggedIn(false); setRol(null); setUserId(null); return }
      setLoggedIn(true)
      setUserId(session.user.id)
      const { data } = await supabase.from('usuarios').select('rol').eq('id', session.user.id).single()
      setRol(data?.rol ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  // Logística: pedidos sin asignar de hoy
  const cargarLogistica = async () => {
    const { data } = await supabase
      .from('pedidos')
      .select('id, cliente, sucursal_origen, created_at')
      .eq('fecha_entrega', hoy())
      .in('estado', ['pendiente', 'conf_stock'])
      .order('created_at', { ascending: false })
      .limit(8)
    setPedidos(data ?? [])
    setCount((data ?? []).length)
  }

  // Comercial: sus pedidos rechazados de los últimos 30 días
  const cargarRechazados = async (uid: string) => {
    const { data } = await supabase
      .from('pedidos')
      .select('id, nv, cliente, fecha_entrega, notas')
      .eq('estado', 'rechazado')
      .eq('vendedor_id', uid)
      .gte('fecha_entrega', hace30Dias())
      .order('fecha_entrega', { ascending: false })
      .limit(10)
    setRechazados(data ?? [])
    setCount((data ?? []).length)
  }

  useEffect(() => {
    if (!loggedIn || !rol) { setCount(0); setPedidos([]); setRechazados([]); return }
    if (esLogistica) {
      cargarLogistica()
      const interval = setInterval(cargarLogistica, 2 * 60 * 1000)
      return () => clearInterval(interval)
    }
    if (esComercial && userId) {
      cargarRechazados(userId)
      const interval = setInterval(() => cargarRechazados(userId), 5 * 60 * 1000)
      return () => clearInterval(interval)
    }
  }, [loggedIn, rol, userId])

  useEffect(() => {
    if (!loggedIn) return
    if (esLogistica) cargarLogistica()
    if (esComercial && userId) cargarRechazados(userId)
  }, [pathname])

  // Ocultar para roles que no usan la campanita (chofer, etc.)
  if (!loggedIn || (rol !== null && !esLogistica && !esComercial)) return null
  if (mode === 'fixed' && HIDDEN_PATHS.includes(pathname)) return null

  const hayNotificaciones = count > 0
  const colorBtn = esComercial
    ? (open ? '#92400e' : hayNotificaciones ? '#f59e0b' : '#fef3c7')
    : (open ? '#1a3a7a' : hayNotificaciones ? '#254A96' : '#e8edf8')

  const button = (
    <button
      onClick={() => setOpen(o => !o)}
      className="relative flex items-center justify-center rounded-xl"
      style={{
        width: 36, height: 36,
        background: colorBtn,
        transition: 'background 0.15s',
        flexShrink: 0,
        boxShadow: mode === 'fixed' ? '0 2px 8px rgba(0,0,0,0.15)' : 'none',
      }}
      title={esComercial
        ? (hayNotificaciones ? `${count} pedido${count !== 1 ? 's' : ''} rechazado${count !== 1 ? 's' : ''} — necesitás volver a cargar` : 'Sin pedidos rechazados')
        : (hayNotificaciones ? `${count} pedido${count !== 1 ? 's' : ''} para hoy sin asignar` : 'Sin pedidos pendientes para hoy')}
    >
      <span style={{ fontSize: 16, lineHeight: 1, opacity: hayNotificaciones ? 1 : 0.5 }}>🔔</span>
      {hayNotificaciones && (
        <span
          className="absolute flex items-center justify-center rounded-full font-bold text-white"
          style={{
            top: -4, right: -4,
            minWidth: 17, height: 17,
            fontSize: 9,
            padding: '0 3px',
            background: '#E52322',
          }}
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  )

  // ── Dropdown logística ──
  const dropdownLogistica = (
    <div
      className="absolute bg-white rounded-2xl shadow-2xl"
      style={{ top: mode === 'fixed' ? 46 : 44, right: 0, width: 288, border: '1px solid #e8edf8', zIndex: 100 }}
    >
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 14 }}>🔔</span>
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Pedidos para hoy</span>
        </div>
        <span className="text-xs font-semibold rounded-full px-2 py-0.5"
          style={hayNotificaciones ? { background: '#fde8e8', color: '#E52322' } : { background: '#d1fae5', color: '#065f46' }}>
          {hayNotificaciones ? `${count} sin asignar` : 'Al día ✓'}
        </span>
      </div>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {!hayNotificaciones && (
          <p className="px-4 py-5 text-sm text-center" style={{ color: '#B9BBB7' }}>No hay pedidos pendientes para hoy</p>
        )}
        {pedidos.map(p => (
          <div key={p.id} className="px-4 py-2.5" style={{ borderBottom: '1px solid #f9f9f9' }}>
            <p className="text-sm font-medium truncate" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
            <p className="text-xs" style={{ color: '#B9BBB7' }}>
              {p.sucursal_origen} · cargado{' '}
              {new Date(p.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
            </p>
          </div>
        ))}
        {count > 8 && <p className="text-xs text-center py-2" style={{ color: '#B9BBB7' }}>y {count - 8} más…</p>}
      </div>
      <div className="px-4 py-3 flex gap-2 border-t" style={{ borderColor: '#f0f0f0' }}>
        <button onClick={() => { setOpen(false); router.push('/programacion') }}
          className="flex-1 py-2 rounded-lg text-xs font-semibold text-white"
          style={{ background: '#254A96' }}>
          Ir a Programación
        </button>
        <button onClick={() => { setOpen(false); router.push('/pedidos') }}
          className="flex-1 py-2 rounded-lg text-xs font-semibold"
          style={{ background: '#f4f4f3', color: '#555' }}>
          Ver pedidos
        </button>
      </div>
    </div>
  )

  // ── Dropdown comercial ──
  const dropdownComercial = (
    <div
      className="absolute bg-white rounded-2xl shadow-2xl"
      style={{ top: mode === 'fixed' ? 46 : 44, right: 0, width: 300, border: '1px solid #e8edf8', zIndex: 100 }}
    >
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 14 }}>🔔</span>
          <span className="font-semibold text-sm" style={{ color: '#b45309' }}>Pedidos rechazados</span>
        </div>
        <span className="text-xs font-semibold rounded-full px-2 py-0.5"
          style={hayNotificaciones ? { background: '#fde8e8', color: '#E52322' } : { background: '#d1fae5', color: '#065f46' }}>
          {hayNotificaciones ? `${count} para volver a cargar` : 'Sin rechazados ✓'}
        </span>
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        {!hayNotificaciones ? (
          <p className="px-4 py-5 text-sm text-center" style={{ color: '#B9BBB7' }}>No tenés pedidos rechazados recientes</p>
        ) : (
          <>
            <div className="px-4 pt-3 pb-1">
              <p className="text-xs" style={{ color: '#b45309' }}>
                Estos pedidos fueron rechazados y necesitan que cargues un ID nuevo.
              </p>
            </div>
            {rechazados.map(p => (
              <div key={p.id} className="px-4 py-2.5" style={{ borderBottom: '1px solid #f9f9f9' }}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium truncate" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
                  <span className="text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded"
                    style={{ background: '#fde8e8', color: '#E52322' }}>NV {p.nv}</span>
                </div>
                <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                  Fecha: {new Date(p.fecha_entrega + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' })}
                </p>
                {p.notas && (
                  <p className="text-xs mt-0.5 truncate" style={{ color: '#E52322' }}>✕ {p.notas}</p>
                )}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="px-4 py-3 border-t" style={{ borderColor: '#f0f0f0' }}>
        <button onClick={() => { setOpen(false); router.push('/despachos') }}
          className="w-full py-2 rounded-lg text-xs font-semibold text-white"
          style={{ background: '#f59e0b' }}>
          📋 Ir a Despachos — cargar nuevo ID
        </button>
      </div>
    </div>
  )

  const dropdown = open && (esComercial ? dropdownComercial : dropdownLogistica)

  if (mode === 'fixed') {
    return (
      <div ref={ref} className="fixed z-[9999]" style={{ top: 10, right: 12 }}>
        {button}
        {dropdown}
      </div>
    )
  }

  // inline mode — no fixed positioning, sits in the flow of the navbar
  return (
    <div ref={ref} className="relative">
      {button}
      {dropdown}
    </div>
  )
}
