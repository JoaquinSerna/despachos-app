'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Fuera de servicio']

const SUCURSAL_LABELS: { [key: string]: string } = {
  'LP520': 'La Plata 520',
  'LP139': 'La Plata 139',
  'Guernica': 'Guernica',
  'Cañuelas': 'Cañuelas',
  'Fuera de servicio': '🔴 Fuera de servicio',
}

const SUCURSAL_COLORS: { [key: string]: string } = {
  'LP520': 'border-purple-300 bg-purple-50',
  'LP139': 'border-pink-300 bg-pink-50',
  'Guernica': 'border-green-300 bg-green-50',
  'Cañuelas': 'border-blue-300 bg-blue-50',
  'Fuera de servicio': 'border-red-300 bg-red-50',
}

export default function FlotaDia() {
  const router = useRouter()
  const [camiones, setCamiones] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [guardado, setGuardado] = useState(false)
  const [fecha, setFecha] = useState(() => new Date().toISOString().split('T')[0])
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  useEffect(() => {
    const checkUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) router.push('/')
    }
    checkUser()
  }, [])

  useEffect(() => {
    cargarFlota()
  }, [fecha])

  const cargarFlota = async () => {
    setLoading(true)

    // Cargar camiones base
    const { data: flotaBase } = await supabase
      .from('camiones_flota')
      .select('*')
      .eq('activo', true)
      .order('sucursal')

    // Ver si hay configuracion guardada para este dia
    const { data: flotaDia } = await supabase
      .from('flota_dia')
      .select('*')
      .eq('fecha', fecha)

    if (flotaDia && flotaDia.length > 0) {
      // Usar configuracion del dia
      const camionesConDia = flotaBase?.map(c => {
        const diaConfig = flotaDia.find((d: any) => d.camion_codigo === c.codigo)
        return {
          ...c,
          sucursal_dia: diaConfig ? diaConfig.sucursal : c.sucursal,
          activo_dia: diaConfig ? diaConfig.activo : true,
        }
      }) || []
      setCamiones(camionesConDia)
    } else {
      // Usar configuracion base
      const camionesBase = flotaBase?.map(c => ({
        ...c,
        sucursal_dia: c.sucursal,
        activo_dia: true,
      })) || []
      setCamiones(camionesBase)
    }

    setLoading(false)
  }

  const moverCamion = (codigo: string, nuevaSucursal: string) => {
    setCamiones(prev => prev.map(c =>
      c.codigo === codigo
        ? { ...c, sucursal_dia: nuevaSucursal, activo_dia: nuevaSucursal !== 'Fuera de servicio' }
        : c
    ))
  }

  const toggleActivo = (codigo: string) => {
    setCamiones(prev => prev.map(c =>
      c.codigo === codigo
        ? {
            ...c,
            activo_dia: !c.activo_dia,
            sucursal_dia: c.activo_dia ? 'Fuera de servicio' : c.sucursal
          }
        : c
    ))
  }

  const guardarFlota = async () => {
    setGuardando(true)
    setGuardado(false)

    const upserts = camiones.map(c => ({
      fecha,
      camion_codigo: c.codigo,
      sucursal: c.sucursal_dia,
      activo: c.activo_dia,
    }))

    const { error } = await supabase
      .from('flota_dia')
      .upsert(upserts, { onConflict: 'fecha,camion_codigo' })

    if (error) {
      console.error('Error guardando:', error)
    } else {
      setGuardado(true)
      setTimeout(() => setGuardado(false), 3000)
    }

    setGuardando(false)
  }

  const camionesEnSucursal = (sucursal: string) =>
    camiones.filter(c => c.sucursal_dia === sucursal)

  const handleDragStart = (codigo: string) => {
    setDragging(codigo)
  }

  const handleDragOver = (e: React.DragEvent, sucursal: string) => {
    e.preventDefault()
    setDragOver(sucursal)
  }

  const handleDrop = (e: React.DragEvent, sucursal: string) => {
    e.preventDefault()
    if (dragging) {
      moverCamion(dragging, sucursal)
    }
    setDragging(null)
    setDragOver(null)
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <p className="text-gray-500">Cargando flota...</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow px-6 py-4 flex justify-between items-center">
        <h1 className="text-xl font-bold text-gray-800">Flota del día</h1>
        <div className="flex items-center gap-4">
          <input
            type="date"
            value={fecha}
            onChange={e => setFecha(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={guardarFlota}
            disabled={guardando}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition disabled:opacity-50"
          >
            {guardando ? 'Guardando...' : guardado ? '✓ Guardado' : 'Guardar flota'}
          </button>
          <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 text-sm">
            ← Panel
          </button>
        </div>
      </nav>

      <main className="p-6">
        <p className="text-sm text-gray-500 mb-4">
          Arrastrá los camiones entre sucursales o marcalos como fuera de servicio. Los cambios se guardan para la fecha seleccionada.
        </p>

        <div className="grid grid-cols-5 gap-4">
          {SUCURSALES.map(sucursal => (
            <div
              key={sucursal}
              onDragOver={e => handleDragOver(e, sucursal)}
              onDrop={e => handleDrop(e, sucursal)}
              className={`rounded-xl border-2 p-3 min-h-64 transition ${SUCURSAL_COLORS[sucursal]} ${dragOver === sucursal ? 'ring-2 ring-blue-400 scale-105' : ''}`}
            >
              <div className="flex justify-between items-center mb-3">
                <h3 className="font-semibold text-sm text-gray-700">{SUCURSAL_LABELS[sucursal]}</h3>
                <span className="text-xs text-gray-400">{camionesEnSucursal(sucursal).length} camiones</span>
              </div>

              <div className="space-y-2">
                {camionesEnSucursal(sucursal).map(c => (
                  <div
                    key={c.codigo}
                    draggable
                    onDragStart={() => handleDragStart(c.codigo)}
                    className={`bg-white rounded-lg p-2.5 shadow-sm cursor-grab active:cursor-grabbing border transition ${
                      !c.activo_dia ? 'opacity-50 border-red-200' : 'border-gray-200 hover:border-blue-300'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-semibold text-sm text-gray-800">{c.codigo}</p>
                        <p className="text-xs text-gray-400">{c.tipo_unidad}</p>
                      </div>
                      <button
                        onClick={() => toggleActivo(c.codigo)}
                        className={`text-xs px-1.5 py-0.5 rounded ${c.activo_dia ? 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-500' : 'bg-red-100 text-red-500 hover:bg-green-100 hover:text-green-500'}`}
                      >
                        {c.activo_dia ? '✕' : '↺'}
                      </button>
                    </div>
                    <div className="mt-1.5 flex gap-2 text-xs text-gray-500">
                      <span>📦 {c.posiciones_total} pos</span>
                      <span>⚖️ {(c.tonelaje_max_kg / 1000).toFixed(0)}tn</span>
                    </div>
                    <div className="mt-1 flex gap-1">
                      {c.grua_hidraulica && <span className="text-xs bg-blue-50 text-blue-600 px-1 rounded">🏗️ Grúa</span>}
                      {c.volcador && <span className="text-xs bg-orange-50 text-orange-600 px-1 rounded">🪣 Volcador</span>}
                    </div>
                  </div>
                ))}

                {camionesEnSucursal(sucursal).length === 0 && (
                  <div className="text-center text-gray-300 text-xs py-8 border-2 border-dashed border-gray-200 rounded-lg">
                    Soltá un camión acá
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}