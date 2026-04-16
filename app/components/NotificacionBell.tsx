'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter, usePathname } from 'next/navigation'

function hoy() { return new Date().toISOString().split('T')[0] }

interface PedidoPendiente {
  id: string
  cliente: string
  sucursal_origen: string
  created_at: string
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
  const [open, setOpen] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [rol, setRol] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

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
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      setRol(data?.rol ?? null)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_, session) => {
      if (!session?.user) { setLoggedIn(false); setRol(null); return }
      setLoggedIn(true)
      const { data } = await supabase.from('usuarios').select('rol').eq('id', session.user.id).single()
      setRol(data?.rol ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  const cargar = async () => {
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

  useEffect(() => {
    if (!loggedIn) { setCount(0); setPedidos([]); return }
    cargar()
    const interval = setInterval(cargar, 2 * 60 * 1000)
    return () => clearInterval(interval)
  }, [loggedIn])

  useEffect(() => {
    if (loggedIn) cargar()
  }, [pathname])

  // Fixed overlay: hide on login page and pages that have inline bell
  // Only show for logistics roles — not for comercial/chofer
  if (!loggedIn || (rol !== null && !ROLES_LOGISTICA.includes(rol))) return null
  if (mode === 'fixed' && HIDDEN_PATHS.includes(pathname)) return null

  const hayNotificaciones = count > 0

  const button = (
    <button
      onClick={() => setOpen(o => !o)}
      className="relative flex items-center justify-center rounded-xl"
      style={{
        width: 36, height: 36,
        background: open ? '#1a3a7a' : hayNotificaciones ? '#254A96' : '#e8edf8',
        transition: 'background 0.15s',
        flexShrink: 0,
        boxShadow: mode === 'fixed' ? '0 2px 8px rgba(0,0,0,0.15)' : 'none',
      }}
      title={hayNotificaciones
        ? `${count} pedido${count !== 1 ? 's' : ''} para hoy sin asignar`
        : 'Sin pedidos pendientes para hoy'}
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

  const dropdown = open && (
    <div
      className="absolute bg-white rounded-2xl shadow-2xl"
      style={{
        top: mode === 'fixed' ? 46 : 44,
        right: 0,
        width: 288,
        border: '1px solid #e8edf8',
        zIndex: 100,
      }}
    >
      <div className="px-4 py-3 flex items-center justify-between border-b" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 14 }}>🔔</span>
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Pedidos para hoy</span>
        </div>
        <span
          className="text-xs font-semibold rounded-full px-2 py-0.5"
          style={hayNotificaciones
            ? { background: '#fde8e8', color: '#E52322' }
            : { background: '#d1fae5', color: '#065f46' }}
        >
          {hayNotificaciones ? `${count} sin asignar` : 'Al día ✓'}
        </span>
      </div>

      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {!hayNotificaciones && (
          <p className="px-4 py-5 text-sm text-center" style={{ color: '#B9BBB7' }}>
            No hay pedidos pendientes para hoy
          </p>
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
        {count > 8 && (
          <p className="text-xs text-center py-2" style={{ color: '#B9BBB7' }}>y {count - 8} más…</p>
        )}
      </div>

      <div className="px-4 py-3 flex gap-2 border-t" style={{ borderColor: '#f0f0f0' }}>
        <button
          onClick={() => { setOpen(false); router.push('/programacion') }}
          className="flex-1 py-2 rounded-lg text-xs font-semibold text-white"
          style={{ background: '#254A96' }}
        >
          Ir a Programación
        </button>
        <button
          onClick={() => { setOpen(false); router.push('/pedidos') }}
          className="flex-1 py-2 rounded-lg text-xs font-semibold"
          style={{ background: '#f4f4f3', color: '#555' }}
        >
          Ver pedidos
        </button>
      </div>
    </div>
  )

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
