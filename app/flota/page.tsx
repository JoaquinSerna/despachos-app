'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { tieneAcceso } from '../lib/permisos'
import { logAuditoria } from '../lib/auditoria'

// ─── Constantes ────────────────────────────────────────────────────────────────

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

function hoy() { return new Date().toISOString().split('T')[0] }

function formatFecha(f: string) {
  const d = new Date(f + 'T00:00:00')
  return d.toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
}

function formatRelativo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'hace un momento'
  if (min < 60) return `hace ${min} min`
  const hs = Math.floor(min / 60)
  if (hs < 24) return `hace ${hs}h`
  const dias = Math.floor(hs / 24)
  return `hace ${dias} día${dias > 1 ? 's' : ''}`
}

// ─── Componente principal ───────────────────────────────────────────────────────

export default function FlotaDia() {
  const router = useRouter()
  const [vista, setVista] = useState<'lista' | 'editar'>('lista')
  const [fechaEditar, setFechaEditar] = useState('')
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [userId, setUserId] = useState('')
  const [userNombre, setUserNombre] = useState('')

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol, permisos, nombre').eq('id', user.id).single()
      if (!tieneAcceso(data?.permisos, data?.rol, 'flota')) { router.push('/dashboard'); return }
      setUserId(user.id)
      setUserNombre(data?.nombre ?? '')
    })
  }, [])

  const abrirEditar = (fecha: string) => {
    if (fecha < hoy()) {
      showToast('No podés modificar flotas de días pasados', 'err')
      return
    }
    setFechaEditar(fecha)
    setVista('editar')
  }

  const volverALista = () => {
    setVista('lista')
    setFechaEditar('')
  }

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {vista === 'lista'
        ? <VistaLista onEditar={abrirEditar} onVolver={() => router.push('/dashboard')} showToast={showToast} />
        : <VistaEditar fecha={fechaEditar} onVolver={volverALista} showToast={showToast} userId={userId} userNombre={userNombre} />
      }
    </div>
  )
}

// ─── Vista Lista ────────────────────────────────────────────────────────────────

interface ResumenFlota {
  fecha: string
  totalCamiones: number
  activos: number
  sucursales: string[]
  choferes: number
  ultimaModif: string | null
  revisado: boolean
  sinConfigurar: boolean  // true = no existe en flota_dia, usa flota base
}

function VistaLista({ onEditar, onVolver, showToast }: {
  onEditar: (fecha: string) => void
  onVolver: () => void
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}) {
  const [flotas, setFlotas] = useState<ResumenFlota[]>([])
  const [loading, setLoading] = useState(true)
  const [nuevaFecha, setNuevaFecha] = useState('')
  const [mostrarPicker, setMostrarPicker] = useState(false)

  useEffect(() => { cargarResumen() }, [])

  const cargarResumen = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('flota_dia')
      .select('fecha, activo, sucursal, chofer_id, updated_at, revisado')
      .order('fecha', { ascending: false })

    if (error) { showToast('Error al cargar flotas', 'err'); setLoading(false); return }

    // Agrupar por fecha
    const porFecha: Record<string, any[]> = {}
    ;(data ?? []).forEach((row: any) => {
      if (!porFecha[row.fecha]) porFecha[row.fecha] = []
      porFecha[row.fecha].push(row)
    })

    const resumenExistente: ResumenFlota[] = Object.entries(porFecha).map(([fecha, rows]) => {
      const activos = rows.filter((r: any) => r.activo && r.sucursal !== 'Fuera de servicio')
      const sucursalesSet = new Set(activos.map((r: any) => r.sucursal).filter(Boolean))
      const choferes = rows.filter((r: any) => r.chofer_id).length
      const ultimaModif = rows.map((r: any) => r.updated_at).filter(Boolean).sort().at(-1) ?? null
      const revisado = rows.every((r: any) => r.revisado === true)
      return {
        fecha,
        totalCamiones: rows.length,
        activos: activos.length,
        sucursales: [...sucursalesSet],
        choferes,
        ultimaModif,
        revisado,
        sinConfigurar: false,
      }
    })

    // Agregar los próximos 30 días aunque no tengan flota_dia configurada (excepto domingos)
    const fechasExistentes = new Set(resumenExistente.map(r => r.fecha))
    const proximos: ResumenFlota[] = []
    for (let i = 0; i < 30; i++) {
      const d = new Date(); d.setDate(d.getDate() + i)
      if (d.getDay() === 0) continue  // Saltar domingos
      const fecha = d.toISOString().split('T')[0]
      if (!fechasExistentes.has(fecha)) {
        proximos.push({
          fecha,
          totalCamiones: 0,
          activos: 0,
          sucursales: [],
          choferes: 0,
          ultimaModif: null,
          revisado: false,
          sinConfigurar: true,
        })
      }
    }

    const todos = [...resumenExistente, ...proximos]
      .sort((a, b) => a.fecha.localeCompare(b.fecha))  // ascendente: más cercano primero

    setFlotas(todos)
    setLoading(false)
  }

  const handleNuevaFlota = () => {
    if (!nuevaFecha) { showToast('Seleccioná una fecha', 'err'); return }
    if (nuevaFecha < hoy()) { showToast('No podés crear una flota para días pasados', 'err'); return }
    const yaExiste = flotas.some(f => f.fecha === nuevaFecha)
    if (yaExiste) {
      showToast('Ya hay una flota para esa fecha, hacé clic en ella para editarla', 'err')
      return
    }
    onEditar(nuevaFecha)
  }

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  const flotasHoy = flotas.filter(f => f.fecha === hoy())
  const flotasFuturas = flotas.filter(f => f.fecha > hoy())
  const flotasPasadas = flotas.filter(f => f.fecha < hoy())

  return (
    <>
      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-4xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button onClick={onVolver}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>
              ← Volver
            </button>
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div className="hidden sm:block">
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Flota del día</span>
              <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Flotas configuradas</span>
            </div>
          </div>
          <button
            onClick={() => setMostrarPicker(v => !v)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: '#254A96' }}>
            + Nueva flota
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-4 md:px-6 py-6">

        {/* Picker nueva flota */}
        {mostrarPicker && (
          <div className="mb-6 bg-white rounded-xl border p-4 flex items-end gap-3"
            style={{ borderColor: '#e8edf8' }}>
            <div className="flex-1">
              <label className="block text-xs font-semibold mb-1.5" style={{ color: '#254A96' }}>
                Fecha de la nueva flota
              </label>
              <input
                type="date"
                value={nuevaFecha}
                min={hoy()}
                onChange={e => setNuevaFecha(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}
              />
            </div>
            <button
              onClick={handleNuevaFlota}
              disabled={!nuevaFecha}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-40"
              style={{ background: '#254A96' }}>
              Crear
            </button>
            <button
              onClick={() => { setMostrarPicker(false); setNuevaFecha('') }}
              className="px-3 py-2 rounded-lg text-sm"
              style={{ color: '#B9BBB7' }}>
              Cancelar
            </button>
          </div>
        )}

        <div className="space-y-6">
          {flotasHoy.length > 0 && (
            <Section titulo="Hoy" flotas={flotasHoy} onEditar={onEditar} destacar />
          )}
          {flotasFuturas.length > 0 && (
            <Section titulo="Próximos días" flotas={flotasFuturas} onEditar={onEditar} />
          )}
          {flotasPasadas.length > 0 && (
            <Section titulo="Días anteriores" flotas={[...flotasPasadas].reverse()} onEditar={onEditar} opaco />
          )}
        </div>
      </main>
    </>
  )
}

function Section({ titulo, flotas, onEditar, destacar = false, opaco = false }: {
  titulo: string
  flotas: ResumenFlota[]
  onEditar: (fecha: string) => void
  destacar?: boolean
  opaco?: boolean
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-widest mb-3" style={{ color: '#B9BBB7' }}>{titulo}</p>
      <div className="space-y-2">
        {flotas.map(f => <CardFlota key={f.fecha} flota={f} onEditar={onEditar} destacar={destacar} opaco={opaco} />)}
      </div>
    </div>
  )
}

function CardFlota({ flota, onEditar, destacar, opaco }: {
  flota: ResumenFlota
  onEditar: (fecha: string) => void
  destacar: boolean
  opaco: boolean
}) {
  const esHoy = flota.fecha === hoy()
  return (
    <button
      onClick={() => onEditar(flota.fecha)}
      disabled={opaco}
      className="w-full bg-white rounded-xl p-4 flex items-center gap-4 text-left transition-all"
      style={{
        border: `2px solid ${destacar ? '#254A96' : '#f0f0f0'}`,
        opacity: opaco ? 0.5 : 1,
        cursor: opaco ? 'not-allowed' : 'pointer',
      }}
      onMouseEnter={e => { if (!opaco) (e.currentTarget as HTMLElement).style.transform = 'translateX(3px)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.transform = 'translateX(0)' }}
    >
      {/* Ícono fecha */}
      <div className="w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 text-white"
        style={{ background: destacar ? '#254A96' : '#f4f4f3' }}>
        <span className="text-xs font-bold leading-none" style={{ color: destacar ? 'white' : '#B9BBB7' }}>
          {new Date(flota.fecha + 'T00:00:00').toLocaleDateString('es-AR', { month: 'short' }).toUpperCase()}
        </span>
        <span className="text-xl font-bold leading-none" style={{ color: destacar ? 'white' : '#254A96' }}>
          {new Date(flota.fecha + 'T00:00:00').getDate()}
        </span>
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="font-semibold text-sm capitalize" style={{ color: '#1a1a1a' }}>
            {formatFecha(flota.fecha)}
          </span>
          {esHoy && (
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#254A96', color: 'white' }}>Hoy</span>
          )}
          {!flota.revisado && !opaco && (
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#fef3c7', color: '#92400e' }}>⚠️ Sin revisar</span>
          )}
          {flota.revisado && (
            <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
              style={{ background: '#d1fae5', color: '#065f46' }}>✓ Revisada</span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs flex-wrap" style={{ color: '#B9BBB7' }}>
          {flota.sinConfigurar
            ? <span style={{ color: '#92400e' }}>Usando flota base — hacé clic para revisar y confirmar</span>
            : <>
                <span>🚛 {flota.activos} camión{flota.activos !== 1 ? 'es' : ''} activo{flota.activos !== 1 ? 's' : ''}</span>
                <span>👤 {flota.choferes} chofer{flota.choferes !== 1 ? 'es' : ''}</span>
                {flota.sucursales.length > 0 && <span>📍 {flota.sucursales.join(', ')}</span>}
              </>
          }
        </div>
        {flota.ultimaModif && (
          <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>
            Última modificación: {formatRelativo(flota.ultimaModif)}
          </p>
        )}
      </div>

      <span className="text-xl shrink-0" style={{ color: '#B9BBB7' }}>›</span>
    </button>
  )
}

// ─── Vista Editar ───────────────────────────────────────────────────────────────

function VistaEditar({ fecha, onVolver, showToast, userId, userNombre }: {
  fecha: string
  onVolver: () => void
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  userId: string
  userNombre: string
}) {
  const [camiones, setCamiones] = useState<any[]>([])
  const [camionesOriginal, setCamionesOriginal] = useState<any[]>([])
  const [choferes, setChoferes] = useState<{ id: string; nombre: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [ultimaModif, setUltimaModif] = useState<string | null>(null)
  const [sinRevisar, setSinRevisar] = useState(false)

  useEffect(() => { cargarFlota() }, [fecha])

  const cargarFlota = async () => {
    setLoading(true)
    const [{ data: flotaBase }, { data: flotaDia }, { data: choferesData }] = await Promise.all([
      supabase.from('camiones_flota').select('*').eq('activo', true).order('sucursal'),
      supabase.from('flota_dia').select('*').eq('fecha', fecha),
      supabase.from('usuarios').select('id, nombre').eq('rol', 'chofer').order('nombre'),
    ])
    setSinRevisar((flotaDia ?? []).length === 0 || (flotaDia ?? []).some((d: any) => d.revisado === false))

    setChoferes(choferesData ?? [])

    // Calcular última modificación
    const fechas = (flotaDia ?? []).map((d: any) => d.updated_at).filter(Boolean).sort()
    setUltimaModif(fechas.at(-1) ?? null)

    const mapped = (flotaBase ?? []).map((c: any) => {
      const diaConfig = (flotaDia ?? []).find((d: any) => d.camion_codigo === c.codigo)
      return {
        ...c,
        sucursal_dia: diaConfig ? diaConfig.sucursal : c.sucursal,
        activo_dia: diaConfig ? diaConfig.activo : true,
        chofer_id: diaConfig?.chofer_id ?? c.chofer_id_default ?? '',
        sucursal_extra: diaConfig?.sucursal_extra ?? '',
        sucursal_extra_desde_vuelta: diaConfig?.sucursal_extra_desde_vuelta ?? 2,
      }
    })
    setCamiones(mapped)
    setCamionesOriginal(JSON.parse(JSON.stringify(mapped)))
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
      const resultados = await Promise.all(
        camiones.map(c =>
          supabase.from('flota_dia').upsert(
            {
              fecha,
              camion_codigo: c.codigo,
              sucursal: c.sucursal_dia,
              activo: c.activo_dia,
              chofer_id: c.chofer_id || null,
              revisado: true,
              sucursal_extra: c.sucursal_extra || null,
              sucursal_extra_desde_vuelta: c.sucursal_extra ? (c.sucursal_extra_desde_vuelta ?? 2) : null,
            },
            { onConflict: 'fecha,camion_codigo' }
          )
        )
      )

      const errores = resultados.filter(r => r.error)
      if (errores.length > 0) {
        const msg = errores[0].error?.message ?? 'error desconocido'
        console.error('Errores al guardar flota:', errores.map(r => r.error))
        showToast(`Error: ${msg}`, 'err')
      } else {
        showToast('Flota guardada correctamente')
        // Audit: log per-camion changes
        if (userId) {
          for (const c of camiones) {
            const orig = camionesOriginal.find((o: any) => o.codigo === c.codigo)
            if (!orig) continue
            if (orig.activo_dia !== c.activo_dia) {
              logAuditoria(userId, userNombre, c.activo_dia ? 'Activó camión en flota' : 'Desactivó camión', 'Flota', { fecha, camion_codigo: c.codigo, sucursal: c.sucursal_dia })
            } else if (orig.chofer_id !== c.chofer_id && c.chofer_id) {
              const chofer = choferes.find(ch => ch.id === c.chofer_id)
              logAuditoria(userId, userNombre, 'Asignó chofer', 'Flota', { fecha, camion_codigo: c.codigo, chofer_nombre: chofer?.nombre ?? c.chofer_id, sucursal: c.sucursal_dia })
            } else if (orig.sucursal_extra !== c.sucursal_extra && c.sucursal_extra) {
              logAuditoria(userId, userNombre, 'Asignó camión a sucursal extra', 'Flota', { camion_codigo: c.codigo, sucursal_extra: c.sucursal_extra })
            }
          }
        }
        await cargarFlota()
      }
    } catch (e: any) {
      console.error('Error inesperado:', e)
      showToast(`Error: ${e.message}`, 'err')
    } finally {
      setGuardando(false)
    }
  }

  const camionesEnSucursal = (s: string) => camiones.filter(c => c.sucursal_dia === s)
  const choferDeOtroCamion = (choferId: string, camionActual: string) =>
    camiones.some(c => c.codigo !== camionActual && c.chofer_id === choferId)

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <>
      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-screen-xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button onClick={onVolver}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>
              ← Flotas
            </button>
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-semibold text-sm capitalize" style={{ color: '#254A96' }}>
                {formatFecha(fecha)}
              </span>
              {ultimaModif && (
                <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>
                  · Modificado {formatRelativo(ultimaModif)}
                </span>
              )}
            </div>
          </div>
          <button onClick={guardarFlota} disabled={guardando}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: '#254A96' }}>
            {guardando ? 'Guardando...' : 'Guardar flota'}
          </button>
        </div>
      </nav>

      <main className="max-w-screen-xl mx-auto px-4 md:px-6 py-6">
        {sinRevisar && (
          <div className="mb-5 rounded-xl px-5 py-4 flex items-start gap-3 text-sm"
            style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e' }}>
            <span className="text-lg leading-none mt-0.5">⚠️</span>
            <div>
              <p className="font-semibold">Flota sin revisar</p>
              <p className="text-xs mt-0.5">Esta flota todavía no fue confirmada para este día. Revisá la asignación de camiones y choferes, y guardá para marcarla como revisada.</p>
            </div>
          </div>
        )}
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

                      {sucursal !== 'Fuera de servicio' && c.activo_dia && (
                        <div onMouseDown={e => e.stopPropagation()} className="space-y-1.5">
                          <select
                            value={c.chofer_id ?? ''}
                            onChange={e => asignarChofer(c.codigo, e.target.value)}
                            className="w-full text-xs border rounded-lg px-2 py-1 focus:outline-none"
                            style={{
                              borderColor: c.chofer_id ? '#254A96' : '#e8edf8',
                              color: c.chofer_id ? '#254A96' : '#B9BBB7',
                              background: c.chofer_id ? '#e8edf8' : 'white',
                            }}>
                            <option value="">🚗 Sin chofer</option>
                            {choferes.map(ch => (
                              <option key={ch.id} value={ch.id}
                                disabled={choferDeOtroCamion(ch.id, c.codigo)}>
                                {ch.nombre}{choferDeOtroCamion(ch.id, c.codigo) ? ' (asignado)' : ''}
                              </option>
                            ))}
                          </select>

                          {/* Segunda sucursal */}
                          <select
                            value={c.sucursal_extra ?? ''}
                            onChange={e => setCamiones(prev => prev.map(x =>
                              x.codigo === c.codigo ? { ...x, sucursal_extra: e.target.value, sucursal_extra_desde_vuelta: 2 } : x
                            ))}
                            className="w-full text-xs border rounded-lg px-2 py-1 focus:outline-none"
                            style={{
                              borderColor: c.sucursal_extra ? '#7c3aed' : '#e8edf8',
                              color: c.sucursal_extra ? '#7c3aed' : '#B9BBB7',
                              background: c.sucursal_extra ? '#f5f3ff' : 'white',
                            }}>
                            <option value="">🔀 Sin 2ª sucursal</option>
                            {SUCURSALES.filter(s => s !== sucursal && s !== 'Fuera de servicio').map(s => (
                              <option key={s} value={s}>{s}</option>
                            ))}
                          </select>

                          {/* Desde qué vuelta está disponible en la 2ª sucursal */}
                          {c.sucursal_extra && (
                            <select
                              value={c.sucursal_extra_desde_vuelta ?? 2}
                              onChange={e => setCamiones(prev => prev.map(x =>
                                x.codigo === c.codigo ? { ...x, sucursal_extra_desde_vuelta: parseInt(e.target.value) } : x
                              ))}
                              className="w-full text-xs border rounded-lg px-2 py-1 focus:outline-none"
                              style={{ borderColor: '#e8edf8', color: '#7c3aed', background: '#f5f3ff' }}>
                              <option value={2}>Disponible desde V2</option>
                              <option value={3}>Disponible desde V3</option>
                            </select>
                          )}
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
    </>
  )
}
