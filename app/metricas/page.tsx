'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

function hoy() { return new Date().toISOString().split('T')[0] }
function mesActual() { return new Date().toISOString().slice(0, 7) }

function pct(valor: number, max: number) {
  if (!max) return 0
  return Math.min(100, Math.round((valor / max) * 100))
}

function colorSemaforo(p: number) {
  if (p >= 70) return { bg: '#d1fae5', color: '#065f46', label: 'Alto' }
  if (p >= 40) return { bg: '#fef3c7', color: '#b45309', label: 'Medio' }
  return { bg: '#fde8e8', color: '#E52322', label: 'Bajo' }
}

function colorBarra(p: number) {
  return p >= 90 ? '#E52322' : p >= 70 ? '#10b981' : p >= 40 ? '#f59e0b' : '#B9BBB7'
}

function formatHora(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
}

function duracion(inicio: string | null, fin: string | null): string {
  if (!inicio || !fin) return '—'
  const min = Math.round((new Date(fin).getTime() - new Date(inicio).getTime()) / 60000)
  const hs = Math.floor(min / 60); const m = min % 60
  return hs > 0 ? `${hs}h ${m}min` : `${m}min`
}

function minKm(inicio: string | null, fin: string | null, km: number | null): string {
  if (!inicio || !fin || !km || km === 0) return '—'
  const min = (new Date(fin).getTime() - new Date(inicio).getTime()) / 60000
  return `${(min / km).toFixed(1)}`
}

interface DatosCamionDia {
  camion_codigo: string
  tipo_unidad: string
  sucursal: string
  posiciones_total: number
  tonelaje_max_kg: number
  chofer_nombre: string
  posicionesUsadas: number
  kgUsados: number
  pedidos: number
  pctPos: number
  pctKg: number
  hora_inicio: string | null
  hora_fin: string | null
  km_ruta: number | null
}

interface DatosCamionMes {
  camion_codigo: string
  tipo_unidad: string
  sucursal: string
  posiciones_total: number
  tonelaje_max_kg: number
  diasActivo: number
  avgPctPos: number
  avgPctKg: number
  totalKm: number
  avgMinKm: string
}

export default function MetricasPage() {
  const router = useRouter()
  const [vista, setVista] = useState<'diaria' | 'mensual'>('diaria')
  const [fecha, setFecha] = useState(hoy())
  const [mes, setMes] = useState(mesActual())
  const [loading, setLoading] = useState(false)
  const [datosDia, setDatosDia] = useState<DatosCamionDia[]>([])
  const [datosMes, setDatosMes] = useState<DatosCamionMes[]>([])
  const [toast, setToast] = useState<string | null>(null)

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      if (!['gerencia', 'admin_flota', 'ruteador'].includes(data?.rol)) { router.push('/dashboard'); return }
    })
  }, [])

  useEffect(() => { if (vista === 'diaria') cargarDiaria() }, [fecha, vista])
  useEffect(() => { if (vista === 'mensual') cargarMensual() }, [mes, vista])

  const cargarDiaria = async () => {
    setLoading(true)
    const [{ data: flotaDia }, { data: pedidosData }, { data: camionesData }] = await Promise.all([
      supabase.from('flota_dia').select('camion_codigo, chofer_id, hora_inicio, hora_fin, km_ruta').eq('fecha', fecha).eq('activo', true),
      supabase.from('pedidos').select('camion_id, peso_total_kg, volumen_total_m3').eq('fecha_entrega', fecha).neq('estado', 'cancelado').not('camion_id', 'is', null),
      supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg'),
    ])

    const choferIds = (flotaDia ?? []).filter((f: any) => f.chofer_id).map((f: any) => f.chofer_id)
    const { data: choferes } = choferIds.length > 0
      ? await supabase.from('usuarios').select('id, nombre').in('id', choferIds)
      : { data: [] }

    const choferMap: Record<string, string> = {}
    ;(choferes ?? []).forEach((c: any) => { choferMap[c.id] = c.nombre })

    const camionMap: Record<string, any> = {}
    ;(camionesData ?? []).forEach((c: any) => { camionMap[c.codigo] = c })

    const datos: DatosCamionDia[] = (flotaDia ?? []).map((f: any) => {
      const camion = camionMap[f.camion_codigo]
      if (!camion) return null
      const pedidosCamion = (pedidosData ?? []).filter((p: any) => p.camion_id === f.camion_codigo)
      const kgUsados = pedidosCamion.reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
      const posicionesUsadas = pedidosCamion.reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
      return {
        camion_codigo: f.camion_codigo,
        tipo_unidad: camion.tipo_unidad,
        sucursal: camion.sucursal,
        posiciones_total: camion.posiciones_total,
        tonelaje_max_kg: camion.tonelaje_max_kg,
        chofer_nombre: f.chofer_id ? (choferMap[f.chofer_id] ?? 'Sin nombre') : 'Sin chofer',
        posicionesUsadas,
        kgUsados,
        pedidos: pedidosCamion.length,
        pctPos: pct(posicionesUsadas, camion.posiciones_total),
        pctKg: pct(kgUsados, camion.tonelaje_max_kg),
        hora_inicio: f.hora_inicio,
        hora_fin: f.hora_fin,
        km_ruta: f.km_ruta,
      }
    }).filter(Boolean) as DatosCamionDia[]

    setDatosDia(datos.sort((a, b) => b.pctKg - a.pctKg))
    setLoading(false)
  }

  const cargarMensual = async () => {
    setLoading(true)
    const fechaInicio = `${mes}-01`
    const fechaFin = `${mes}-31`

    const [{ data: flotaMes }, { data: pedidosMes }, { data: camionesData }] = await Promise.all([
      supabase.from('flota_dia').select('fecha, camion_codigo, hora_inicio, hora_fin, km_ruta').gte('fecha', fechaInicio).lte('fecha', fechaFin).eq('activo', true),
      supabase.from('pedidos').select('camion_id, fecha_entrega, peso_total_kg, volumen_total_m3').gte('fecha_entrega', fechaInicio).lte('fecha_entrega', fechaFin).neq('estado', 'cancelado').not('camion_id', 'is', null),
      supabase.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg'),
    ])

    const camionMap: Record<string, any> = {}
    ;(camionesData ?? []).forEach((c: any) => { camionMap[c.codigo] = c })

    // Agrupar por camion
    const porCamion: Record<string, { flotaDias: any[]; pedidosDias: any[] }> = {}
    ;(flotaMes ?? []).forEach((f: any) => {
      if (!porCamion[f.camion_codigo]) porCamion[f.camion_codigo] = { flotaDias: [], pedidosDias: [] }
      porCamion[f.camion_codigo].flotaDias.push(f)
    })
    ;(pedidosMes ?? []).forEach((p: any) => {
      if (!p.camion_id || !porCamion[p.camion_id]) return
      porCamion[p.camion_id].pedidosDias.push(p)
    })

    const datos: DatosCamionMes[] = Object.entries(porCamion).map(([codigo, { flotaDias, pedidosDias }]) => {
      const camion = camionMap[codigo]
      if (!camion) return null
      const diasActivo = flotaDias.length
      const totalKm = flotaDias.reduce((a, f) => a + (f.km_ruta ?? 0), 0)

      // Por día, calcular ocupación
      let sumPctPos = 0; let sumPctKg = 0
      let sumMinKm = 0; let diasConTiempo = 0

      flotaDias.forEach(f => {
        const pedidosDia = pedidosDias.filter(p => p.fecha_entrega === f.fecha)
        const kg = pedidosDia.reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
        const pos = pedidosDia.reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
        sumPctKg += pct(kg, camion.tonelaje_max_kg)
        sumPctPos += pct(pos, camion.posiciones_total)
        if (f.hora_inicio && f.hora_fin && f.km_ruta) {
          const min = (new Date(f.hora_fin).getTime() - new Date(f.hora_inicio).getTime()) / 60000
          sumMinKm += min / f.km_ruta
          diasConTiempo++
        }
      })

      return {
        camion_codigo: codigo,
        tipo_unidad: camion.tipo_unidad,
        sucursal: camion.sucursal,
        posiciones_total: camion.posiciones_total,
        tonelaje_max_kg: camion.tonelaje_max_kg,
        diasActivo,
        avgPctPos: diasActivo > 0 ? Math.round(sumPctPos / diasActivo) : 0,
        avgPctKg: diasActivo > 0 ? Math.round(sumPctKg / diasActivo) : 0,
        totalKm: Math.round(totalKm),
        avgMinKm: diasConTiempo > 0 ? (sumMinKm / diasConTiempo).toFixed(1) : '—',
      }
    }).filter(Boolean) as DatosCamionMes[]

    setDatosMes(datos.sort((a, b) => b.avgPctKg - a.avgPctKg))
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: '#254A96' }}>✓ {toast}</div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-5xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button onClick={() => router.push('/dashboard')}
              className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>
              ← Volver
            </button>
            <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Métricas de flota</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setVista('diaria')}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{ background: vista === 'diaria' ? '#254A96' : '#f4f4f3', color: vista === 'diaria' ? 'white' : '#666' }}>
              Diaria
            </button>
            <button onClick={() => setVista('mensual')}
              className="px-4 py-1.5 rounded-lg text-sm font-medium"
              style={{ background: vista === 'mensual' ? '#254A96' : '#f4f4f3', color: vista === 'mensual' ? 'white' : '#666' }}>
              Mensual
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 md:px-6 py-6">

        {/* Filtro fecha/mes */}
        <div className="flex items-center gap-3 mb-6">
          {vista === 'diaria' ? (
            <>
              <label className="text-sm font-medium" style={{ color: '#254A96' }}>Fecha:</label>
              <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </>
          ) : (
            <>
              <label className="text-sm font-medium" style={{ color: '#254A96' }}>Mes:</label>
              <input type="month" value={mes} onChange={e => setMes(e.target.value)}
                className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            </>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : vista === 'diaria' ? (
          <VistaDiaria datos={datosDia} fecha={fecha} />
        ) : (
          <VistaMensual datos={datosMes} mes={mes} />
        )}
      </main>
    </div>
  )
}

// ─── Vista Diaria ───────────────────────────────────────────────────────────────

function VistaDiaria({ datos, fecha }: { datos: DatosCamionDia[]; fecha: string }) {
  if (datos.length === 0) return (
    <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
      <div className="text-5xl mb-4">🚛</div>
      <p className="font-medium">No hay flota configurada para esta fecha</p>
      <p className="text-sm mt-1">Creá la flota del día primero desde el módulo de Flota del día</p>
    </div>
  )

  // Resumen general
  const totalPedidos = datos.reduce((a, d) => a + d.pedidos, 0)
  const avgPctKg = datos.length > 0 ? Math.round(datos.reduce((a, d) => a + d.pctKg, 0) / datos.length) : 0
  const avgPctPos = datos.length > 0 ? Math.round(datos.reduce((a, d) => a + d.pctPos, 0) / datos.length) : 0
  const conRuta = datos.filter(d => d.hora_inicio && d.hora_fin)

  return (
    <div className="space-y-4">
      {/* Resumen */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
        {[
          { label: 'Camiones activos', value: datos.length, emoji: '🚛', bg: '#e8edf8', color: '#254A96' },
          { label: 'Total pedidos', value: totalPedidos, emoji: '📦', bg: '#f3e8ff', color: '#7c3aed' },
          { label: 'Ocup. prom. kg', value: `${avgPctKg}%`, emoji: '⚖️', bg: colorSemaforo(avgPctKg).bg, color: colorSemaforo(avgPctKg).color },
          { label: 'Ocup. prom. pos', value: `${avgPctPos}%`, emoji: '📐', bg: colorSemaforo(avgPctPos).bg, color: colorSemaforo(avgPctPos).color },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl p-4 flex items-center gap-3 shadow-sm" style={{ border: '1px solid #f0f0f0' }}>
            <div className="w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0" style={{ background: s.bg }}>{s.emoji}</div>
            <div>
              <p className="text-xl font-bold leading-none" style={{ color: s.color }}>{s.value}</p>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Cards por camión */}
      {datos.map(d => {
        const botKg = colorSemaforo(d.pctKg)
        const botPos = colorSemaforo(d.pctPos)
        const ocupPrincipal = Math.max(d.pctKg, d.pctPos)
        const semaforo = colorSemaforo(ocupPrincipal)
        return (
          <div key={d.camion_codigo} className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f0f0f0' }}>
            {/* Header */}
            <div className="px-4 py-3 flex items-center justify-between" style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold"
                  style={{ background: '#254A96' }}>🚛</div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm" style={{ color: '#1a1a1a' }}>{d.camion_codigo}</span>
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>{d.tipo_unidad}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: semaforo.bg, color: semaforo.color }}>
                      {ocupPrincipal}% ocupación
                    </span>
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                    👤 {d.chofer_nombre} · 📍 {d.sucursal} · 📦 {d.pedidos} pedidos
                  </p>
                </div>
              </div>
            </div>

            {/* Barras de ocupación */}
            <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-medium" style={{ color: '#666' }}>⚖️ Peso</span>
                  <span className="text-xs font-bold" style={{ color: botKg.color }}>{d.pctKg}%</span>
                </div>
                <div className="w-full h-3 rounded-full" style={{ background: '#f0f0f0' }}>
                  <div className="h-3 rounded-full transition-all" style={{ width: `${Math.min(d.pctKg, 100)}%`, background: colorBarra(d.pctKg) }} />
                </div>
                <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>{Math.round(d.kgUsados)} / {d.tonelaje_max_kg} kg</p>
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-medium" style={{ color: '#666' }}>📦 Posiciones</span>
                  <span className="text-xs font-bold" style={{ color: botPos.color }}>{d.pctPos}%</span>
                </div>
                <div className="w-full h-3 rounded-full" style={{ background: '#f0f0f0' }}>
                  <div className="h-3 rounded-full transition-all" style={{ width: `${Math.min(d.pctPos, 100)}%`, background: colorBarra(d.pctPos) }} />
                </div>
                <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>{Math.round(d.posicionesUsadas)} / {d.posiciones_total} pos</p>
              </div>
            </div>

            {/* Tiempos de ruta */}
            {(d.hora_inicio || d.km_ruta) && (
              <div className="px-4 pb-3 pt-0">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'Inicio', value: formatHora(d.hora_inicio) },
                    { label: 'Fin', value: formatHora(d.hora_fin) },
                    { label: 'Duración', value: duracion(d.hora_inicio, d.hora_fin) },
                    { label: 'Min/km', value: minKm(d.hora_inicio, d.hora_fin, d.km_ruta) + (minKm(d.hora_inicio, d.hora_fin, d.km_ruta) !== '—' ? ' min/km' : '') },
                  ].map(item => (
                    <div key={item.label} className="rounded-lg p-2 text-center" style={{ background: '#f4f4f3' }}>
                      <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>{item.label}</p>
                      <p className="text-xs font-bold" style={{ color: '#254A96' }}>{item.value}</p>
                    </div>
                  ))}
                </div>
                {d.km_ruta && <p className="text-xs mt-2 text-center" style={{ color: '#B9BBB7' }}>🗺️ {d.km_ruta} km planificados</p>}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Vista Mensual ──────────────────────────────────────────────────────────────

function VistaMensual({ datos, mes }: { datos: DatosCamionMes[]; mes: string }) {
  const nombreMes = new Date(mes + '-15').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })

  if (datos.length === 0) return (
    <div className="flex flex-col items-center justify-center py-24" style={{ color: '#B9BBB7' }}>
      <div className="text-5xl mb-4">📅</div>
      <p className="font-medium">No hay datos para {nombreMes}</p>
    </div>
  )

  const ociosos = datos.filter(d => d.avgPctKg < 40)

  return (
    <div className="space-y-4">

      {ociosos.length > 0 && (
        <div className="bg-white rounded-xl p-4 shadow-sm" style={{ border: '2px solid #fde8e8' }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-lg">⚠️</span>
            <span className="font-semibold text-sm" style={{ color: '#E52322' }}>Flota ociosa detectada ({nombreMes})</span>
          </div>
          <p className="text-xs mb-3" style={{ color: '#B9BBB7' }}>Los siguientes camiones tuvieron menos del 40% de ocupación promedio:</p>
          <div className="flex flex-wrap gap-2">
            {ociosos.map(d => (
              <span key={d.camion_codigo} className="text-xs px-3 py-1.5 rounded-full font-medium"
                style={{ background: '#fde8e8', color: '#E52322' }}>
                🚛 {d.camion_codigo} — {d.avgPctKg}% prom.
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl shadow-sm overflow-hidden" style={{ border: '1px solid #f0f0f0' }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
          <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>
            Rendimiento por camión — {nombreMes}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#f9f9f9', borderBottom: '1px solid #f0f0f0' }}>
                {['Camión', 'Sucursal', 'Días activo', 'Ocup. kg', 'Ocup. pos', 'Total km', 'Min/km prom', 'Estado'].map(h => (
                  <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold uppercase tracking-wide whitespace-nowrap" style={{ color: '#B9BBB7' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datos.map((d, i) => {
                const sem = colorSemaforo(d.avgPctKg)
                return (
                  <tr key={d.camion_codigo} style={{ borderBottom: '1px solid #f9f9f9', background: i % 2 === 0 ? 'white' : '#fdfdfd' }}>
                    <td className="px-4 py-3">
                      <div>
                        <p className="font-bold text-sm" style={{ color: '#254A96' }}>{d.camion_codigo}</p>
                        <p className="text-xs" style={{ color: '#B9BBB7' }}>{d.tipo_unidad}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: '#B9BBB7' }}>{d.sucursal}</td>
                    <td className="px-4 py-3 text-sm font-medium" style={{ color: '#1a1a1a' }}>{d.diasActivo}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 rounded-full" style={{ background: '#f0f0f0' }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.min(d.avgPctKg, 100)}%`, background: colorBarra(d.avgPctKg) }} />
                        </div>
                        <span className="text-xs font-semibold whitespace-nowrap" style={{ color: colorBarra(d.avgPctKg) }}>{d.avgPctKg}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-2 rounded-full" style={{ background: '#f0f0f0' }}>
                          <div className="h-2 rounded-full" style={{ width: `${Math.min(d.avgPctPos, 100)}%`, background: colorBarra(d.avgPctPos) }} />
                        </div>
                        <span className="text-xs font-semibold whitespace-nowrap" style={{ color: colorBarra(d.avgPctPos) }}>{d.avgPctPos}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium whitespace-nowrap" style={{ color: '#1a1a1a' }}>
                      {d.totalKm > 0 ? `${d.totalKm} km` : '—'}
                    </td>
                    <td className="px-4 py-3 text-sm whitespace-nowrap" style={{ color: '#B9BBB7' }}>
                      {d.avgMinKm !== '—' ? `${d.avgMinKm} min/km` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-1 rounded-full font-semibold whitespace-nowrap" style={{ background: sem.bg, color: sem.color }}>
                        {sem.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
