'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { supabase } from '@/app/supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { logAuditoria } from '@/app/lib/auditoria'

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

function hoy() { return new Date().toISOString().split('T')[0] }
function hace30Dias() {
  const d = new Date(); d.setDate(d.getDate() - 30)
  return d.toISOString().split('T')[0]
}

interface Devolucion {
  id: string
  fecha: string
  cliente: string
  chofer_nombre: string
  sucursal: string
  sanos: number
  daniados: number
  rotos: number
  notas: string | null
  registrado_por_nombre: string | null
  created_at: string
}

interface Chofer {
  id: string
  nombre: string
}

// ── Roles autorizados ──
const ROLES_DEPOSITO = ['deposito', 'admin_flota', 'gerencia', 'ruteador']
const ROLES_COMERCIAL = ['comercial', 'admin_flota', 'gerencia']
const ROLES_RUTEADOR  = ['ruteador', 'admin_flota', 'gerencia']

export default function PalletsPage() {
  const router = useRouter()
  const [rol, setRol]       = useState<string | null>(null)
  const [userId, setUserId] = useState('')
  const [userNombre, setUserNombre] = useState('')
  const [tab, setTab]       = useState<'registrar' | 'comercial' | 'ruteador'>('registrar')

  // ── form registro ──
  const [fecha, setFecha]         = useState(hoy())
  const [sucursal, setSucursal]   = useState('LP520')
  const [chofer, setChofer]       = useState('')
  const [cliente, setCliente]     = useState('')
  const [sanos, setSanos]         = useState('')
  const [daniados, setDaniados]   = useState('')
  const [rotos, setRotos]         = useState('')
  const [notas, setNotas]         = useState('')
  const [guardando, setGuardando] = useState(false)

  // autocomplete cliente
  const [sugerencias, setSugerencias] = useState<string[]>([])
  const [showSug, setShowSug]         = useState(false)
  const clienteRef = useRef<HTMLDivElement>(null)

  // choferes
  const [choferes, setChoferes] = useState<Chofer[]>([])

  // registros recientes
  const [registros, setRegistros] = useState<Devolucion[]>([])
  const [cargandoReg, setCargandoReg] = useState(false)

  // vista comercial
  const [comFechaDesde, setComFechaDesde] = useState(hace30Dias())
  const [comFechaHasta, setComFechaHasta] = useState(hoy())
  const [comCliente, setComCliente]       = useState('')
  const [comData, setComData]             = useState<Devolucion[]>([])
  const [cargandoCom, setCargandoCom]     = useState(false)

  // vista ruteador
  const [rutFecha, setRutFecha]   = useState(hoy())
  const [rutChofer, setRutChofer] = useState('')
  const [rutData, setRutData]     = useState<Devolucion[]>([])
  const [cargandoRut, setCargandoRut] = useState(false)

  // toast
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  // ── Auth ──
  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      setUserId(user.id)
      const { data } = await supabase.from('usuarios').select('nombre, rol').eq('id', user.id).single()
      setUserNombre(data?.nombre ?? '')
      const r = data?.rol ?? ''
      setRol(r)
      // Determinar tab inicial según rol
      if (ROLES_DEPOSITO.includes(r)) setTab('registrar')
      else if (ROLES_COMERCIAL.includes(r)) setTab('comercial')
      else if (ROLES_RUTEADOR.includes(r)) setTab('ruteador')
    })
  }, [])

  // ── Cargar choferes ──
  useEffect(() => {
    supabase.from('usuarios').select('id, nombre').eq('rol', 'chofer').order('nombre')
      .then(({ data }) => setChoferes(data ?? []))
  }, [])

  // ── Cerrar autocomplete al click fuera ──
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (clienteRef.current && !clienteRef.current.contains(e.target as Node)) setShowSug(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  // ── Autocomplete cliente ──
  const buscarClientes = useCallback(async (q: string) => {
    if (q.length < 2) { setSugerencias([]); return }
    const { data } = await supabase
      .from('pedidos')
      .select('cliente')
      .ilike('cliente', `%${q}%`)
      .limit(20)
    if (!data) return
    const unique = [...new Set(data.map(r => r.cliente as string))].sort().slice(0, 8)
    setSugerencias(unique)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => buscarClientes(cliente), 300)
    return () => clearTimeout(t)
  }, [cliente])

  // ── Cargar registros recientes (tab registrar) ──
  const cargarRegistros = useCallback(async () => {
    setCargandoReg(true)
    const { data } = await supabase
      .from('devoluciones_pallets')
      .select('*')
      .gte('fecha', hace30Dias())
      .order('created_at', { ascending: false })
      .limit(50)
    setRegistros(data ?? [])
    setCargandoReg(false)
  }, [])

  useEffect(() => { if (tab === 'registrar') cargarRegistros() }, [tab])

  // ── Cargar vista comercial ──
  const cargarComercial = useCallback(async () => {
    setCargandoCom(true)
    let q = supabase
      .from('devoluciones_pallets')
      .select('*')
      .gt('sanos', 0)
      .gte('fecha', comFechaDesde)
      .lte('fecha', comFechaHasta)
      .order('fecha', { ascending: false })
    if (comCliente.trim()) q = q.ilike('cliente', `%${comCliente.trim()}%`)
    const { data } = await q.limit(200)
    setComData(data ?? [])
    setCargandoCom(false)
  }, [comFechaDesde, comFechaHasta, comCliente])

  useEffect(() => { if (tab === 'comercial') cargarComercial() }, [tab, comFechaDesde, comFechaHasta, comCliente])

  // ── Cargar vista ruteador ──
  const cargarRuteador = useCallback(async () => {
    setCargandoRut(true)
    let q = supabase
      .from('devoluciones_pallets')
      .select('*')
      .eq('fecha', rutFecha)
      .order('chofer_nombre')
    if (rutChofer.trim()) q = q.ilike('chofer_nombre', `%${rutChofer.trim()}%`)
    const { data } = await q.limit(200)
    setRutData(data ?? [])
    setCargandoRut(false)
  }, [rutFecha, rutChofer])

  useEffect(() => { if (tab === 'ruteador') cargarRuteador() }, [tab, rutFecha, rutChofer])

  // ── Guardar registro ──
  async function handleGuardar() {
    if (!cliente.trim() || !chofer) { showToast('Completá cliente y chofer', 'err'); return }
    const s = parseInt(sanos) || 0
    const d = parseInt(daniados) || 0
    const r = parseInt(rotos) || 0
    if (s + d + r === 0) { showToast('Ingresá al menos un pallet (sano, dañado o roto)', 'err'); return }

    setGuardando(true)
    const { error } = await supabase.from('devoluciones_pallets').insert({
      fecha,
      sucursal,
      cliente: cliente.trim(),
      chofer_nombre: chofer,
      sanos: s,
      daniados: d,
      rotos: r,
      notas: notas.trim() || null,
      registrado_por_id: userId || null,
      registrado_por_nombre: userNombre || null,
    })
    if (error) { showToast(`Error: ${error.message}`, 'err'); setGuardando(false); return }

    if (userId) logAuditoria(userId, userNombre, 'Registró devolución de pallets', 'Pallets',
      { cliente: cliente.trim(), chofer, sanos: s, daniados: d, rotos: r })

    showToast(`✓ Pallets registrados — ${cliente.trim()}`)
    setCliente(''); setSanos(''); setDaniados(''); setRotos(''); setNotas('')
    cargarRegistros()
    setGuardando(false)
  }

  // ── Agrupar por chofer (ruteador) ──
  const choferesList = [...new Set(rutData.map(r => r.chofer_nombre))].sort()

  // ── Totales comercial ──
  const totalSanos = comData.reduce((s, r) => s + r.sanos, 0)

  if (!rol) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#f9f9f9' }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  const puedeRegistrar = ROLES_DEPOSITO.includes(rol)
  const puedeVerComercial = ROLES_COMERCIAL.includes(rol)
  const puedeVerRuteador = ROLES_RUTEADOR.includes(rol)

  const tabs: { key: 'registrar' | 'comercial' | 'ruteador'; label: string; icon: string }[] = [
    ...(puedeRegistrar  ? [{ key: 'registrar' as const,  label: 'Registrar',     icon: '📦' }] : []),
    ...(puedeVerComercial ? [{ key: 'comercial' as const, label: 'Reintegros',    icon: '💰' }] : []),
    ...(puedeVerRuteador  ? [{ key: 'ruteador'  as const, label: 'Por chofer',    icon: '🚛' }] : []),
  ]

  const fmtFecha = (iso: string) => {
    const [y, m, d] = iso.split('-')
    return `${d}/${m}/${y}`
  }

  return (
    <div className="min-h-screen" style={{ background: '#f9f9f9', fontFamily: 'Barlow, sans-serif' }}>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link href="/dashboard"
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg shrink-0"
            style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</Link>
          <div className="w-px h-5 bg-gray-200" />
          <span className="text-lg">📦</span>
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Devolución de Pallets</span>
        </div>
      </nav>

      {/* Tabs */}
      <div className="bg-white border-b" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-4xl mx-auto px-4 flex gap-1 pt-2">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors"
              style={{
                background: tab === t.key ? '#254A96' : 'transparent',
                color: tab === t.key ? '#fff' : '#888',
              }}>
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-4">

        {/* ── TAB REGISTRAR ── */}
        {tab === 'registrar' && (
          <>
            {/* Formulario */}
            <div className="bg-white rounded-xl shadow-sm p-5 space-y-4">
              <h2 className="font-semibold text-sm" style={{ color: '#254A96' }}>Nuevo registro de pallets</h2>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {/* Fecha */}
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Fecha</label>
                  <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
                {/* Sucursal */}
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Sucursal</label>
                  <select value={sucursal} onChange={e => setSucursal(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }}>
                    {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                {/* Chofer */}
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Chofer</label>
                  <select value={chofer} onChange={e => setChofer(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: chofer ? '#e8edf8' : '#E52322' }}>
                    <option value="">— Seleccioná —</option>
                    {choferes.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
                  </select>
                </div>
              </div>

              {/* Cliente autocomplete */}
              <div ref={clienteRef} className="relative">
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Cliente</label>
                <input
                  type="text"
                  value={cliente}
                  onChange={e => { setCliente(e.target.value); setShowSug(true) }}
                  onFocus={() => setShowSug(true)}
                  placeholder="Buscar cliente…"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: cliente.trim() ? '#e8edf8' : '#E52322' }}
                  autoComplete="off"
                />
                {showSug && sugerencias.length > 0 && (
                  <div className="absolute top-full left-0 right-0 bg-white border rounded-lg shadow-lg z-20 mt-0.5 max-h-44 overflow-y-auto"
                    style={{ borderColor: '#e8edf8' }}>
                    {sugerencias.map(s => (
                      <button key={s} onClick={() => { setCliente(s); setShowSug(false) }}
                        className="w-full text-left px-4 py-2.5 text-sm hover:bg-blue-50 transition-colors"
                        style={{ color: '#1a1a1a' }}>
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Cantidades */}
              <div>
                <label className="block text-xs font-medium mb-2" style={{ color: '#666' }}>Pallets recibidos</label>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Sanos', color: '#1a7a3c', bg: '#d1fae5', value: sanos, set: setSanos },
                    { label: 'Dañados', color: '#b45309', bg: '#fef3c7', value: daniados, set: setDaniados },
                    { label: 'Rotos', color: '#E52322', bg: '#fde8e8', value: rotos, set: setRotos },
                  ].map(({ label, color, bg, value, set }) => (
                    <div key={label} className="rounded-xl p-3 text-center" style={{ background: bg }}>
                      <p className="text-xs font-semibold mb-2" style={{ color }}>{label}</p>
                      <input
                        type="number"
                        min="0"
                        value={value}
                        onChange={e => set(e.target.value)}
                        placeholder="0"
                        className="w-full text-center text-2xl font-bold bg-transparent border-none outline-none"
                        style={{ color }}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Notas */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Notas <span style={{ color: '#B9BBB7' }}>(opcional)</span></label>
                <input type="text" value={notas} onChange={e => setNotas(e.target.value)}
                  placeholder="Ej: 2 rotos por humedad, cliente confirma…"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>

              <button
                onClick={handleGuardar}
                disabled={guardando}
                className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardando ? 'Guardando…' : '✓ Registrar pallets'}
              </button>
            </div>

            {/* Lista recientes */}
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: '#f0f0f0' }}>
                <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Últimos 30 días</span>
                <span className="text-xs" style={{ color: '#B9BBB7' }}>{registros.length} registros</span>
              </div>
              {cargandoReg ? (
                <div className="flex justify-center py-8">
                  <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
                </div>
              ) : registros.length === 0 ? (
                <p className="text-center py-8 text-sm" style={{ color: '#B9BBB7' }}>Sin registros aún</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: '#f9f9f9' }}>
                        {['Fecha', 'Cliente', 'Chofer', 'Sanos', 'Dañados', 'Rotos', 'Notas', 'Registrado por'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold" style={{ color: '#888' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {registros.map(r => (
                        <tr key={r.id} className="border-t hover:bg-gray-50" style={{ borderColor: '#f5f5f5' }}>
                          <td className="px-4 py-2.5 text-xs" style={{ color: '#888' }}>{fmtFecha(r.fecha)}</td>
                          <td className="px-4 py-2.5 font-medium text-xs" style={{ color: '#1a1a1a', maxWidth: 180 }}>
                            <span className="block truncate">{r.cliente}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs" style={{ color: '#555' }}>{r.chofer_nombre}</td>
                          <td className="px-4 py-2.5 text-xs font-bold text-center" style={{ color: r.sanos > 0 ? '#1a7a3c' : '#B9BBB7' }}>
                            {r.sanos > 0 ? r.sanos : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs font-bold text-center" style={{ color: r.daniados > 0 ? '#b45309' : '#B9BBB7' }}>
                            {r.daniados > 0 ? r.daniados : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs font-bold text-center" style={{ color: r.rotos > 0 ? '#E52322' : '#B9BBB7' }}>
                            {r.rotos > 0 ? r.rotos : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs" style={{ color: '#888', maxWidth: 140 }}>
                            <span className="block truncate">{r.notas ?? '—'}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs" style={{ color: '#B9BBB7' }}>{r.registrado_por_nombre ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── TAB COMERCIAL ── */}
        {tab === 'comercial' && (
          <>
            {/* Filtros */}
            <div className="bg-white rounded-xl shadow-sm p-4 flex gap-3 flex-wrap items-end">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Desde</label>
                <input type="date" value={comFechaDesde} onChange={e => setComFechaDesde(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Hasta</label>
                <input type="date" value={comFechaHasta} onChange={e => setComFechaHasta(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div className="flex-1 min-w-40">
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Filtrar cliente</label>
                <input type="text" value={comCliente} onChange={e => setComCliente(e.target.value)}
                  placeholder="Nombre del cliente…"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              {totalSanos > 0 && (
                <div className="ml-auto px-4 py-2 rounded-lg text-sm font-semibold" style={{ background: '#d1fae5', color: '#1a7a3c' }}>
                  Total: {totalSanos} pallets sanos
                </div>
              )}
            </div>

            {/* Tabla */}
            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b" style={{ borderColor: '#f0f0f0' }}>
                <span className="font-semibold text-sm" style={{ color: '#254A96' }}>💰 Pallets para reintegro (solo sanos)</span>
              </div>
              {cargandoCom ? (
                <div className="flex justify-center py-8">
                  <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
                </div>
              ) : comData.length === 0 ? (
                <p className="text-center py-10 text-sm" style={{ color: '#B9BBB7' }}>Sin pallets sanos en el período seleccionado</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: '#f9f9f9' }}>
                        {['Fecha', 'Cliente', 'Pallets sanos', 'Chofer', 'Sucursal', 'Notas'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold" style={{ color: '#888' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {comData.map(r => (
                        <tr key={r.id} className="border-t hover:bg-green-50" style={{ borderColor: '#f5f5f5' }}>
                          <td className="px-4 py-3 text-xs" style={{ color: '#888' }}>{fmtFecha(r.fecha)}</td>
                          <td className="px-4 py-3 font-semibold text-sm" style={{ color: '#1a1a1a' }}>{r.cliente}</td>
                          <td className="px-4 py-3">
                            <span className="px-3 py-1 rounded-full text-sm font-bold"
                              style={{ background: '#d1fae5', color: '#1a7a3c' }}>
                              {r.sanos} pallet{r.sanos !== 1 ? 's' : ''}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#555' }}>{r.chofer_nombre}</td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#888' }}>{r.sucursal}</td>
                          <td className="px-4 py-3 text-xs" style={{ color: '#888' }}>{r.notas ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── TAB RUTEADOR ── */}
        {tab === 'ruteador' && (
          <>
            {/* Filtros */}
            <div className="bg-white rounded-xl shadow-sm p-4 flex gap-3 flex-wrap items-end">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Fecha</label>
                <input type="date" value={rutFecha} onChange={e => setRutFecha(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div className="flex-1 min-w-36">
                <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Filtrar chofer</label>
                <input type="text" value={rutChofer} onChange={e => setRutChofer(e.target.value)}
                  placeholder="Nombre del chofer…"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>

            {/* Por chofer */}
            {cargandoRut ? (
              <div className="flex justify-center py-8">
                <div className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
              </div>
            ) : rutData.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm p-10 text-center">
                <p className="text-sm" style={{ color: '#B9BBB7' }}>Sin registros para esta fecha</p>
              </div>
            ) : (
              choferesList.map(nombreChofer => {
                const rows = rutData.filter(r => r.chofer_nombre === nombreChofer)
                const totS = rows.reduce((s, r) => s + r.sanos, 0)
                const totD = rows.reduce((s, r) => s + r.daniados, 0)
                const totR = rows.reduce((s, r) => s + r.rotos, 0)
                return (
                  <div key={nombreChofer} className="bg-white rounded-xl shadow-sm overflow-hidden">
                    <div className="px-4 py-3 border-b flex items-center gap-3 flex-wrap" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
                      <span className="font-semibold text-sm" style={{ color: '#254A96' }}>🚛 {nombreChofer}</span>
                      <div className="flex gap-2 ml-auto">
                        {totS > 0 && <span className="px-2.5 py-1 rounded-full text-xs font-bold" style={{ background: '#d1fae5', color: '#1a7a3c' }}>✓ {totS} sano{totS !== 1 ? 's' : ''}</span>}
                        {totD > 0 && <span className="px-2.5 py-1 rounded-full text-xs font-bold" style={{ background: '#fef3c7', color: '#b45309' }}>⚠ {totD} dañado{totD !== 1 ? 's' : ''}</span>}
                        {totR > 0 && <span className="px-2.5 py-1 rounded-full text-xs font-bold" style={{ background: '#fde8e8', color: '#E52322' }}>✕ {totR} roto{totR !== 1 ? 's' : ''}</span>}
                      </div>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr style={{ background: '#fafafa' }}>
                          {['Cliente', 'Sucursal', 'Sanos', 'Dañados', 'Rotos', 'Notas'].map(h => (
                            <th key={h} className="px-4 py-2 text-left text-xs font-semibold" style={{ color: '#888' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map(r => (
                          <tr key={r.id} className="border-t" style={{ borderColor: '#f5f5f5' }}>
                            <td className="px-4 py-2.5 font-medium text-sm" style={{ color: '#1a1a1a' }}>{r.cliente}</td>
                            <td className="px-4 py-2.5 text-xs" style={{ color: '#888' }}>{r.sucursal}</td>
                            <td className="px-4 py-2.5 text-sm font-bold text-center" style={{ color: r.sanos > 0 ? '#1a7a3c' : '#B9BBB7' }}>
                              {r.sanos > 0 ? r.sanos : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-sm font-bold text-center" style={{ color: r.daniados > 0 ? '#b45309' : '#B9BBB7' }}>
                              {r.daniados > 0 ? r.daniados : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-sm font-bold text-center" style={{ color: r.rotos > 0 ? '#E52322' : '#B9BBB7' }}>
                              {r.rotos > 0 ? r.rotos : '—'}
                            </td>
                            <td className="px-4 py-2.5 text-xs" style={{ color: '#888' }}>{r.notas ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })
            )}
          </>
        )}

      </main>
    </div>
  )
}
