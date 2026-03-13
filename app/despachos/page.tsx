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

const SUCURSAL_MAP: { [key: string]: string } = {
  '520': 'LP520',
  '139': 'LP139',
  'GUERNICA': 'Guernica',
  'CAÑUELAS': 'Cañuelas',
  'CANUELAS': 'Cañuelas',
}

function detectarSucursal(texto: string): string {
  const upper = texto.toUpperCase()
  if (upper.includes('520')) return 'LP520'
  if (upper.includes('139')) return 'LP139'
  if (upper.includes('GUERNICA')) return 'Guernica'
  if (upper.includes('CAÑUELAS') || upper.includes('CANUELAS')) return 'Cañuelas'
  return ''
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

  const [form, setForm] = useState({
    nv: '',
    id_despacho: '',
    cliente: '',
    telefono: '',
    direccion: '',
    sucursal: '',
    fecha_entrega: '',
    vuelta: '',
    estado_pago: '',
    notas: ''
  })

  useEffect(() => {
    const checkUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) router.push('/')
    }
    checkUser()
  }, [])

  useEffect(() => {
    if (form.sucursal && form.fecha_entrega) {
      verificarCupos()
    } else {
      setCuposDisponibles([])
    }
  }, [form.sucursal, form.fecha_entrega])

  const verificarCupos = async () => {
    setVerificando(true)
    const disponibles: number[] = []

    for (const { vuelta } of VUELTAS) {
      const { count } = await supabase
        .from('pedidos')
        .select('*', { count: 'exact', head: true })
        .eq('sucursal', form.sucursal)
        .eq('fecha_entrega', form.fecha_entrega)
        .eq('vuelta', vuelta)
        .neq('estado', 'reprogramado')

      const { data: cupo } = await supabase
        .from('cupos')
        .select('camiones_disponibles, pedidos_max_por_camion')
        .eq('sucursal', form.sucursal)
        .eq('fecha', form.fecha_entrega)
        .eq('vuelta', vuelta)
        .single()

      const max = cupo ? cupo.camiones_disponibles * cupo.pedidos_max_por_camion : 6
      if ((count || 0) < max) disponibles.push(vuelta)
    }

    setCuposDisponibles(disponibles)
    setVerificando(false)
  }

  const handlePDF = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setPdfFile(file)
    setLeyendoPDF(true)
    setError('')
    setPdfListo(false)

    const formData = new FormData()
    formData.append('pdf', file)

    try {
      const res = await fetch('/api/leer-nv', {
        method: 'POST',
        body: formData
      })
      const data = await res.json()

      if (!data.success) {
        setError('No se pudo leer el PDF.')
        setLeyendoPDF(false)
        return
      }

      const { datos } = data
      const sucursal = detectarSucursal(datos.deposito || '')

      setForm(prev => ({
        ...prev,
        nv: datos.nv || '',
        id_despacho: datos.id_despacho || '',
        cliente: datos.cliente || '',
        telefono: datos.telefono || '',
        direccion: datos.direccion || '',
        sucursal: sucursal,
      }))

      // Buscar productos en materiales
      if (datos.productos?.length > 0) {
        const ids = datos.productos.map((p: any) => p.id_producto)
        const { data: materiales } = await supabase
          .from('materiales')
          .select('*')
          .in('id', ids)

        const productosConDatos = datos.productos.map((p: any) => {
          const material = materiales?.find((m: any) => m.id === p.id_producto)
          return {
            ...p,
            material,
            posiciones: material ? Math.ceil(p.cantidad / material.cant_x_unid_log) * material.posiciones_x_unid_log : 0,
            peso: material ? Math.ceil(p.cantidad / material.cant_x_unid_log) * material.peso_kg_x_posicion : 0,
          }
        })

        setProductosNV(productosConDatos)
        const totalPos = productosConDatos.reduce((acc: number, p: any) => acc + p.posiciones, 0)
        const totalPeso = productosConDatos.reduce((acc: number, p: any) => acc + p.peso, 0)
        setPosicionesTotal(totalPos)
        setPesoTotal(totalPeso)
      }

      setPdfListo(true)
    } catch (err) {
      setError('Error al procesar el PDF.')
    }

    setLeyendoPDF(false)
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault()
  setLoading(true)
  setError('')

  // Subir PDF a Storage
  let pdf_url = null
  if (pdfFile) {
    const fileName = `${form.id_despacho || form.nv}_${Date.now()}.pdf`
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('solicitudes-despacho')
      .upload(fileName, pdfFile)

    if (uploadError) {
      console.error('Error subiendo PDF:', uploadError)
    } else {
      pdf_url = uploadData?.path
    }
  }

  // Insertar pedido
  const { data: pedidoInsertado, error } = await supabase
    .from('pedidos')
    .insert({
      nv: form.nv,
      id_despacho: form.id_despacho,
      cliente: form.cliente,
      telefono: form.telefono,
      direccion: form.direccion,
      sucursal: form.sucursal,
      fecha_entrega: form.fecha_entrega,
      vuelta: parseInt(form.vuelta),
      estado_pago: form.estado_pago,
      notas: form.notas,
      vendedor_id: null,
      estado: 'pendiente',
      peso_total_kg: pesoTotal,
      volumen_total_m3: posicionesTotal,
    })
    .select('id')
    .single()

  if (error) {
    setError(error.message)
    setLoading(false)
    return
  }

  // Insertar productos en pedido_items
  if (pedidoInsertado && productosNV.length > 0) {
    const items = productosNV.map((p: any) => ({
      pedido_id: pedidoInsertado.id,
      codigo_material: String(p.id_producto),
      nombre: p.descripcion,
      cantidad: p.cantidad,
      unidad: p.material?.unidad_base || 'u',
    }))

    const { error: itemsError } = await supabase
      .from('pedido_items')
      .insert(items)

    if (itemsError) {
      console.error('Error guardando productos:', itemsError)
      // No bloqueamos — el pedido ya se guardó
    }
  }

  setExito(true)
  setLoading(false)
}

  if (exito) return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow p-8 text-center max-w-md">
        <div className="text-5xl mb-4">✅</div>
        <h2 className="text-2xl font-bold text-gray-800 mb-2">Pedido cargado</h2>
        <p className="text-gray-500 mb-6">La solicitud de despacho fue registrada correctamente.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={() => {
            setExito(false)
            setForm({ nv: '', id_despacho: '', cliente: '', telefono: '', direccion: '', sucursal: '', fecha_entrega: '', vuelta: '', estado_pago: '', notas: '' })
            setProductosNV([])
            setPesoTotal(0)
            setPosicionesTotal(0)
            setPdfFile(null)
            setPdfListo(false)
          }} className="bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition">
            Nuevo pedido
          </button>
          <button onClick={() => router.push('/dashboard')} className="bg-gray-200 text-gray-700 px-6 py-2 rounded-lg hover:bg-gray-300 transition">
            Ir al panel
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow px-6 py-4 flex justify-between items-center">
        <h1 className="text-xl font-bold text-gray-800">Nueva Solicitud de Despacho</h1>
        <button onClick={() => router.push('/dashboard')} className="text-gray-500 hover:text-gray-700 text-sm">
          ← Volver al panel
        </button>
      </nav>

      <main className="p-6 max-w-2xl mx-auto space-y-4">

        {/* Lector de PDF */}
        <div className="bg-white rounded-xl shadow p-6">
          <h2 className="text-lg font-semibold text-gray-700 mb-1">📄 Subir Solicitud de Despacho</h2>
          <p className="text-sm text-gray-500 mb-4">El sistema completará los datos automáticamente desde el PDF.</p>
          <input
            type="file"
            accept=".pdf"
            onChange={handlePDF}
            className="w-full border border-dashed border-gray-300 rounded-lg px-4 py-3 text-sm text-gray-600 cursor-pointer hover:border-blue-400 transition"
          />
          {leyendoPDF && (
            <div className="mt-3 flex items-center gap-2 text-blue-500 text-sm">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Leyendo PDF...
            </div>
          )}
          {pdfListo && !leyendoPDF && (
            <p className="mt-2 text-green-600 text-sm">✓ PDF leído correctamente</p>
          )}
        </div>

        {/* Productos detectados */}
        {productosNV.length > 0 && (
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold text-gray-700 mb-3">📦 Productos del pedido</h2>
            <div className="space-y-2">
              {productosNV.map((p, i) => (
                <div key={i} className="flex justify-between items-center text-sm border-b pb-2">
                  <div>
                    <span className="font-medium">{p.descripcion}</span>
                    <span className="text-gray-400 ml-2">x{p.cantidad}</span>
                  </div>
                  <div className="text-right text-gray-500">
                    {p.material ? (
                      <>
                        <span>{p.posiciones.toFixed(1)} pos</span>
                        <span className="ml-2">{(p.peso / 1000).toFixed(1)} tn</span>
                      </>
                    ) : (
                      <span className="text-orange-400">Sin datos logísticos</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t flex justify-between font-semibold text-sm">
              <span>Total del pedido</span>
              <span>{posicionesTotal.toFixed(1)} posiciones — {(pesoTotal / 1000).toFixed(1)} toneladas</span>
            </div>
          </div>
        )}

        {/* Formulario */}
        {pdfListo && (
          <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow p-6 space-y-4">

            {/* Datos del PDF — solo lectura */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Datos del PDF — no editables</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Presupuesto (NV)</label>
                  <p className="font-medium text-gray-800">{form.nv || '—'}</p>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">ID Despacho</label>
                  <p className="font-medium text-gray-800">{form.id_despacho || '—'}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Cliente</label>
                  <p className="font-medium text-gray-800">{form.cliente || '—'}</p>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Teléfono</label>
                  <p className="font-medium text-gray-800">{form.telefono || '—'}</p>
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Dirección de entrega</label>
                <p className="font-medium text-gray-800">{form.direccion || '—'}</p>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Sucursal</label>
                <p className="font-medium text-gray-800">{form.sucursal || '—'}</p>
              </div>
            </div>

            {/* Datos a completar por el vendedor */}
            <div className="space-y-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Completar</p>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Fecha de entrega</label>
                  <input type="date" name="fecha_entrega" value={form.fecha_entrega} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Vuelta</label>
                  <select name="vuelta" value={form.vuelta} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" disabled={!form.fecha_entrega}>
                    <option value="">{!form.fecha_entrega ? 'Primero elegí la fecha' : verificando ? 'Verificando cupos...' : 'Seleccionar vuelta'}</option>
                    {VUELTAS.map(({ vuelta, label }) => (
                      cuposDisponibles.includes(vuelta)
                        ? <option key={vuelta} value={vuelta}>{label}</option>
                        : <option key={vuelta} value={vuelta} disabled>{label} — SIN CUPO</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estado de pago</label>
                <select name="estado_pago" value={form.estado_pago} onChange={handleChange} required className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="">Seleccionar...</option>
                  <option value="cobrado">Cobrado</option>
                  <option value="cuenta_corriente">Cuenta corriente</option>
                  <option value="pendiente_cobro">Pendiente de cobro</option>
                  <option value="provisorio">Provisorio</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notas adicionales</label>
                <textarea name="notas" value={form.notas} onChange={handleChange} className="w-full border border-gray-300 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" rows={3} placeholder="Instrucciones especiales, restricciones de acceso, etc." />
              </div>
            </div>

            {error && <p className="text-red-500 text-sm">{error}</p>}

            <button type="submit" disabled={loading || !form.vuelta} className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 transition disabled:opacity-50">
              {loading ? 'Guardando...' : 'Confirmar solicitud de despacho'}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}