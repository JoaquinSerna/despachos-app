'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { logAuditoria } from '../lib/auditoria'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']
const VUELTAS = [
  { vuelta: 1, label: 'Primera hora (8-10hs)' },
  { vuelta: 2, label: 'Antes del mediodía (10-12hs)' },
  { vuelta: 3, label: 'Después del mediodía (13-17hs)' },
]

function detectarSucursal(sucursalObra: string, deposito: string): string {
  const obra = sucursalObra?.toUpperCase() || ''
  if (obra.includes('520') || obra.includes('LA PLATA')) return 'LP520'
  if (obra.includes('139')) return 'LP139'
  if (obra.includes('GUERNICA')) return 'Guernica'
  if (obra.includes('CAÑUELAS') || obra.includes('CANUELAS')) return 'Cañuelas'
  if (obra.includes('PINAMAR') || obra.includes('COSTA')) return 'Pinamar'
  const dep = deposito?.toUpperCase() || ''
  if (dep.includes('520')) return 'LP520'
  if (dep.includes('139')) return 'LP139'
  if (dep.includes('GUERNICA')) return 'Guernica'
  if (dep.includes('CAÑUELAS') || dep.includes('CANUELAS')) return 'Cañuelas'
  if (dep.includes('COSTA') || dep.includes('PINAMAR')) return 'Pinamar'
  return 'LP520'
}

function horarioToVuelta(horario: string): number {
  if (horario?.toLowerCase() === 'tarde') return 3
  return 1
}

interface SolicitudRaw {
  id_despacho: string
  nv: string
  cliente: string
  telefono: string
  direccion: string
  deposito: string
  sucursal_obra: string
  latitud: number | null
  longitud: number | null
  horario: string
  prioridad_texto: string
  productos: { descripcion: string; cantidad: number }[]
}

interface SolicitudEdit {
  raw: SolicitudRaw
  seleccionada: boolean
  sucursal: string
  vuelta: number
  prioridad: boolean
  duplicada: boolean
  peso_total_kg: number
  volumen_total_m3: number  // posiciones logísticas
  requiere_volcador: boolean
}

export default function CargaMasiva() {
  const router = useRouter()
  const [procesando, setProcesando] = useState(false)
  const [cargando, setCargando] = useState(false)
  const [solicitudes, setSolicitudes] = useState<SolicitudEdit[]>([])
  const [fechaEntrega, setFechaEntrega] = useState('')
  const [error, setError] = useState('')
  const [resultado, setResultado] = useState<{ insertados: number; items_ok: number; items_error_msg: string | null; errores: any[] } | null>(null)
  const [expandido, setExpandido] = useState<string | null>(null)
  const [userId, setUserId] = useState('')
  const [userNombre, setUserNombre] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      setUserId(user.id)
      const { data } = await supabase.from('usuarios').select('nombre').eq('id', user.id).single()
      setUserNombre(data?.nombre ?? '')
    })
  }, [])

  const handlePDF = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setProcesando(true)
    setError('')
    setSolicitudes([])
    setResultado(null)

    const formData = new FormData()
    formData.append('pdf', file)

    try {
      const res = await fetch('/api/leer-masivo', { method: 'POST', body: formData })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Error al procesar PDF')

      const ids = (data.solicitudes as SolicitudRaw[]).map(s => s.id_despacho)

      // Traer existentes y materiales en paralelo
      const [{ data: existentes }, { data: todosMateriales }] = await Promise.all([
        supabase.from('pedidos').select('id_despacho').in('id_despacho', ids),
        supabase.from('materiales').select('nombre, cant_x_unid_log, posiciones_x_unid_log, peso_kg_x_posicion, unidad_base'),
      ])
      const existentesSet = new Set((existentes ?? []).map((e: any) => String(e.id_despacho)))
      const materiales = todosMateriales ?? []

      // Normaliza: minúsculas, sin tildes, espacios colapsados, sin espacio antes de unidades
      const normalizar = (s: string) =>
        s.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
          .replace(/(\d),(\d)/g, '$1.$2')      // 2,4 → 2.4
          .replace(/\s*x\s*/g, 'x')           // "X 25" → "x25", "4.0 x" → "4.0x"
          .replace(/(\d)\s*(mt|kg|cm|mm|m)\b/g, '$1$2') // "4.0 MT" → "4.0mt"
          .replace(/\s+/g, ' ').trim()

      const matchMaterial = (descripcion: string) => {
        const nombre = normalizar(descripcion)
        return materiales.find((m: any) => {
          const n = normalizar(m.nombre)
          return n === nombre || n.includes(nombre) || nombre.includes(n)
        })
      }

      const MAX_BOLSAS_POR_PALLET = 60
      const calcularTotales = (productos: { descripcion: string; cantidad: number }[]) => {
        let peso = 0, posiciones = 0, totalBolsas = 0
        let requiere_volcador = false
        for (const p of productos) {
          if (p.descripcion.toLowerCase().includes('granel')) requiere_volcador = true
          const mat = matchMaterial(p.descripcion)
          if (mat) {
            const pesoUnitario = mat.cant_x_unid_log > 0 ? mat.peso_kg_x_posicion / mat.cant_x_unid_log : 0
            peso += p.cantidad * pesoUnitario
            if (mat.unidad_base === 'bolsa') {
              totalBolsas += p.cantidad
            } else {
              const unidades = Math.ceil(p.cantidad / mat.cant_x_unid_log)
              posiciones += unidades * mat.posiciones_x_unid_log
            }
          }
        }
        posiciones += Math.ceil(totalBolsas / MAX_BOLSAS_POR_PALLET)
        return { peso, posiciones, requiere_volcador }
      }

      const editables: SolicitudEdit[] = (data.solicitudes as SolicitudRaw[]).map(raw => {
        const { peso, posiciones, requiere_volcador } = calcularTotales(raw.productos)
        return {
          raw,
          seleccionada: !existentesSet.has(String(raw.id_despacho)),
          sucursal: detectarSucursal(raw.sucursal_obra, raw.deposito),
          vuelta: horarioToVuelta(raw.horario),
          prioridad: raw.prioridad_texto !== 'Normal',
          requiere_volcador,
          duplicada: existentesSet.has(String(raw.id_despacho)),
          peso_total_kg: Math.round(peso),
          volumen_total_m3: Math.round(posiciones * 10) / 10,
        }
      })

      setSolicitudes(editables)
    } catch (err: any) {
      setError(err.message)
    }
    setProcesando(false)
  }

  const toggleSeleccion = (idx: number) => {
    setSolicitudes(prev => prev.map((s, i) =>
      i === idx && !s.duplicada ? { ...s, seleccionada: !s.seleccionada } : s
    ))
  }

  const toggleTodas = () => {
    const hayAlguna = solicitudes.some(s => s.seleccionada && !s.duplicada)
    setSolicitudes(prev => prev.map(s => s.duplicada ? s : { ...s, seleccionada: !hayAlguna }))
  }

  const updateSolicitud = (idx: number, key: keyof SolicitudEdit, value: any) => {
    setSolicitudes(prev => prev.map((s, i) => i === idx ? { ...s, [key]: value } : s))
  }

  const handleCargar = async () => {
    if (!fechaEntrega) { setError('Seleccioná la fecha de entrega'); return }
    const seleccionadas = solicitudes.filter(s => s.seleccionada && !s.duplicada)
    if (seleccionadas.length === 0) { setError('No hay solicitudes seleccionadas'); return }

    setCargando(true)
    setError('')

    const pedidos = seleccionadas.map(s => ({
      id_despacho: s.raw.id_despacho,
      nv: s.raw.nv,
      cliente: s.raw.cliente,
      telefono: s.raw.telefono || '',
      direccion: s.raw.direccion,
      sucursal: s.sucursal,
      fecha_entrega: fechaEntrega,
      vuelta: s.vuelta,
      estado: 'pendiente',
      estado_pago: 'cuenta_corriente',
      prioridad: s.prioridad,
      latitud: s.raw.latitud,
      longitud: s.raw.longitud,
      notas: `Carga masiva — ${s.raw.horario}`,
      vendedor_id: null,
      peso_total_kg: s.peso_total_kg,
      volumen_total_m3: s.volumen_total_m3,
      requiere_volcador: s.requiere_volcador,
      items: s.raw.productos,
    }))

    try {
      const res = await fetch('/api/pedidos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidos }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Error al cargar')

      setResultado({ insertados: data.insertados, items_ok: data.items_ok ?? 0, items_error_msg: data.items_error_msg ?? null, errores: data.errores })
      if (userId && data.insertados > 0) {
        const sucursales = [...new Set(seleccionadas.map(s => s.sucursal))]
        logAuditoria(userId, userNombre, 'Carga masiva de pedidos', 'Carga Masiva', { cantidad: data.insertados, sucursal: sucursales.join(', '), fuente: 'pdf' })
      }
      const insertadosIds = new Set(data.resultados.map((r: any) => String(r.id_despacho)))
      setSolicitudes(prev => prev.map(s => ({
        ...s,
        duplicada: s.duplicada || insertadosIds.has(String(s.raw.id_despacho)),
        seleccionada: false,
      })))
    } catch (err: any) {
      setError(err.message)
    }
    setCargando(false)
  }

  const selCount = solicitudes.filter(s => s.seleccionada && !s.duplicada).length
  const dupCount = solicitudes.filter(s => s.duplicada).length

  return (
    <div style={{ minHeight: '100vh', background: '#f4f6fa', padding: '24px', fontFamily: 'Inter, sans-serif' }}>
      {/* Warning banner */}
      <div style={{
        background: '#fef3c7', border: '1px solid #d97706', borderRadius: 8,
        padding: '10px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8,
        color: '#92400e', fontSize: 13,
      }}>
        ⚠️ Esta función es solo para pruebas. No estará disponible en producción.
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#666', fontSize: 20 }}
        >←</button>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1a1a1a' }}>
            Carga Masiva de Solicitudes
          </h1>
          <p style={{ margin: 0, fontSize: 13, color: '#666' }}>
            Importá múltiples solicitudes de despacho desde un PDF
          </p>
        </div>
      </div>

      {/* Upload card */}
      <div style={{
        background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
        padding: 24, marginBottom: 24,
      }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600, color: '#374151' }}>
          1. Subir PDF de solicitudes
        </h2>
        <label style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          border: '2px dashed #d1d5db', borderRadius: 10, padding: '32px 20px',
          cursor: 'pointer', background: procesando ? '#f9fafb' : '#fafbfd',
          transition: 'border-color 0.2s',
        }}>
          <span style={{ fontSize: 32, marginBottom: 8 }}>📄</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: '#374151' }}>
            {procesando ? 'Procesando con IA...' : 'Hacé clic para seleccionar el PDF'}
          </span>
          <span style={{ fontSize: 12, color: '#9ca3af', marginTop: 4 }}>
            Solicitudes de Despacho Pendientes (múltiples en un solo archivo)
          </span>
          <input
            type="file"
            accept=".pdf"
            style={{ display: 'none' }}
            onChange={handlePDF}
            disabled={procesando}
          />
        </label>

        {procesando && (
          <div style={{
            marginTop: 16, padding: '12px 16px', background: '#eff6ff', borderRadius: 8,
            display: 'flex', alignItems: 'center', gap: 10, color: '#1e40af', fontSize: 13,
          }}>
            <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⏳</span>
            Analizando el PDF y extrayendo solicitudes... esto puede tardar unos segundos.
          </div>
        )}

        {error && (
          <div style={{
            marginTop: 16, padding: '12px 16px', background: '#fef2f2', borderRadius: 8,
            color: '#991b1b', fontSize: 13, border: '1px solid #fecaca',
          }}>
            ❌ {error}
          </div>
        )}
      </div>

      {/* Results */}
      {solicitudes.length > 0 && (
        <>
          {/* Config */}
          <div style={{
            background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb',
            padding: 20, marginBottom: 16,
            display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16,
          }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                2. Fecha de entrega para todos los pedidos
              </label>
              <input
                type="date"
                value={fechaEntrega}
                onChange={e => setFechaEntrega(e.target.value)}
                style={{
                  border: '1px solid #d1d5db', borderRadius: 8, padding: '8px 12px',
                  fontSize: 14, color: '#374151',
                }}
              />
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
              {dupCount > 0 && (
                <span style={{ fontSize: 13, color: '#9ca3af' }}>
                  {dupCount} ya cargados
                </span>
              )}
              <span style={{ fontSize: 13, color: '#374151' }}>
                <strong>{selCount}</strong> seleccionadas de {solicitudes.filter(s => !s.duplicada).length}
              </span>
              <button
                onClick={handleCargar}
                disabled={cargando || selCount === 0 || !fechaEntrega}
                style={{
                  background: selCount === 0 || !fechaEntrega ? '#e5e7eb' : '#254A96',
                  color: selCount === 0 || !fechaEntrega ? '#9ca3af' : '#fff',
                  border: 'none', borderRadius: 8, padding: '10px 20px',
                  fontSize: 14, fontWeight: 600, cursor: selCount === 0 || !fechaEntrega ? 'default' : 'pointer',
                }}
              >
                {cargando ? 'Cargando...' : `Cargar ${selCount} solicitud${selCount !== 1 ? 'es' : ''}`}
              </button>
            </div>
          </div>

          {/* Result banner */}
          {resultado && (
            <div style={{ marginBottom: 16 }}>
              <div style={{
                background: resultado.insertados > 0 ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${resultado.insertados > 0 ? '#86efac' : '#fecaca'}`,
                borderRadius: 8, padding: '12px 16px',
                color: resultado.insertados > 0 ? '#166534' : '#991b1b', fontSize: 13,
              }}>
                {resultado.insertados > 0 && `✅ ${resultado.insertados} solicitudes cargadas. `}
                {resultado.items_ok > 0 && <span style={{ color: '#166534' }}>📦 {resultado.items_ok} con productos cargados. </span>}
                {resultado.items_ok === 0 && resultado.insertados > 0 && <span style={{ color: '#b45309', fontWeight: 600 }}>⚠️ PRODUCTOS NO INSERTADOS{resultado.items_error_msg ? `: ${resultado.items_error_msg}` : ''} </span>}
              </div>
              {resultado.errores.filter(e => !e.error.startsWith('Ya existe')).length > 0 && (
                <div style={{
                  background: '#fef3c7', border: '1px solid #fcd34d',
                  borderRadius: 8, padding: '10px 16px', marginTop: 8,
                  color: '#92400e', fontSize: 12,
                }}>
                  ⚠️ {resultado.errores.filter(e => !e.error.startsWith('Ya existe')).length} errores:&nbsp;
                  {resultado.errores.filter(e => !e.error.startsWith('Ya existe')).slice(0, 3).map(e => `#${e.id_despacho}: ${e.error}`).join(' · ')}
                  {resultado.errores.filter(e => !e.error.startsWith('Ya existe')).length > 3 && ` · ...`}
                </div>
              )}
            </div>
          )}

          {/* Table */}
          <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
            <div style={{
              padding: '14px 20px', borderBottom: '1px solid #f3f4f6',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#374151' }}>
                3. Revisar y confirmar solicitudes extraídas
              </h2>
              <span style={{
                background: '#eff6ff', color: '#1e40af', fontSize: 12,
                padding: '2px 8px', borderRadius: 20, fontWeight: 600,
              }}>
                {solicitudes.length} solicitudes
              </span>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280', width: 40 }}>
                      <input
                        type="checkbox"
                        checked={selCount > 0 && selCount === solicitudes.filter(s => !s.duplicada).length}
                        onChange={toggleTodas}
                      />
                    </th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}># Sol.</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Cliente</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Dirección</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Sucursal</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Franja</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Prioridad</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Peso / Pos.</th>
                    <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Productos</th>
                  </tr>
                </thead>
                <tbody>
                  {solicitudes.map((s, idx) => (
                    <>
                      <tr
                        key={s.raw.id_despacho}
                        style={{
                          borderBottom: '1px solid #f3f4f6',
                          background: s.duplicada ? '#f9fafb' : s.seleccionada ? '#f0f7ff' : '#fff',
                          opacity: s.duplicada ? 0.6 : 1,
                        }}
                      >
                        <td style={{ padding: '10px 14px' }}>
                          {s.duplicada ? (
                            <span style={{ fontSize: 11, color: '#9ca3af', fontStyle: 'italic' }}>ya cargado</span>
                          ) : (
                            <input
                              type="checkbox"
                              checked={s.seleccionada}
                              onChange={() => toggleSeleccion(idx)}
                            />
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', fontWeight: 600, color: '#374151' }}>
                          #{s.raw.id_despacho}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#374151', maxWidth: 180 }}>
                          <div style={{ fontWeight: 500 }}>{s.raw.cliente}</div>
                          {s.raw.telefono && (
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.raw.telefono}</div>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', color: '#6b7280', maxWidth: 200 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.raw.direccion}
                          </div>
                          {s.raw.latitud && (
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>
                              {s.raw.latitud.toFixed(4)}, {s.raw.longitud?.toFixed(4)}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <select
                            value={s.sucursal}
                            onChange={e => updateSolicitud(idx, 'sucursal', e.target.value)}
                            disabled={s.duplicada}
                            style={{
                              border: '1px solid #d1d5db', borderRadius: 6,
                              padding: '4px 8px', fontSize: 12, color: '#374151',
                              background: s.duplicada ? '#f9fafb' : '#fff',
                            }}
                          >
                            {SUCURSALES.map(suc => (
                              <option key={suc} value={suc}>{suc}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <select
                            value={s.vuelta}
                            onChange={e => updateSolicitud(idx, 'vuelta', parseInt(e.target.value))}
                            disabled={s.duplicada}
                            style={{
                              border: '1px solid #d1d5db', borderRadius: 6,
                              padding: '4px 8px', fontSize: 12, color: '#374151',
                              background: s.duplicada ? '#f9fafb' : '#fff',
                            }}
                          >
                            {VUELTAS.map(v => (
                              <option key={v.vuelta} value={v.vuelta}>{v.label}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{
                            fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 12,
                            background: s.prioridad ? '#fef3c7' : '#f3f4f6',
                            color: s.prioridad ? '#92400e' : '#6b7280',
                          }}>
                            {s.raw.prioridad_texto}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <div style={{ fontSize: 12, color: '#374151' }}>
                            {s.peso_total_kg > 0 ? `⚖️ ${(s.peso_total_kg / 1000).toFixed(2)}tn` : <span style={{ color: '#d1d5db' }}>—</span>}
                          </div>
                          <div style={{ fontSize: 11, color: '#9ca3af' }}>
                            {s.volumen_total_m3 > 0 ? `📦 ${s.volumen_total_m3} pos.` : ''}
                          </div>
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <button
                            onClick={() => setExpandido(expandido === s.raw.id_despacho ? null : s.raw.id_despacho)}
                            style={{
                              background: 'none', border: '1px solid #e5e7eb',
                              borderRadius: 6, padding: '3px 8px', fontSize: 12,
                              cursor: 'pointer', color: '#374151',
                            }}
                          >
                            {s.raw.productos.length} items {expandido === s.raw.id_despacho ? '▲' : '▼'}
                          </button>
                        </td>
                      </tr>
                      {expandido === s.raw.id_despacho && (
                        <tr key={`${s.raw.id_despacho}-exp`} style={{ background: '#fafbfc' }}>
                          <td colSpan={8} style={{ padding: '8px 14px 12px 54px' }}>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>
                              {s.raw.productos.map((p, pi) => (
                                <span key={pi} style={{
                                  display: 'inline-block', background: '#fff',
                                  border: '1px solid #e5e7eb', borderRadius: 6,
                                  padding: '2px 8px', margin: '2px 4px 2px 0',
                                }}>
                                  {p.descripcion} × {p.cantidad}
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
