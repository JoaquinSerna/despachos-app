'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const CARDS = [
  {
    href: '/despachos',
    emoji: '📦',
    titulo: 'Nuevo despacho',
    descripcion: 'Cargar solicitud desde PDF',
    color: 'border-blue-400',
    bg: 'hover:bg-blue-50',
  },
  {
    href: '/flota',
    emoji: '🚛',
    titulo: 'Flota del día',
    descripcion: 'Configurar camiones disponibles',
    color: 'border-orange-400',
    bg: 'hover:bg-orange-50',
  },
  {
    href: '/programacion',
    emoji: '📅',
    titulo: 'Programación',
    descripcion: 'Importar y asignar solicitudes',
    color: 'border-purple-400',
    bg: 'hover:bg-purple-50',
  },
  {
    href: '/ruteo',
    emoji: '🗺️',
    titulo: 'Ruteo',
    descripcion: 'Asignar pedidos a camiones',
    color: 'border-green-400',
    bg: 'hover:bg-green-50',
  },
  {
    href: '/metricas',
    emoji: '📊',
    titulo: 'Métricas',
    descripcion: 'KPIs y estadísticas de entregas',
    color: 'border-pink-400',
    bg: 'hover:bg-pink-50',
  },
]

export default function Dashboard() {
  const [usuario, setUsuario] = useState<any>(null)
  const [stats, setStats] = useState({ pendientes: 0, hoy: 0, enCamino: 0 })
  const router = useRouter()

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/'); return }
      setUsuario(user)
    }
    getUser()
    cargarStats()
  }, [])

  const cargarStats = async () => {
    const hoy = new Date().toISOString().split('T')[0]

    const { count: pendientes } = await supabase
      .from('pedidos').select('*', { count: 'exact', head: true })
      .eq('estado', 'pendiente')

    const { count: hoyCount } = await supabase
      .from('pedidos').select('*', { count: 'exact', head: true })
      .eq('fecha_entrega', hoy)

    const { count: enCamino } = await supabase
      .from('pedidos').select('*', { count: 'exact', head: true })
      .eq('estado', 'en_camino')

    setStats({
      pendientes: pendientes || 0,
      hoy: hoyCount || 0,
      enCamino: enCamino || 0,
    })
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/')
  }

  if (!usuario) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <p className="text-gray-400">Cargando...</p>
    </div>
  )

  const hora = new Date().getHours()
  const saludo = hora < 12 ? 'Buenos días' : hora < 18 ? 'Buenas tardes' : 'Buenas noches'
  const nombre = usuario.email?.split('@')[0] || 'usuario'

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow px-6 py-4 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 text-white font-bold text-lg px-3 py-1 rounded-lg">CaC</div>
          <div>
            <h1 className="text-lg font-bold text-gray-800 leading-tight">Construyo al Costo</h1>
            <p className="text-xs text-gray-400">Sistema de despachos</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-gray-500 text-sm hidden md:block">{usuario.email}</span>
          <button onClick={handleLogout} className="text-sm text-red-500 hover:text-red-700 transition">
            Cerrar sesión
          </button>
        </div>
      </nav>

      <main className="p-6 max-w-6xl mx-auto">

        {/* Saludo */}
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-gray-800">{saludo}, {nombre} 👋</h2>
          <p className="text-gray-400 text-sm mt-1">{new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-xl shadow p-4 flex items-center gap-4">
            <div className="bg-yellow-100 text-yellow-600 text-2xl p-3 rounded-lg">⏳</div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{stats.pendientes}</p>
              <p className="text-xs text-gray-400">Pedidos pendientes</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 flex items-center gap-4">
            <div className="bg-blue-100 text-blue-600 text-2xl p-3 rounded-lg">📅</div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{stats.hoy}</p>
              <p className="text-xs text-gray-400">Entregas hoy</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow p-4 flex items-center gap-4">
            <div className="bg-green-100 text-green-600 text-2xl p-3 rounded-lg">🚚</div>
            <div>
              <p className="text-2xl font-bold text-gray-800">{stats.enCamino}</p>
              <p className="text-xs text-gray-400">En camino ahora</p>
            </div>
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {CARDS.map(card => (
            <div
              key={card.href}
              onClick={() => router.push(card.href)}
              className={`bg-white rounded-xl shadow p-6 cursor-pointer border-l-4 ${card.color} ${card.bg} transition hover:shadow-md`}
            >
              <div className="text-3xl mb-3">{card.emoji}</div>
              <h3 className="text-lg font-semibold text-gray-800">{card.titulo}</h3>
              <p className="text-gray-400 text-sm mt-1">{card.descripcion}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}