'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const VUELTAS = [
  { vuelta: 1, label: 'Vuelta 1 — 8:00 a 10:00hs' },
  { vuelta: 2, label: 'Vuelta 2 — 10:00 a 12:00hs' },
  { vuelta: 3, label: 'Vuelta 3 — 13:00 a 15:00hs' },
  { vuelta: 4, label: 'Vuelta 4 — 15:00 a 17:00hs' },
]
function detectarSucursal(texto: string): string {
  const upper = texto.toUpperCase()
  if (upper.includes('520')) return 'LP520'
  if (upper.includes('139')) return 'LP139'
  if (upper.includes('GUERNICA')) return 'Guernica'
  if (upper.includes('CAÑUELAS') || upper.includes('CANUELAS')) return 'Cañuelas'
  return ''
}

// Toast simple inline
let _setToast: ((t: { msg: string; tipo: 'ok' | 'err' } | null) => void) | null = null
function toast(msg: string, tipo: 'ok' | 'err' = 'ok') {
  _setToast?.({ msg, tipo })
  setTimeout(() => _setToast?.(null), 3500)
}

export default function NuevoDespacho() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [leyendoPDF, setLeyendoPDF] = useState(false)
  const [error, setError] = useState('')
  const [exito, setExito] = useState(false)
  const [cuposDisponibles, setCuposDisponibles] = useState<number[]>([])
  const [verificando, setVerificando] = useState(false)
  const [productosNV, setProductosNV] = useState<any[]>([])
  const [pesoTotal, setPesoTotal] = useState(0)
  const [posicionesTotal, setPosicionesTotal] = useState(0)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfListo, setPdfListo] = useState(false)
  const [toastState, setToastState] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)

  const [form, setForm] = useState({
    nv: '', id_despacho: '', cliente: '', telefono: '',
    direccion: '', sucursal: '', fecha_entrega: '', vuelta: '', estado_pago: '', notas: ''
  })

  useEffect(() => { _setToast = setToastState; return () => { _setToast = null } }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => { if (!user) router.push('/') })
  }, [])

  useEffect(() => {
    if (form.sucursal && form.fecha_entrega) verificarCupos()
    else setCuposDisponibles([])
  }, [form.sucursal, form.fecha_entrega, pesoTotal, posicionesTotal])

  const verificarCupos = async () => {
    setVerificando(true)
    const disponibles: number[] = []

    const { data: flotaData } = await supabase
      .from('flota_dia').select('camion_codigo')
      .eq('fecha', form.fecha_entrega).eq('sucursal', form.sucursal).eq('activo', true)

    const codigos = (flotaData ?? []).map((f: any) => f.camion_codigo)

    if (codigos.length === 0) {
      setCuposDisponibles([1, 2, 3, 4])
      setVerificando(false)
      return
    }

    const { data: camionesData } = await supabase
      .from('camiones_flota').select('codigo, tonelaje_max_kg, posiciones_total').in('codigo', codigos)
    const camiones = camionesData ?? []

    for (const { vuelta } of VUELTAS) {
      const { data: pedidosVuelta } = await supabase
        .from('pedidos').select('camion_id, peso_total_kg, volumen_total_m3')
        .eq('sucursal', form.sucursal).eq('fecha_entrega', form.fecha_entrega)
        .eq('vuelta', vuelta).neq('estado', 'cancelado')

      const pesoAcum: Record<string, number> = {}
      const posAcum: Record<string, number> = {}
      camiones.forEach(c => { pesoAcum[c.codigo] = 0; posAcum[c.codigo] = 0 })
      ;(pedidosVuelta ?? []).forEach((p: any) => {
        if (p.camion_id) {
          pesoAcum[p.camion_id] = (pesoAcum[p.camion_id] ?? 0) + (p.peso_total_kg ?? 0)
          posAcum[p.camion_id] = (posAcum[p.camion_id] ?? 0) + (p.volumen_total_m3 ?? 0)
        }
      })

      const pesoNuevo = pesoTotal > 0 ? pesoTotal : 0
      const posNuevas = posicionesTotal > 0 ? posicionesTotal : 0
      const hayLugar = camiones.some(c => {
        if (pesoNuevo === 0 && posNuevas === 0) return true
        return (c.tonelaje_max_kg - (pesoAcum[c.codigo] ?? 0)) >= pesoNuevo &&
               (c.posiciones_total - (posAcum[c.codigo] ?? 0)) >= posNuevas
      })
      if (hayLugar) disponibles.push(vuelta)
    }

    setCuposDisponibles(disponibles)
    setVerificando(false)
  }

  const handlePDF = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPdfFile(file); setLeyendoPDF(true); setError(''); setPdfListo(false)

    const formData = new FormData()
    formData.append('pdf', file)
    try {
      const res = await fetch('/api/leer-nv', { method: 'POST', body: formData })
      const data = await res.json()
      if (!data.success) { setError('No se pudo leer el PDF.'); setLeyendoPDF(false); return }

      const { datos } = data
      const sucursal = detectarSucursal(datos.deposito || '')
      setForm(prev => ({ ...prev, nv: datos.nv || '', id_despacho: datos.id_despacho || '', cliente: datos.cliente || '', telefono: datos.telefono || '', direccion: datos.direccion || '', sucursal }))

      if (datos.productos?.length > 0) {
        const ids = datos.productos.map((p: any) => p.id_producto)
        const { data: materiales } = await supabase.from('materiales').select('*').in('id', ids)
        const productosConDatos = datos.productos.map((p: any) => {
          const material = materiales?.find((m: any) => m.id === p.id_producto)
          return { ...p, material,
            posiciones: material ? Math.ceil(p.cantidad / material.cant_x_unid_log) * material.posiciones_x_unid_log : 0,
            peso: material ? Math.ceil(p.cantidad / material.cant_x_unid_log) * material.peso_kg_x_posicion : 0,
          }
        })
        setProductosNV(productosConDatos)
        setPosicionesTotal(productosConDatos.reduce((acc: number, p: any) => acc + p.posiciones, 0))
        setPesoTotal(productosConDatos.reduce((acc: number, p: any) => acc + p.peso, 0))
      }
      setPdfListo(true)
    } catch { setError('Error al procesar el PDF.') }
    setLeyendoPDF(false)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError('')

    // Verificar duplicado
    const { data: existente } = await supabase.from('pedidos').select('id').eq('id_despacho', form.id_despacho).single()
    if (existente) { setError(`Ya existe un pedido para la solicitud ${form.id_despacho}`); setLoading(false); return }

    if (pdfFile) {
      const fileName = `${form.id_despacho || form.nv}_${Date.now()}.pdf`
      await supabase.storage.from('solicitudes-despacho').upload(fileName, pdfFile)
    }

    const { data: pedidoInsertado, error } = await supabase.from('pedidos').insert({
      nv: form.nv, id_despacho: form.id_despacho, cliente: form.cliente, telefono: form.telefono,
      direccion: form.direccion, sucursal: form.sucursal, fecha_entrega: form.fecha_entrega,
      vuelta: parseInt(form.vuelta), estado_pago: form.estado_pago, notas: form.notas,
      vendedor_id: null, estado: 'pendiente', peso_total_kg: pesoTotal, volumen_total_m3: posicionesTotal,
    }).select('id').single()

    if (error) { setError(error.message); setLoading(false); return }

    if (pedidoInsertado && productosNV.length > 0) {
      await supabase.from('pedido_items').insert(
        productosNV.map((p: any) => ({
          pedido_id: pedidoInsertado.id, codigo_material: String(p.id_producto),
          nombre: p.descripcion, cantidad: p.cantidad, unidad: p.material?.unidad_base || 'u',
        }))
      )
    }

    toast('Solicitud de despacho guardada correctamente')
    setExito(true); setLoading(false)
  }

  const resetForm = () => {
    setExito(false)
    setForm({ nv: '', id_despacho: '', cliente: '', telefono: '', direccion: '', sucursal: '', fecha_entrega: '', vuelta: '', estado_pago: '', notas: '' })
    setProductosNV([]); setPesoTotal(0); setPosicionesTotal(0); setPdfFile(null); setPdfListo(false)
  }

  const inputClass = "w-full border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 transition-colors"
  const inputStyle = { borderColor: '#e8edf8', fontFamily: 'Barlow, sans-serif' }

  if (exito) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>
      <div className="bg-white rounded-2xl shadow-lg p-10 text-center max-w-md w-full mx-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl mx-auto mb-6" style={{ background: '#d1fae5' }}>✅</div>
        <h2 className="text-2xl font-semibold mb-2" style={{ color: '#254A96' }}>Pedido cargado</h2>
        <p className="text-sm mb-8" style={{ color: '#B9BBB7' }}>La solicitud de despacho fue registrada correctamente.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={resetForm} className="px-6 py-2.5 rounded-lg text-sm font-medium text-white transition-colors" style={{ background: '#254A96' }}>
            Nuevo pedido
          </button>
          <button onClick={() => router.push('/dashboard')} className="px-6 py-2.5 rounded-lg text-sm font-medium transition-colors" style={{ background: '#f4f4f3', color: '#666' }}>
            Ir al panel
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toastState && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toastState.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toastState.tipo === 'ok' ? '✓' : '✕'} {toastState.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-3xl mx-auto px-4 md:px-6 h-14 flex items-center gap-4">
          <button onClick={() => router.push('/dashboard')}
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
            style={{ color: '#254A96', background: '#e8edf8' }}>
            ← Volver
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <div>
            <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Nueva Solicitud de Despacho</span>
          </div>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-4 md:px-6 py-6 space-y-4">

        {/* Subir PDF */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="font-semibold text-sm mb-1" style={{ color: '#254A96' }}>📄 Solicitud de Despacho</h2>
          <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>El sistema completará los datos automáticamente desde el PDF.</p>
          <label className="block w-full border-2 border-dashed rounded-xl px-4 py-6 text-center cursor-pointer transition-colors"
            style={{ borderColor: leyendoPDF ? '#254A96' : '#e8edf8', background: leyendoPDF ? '#e8edf8' : '#fafafa' }}>
            <input type="file" accept=".pdf" onChange={handlePDF} className="hidden" />
            {leyendoPDF ? (
              <div className="flex flex-col items-center gap-2">
                <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
                <span className="text-sm" style={{ color: '#254A96' }}>Leyendo PDF...</span>
              </div>
            ) : pdfListo ? (
              <div className="flex flex-col items-center gap-1">
                <span className="text-2xl">✅</span>
                <span className="text-sm font-medium" style={{ color: '#254A96' }}>PDF leído correctamente</span>
                <span className="text-xs" style={{ color: '#B9BBB7' }}>Hacé click para cambiar el archivo</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <span className="text-3xl">📄</span>
                <span className="text-sm font-medium" style={{ color: '#254A96' }}>Seleccionar PDF</span>
                <span className="text-xs" style={{ color: '#B9BBB7' }}>Arrastrá o hacé click para subir</span>
              </div>
            )}
          </label>
        </div>

        {/* Productos */}
        {productosNV.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="font-semibold text-sm mb-4" style={{ color: '#254A96' }}>📦 Productos del pedido</h2>
            <div className="space-y-2">
              {productosNV.map((p, i) => (
                <div key={i} className="flex justify-between items-center text-sm py-2 border-b last:border-0" style={{ borderColor: '#f4f4f3' }}>
                  <div>
                    <span className="font-medium" style={{ color: '#1a1a1a' }}>{p.descripcion}</span>
                    <span className="ml-2 text-xs" style={{ color: '#B9BBB7' }}>×{p.cantidad}</span>
                  </div>
                  <div className="text-right text-xs" style={{ color: '#B9BBB7' }}>
                    {p.material ? (
                      <span>{p.posiciones.toFixed(1)} pos · {(p.peso / 1000).toFixed(1)} tn</span>
                    ) : (
                      <span style={{ color: '#E52322' }}>Sin datos logísticos</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-3 flex justify-between text-sm font-semibold" style={{ borderTop: '2px solid #254A96', color: '#254A96' }}>
              <span>Total</span>
              <span>{posicionesTotal.toFixed(1)} posiciones · {(pesoTotal / 1000).toFixed(1)} toneladas</span>
            </div>
          </div>
        )}

        {/* Formulario */}
        {pdfListo && (
          <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-sm p-6 space-y-5">

            {/* Datos del PDF */}
            <div className="rounded-xl p-4 space-y-4" style={{ background: '#f4f4f3' }}>
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>Datos del PDF</p>
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Presupuesto (NV)', value: form.nv },
                  { label: 'ID Despacho', value: form.id_despacho },
                  { label: 'Cliente', value: form.cliente },
                  { label: 'Teléfono', value: form.telefono },
                ].map(f => (
                  <div key={f.label}>
                    <p className="text-xs mb-1" style={{ color: '#B9BBB7' }}>{f.label}</p>
                    <p className="font-medium text-sm" style={{ color: '#1a1a1a' }}>{f.value || '—'}</p>
                  </div>
                ))}
              </div>
              <div>
                <p className="text-xs mb-1" style={{ color: '#B9BBB7' }}>Dirección de entrega</p>
                <p className="font-medium text-sm" style={{ color: '#1a1a1a' }}>{form.direccion || '—'}</p>
              </div>
              <div>
                <p className="text-xs mb-1" style={{ color: '#B9BBB7' }}>Sucursal</p>
                {form.sucursal ? (
                  <p className="font-medium text-sm" style={{ color: '#1a1a1a' }}>{form.sucursal}</p>
                ) : (
                  <select name="sucursal" value={form.sucursal} onChange={handleChange} required
                    className={inputClass} style={inputStyle}>
                    <option value="">Seleccionar sucursal...</option>
                    <option value="LP520">LP520</option>
                    <option value="LP139">LP139</option>
                    <option value="Guernica">Guernica</option>
                    <option value="Cañuelas">Cañuelas</option>
                  </select>
                )}
              </div>
            </div>

            {/* Datos a completar */}
            <div className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>Completar</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Fecha de entrega</label>
                  <input type="date" name="fecha_entrega" value={form.fecha_entrega} onChange={handleChange} required
                    className={inputClass} style={{ ...inputStyle, focusRingColor: '#254A96' }} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Vuelta</label>
                  <select name="vuelta" value={form.vuelta} onChange={handleChange} required
                    className={inputClass} style={inputStyle} disabled={!form.fecha_entrega}>
                    <option value="">{!form.fecha_entrega ? 'Primero elegí la fecha' : verificando ? 'Verificando...' : 'Seleccionar'}</option>
                    {VUELTAS.map(({ vuelta, label }) => (
                      cuposDisponibles.includes(vuelta)
                        ? <option key={vuelta} value={vuelta}>{label}</option>
                        : <option key={vuelta} value={vuelta} disabled>{label} — Sin cupo</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Estado de pago</label>
                <select name="estado_pago" value={form.estado_pago} onChange={handleChange} required
                  className={inputClass} style={inputStyle}>
                  <option value="">Seleccionar...</option>
                  <option value="cobrado">Cobrado</option>
                  <option value="cuenta_corriente">Cuenta corriente</option>
                  <option value="pendiente_cobro">Pendiente de cobro</option>
                  <option value="provisorio">Provisorio</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Notas adicionales</label>
                <textarea name="notas" value={form.notas} onChange={handleChange} rows={3}
                  className={inputClass} style={inputStyle}
                  placeholder="Instrucciones especiales, restricciones de acceso, etc." />
              </div>
            </div>

            {error && (
              <div className="rounded-lg px-4 py-3 text-sm font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading || !form.vuelta}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
              style={{ background: loading ? '#7a90be' : '#254A96' }}>
              {loading ? 'Guardando...' : 'Confirmar solicitud de despacho'}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}