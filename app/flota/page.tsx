'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar', 'Fuera de servicio']

const SUCURSAL_LABELS: Record<string, string> = {
  'LP520': 'La Plata 520', 'LP139': 'La Plata 139', 'Guernica': 'Guernica',
  'Cañuelas': 'Cañuelas', 'Pinamar': 'Pinamar', 'Fuera de servicio': 'Fuera de servicio',
}

const SUCURSAL_COLORS: Record<string, { border: string; bg: string; header: string }> = {
  'LP520':             { border: '#254A96', bg: '#e8edf8', header: '#254A96' },
  'LP139':             { border: '#7c3aed', bg: '#f3e8ff', header: '#7c3aed' },
  'Guernica':          { border: '#059669', bg: '#d1fae5', header: '#059669' },
  'Cañuelas':          { border: '#d97706', bg: '#fef3c7', header: '#d97706' },
  'Pinamar':           { border: '#0891b2', bg: '#e0f2fe', header: '#0891b2' },
  'Fuera de servicio': { border: '#E52322', bg: '#fde8e8', header: '#E52322' },
}

export default function FlotaDia() {
  const router = useRouter()
  const [camiones, setCamiones] = useState<any[]>([])
  const [choferes, setChoferes] = useState<{ id: string; nombre: string; camion_codigo: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [fecha, setFecha] = useState(() => new Date().toISOString().split('T')[0])
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      if (!['gerencia', 'admin_flota'].includes(data?.rol)) { router.push('/dashboard'); return }
    })
  }, [])

  useEffect(() => { cargarFlota() }, [fecha])

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000)
  }

  const cargarFlota = async () => {
    setLoading(true)
    const [{ data: flotaBase }, { data: flotaDia }, { data: choferesData }] = await Promise.all([
      supabase.from('camiones_flota').select('*').eq('activo', true).order('sucursal'),
      supabase.from('flota_dia').select('*').eq('fecha', fecha),
      supabase.from('usuarios').select('id, nombre').eq('rol', 'chofer').order('nombre'),
    ])

    setChoferes(choferesData ?? [])

    setCamiones((flotaBase ?? []).map(c => {
      const diaConfig = flotaDia?.find((d: any) => d.camion_codigo === c.codigo)
      return {
        ...c,
        sucursal_dia: diaConfig ? diaConfig.sucursal : c.sucursal,
        activo_dia: diaConfig ? diaConfig.activo : true,
        // chofer_id viene de flota_dia (por fecha), no de usuarios (global)
        chofer_id: diaConfig?.chofer_id ?? '',
      }
    }))
    setLoading(false)
  }

  const moverCamion = (codigo: string, nuevaSucursal: string) => {
    setCamiones(prev => prev.map(c =>
      c.codigo === codigo ? { ...c, sucursal_dia: nuevaSucursal, activo_dia: nuevaSucursal !== 'Fuera de servicio' } : c
    ))
  }

  const toggleActivo = (codigo: string) => {
    setCamiones(prev => prev.map(c =>
      c.codigo === codigo ? { ...c, activo_dia: !c.activo_dia, sucursal_dia: c.activo_dia ? 'Fuera de servicio' : c.sucursal } : c
    ))
  }

  const asignarChofer = (camionCodigo: string, choferId: string) => {
    setCamiones(prev => prev.map(c =>
      c.codigo === camionCodigo ? { ...c, chofer_id: choferId } : c
    ))
  }

  const guardarFlota = async () => {
    setGuardando(true)
    try {
      // Guardar flota del día con chofer incluido (todo en una sola operación)
      const { error } = await supabase.from('flota_dia').upsert(
        camiones.map(c => ({
          fecha,
          camion_codigo: c.codigo,
          sucursal: c.sucursal_dia,
          activo: c.activo_dia,
          chofer_id: c.chofer_id || null,
        })),
        { onConflict: 'fecha,camion_codigo' }
      )
      if (error) throw error

      showToast('Flota y choferes guardados correctamente')
    } catch (e: any) {
      showToast('Error al guardar la flota', 'err')
    } finally {
      setGuardando(false)
    }
  }

  const camionesEnSucursal = (s: string) => camiones.filter(c => c.sucursal_dia === s)
  const choferDeOtroCamion = (choferId: string, camionActual: string) =>
    camiones.some(c => c.codigo !== camionActual && c.chofer_id === choferId)

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-screen-xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push('/dashboard')}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>
              ← Volver
            </button>
            <div className="hidden sm:block">
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Flota del día</span>
              <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Configurar camiones y asignar choferes</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
              className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none"
              style={{ borderColor: '#e8edf8' }} />
            <button onClick={guardarFlota} disabled={guardando}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: '#254A96' }}>
              {guardando ? 'Guardando...' : 'Guardar flota'}
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-screen-xl mx-auto px-4 md:px-6 py-6">
        <p className="text-sm mb-5" style={{ color: '#B9BBB7' }}>
          Arrastrá los camiones entre sucursales. Asigná un chofer a cada camión activo.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {SUCURSALES.map(sucursal => {
            const colors = SUCURSAL_COLORS[sucursal]
            const enSucursal = camionesEnSucursal(sucursal)
            const isDragOver = dragOver === sucursal
            return (
              <div key={sucursal}
                onDragOver={e => { e.preventDefault(); setDragOver(sucursal) }}
                onDrop={e => { e.preventDefault(); if (dragging) moverCamion(dragging, sucursal); setDragging(null); setDragOver(null) }}
                onDragLeave={() => setDragOver(null)}
                className="rounded-xl border-2 transition-all min-h-64"
                style={{
                  borderColor: isDragOver ? colors.border : '#e8edf8',
                  background: isDragOver ? colors.bg : 'white',
                  transform: isDragOver ? 'scale(1.02)' : 'scale(1)',
                  boxShadow: isDragOver ? `0 0 0 3px ${colors.border}33` : '0 1px 3px rgba(0,0,0,0.06)',
                }}>
                <div className="px-3 py-3 rounded-t-xl border-b" style={{ borderColor: '#f4f4f3', background: colors.bg }}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-xs" style={{ color: colors.header }}>{SUCURSAL_LABELS[sucursal]}</span>
                    <span className="text-xs font-medium px-1.5 py-0.5 rounded-full"
                      style={{ background: 'white', color: colors.header }}>{enSucursal.length}</span>
                  </div>
                </div>

                <div className="p-2 space-y-2">
                  {enSucursal.map(c => (
                    <div key={c.codigo} draggable
                      onDragStart={() => setDragging(c.codigo)}
                      onDragEnd={() => setDragging(null)}
                      className="bg-white rounded-lg p-2.5 cursor-grab active:cursor-grabbing transition-all border"
                      style={{
                        borderColor: dragging === c.codigo ? colors.border : '#f0f0f0',
                        opacity: dragging === c.codigo ? 0.5 : c.activo_dia ? 1 : 0.6,
                      }}>
                      <div className="flex justify-between items-start mb-1.5">
                        <div>
                          <p className="font-bold text-sm" style={{ color: '#254A96' }}>{c.codigo}</p>
                          <p className="text-xs" style={{ color: '#B9BBB7' }}>{c.tipo_unidad}</p>
                        </div>
                        <button onClick={() => toggleActivo(c.codigo)}
                          className="w-6 h-6 rounded-full flex items-center justify-center text-xs"
                          style={{ background: c.activo_dia ? '#f4f4f3' : '#fde8e8', color: c.activo_dia ? '#B9BBB7' : '#E52322' }}
                          title={c.activo_dia ? 'Desactivar' : 'Activar'}>
                          {c.activo_dia ? '✕' : '↺'}
                        </button>
                      </div>

                      <div className="flex gap-2 text-xs mb-2" style={{ color: '#B9BBB7' }}>
                        <span>📦 {c.posiciones_total}</span>
                        <span>⚖️ {(c.tonelaje_max_kg / 1000).toFixed(0)}tn</span>
                      </div>

                      {(c.grua_hidraulica || c.volcador) && (
                        <div className="flex gap-1 mb-2">
                          {c.grua_hidraulica && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#e8edf8', color: '#254A96' }}>Grúa</span>}
                          {c.volcador && <span className="text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#fef3c7', color: '#d97706' }}>Volc.</span>}
                        </div>
                      )}

                      {/* Asignación de chofer */}
                      {sucursal !== 'Fuera de servicio' && c.activo_dia && (
                        <div onMouseDown={e => e.stopPropagation()}>
                          <select
                            value={c.chofer_id ?? ''}
                            onChange={e => asignarChofer(c.codigo, e.target.value)}
                            className="w-full text-xs border rounded-lg px-2 py-1 focus:outline-none"
                            style={{ borderColor: c.chofer_id ? '#254A96' : '#e8edf8', color: c.chofer_id ? '#254A96' : '#B9BBB7', background: c.chofer_id ? '#e8edf8' : 'white' }}>
                            <option value="">🚗 Sin chofer</option>
                            {choferes.map(ch => (
                              <option key={ch.id} value={ch.id}
                                disabled={choferDeOtroCamion(ch.id, c.codigo)}>
                                {ch.nombre}{choferDeOtroCamion(ch.id, c.codigo) ? ' (asignado)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  ))}

                  {enSucursal.length === 0 && (
                    <div className="text-center py-8 rounded-lg border-2 border-dashed"
                      style={{ borderColor: '#e8edf8', color: '#B9BBB7' }}>
                      <p className="text-xs">Soltá un camión acá</p>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}
