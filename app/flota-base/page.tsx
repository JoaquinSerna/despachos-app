'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']
const SUCURSAL_COLORS: Record<string, { border: string; bg: string; header: string }> = {
  'LP520':    { border: '#254A96', bg: '#e8edf8', header: '#254A96' },
  'LP139':    { border: '#7c3aed', bg: '#f3e8ff', header: '#7c3aed' },
  'Guernica': { border: '#059669', bg: '#d1fae5', header: '#059669' },
  'Cañuelas': { border: '#d97706', bg: '#fef3c7', header: '#d97706' },
  'Pinamar':  { border: '#0891b2', bg: '#e0f2fe', header: '#0891b2' },
}

interface Camion {
  codigo: string
  sucursal: string
  tipo_unidad: string
  posiciones_total: number
  tonelaje_max_kg: number
  grua_hidraulica: boolean
  volcador: boolean
  activo: boolean
  chofer_id_default: string
}

export default function FlotaBasePage() {
  const router = useRouter()
  const [camiones, setCamiones] = useState<Camion[]>([])
  const [choferes, setChoferes] = useState<{ id: string; nombre: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [camionEditando, setCamionEditando] = useState<string | null>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      if (!['gerencia', 'admin_flota'].includes(data?.rol)) { router.push('/dashboard'); return }
      cargar()
    })
  }, [])

  const cargar = async () => {
    setLoading(true)
    const [{ data: cam }, { data: chof }] = await Promise.all([
      supabase.from('camiones_flota').select('*').order('sucursal').order('codigo'),
      supabase.from('usuarios').select('id, nombre').eq('rol', 'chofer').order('nombre'),
    ])
    setCamiones((cam ?? []).map(c => ({ ...c, chofer_id_default: c.chofer_id_default ?? '' })))
    setChoferes(chof ?? [])
    setLoading(false)
  }

  const actualizar = (codigo: string, campo: keyof Camion, valor: any) => {
    setCamiones(prev => prev.map(c => c.codigo === codigo ? { ...c, [campo]: valor } : c))
  }

  const guardarCamion = async (c: Camion) => {
    setGuardando(true)
    const { error } = await supabase.from('camiones_flota').update({
      sucursal: c.sucursal,
      posiciones_total: c.posiciones_total,
      tonelaje_max_kg: c.tonelaje_max_kg,
      grua_hidraulica: c.grua_hidraulica,
      volcador: c.volcador,
      activo: c.activo,
      chofer_id_default: c.chofer_id_default || null,
    }).eq('codigo', c.codigo)

    if (error) {
      showToast('Error al guardar', 'err')
    } else {
      showToast(`${c.codigo} guardado`)
      setCamionEditando(null)
    }
    setGuardando(false)
  }

  const choferAsignadoAOtro = (choferId: string, camionActual: string) =>
    camiones.some(c => c.codigo !== camionActual && c.chofer_id_default === choferId)

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-4xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push('/dashboard')}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>
              ← Volver
            </button>
            <div>
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Flota base</span>
              <span className="text-xs ml-2 hidden sm:inline" style={{ color: '#B9BBB7' }}>
                Configuración permanente de camiones y choferes habituales
              </span>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-4 md:px-6 py-6">

        <div className="bg-white rounded-xl p-4 mb-6 flex items-start gap-3 shadow-sm"
          style={{ border: '1px solid #e8edf8' }}>
          <span className="text-xl shrink-0">💡</span>
          <p className="text-sm" style={{ color: '#666' }}>
            Acá configurás los camiones de forma permanente: posiciones, tonelaje y el chofer habitual de cada uno.
            Al crear una <strong>flota del día</strong>, los choferes se pre-cargan desde acá automáticamente y podés cambiarlos si ese día hay alguna variación.
          </p>
        </div>

        {SUCURSALES.map(sucursal => {
          const enSucursal = camiones.filter(c => c.sucursal === sucursal)
          if (enSucursal.length === 0) return null
          const colors = SUCURSAL_COLORS[sucursal]

          return (
            <div key={sucursal} className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
                <span className="text-xs font-semibold px-3 py-1 rounded-full"
                  style={{ background: colors.bg, color: colors.header }}>
                  {sucursal} · {enSucursal.filter(c => c.activo).length} activos
                </span>
                <div className="h-px flex-1" style={{ background: '#e8edf8' }} />
              </div>

              <div className="space-y-2">
                {enSucursal.map(c => {
                  const editando = camionEditando === c.codigo
                  const choferDefault = choferes.find(ch => ch.id === c.chofer_id_default)

                  return (
                    <div key={c.codigo}
                      className="bg-white rounded-xl shadow-sm overflow-hidden"
                      style={{ border: `2px solid ${editando ? colors.border : '#f0f0f0'}`, opacity: c.activo ? 1 : 0.6 }}>

                      {/* Header */}
                      <div className="px-4 py-3 flex items-center justify-between"
                        style={{ background: editando ? colors.bg : 'white' }}>
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-xs shrink-0"
                            style={{ background: c.activo ? colors.header : '#B9BBB7' }}>
                            🚛
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-sm" style={{ color: '#1a1a1a' }}>{c.codigo}</p>
                              <span className="text-xs" style={{ color: '#B9BBB7' }}>{c.tipo_unidad}</span>
                              {!c.activo && (
                                <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                                  style={{ background: '#fde8e8', color: '#E52322' }}>Inactivo</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                              <span>📦 {c.posiciones_total} pos.</span>
                              <span>⚖️ {(c.tonelaje_max_kg / 1000).toFixed(1)}tn</span>
                              {c.grua_hidraulica && <span>🏗️ Grúa</span>}
                              {c.volcador && <span>🔄 Volc.</span>}
                              {choferDefault && (
                                <span style={{ color: colors.header }}>👤 {choferDefault.nombre}</span>
                              )}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => setCamionEditando(editando ? null : c.codigo)}
                          className="text-xs px-3 py-1.5 rounded-lg font-medium"
                          style={{
                            background: editando ? colors.header : '#f4f4f3',
                            color: editando ? 'white' : '#666'
                          }}>
                          {editando ? 'Cerrar' : 'Editar'}
                        </button>
                      </div>

                      {/* Formulario edición */}
                      {editando && (
                        <div className="px-4 py-4 space-y-4" style={{ borderTop: `1px solid ${colors.bg}` }}>
                          <div>
                            <label className="block text-xs font-semibold mb-1.5" style={{ color: '#254A96' }}>
                              Sucursal base
                            </label>
                            <select
                              value={c.sucursal}
                              onChange={e => actualizar(c.codigo, 'sucursal', e.target.value)}
                              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                              style={{ borderColor: '#e8edf8' }}>
                              {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-semibold mb-1.5" style={{ color: '#254A96' }}>
                                Posiciones totales
                              </label>
                              <input
                                type="number" min="1" max="50"
                                value={c.posiciones_total}
                                onChange={e => actualizar(c.codigo, 'posiciones_total', parseInt(e.target.value) || 0)}
                                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                                style={{ borderColor: '#e8edf8' }}
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-semibold mb-1.5" style={{ color: '#254A96' }}>
                                Tonelaje máximo (kg)
                              </label>
                              <input
                                type="number" min="0"
                                value={c.tonelaje_max_kg}
                                onChange={e => actualizar(c.codigo, 'tonelaje_max_kg', parseInt(e.target.value) || 0)}
                                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                                style={{ borderColor: '#e8edf8' }}
                              />
                              <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>
                                = {(c.tonelaje_max_kg / 1000).toFixed(2)} tn
                              </p>
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-semibold mb-1.5" style={{ color: '#254A96' }}>
                              Chofer habitual (se pre-carga en flota del día)
                            </label>
                            <select
                              value={c.chofer_id_default}
                              onChange={e => actualizar(c.codigo, 'chofer_id_default', e.target.value)}
                              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                              style={{ borderColor: '#e8edf8' }}>
                              <option value="">— Sin chofer habitual —</option>
                              {choferes.map(ch => (
                                <option key={ch.id} value={ch.id}
                                  disabled={choferAsignadoAOtro(ch.id, c.codigo)}>
                                  {ch.nombre}{choferAsignadoAOtro(ch.id, c.codigo) ? ' (ya asignado)' : ''}
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="flex items-center gap-6">
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={c.grua_hidraulica}
                                onChange={e => actualizar(c.codigo, 'grua_hidraulica', e.target.checked)}
                                className="w-4 h-4 rounded" />
                              <span className="text-sm" style={{ color: '#1a1a1a' }}>🏗️ Grúa hidráulica</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={c.volcador}
                                onChange={e => actualizar(c.codigo, 'volcador', e.target.checked)}
                                className="w-4 h-4 rounded" />
                              <span className="text-sm" style={{ color: '#1a1a1a' }}>🔄 Volcador</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input type="checkbox" checked={c.activo}
                                onChange={e => actualizar(c.codigo, 'activo', e.target.checked)}
                                className="w-4 h-4 rounded" />
                              <span className="text-sm" style={{ color: '#1a1a1a' }}>Activo</span>
                            </label>
                          </div>

                          <div className="flex gap-2 pt-1">
                            <button
                              onClick={() => guardarCamion(c)}
                              disabled={guardando}
                              className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                              style={{ background: colors.header }}>
                              {guardando ? 'Guardando...' : '✓ Guardar cambios'}
                            </button>
                            <button
                              onClick={() => { setCamionEditando(null); cargar() }}
                              className="px-4 py-2.5 rounded-xl text-sm font-medium"
                              style={{ background: '#f4f4f3', color: '#666' }}>
                              Cancelar
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </main>
    </div>
  )
}
