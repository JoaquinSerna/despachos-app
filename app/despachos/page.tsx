'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

// Franjas horarias para comerciales (se mapean a vueltas internas)
// Franja 3 "tarde" cubre V3+V4 — el ruteador decide la vuelta exacta
const FRANJAS = [
  { vuelta: 1, label: 'Primera hora', horario: '8:00 a 10:00hs' },
  { vuelta: 2, label: 'Antes del mediodía', horario: '10:00 a 12:00hs' },
  { vuelta: 3, label: 'Después del mediodía', horario: '13:00 a 17:00hs' },
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
  return ''
}

let _setToast: ((t: { msg: string; tipo: 'ok' | 'err' } | null) => void) | null = null
function toast(msg: string, tipo: 'ok' | 'err' = 'ok') {
  _setToast?.({ msg, tipo })
  setTimeout(() => _setToast?.(null), 3500)
}

const ESTADO_LABEL: Record<string, string> = {
  pendiente: 'Pendiente', programado: 'Programado', en_camino: 'En camino',
  entregado: 'Entregado', cancelado: 'Cancelado',
}
const ESTADO_COLOR: Record<string, string> = {
  pendiente: '#f59e0b', programado: '#254A96', en_camino: '#10b981',
  entregado: '#B9BBB7', cancelado: '#E52322',
}

const FORM_INICIAL = {
  nv: '', id_despacho: '', cliente: '', telefono: '',
  direccion: '', sucursal: '', fecha_entrega: '', vuelta: '',
  estado_pago: '', notas: '',
  barrio_cerrado: false,
  latitud: null as number | null,
  longitud: null as number | null,
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
  const [form, setForm] = useState(FORM_INICIAL)
  const [userId, setUserId] = useState<string | null>(null)
  const [misPedidos, setMisPedidos] = useState<any[]>([])
  const [cargandoPedidos, setCargandoPedidos] = useState(false)
  const [pedidoReprog, setPedidoReprog] = useState<any | null>(null)
  const [reprogFecha, setReprogFecha] = useState('')
  const [reprogVuelta, setReprogVuelta] = useState(1)
  const [reprogMotivo, setReprogMotivo] = useState('')
  const [linkMaps, setLinkMaps] = useState('')
  const [linkMapsOk, setLinkMapsOk] = useState<boolean | null>(null)

  useEffect(() => { _setToast = setToastState; return () => { _setToast = null } }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => { if (!user) router.push('/'); else setUserId(user.id) })
  }, [])

  useEffect(() => {
    cargarMisPedidos()
  }, [])

  useEffect(() => {
    if (form.sucursal && form.fecha_entrega) verificarCupos()
    else setCuposDisponibles([])
  }, [form.sucursal, form.fecha_entrega, pesoTotal, posicionesTotal])

  async function cargarMisPedidos() {
    setCargandoPedidos(true)
    const { data } = await supabase.from('pedidos')
      .select('id, nv, cliente, direccion, sucursal, fecha_entrega, vuelta, estado, notas')
      .in('estado', ['pendiente', 'programado', 'en_camino'])
      .order('fecha_entrega', { ascending: true })
    setMisPedidos(data ?? [])
    setCargandoPedidos(false)
  }

  async function patchPedido(id: string, updates: Record<string, any>) {
    const res = await fetch('/api/pedidos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, ...updates }) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Error desconocido')
  }

  async function handleCancelarPedido(id: string, cliente: string) {
    try {
      const res = await fetch('/api/pedidos', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error desconocido')
      await cargarMisPedidos()
      toast(`Pedido de ${cliente} eliminado`)
    } catch (e: any) { toast(`Error: ${e.message}`, 'err') }
  }

  async function handleReprogramarPedido(id: string, fecha: string, vuelta: number, motivo: string) {
    const pedido = misPedidos.find(p => p.id === id)
    if (!pedido) return
    const nota = `⚡ Reprogramado desde ${pedido.fecha_entrega} V${pedido.vuelta}${motivo ? ` — ${motivo}` : ''}`
    const notaFinal = pedido.notas ? `${pedido.notas} | ${nota}` : nota
    try {
      await patchPedido(id, { fecha_entrega: fecha, vuelta, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: notaFinal })
      setPedidoReprog(null)
      await cargarMisPedidos()
      toast(`Pedido de ${pedido.cliente} reprogramado para el ${fecha}`)
    } catch (e: any) { toast(`Error: ${e.message}`, 'err') }
  }

  const verificarCupos = async () => {
    setVerificando(true)
    const disponibles: number[] = []

    const { data: flotaData } = await supabase
      .from('flota_dia').select('camion_codigo')
      .eq('fecha', form.fecha_entrega).eq('sucursal', form.sucursal).eq('activo', true)

    const codigos = (flotaData ?? []).map((f: any) => f.camion_codigo)

    if (codigos.length === 0) {
      setCuposDisponibles([])
      setVerificando(false)
      return
    }

    const { data: camionesData } = await supabase
      .from('camiones_flota').select('codigo, tonelaje_max_kg, posiciones_total').in('codigo', codigos)
    const camiones = camionesData ?? []

    const pesoTotalFlota = camiones.reduce((a, c) => a + c.tonelaje_max_kg, 0)
    const posTotalFlota = camiones.reduce((a, c) => a + c.posiciones_total, 0)
    const pesoNuevo = pesoTotal > 0 ? pesoTotal : 0
    const posNuevas = posicionesTotal > 0 ? posicionesTotal : 0

    for (const { vuelta } of FRANJAS) {
      // Franja "tarde" (3) cubre V3 y V4 combinadas
      const vueltas = vuelta === 3 ? [3, 4] : [vuelta]
      let pesoUsado = 0; let posUsadas = 0
      for (const v of vueltas) {
        const { data: pv } = await supabase
          .from('pedidos').select('peso_total_kg, volumen_total_m3')
          .eq('sucursal', form.sucursal).eq('fecha_entrega', form.fecha_entrega)
          .eq('vuelta', v).neq('estado', 'cancelado')
        pesoUsado += (pv ?? []).reduce((a: number, p: any) => a + (p.peso_total_kg ?? 0), 0)
        posUsadas += (pv ?? []).reduce((a: number, p: any) => a + (p.volumen_total_m3 ?? 0), 0)
      }

      const LIMITE = 0.85
      const pesoPct = pesoTotalFlota > 0 ? pesoUsado / pesoTotalFlota : 0
      const posPct = posTotalFlota > 0 ? posUsadas / posTotalFlota : 0
      const ocupacionOk = pesoPct < LIMITE && posPct < LIMITE
      const capeOk = pesoNuevo === 0 && posNuevas === 0
        ? true
        : (pesoTotalFlota - pesoUsado) >= pesoNuevo && (posTotalFlota - posUsadas) >= posNuevas
      if (ocupacionOk && capeOk) disponibles.push(vuelta)
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
      const sucursal = detectarSucursal(datos.sucursal_obra || '', datos.deposito || '')
      setForm(prev => ({
        ...prev,
        nv: datos.nv || '',
        id_despacho: datos.id_despacho || '',
        cliente: datos.cliente || '',
        telefono: datos.telefono || '',
        direccion: datos.direccion || '',
        sucursal,
        latitud: datos.latitud ?? null,
        longitud: datos.longitud ?? null,
      }))

      if (datos.productos?.length > 0) {
  const { data: todosMateriales } = await supabase
    .from('materiales')
    .select('*')

  const normalizar = (s: string) =>
    s.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/(\d),(\d)/g, '$1.$2')
      .replace(/\s*x\s*/g, 'x')
      .replace(/(\d)\s*(mt|kg|cm|mm|m)\b/g, '$1$2')
      .replace(/\s+/g, ' ').trim()

  const productosConDatos = datos.productos.map((p: any) => {
    const nombrePDF = normalizar(p.descripcion)
    // Preferir el match más específico (nombre más largo)
    const candidatos = (todosMateriales ?? []).filter((m: any) => {
      const nombreTabla = normalizar(m.nombre)
      return nombreTabla === nombrePDF ||
             nombreTabla.includes(nombrePDF) ||
             nombrePDF.includes(nombreTabla)
    }).sort((a: any, b: any) => b.nombre.length - a.nombre.length)
    const material = candidatos[0] ?? null
    const pesoUnitario = material && material.cant_x_unid_log > 0
      ? material.peso_kg_x_posicion / material.cant_x_unid_log : 0
    const posiciones = material && material.cant_x_unid_log > 0
      ? Math.ceil(p.cantidad / material.cant_x_unid_log) * material.posiciones_x_unid_log : 0
    return { ...p, material, posiciones, peso: material ? p.cantidad * pesoUnitario : 0 }
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
    const { name, value, type } = e.target
    setForm(prev => ({ ...prev, [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError('')

    const { data: existente } = await supabase.from('pedidos').select('id').eq('id_despacho', form.id_despacho).single()
    if (existente) { setError(`Ya existe un pedido para la solicitud ${form.id_despacho}`); setLoading(false); return }

    if (pdfFile) {
      const fileName = `${form.id_despacho || form.nv}_${Date.now()}.pdf`
      await supabase.storage.from('solicitudes-despacho').upload(fileName, pdfFile)
    }

    const { data: pedidoInsertado, error } = await supabase.from('pedidos').insert({
      nv: form.nv,
      id_despacho: form.id_despacho,
      cliente: form.cliente,
      telefono: form.telefono,
      direccion: form.direccion,
      sucursal: form.sucursal,
      fecha_entrega: form.fecha_entrega,
      vuelta: parseInt(form.vuelta),
      estado_pago: form.estado_pago,
      barrio_cerrado: form.barrio_cerrado,
      notas: form.notas,
      vendedor_id: userId,
      estado: 'pendiente',
      peso_total_kg: pesoTotal,
      volumen_total_m3: posicionesTotal,
      latitud: form.latitud,
      longitud: form.longitud,
    }).select('id').single()

    if (error) { setError(error.message); setLoading(false); return }

    if (pedidoInsertado && productosNV.length > 0) {
      await supabase.from('pedido_items').insert(
        productosNV.map((p: any) => ({
          pedido_id: pedidoInsertado.id,
          codigo_material: String(p.id_producto),
          nombre: p.descripcion,
          cantidad: p.cantidad,
          unidad: p.material?.unidad_base || 'u',
        }))
      )
    }

    toast('Solicitud de despacho guardada correctamente')
    setExito(true); setLoading(false)
  }

  const resetForm = () => {
    setExito(false)
    setForm(FORM_INICIAL)
    setProductosNV([])
    setPesoTotal(0)
    setPosicionesTotal(0)
    setPdfFile(null)
    setPdfListo(false)
  }

  const parsearLinkMaps = (url: string) => {
    // Patrones: /@lat,lng,zoom  |  ?q=lat,lng  |  ll=lat,lng
    const patrones = [
      /@(-?\d+\.\d+),(-?\d+\.\d+)/,
      /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
      /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    ]
    for (const re of patrones) {
      const m = url.match(re)
      if (m) {
        const lat = parseFloat(m[1]), lng = parseFloat(m[2])
        // Intentar extraer nombre del lugar desde /place/NOMBRE/@...
        const placeMatch = url.match(/\/place\/([^/@]+)/)
        const direccionMaps = placeMatch
          ? decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).replace(/,.*/, '').trim()
          : null
        return { lat, lng, direccion: direccionMaps }
      }
    }
    return null
  }

  const handleLinkMaps = (url: string) => {
    setLinkMaps(url)
    if (!url.trim()) { setLinkMapsOk(null); return }
    const resultado = parsearLinkMaps(url)
    if (resultado) {
      setForm(prev => ({
        ...prev,
        latitud: resultado.lat,
        longitud: resultado.lng,
        ...(resultado.direccion ? { direccion: resultado.direccion } : {}),
      }))
      setLinkMapsOk(true)
    } else {
      setLinkMapsOk(false)
    }
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
          <button onClick={resetForm} className="px-6 py-2.5 rounded-lg text-sm font-medium text-white" style={{ background: '#254A96' }}>
            Nuevo pedido
          </button>
          <button onClick={() => router.push('/dashboard')} className="px-6 py-2.5 rounded-lg text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>
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
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
            style={{ color: '#254A96', background: '#e8edf8' }}>
            ← Volver
          </button>
          <div className="w-px h-5 bg-gray-200" />
          <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Nueva Solicitud de Despacho</span>
        </div>
      </nav>

      {/* Modal reprogramar */}
      {pedidoReprog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <h3 className="font-semibold text-sm mb-1" style={{ color: '#254A96' }}>📅 Reprogramar entrega</h3>
            <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>{pedidoReprog.cliente} · {pedidoReprog.direccion}</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nueva fecha</label>
                <input type="date" value={reprogFecha}
                  min={(() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0] })()}
                  onChange={e => setReprogFecha(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Vuelta</label>
                <select value={reprogVuelta} onChange={e => setReprogVuelta(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
                  {[1, 2, 3, 4].map(v => <option key={v} value={v}>Vuelta {v}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Motivo</label>
                <input type="text" value={reprogMotivo} onChange={e => setReprogMotivo(e.target.value)}
                  placeholder="Ej: lluvia, cliente no disponible"
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button disabled={!reprogFecha}
                onClick={() => handleReprogramarPedido(pedidoReprog.id, reprogFecha, reprogVuelta, reprogMotivo)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: '#254A96' }}>Confirmar</button>
              <button onClick={() => setPedidoReprog(null)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

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
                ].map(f => (
                  <div key={f.label}>
                    <p className="text-xs mb-1" style={{ color: '#B9BBB7' }}>{f.label}</p>
                    <p className="font-medium text-sm" style={{ color: '#1a1a1a' }}>{f.value || '—'}</p>
                  </div>
                ))}
                <div>
                  <label className="block text-xs mb-1" style={{ color: '#B9BBB7' }}>
                    Teléfono <span style={{ color: '#E52322' }}>*</span>
                  </label>
                  <input type="tel" name="telefono" value={form.telefono} onChange={handleChange} required
                    placeholder="Teléfono del cliente"
                    className={inputClass} style={{ ...inputStyle, background: 'white' }} />
                </div>
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: '#B9BBB7' }}>Dirección de entrega</label>
                <input type="text" name="direccion" value={form.direccion} onChange={handleChange}
                  placeholder="Dirección de entrega"
                  className={inputClass} style={{ ...inputStyle, background: 'white' }} />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: '#B9BBB7' }}>
                  Link de Google Maps <span style={{ color: '#B9BBB7', fontWeight: 400 }}>(opcional — actualiza coordenadas)</span>
                </label>
                <div className="relative">
                  <input type="url" value={linkMaps}
                    onChange={e => handleLinkMaps(e.target.value)}
                    placeholder="https://maps.google.com/..."
                    className={inputClass}
                    style={{ ...inputStyle, background: 'white', paddingRight: '2rem',
                      borderColor: linkMapsOk === true ? '#10b981' : linkMapsOk === false ? '#E52322' : '#e8edf8' }} />
                  {linkMapsOk === true && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: '#10b981' }}>✓</span>}
                  {linkMapsOk === false && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: '#E52322' }}>✕</span>}
                </div>
                {linkMapsOk === false && <p className="text-xs mt-1" style={{ color: '#E52322' }}>No se encontraron coordenadas en el link</p>}
              </div>
              {form.latitud && form.longitud && (
                <div>
                  <p className="text-xs mb-1" style={{ color: '#B9BBB7' }}>Coordenadas</p>
                  <p className="font-medium text-sm" style={{ color: '#1a1a1a' }}>{form.latitud}, {form.longitud}</p>
                </div>
              )}
              <div>
                <label className="block text-xs mb-1" style={{ color: '#B9BBB7' }}>Sucursal</label>
                <select name="sucursal" value={form.sucursal} onChange={handleChange} required
                  className={inputClass} style={inputStyle}>
                  <option value="">Seleccionar sucursal...</option>
                  <option value="LP520">LP520</option>
                  <option value="LP139">LP139</option>
                  <option value="Guernica">Guernica</option>
                  <option value="Cañuelas">Cañuelas</option>
                  <option value="Pinamar">Pinamar</option>
                </select>
              </div>
            </div>

            {/* Datos a completar */}
            <div className="space-y-4">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>Completar</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Fecha de entrega</label>
                  <input type="date" name="fecha_entrega" value={form.fecha_entrega} onChange={handleChange} required
                    className={inputClass} style={inputStyle} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Franja horaria</label>
                  <select name="vuelta" value={form.vuelta} onChange={handleChange} required
                    className={inputClass} style={inputStyle} disabled={!form.fecha_entrega}>
                    <option value="">{!form.fecha_entrega ? 'Primero elegí la fecha' : verificando ? 'Verificando...' : 'Seleccionar'}</option>
                    {FRANJAS.map(({ vuelta, label, horario }) => (
                      cuposDisponibles.includes(vuelta)
                        ? <option key={vuelta} value={vuelta}>{label} — {horario}</option>
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

              <label className="flex items-center gap-3 cursor-pointer py-2.5 px-4 rounded-lg border"
                style={{ borderColor: form.barrio_cerrado ? '#254A96' : '#e8edf8', background: form.barrio_cerrado ? '#e8edf8' : 'white' }}>
                <input type="checkbox" name="barrio_cerrado" checked={form.barrio_cerrado} onChange={handleChange} className="w-4 h-4 accent-blue-700" />
                <div>
                  <p className="text-sm font-medium" style={{ color: '#254A96' }}>🔒 Barrio cerrado</p>
                  <p className="text-xs" style={{ color: '#B9BBB7' }}>El acceso requiere autorización o control de ingreso</p>
                </div>
              </label>

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