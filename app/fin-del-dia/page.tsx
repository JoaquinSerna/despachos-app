'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/app/supabase'
import { useRouter } from 'next/navigation'
import { logAuditoria } from '@/app/lib/auditoria'

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

function hoy() { return new Date().toISOString().split('T')[0] }

export default function FinDelDiaPage() {
  const router = useRouter()
  const [fecha, setFecha] = useState(hoy())
  const [sucursal, setSucursal] = useState('LP520')
  const [pedidos, setPedidos] = useState<any[]>([])
  const [cargando, setCargando] = useState(false)
  const [procesando, setProcesando] = useState(false)
  const [fechaDestino, setFechaDestino] = useState(hoy())
  const [seleccionados, setSeleccionados] = useState<Set<string>>(new Set())
  const [prioridades, setPrioridades] = useState<Set<string>>(new Set())
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [reprogramados, setReprogramados] = useState(false)
  const [userId, setUserId] = useState('')
  const [userNombre, setUserNombre] = useState('')

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      setUserId(user.id)
      const { data } = await supabase.from('usuarios').select('nombre').eq('id', user.id).single()
      setUserNombre(data?.nombre ?? '')
    })
  }, [])

  useEffect(() => { cargar() }, [fecha, sucursal])

  async function cargar() {
    setCargando(true); setReprogramados(false)
    const { data } = await supabase.from('pedidos')
      .select('id, nv, cliente, direccion, vuelta, estado, peso_total_kg, notas, prioridad')
      .eq('fecha_entrega', fecha).eq('sucursal', sucursal)
      .in('estado', ['programado', 'en_camino'])
      .order('vuelta').order('cliente')
    const ps = data ?? []
    setPedidos(ps)
    setSeleccionados(new Set(ps.map((p: any) => p.id)))
    setPrioridades(new Set(ps.filter((p: any) => p.prioridad).map((p: any) => p.id)))
    setCargando(false)
  }

  function toggleSeleccion(id: string) {
    setSeleccionados(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  function togglePrioridad(id: string) {
    setPrioridades(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s })
  }

  async function handleReprogramar() {
    const aReprogramar = pedidos.filter(p => seleccionados.has(p.id))
    if (aReprogramar.length === 0) return
    setProcesando(true)

    try {
      await Promise.all(aReprogramar.map(p => {
        const esPrioridad = prioridades.has(p.id)
        const nota = `⚡ No entregado el ${fecha} V${p.vuelta}${esPrioridad ? ' — PRIORIDAD' : ''}`
        const notaFinal = p.notas ? `${p.notas} | ${nota}` : nota
        return fetch('/api/pedidos', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: p.id,
            fecha_entrega: fechaDestino,
            estado: 'programado',
            notas: notaFinal,
            prioridad: esPrioridad,
          })
        })
      }))
      setReprogramados(true)
      showToast(`${aReprogramar.length} pedido${aReprogramar.length > 1 ? 's' : ''} reprogramados para el ${fechaDestino}`)
      if (userId) logAuditoria(userId, userNombre, 'Reprogramó pedidos fin del día', 'Fin del día', { fecha_origen: fecha, fecha_destino: fechaDestino, pedidos_count: aReprogramar.length, sucursal })
      cargar()
    } catch (e: any) { showToast(`Error: ${e.message}`, 'err') }
    setProcesando(false)
  }

  const vueltasConPedidos = [...new Set(pedidos.map(p => p.vuelta))].sort()

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
        <div className="max-w-3xl mx-auto px-4 md:px-6 h-14 flex items-center gap-4">
          <button onClick={() => router.push('/dashboard')}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg shrink-0"
            style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</button>
          <div className="w-px h-5 bg-gray-200" />
          <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Fin del día — Pedidos no entregados</span>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 md:px-6 py-6 space-y-4">

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 flex gap-3 flex-wrap">
          <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm focus:outline-none flex-1"
            style={{ borderColor: '#e8edf8' }} />
          <select value={sucursal} onChange={e => setSucursal(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm focus:outline-none flex-1"
            style={{ borderColor: '#e8edf8' }}>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {cargando ? (
          <div className="flex justify-center py-16">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : pedidos.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <div className="text-5xl mb-4">✅</div>
            <p className="font-semibold" style={{ color: '#254A96' }}>Todo entregado</p>
            <p className="text-sm mt-1" style={{ color: '#B9BBB7' }}>No hay pedidos pendientes para esta fecha y sucursal</p>
          </div>
        ) : (
          <>
            {/* Lista por vuelta */}
            {vueltasConPedidos.map(v => (
              <div key={v} className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
                  <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Vuelta {v}</span>
                  <span className="text-xs" style={{ color: '#B9BBB7' }}>{pedidos.filter(p => p.vuelta === v).length} pedidos</span>
                </div>
                <div className="divide-y" style={{ borderColor: '#f9f9f9' }}>
                  {pedidos.filter(p => p.vuelta === v).map(p => (
                    <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                      <input type="checkbox" checked={seleccionados.has(p.id)} onChange={() => toggleSeleccion(p.id)}
                        className="w-4 h-4 shrink-0 accent-blue-700" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-medium text-sm truncate" style={{ color: '#1a1a1a' }}>{p.cliente}</p>
                          {p.notas?.startsWith('📦 Saldo parcial') && (
                            <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0"
                              style={{ background: '#fef3c7', color: '#b45309' }}>📦 Saldo</span>
                          )}
                        </div>
                        <p className="text-xs truncate" style={{ color: '#B9BBB7' }}>{p.direccion}</p>
                        {p.peso_total_kg && <p className="text-xs font-medium" style={{ color: '#254A96' }}>{p.peso_total_kg} kg</p>}
                      </div>
                      <button
                        onClick={() => togglePrioridad(p.id)}
                        className="shrink-0 text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
                        style={{
                          background: prioridades.has(p.id) ? '#fef3c7' : '#f4f4f3',
                          color: prioridades.has(p.id) ? '#b45309' : '#B9BBB7',
                          border: prioridades.has(p.id) ? '1px solid #fbbf24' : '1px solid transparent'
                        }}>
                        ⭐ {prioridades.has(p.id) ? 'Prioridad' : 'Normal'}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {/* Acciones */}
            <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Reprogramar para</label>
                  <input type="date" value={fechaDestino}
                    onChange={e => setFechaDestino(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
                <div className="pt-5 text-sm" style={{ color: '#B9BBB7' }}>
                  {seleccionados.size} seleccionado{seleccionados.size !== 1 ? 's' : ''}
                  {prioridades.size > 0 && <span className="ml-2" style={{ color: '#b45309' }}>· {prioridades.size} ⭐ prioridad</span>}
                </div>
              </div>
              <button
                disabled={seleccionados.size === 0 || !fechaDestino || procesando}
                onClick={handleReprogramar}
                className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: '#254A96' }}>
                {procesando ? 'Reprogramando…' : `Reprogramar ${seleccionados.size} pedido${seleccionados.size !== 1 ? 's' : ''} al ${fechaDestino}`}
              </button>
              {reprogramados && (
                <button
                  onClick={() => router.push(`/programacion?fecha=${fechaDestino}&sucursal=${sucursal}`)}
                  className="w-full py-2.5 rounded-xl text-sm font-medium"
                  style={{ background: '#d1fae5', color: '#065f46' }}>
                  📅 Ir a programación del {fechaDestino} →
                </button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
