'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { puedeEditar } from '../lib/permisos'
import { FRANJAS, vultaCerrada, vueltasCerradasPara } from '../lib/franjas'
import { logAuditoria } from '../lib/auditoria'

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
  const [vueltasSinCupoConFlota, setVueltasSinCupoConFlota] = useState<number[]>([])
  const [vueltasCerradas, setVueltasCerradas] = useState<number[]>([])
  const [flotaSinRevisar, setFlotaSinRevisar] = useState(false)
  const [maxCamionPosiciones, setMaxCamionPosiciones] = useState(0)
  const [pedidoGrande, setPedidoGrande] = useState(false)
  const [verificando, setVerificando] = useState(false)
  const [productosNV, setProductosNV] = useState<any[]>([])
  const [pesoTotal, setPesoTotal] = useState(0)
  const [posicionesTotal, setPosicionesTotal] = useState(0)
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [pdfListo, setPdfListo] = useState(false)
  const [toastState, setToastState] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [form, setForm] = useState(FORM_INICIAL)
  const [userId, setUserId] = useState<string | null>(null)
  const [userNombre, setUserNombre] = useState('')
  const [misPedidos, setMisPedidos] = useState<any[]>([])
  const [cargandoPedidos, setCargandoPedidos] = useState(false)
  const [pedidoReprog, setPedidoReprog] = useState<any | null>(null)
  const [reprogFecha, setReprogFecha] = useState('')
  const [reprogVuelta, setReprogVuelta] = useState(1)
  const [reprogMotivo, setReprogMotivo] = useState('')
  const reprogVueltasCerradas = vueltasCerradasPara(reprogFecha)
  const [linkMaps, setLinkMaps] = useState('')
  const [linkMapsOk, setLinkMapsOk] = useState<boolean | null>(null)
  const [puedeEditarDespachos, setPuedeEditarDespachos] = useState(false)
  const [tabActivo, setTabActivo] = useState<'despacho' | 'retiro'>('despacho')

  // ── Retiro state ──────────────────────────────────────────
  const RETIRO_FORM_INICIAL = { cliente: '', telefono: '', direccion: '', sucursal: '', fecha_estimada: '', notas: '' }
  const [formRetiro, setFormRetiro] = useState(RETIRO_FORM_INICIAL)
  const [itemsRetiro, setItemsRetiro] = useState<{ nombre_producto: string; cantidad: number; id_producto: number | null; _codigo?: string; _encontrado?: boolean; _noEncontrado?: boolean }[]>(
    [{ nombre_producto: '', cantidad: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }]
  )
  const [loadingRetiro, setLoadingRetiro] = useState(false)
  const [exitoRetiro, setExitoRetiro] = useState(false)
  const [errorRetiro, setErrorRetiro] = useState('')
  const [linkMapsRetiro, setLinkMapsRetiro] = useState('')
  const [linkMapsRetiroOk, setLinkMapsRetiroOk] = useState<boolean | null>(null)
  const [latRetiro, setLatRetiro] = useState<number | null>(null)
  const [lngRetiro, setLngRetiro] = useState<number | null>(null)

  useEffect(() => { _setToast = setToastState; return () => { _setToast = null } }, [])

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      setUserId(user.id)
      supabase.from('usuarios').select('rol, permisos, nombre').eq('id', user.id).single().then(({ data }) => {
        if (data) {
          setPuedeEditarDespachos(puedeEditar(data.permisos, data.rol, 'despachos'))
          setUserNombre(data.nombre ?? '')
        }
      })
    })
  }, [])

  useEffect(() => {
    cargarMisPedidos()
  }, [])

  useEffect(() => {
    if (form.sucursal && form.fecha_entrega) verificarCupos()
    else { setCuposDisponibles([]); setVueltasCerradas([]) }
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
    const pedido = misPedidos.find(p => p.id === id)
    try {
      const res = await fetch('/api/pedidos', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Error desconocido')
      await cargarMisPedidos()
      toast(`Pedido de ${cliente} eliminado`)
      if (userId) logAuditoria(userId, userNombre, 'Canceló pedido', 'Despachos', { nv: pedido?.nv, cliente, sucursal: pedido?.sucursal })
    } catch (e: any) { toast(`Error: ${e.message}`, 'err') }
  }

  async function handleReprogramarPedido(id: string, fecha: string, vuelta: number, motivo: string) {
    const pedido = misPedidos.find(p => p.id === id)
    if (!pedido) return
    // Validar cutoff — mismas restricciones que cargar un pedido nuevo
    const franja = FRANJAS.find(f => f.vuelta === vuelta)
    if (franja && vultaCerrada(fecha, franja)) {
      toast('Esta vuelta ya cerró para esa fecha. Elegí una franja disponible.', 'err')
      return
    }
    const nota = `⚡ Reprogramado desde ${pedido.fecha_entrega} V${pedido.vuelta}${motivo ? ` — ${motivo}` : ''}`
    const notaFinal = pedido.notas ? `${pedido.notas} | ${nota}` : nota
    try {
      await patchPedido(id, { fecha_entrega: fecha, vuelta, camion_id: null, orden_entrega: null, estado: 'pendiente', notas: notaFinal })
      setPedidoReprog(null)
      await cargarMisPedidos()
      toast(`Pedido de ${pedido.cliente} reprogramado para el ${fecha}`)
      if (userId) logAuditoria(userId, userNombre, 'Reprogramó pedido', 'Despachos', { nv: pedido.nv, cliente: pedido.cliente, fecha_nueva: fecha, vuelta_nueva: vuelta, motivo })
    } catch (e: any) { toast(`Error: ${e.message}`, 'err') }
  }

  const verificarCupos = async () => {
    setVerificando(true)
    const disponibles: number[] = []
    const sinCupoConFlota: number[] = []

    // Calcular vueltas cerradas por horario
    const cerradas = FRANJAS.filter(f => vultaCerrada(form.fecha_entrega, f)).map(f => f.vuelta)
    setVueltasCerradas(cerradas)
    // Si todas las vueltas cerraron, auto-seleccionar "fuera de programación"
    if (cerradas.length === FRANJAS.length) {
      setForm(prev => ({ ...prev, vuelta: 'fuera_prog' }))
    } else if (form.vuelta && form.vuelta !== 'fuera_prog') {
      // Si la vuelta ya seleccionada quedó cerrada, resetearla
      const vueltaSeleccionada = parseInt(form.vuelta)
      if (!isNaN(vueltaSeleccionada) && cerradas.includes(vueltaSeleccionada)) {
        setForm(prev => ({ ...prev, vuelta: '' }))
      }
    }

    const { data: flotaData } = await supabase
      .from('flota_dia').select('camion_codigo, revisado')
      .eq('fecha', form.fecha_entrega).eq('sucursal', form.sucursal).eq('activo', true)

    let codigos = (flotaData ?? []).map((f: any) => f.camion_codigo)
    let sinRevisar = (flotaData ?? []).length === 0 || (flotaData ?? []).some((f: any) => f.revisado === false)

    // Fallback a flota base si no hay flota_dia configurada para este día
    if (codigos.length === 0) {
      const { data: baseData } = await supabase
        .from('camiones_flota').select('codigo')
        .eq('sucursal', form.sucursal).eq('activo', true)
      codigos = (baseData ?? []).map((b: any) => b.codigo)
      sinRevisar = true
    }

    setFlotaSinRevisar(sinRevisar)

    if (codigos.length === 0) {
      setCuposDisponibles([])
      setVueltasSinCupoConFlota([])
      setVerificando(false)
      return
    }


    const { data: camionesData } = await supabase
      .from('camiones_flota').select('codigo, tonelaje_max_kg, posiciones_total').in('codigo', codigos)
    const camiones = camionesData ?? []

    const pesoTotalFlota = camiones.reduce((a: number, c: any) => a + c.tonelaje_max_kg, 0)
    const posTotalFlota = camiones.reduce((a: number, c: any) => a + c.posiciones_total, 0)
    const maxPos = camiones.reduce((a: number, c: any) => Math.max(a, c.posiciones_total), 0)
    setMaxCamionPosiciones(maxPos)

    const pesoNuevo = pesoTotal > 0 ? pesoTotal : 0
    const posNuevas = posicionesTotal > 0 ? posicionesTotal : 0

    for (const { vuelta } of FRANJAS) {
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

      if (ocupacionOk && capeOk) {
        disponibles.push(vuelta)
      } else {
        // Sin cupo pero hay flota → se puede cargar como pedido grande
        sinCupoConFlota.push(vuelta)
      }
    }

    setCuposDisponibles(disponibles)
    setVueltasSinCupoConFlota(sinCupoConFlota)
    // Reset flag si cambia la selección
    if (form.vuelta && disponibles.includes(parseInt(form.vuelta))) setPedidoGrande(false)
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

    // Validar que la vuelta seleccionada no esté cerrada por horario
    if (form.vuelta && form.vuelta !== 'fuera_prog') {
      const vueltaNum = parseInt(form.vuelta)
      const franja = FRANJAS.find(f => f.vuelta === vueltaNum)
      if (franja && vultaCerrada(form.fecha_entrega, franja)) {
        setError('Esta vuelta ya cerró. Seleccioná "Fuera de programación" para que el ruteador lo asigne a la franja disponible.')
        setLoading(false)
        return
      }
    }

    const { data: existente } = await supabase.from('pedidos').select('id').eq('id_despacho', form.id_despacho).single()
    if (existente) { setError(`Ya existe un pedido para la solicitud ${form.id_despacho}`); setLoading(false); return }

    if (pdfFile) {
      const fileName = `${form.id_despacho || form.nv}_${Date.now()}.pdf`
      await supabase.storage.from('solicitudes-despacho').upload(fileName, pdfFile)
    }

    // "fuera_prog" = pedido sin vuelta asignada, el ruteador la asigna después
    // vuelta 0 = fuera de programación (columna NOT NULL, no puede ser null)
    const vueltaFinal = form.vuelta === 'fuera_prog' ? 0 : parseInt(form.vuelta)

    const { data: pedidoInsertado, error } = await supabase.from('pedidos').insert({
      nv: form.nv,
      id_despacho: form.id_despacho,
      cliente: form.cliente,
      telefono: form.telefono,
      direccion: form.direccion,
      sucursal: form.sucursal,
      fecha_entrega: form.fecha_entrega,
      vuelta: vueltaFinal,
      estado_pago: form.estado_pago,
      barrio_cerrado: form.barrio_cerrado,
      notas: form.notas,
      vendedor_id: userId,
      estado: 'pendiente',
      peso_total_kg: pesoTotal,
      // Si es pedido grande, capear posiciones al máximo de un camión para reservar solo uno
      volumen_total_m3: pedidoGrande && maxCamionPosiciones > 0
        ? Math.max(posicionesTotal, maxCamionPosiciones)
        : posicionesTotal,
      pedido_grande: pedidoGrande || undefined,
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
    if (userId) logAuditoria(userId, userNombre, 'Creó pedido', 'Despachos', { nv: form.nv, id_despacho: form.id_despacho, cliente: form.cliente, sucursal: form.sucursal, fecha_entrega: form.fecha_entrega, peso_total_kg: pesoTotal })
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

  const handleLinkMapsRetiro = (url: string) => {
    setLinkMapsRetiro(url)
    if (!url.trim()) { setLinkMapsRetiroOk(null); return }
    const resultado = parsearLinkMaps(url)
    if (resultado) {
      setLatRetiro(resultado.lat)
      setLngRetiro(resultado.lng)
      if (resultado.direccion) setFormRetiro(prev => ({ ...prev, direccion: resultado.direccion! }))
      setLinkMapsRetiroOk(true)
    } else {
      setLinkMapsRetiroOk(false)
    }
  }

  async function buscarPorCodigoRetiro(codigo: string, idx: number) {
    const cod = codigo.trim()
    if (!cod || isNaN(Number(cod))) return
    const res = await fetch(`/api/stock-import?id_producto=${cod}`)
    const data = await res.json()
    if (Array.isArray(data) && data.length > 0) {
      const nombre = data[0].nombre
      const id = data[0].id_producto ?? null
      setItemsRetiro(prev => {
        const upd = [...prev]
        upd[idx] = { ...upd[idx], nombre_producto: nombre, id_producto: id, _encontrado: true, _noEncontrado: false }
        return upd
      })
    } else {
      setItemsRetiro(prev => {
        const upd = [...prev]
        upd[idx] = { ...upd[idx], nombre_producto: '', id_producto: null, _encontrado: false, _noEncontrado: true }
        return upd
      })
    }
  }

  const handleSubmitRetiro = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoadingRetiro(true)
    setErrorRetiro('')

    const itemsValidos = itemsRetiro.filter(it => it.nombre_producto.trim())
    if (itemsValidos.length === 0) {
      setErrorRetiro('Agregá al menos un producto para retirar.')
      setLoadingRetiro(false)
      return
    }

    const { data: pedidoInsertado, error: errIns } = await supabase.from('pedidos').insert({
      cliente: formRetiro.cliente,
      telefono: formRetiro.telefono,
      direccion: formRetiro.direccion,
      sucursal: formRetiro.sucursal,
      fecha_entrega: formRetiro.fecha_estimada || null,
      vuelta: 1,
      estado_pago: 'cuenta_corriente',
      notas: formRetiro.notas || null,
      vendedor_id: userId,
      estado: 'pendiente',
      peso_total_kg: 0,
      volumen_total_m3: 0,
      tipo: 'retiro',
      latitud: latRetiro,
      longitud: lngRetiro,
    }).select('id').single()

    if (errIns) { setErrorRetiro(errIns.message); setLoadingRetiro(false); return }

    if (pedidoInsertado && itemsValidos.length > 0) {
      await supabase.from('pedido_items').insert(
        itemsValidos.map(it => ({
          pedido_id: pedidoInsertado.id,
          codigo_material: it.id_producto ? String(it.id_producto) : null,
          nombre: it.nombre_producto,
          cantidad: it.cantidad,
          unidad: 'u',
        }))
      )
    }

    toast('Solicitud de retiro guardada correctamente')
    setExitoRetiro(true)
    setLoadingRetiro(false)
  }

  const resetRetiro = () => {
    setExitoRetiro(false)
    setFormRetiro(RETIRO_FORM_INICIAL)
    setItemsRetiro([{ nombre_producto: '', cantidad: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }])
    setLinkMapsRetiro('')
    setLinkMapsRetiroOk(null)
    setLatRetiro(null)
    setLngRetiro(null)
    setErrorRetiro('')
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

  if (exitoRetiro) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>
      <div className="bg-white rounded-2xl shadow-lg p-10 text-center max-w-md w-full mx-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl mx-auto mb-6" style={{ background: '#d1fae5' }}>🔄</div>
        <h2 className="text-2xl font-semibold mb-2" style={{ color: '#254A96' }}>Retiro solicitado</h2>
        <p className="text-sm mb-8" style={{ color: '#B9BBB7' }}>La solicitud de retiro fue registrada. El ruteador definirá cuándo pasamos a buscarlo.</p>
        <div className="flex gap-3 justify-center">
          <button onClick={resetRetiro} className="px-6 py-2.5 rounded-lg text-sm font-medium text-white" style={{ background: '#254A96' }}>
            Nueva solicitud
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
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>
            {tabActivo === 'retiro' ? 'Solicitud de Retiro' : 'Nueva Solicitud de Despacho'}
          </span>
        </div>
      </nav>

      {/* Tab switcher */}
      {puedeEditarDespachos && (
        <div className="sticky top-14 z-30 bg-white border-b" style={{ borderColor: '#e8edf8' }}>
          <div className="max-w-3xl mx-auto px-4 md:px-6 flex gap-0">
            {([
              { id: 'despacho', label: '📦 Nueva solicitud de despacho' },
              { id: 'retiro', label: '🔄 Solicitud de retiro' },
            ] as const).map(tab => (
              <button key={tab.id} onClick={() => setTabActivo(tab.id)}
                className="px-4 py-3 text-sm font-medium border-b-2 transition-colors"
                style={{
                  borderBottomColor: tabActivo === tab.id ? '#254A96' : 'transparent',
                  color: tabActivo === tab.id ? '#254A96' : '#B9BBB7',
                }}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      )}

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
                  min={new Date().toISOString().split('T')[0]}
                  onChange={e => {
                    setReprogFecha(e.target.value)
                    // Si la vuelta actual queda cerrada con la nueva fecha, resetear a la primera disponible
                    const cerradas = vueltasCerradasPara(e.target.value)
                    if (cerradas.includes(reprogVuelta)) {
                      const primerLibre = [1, 2, 3, 4].find(v => !cerradas.includes(v))
                      setReprogVuelta(primerLibre ?? 4)
                    }
                  }}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Vuelta</label>
                <select value={reprogVuelta}
                  onChange={e => setReprogVuelta(parseInt(e.target.value))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
                  {[1, 2, 3, 4].map(v => {
                    const franja = FRANJAS.find(f => f.vuelta === v)
                    const cerrada = franja ? reprogVueltasCerradas.includes(v) : false
                    return (
                      <option key={v} value={v} disabled={cerrada}>
                        Vuelta {v}{cerrada ? ' — ⛔ Fuera de horario' : ''}
                      </option>
                    )
                  })}
                </select>
                {reprogFecha && reprogVueltasCerradas.includes(reprogVuelta) && (
                  <p className="text-xs mt-1" style={{ color: '#E52322' }}>
                    Esta vuelta ya cerró para esa fecha. Seleccioná otra.
                  </p>
                )}
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
              <button disabled={!reprogFecha || reprogVueltasCerradas.includes(reprogVuelta)}
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

        {/* Aviso solo visualización */}
        {!puedeEditarDespachos && (
          <div className="rounded-xl px-5 py-4 text-sm font-medium flex items-center gap-3"
            style={{ background: '#fef3c7', color: '#b45309', border: '1px solid #fde68a' }}>
            👁️ Tenés acceso de solo visualización a este módulo. No podés cargar nuevas solicitudes de despacho.
          </div>
        )}

        {puedeEditarDespachos && tabActivo === 'despacho' && <>

        {/* Subir PDF */}
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="font-semibold text-sm mb-1" style={{ color: '#254A96' }}>📄 Solicitud de Despacho</h2>
          <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>El sistema completará los datos automáticamente desde el PDF o foto.</p>
          <label className="block w-full border-2 border-dashed rounded-xl px-4 py-6 text-center cursor-pointer transition-colors"
            style={{ borderColor: leyendoPDF ? '#254A96' : '#e8edf8', background: leyendoPDF ? '#e8edf8' : '#fafafa' }}>
            <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" onChange={handlePDF} className="hidden" />
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
                <span className="text-sm font-medium" style={{ color: '#254A96' }}>Seleccionar PDF o foto</span>
                <span className="text-xs" style={{ color: '#B9BBB7' }}>PDF, JPG o PNG — arrastrá o hacé click</span>
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
                  <p className="text-xs mb-1" style={{ color: '#B9BBB7' }}>Ubicación de entrega</p>
                  <div className="rounded-xl overflow-hidden border" style={{ borderColor: '#e8edf8', height: 220 }}>
                    <iframe
                      src={`https://www.openstreetmap.org/export/embed.html?bbox=${form.longitud! - 0.015},${form.latitud! - 0.015},${form.longitud! + 0.015},${form.latitud! + 0.015}&layer=mapnik&marker=${form.latitud},${form.longitud}`}
                      width="100%" height="220" style={{ border: 0, display: 'block' }}
                      loading="lazy"
                    />
                  </div>
                  <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>{form.latitud}, {form.longitud}</p>
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
                  <select name="vuelta" value={form.vuelta}
                    onChange={e => {
                      handleChange(e)
                      const v = parseInt(e.target.value)
                      setPedidoGrande(vueltasSinCupoConFlota.includes(v))
                    }}
                    required className={inputClass} style={inputStyle} disabled={!form.fecha_entrega}>
                    <option value="">{!form.fecha_entrega ? 'Primero elegí la fecha' : verificando ? 'Verificando...' : 'Seleccionar'}</option>
                    {FRANJAS.map((franja) => {
                      const { vuelta, label, horario } = franja
                      const cerrada = vueltasCerradas.includes(vuelta)
                      const tieneFlota = vueltasSinCupoConFlota.includes(vuelta)
                      const disponible = cuposDisponibles.includes(vuelta)
                      if (cerrada) return <option key={vuelta} value={vuelta} disabled>{label} — ⛔ Fuera de horario</option>
                      if (disponible) return <option key={vuelta} value={vuelta}>{label} — {horario}</option>
                      if (tieneFlota) return <option key={vuelta} value={vuelta}>{label} — ⚠️ Sin cupo (cargar igual)</option>
                      return <option key={vuelta} value={vuelta} disabled>{label} — Sin cupo</option>
                    })}
                    <option value="fuera_prog">Pedido fuera de programación</option>
                  </select>

                  {/* Aviso todas las vueltas cerradas */}
                  {vueltasCerradas.length === FRANJAS.length && form.fecha_entrega && (
                    <div className="mt-2 rounded-xl px-4 py-3 text-xs leading-relaxed"
                      style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e' }}>
                      <p className="font-semibold mb-1">⏰ Las vueltas de hoy ya cerraron</p>
                      <p>El pedido se cargó como <strong>fuera de programación</strong>. El ruteador lo va a asignar a la vuelta que corresponda según disponibilidad.</p>
                    </div>
                  )}

                  {/* Aviso pedido grande */}
                  {pedidoGrande && (
                    <div className="mt-2 rounded-xl px-4 py-3 text-xs leading-relaxed"
                      style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e' }}>
                      <p className="font-semibold mb-1">⚠️ Este pedido supera el cupo disponible</p>
                      <p>Se va a cargar como <strong>pedido grande</strong>. Se reservará un camión completo para esta vuelta y el programador deberá separarlo manualmente. El resto de los camiones queda disponible para otros pedidos.</p>
                    </div>
                  )}

                  {/* Aviso pedido fuera de programación */}
                  {form.vuelta === 'fuera_prog' && (
                    <div className="mt-2 rounded-xl px-4 py-3 text-xs leading-relaxed"
                      style={{ background: '#f0f4ff', border: '1px solid #c7d2fe', color: '#3730a3' }}>
                      <p className="font-semibold mb-1">📋 Pedido fuera de programación</p>
                      <p>El ruteador va a asignarle la vuelta y el camión que corresponda.</p>
                    </div>
                  )}
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
                  <option value="pago_en_obra">Pago en obra</option>
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

        </>}

        {/* ── TAB RETIRO ─────────────────────────────────────── */}
        {puedeEditarDespachos && tabActivo === 'retiro' && (
          <form onSubmit={handleSubmitRetiro} className="space-y-4">

            {/* Info banner */}
            <div className="rounded-xl px-5 py-4 text-sm flex items-start gap-3"
              style={{ background: '#f0fdfa', border: '1px solid #99f6e4', color: '#0f766e' }}>
              <span className="text-lg leading-none mt-0.5">🔄</span>
              <div>
                <p className="font-semibold">Solicitud de retiro</p>
                <p className="text-xs mt-0.5" style={{ color: '#0d9488' }}>Indicá qué pallets/materiales tenemos que retirar y de dónde. El ruteador va a definir cuándo conviene pasar.</p>
              </div>
            </div>

            {/* Datos del cliente */}
            <div className="bg-white rounded-xl shadow-sm p-6 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>Datos del cliente</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Cliente <span style={{ color: '#E52322' }}>*</span></label>
                  <input type="text" value={formRetiro.cliente} onChange={e => setFormRetiro(p => ({ ...p, cliente: e.target.value }))} required
                    placeholder="Nombre del cliente"
                    className={inputClass} style={inputStyle} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Teléfono</label>
                  <input type="tel" value={formRetiro.telefono} onChange={e => setFormRetiro(p => ({ ...p, telefono: e.target.value }))}
                    placeholder="Teléfono de contacto"
                    className={inputClass} style={inputStyle} />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Dirección de retiro <span style={{ color: '#E52322' }}>*</span></label>
                <input type="text" value={formRetiro.direccion} onChange={e => setFormRetiro(p => ({ ...p, direccion: e.target.value }))} required
                  placeholder="Dirección donde está el material"
                  className={inputClass} style={inputStyle} />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>
                  Link de Google Maps <span style={{ color: '#B9BBB7', fontWeight: 400 }}>(opcional)</span>
                </label>
                <div className="relative">
                  <input type="url" value={linkMapsRetiro}
                    onChange={e => handleLinkMapsRetiro(e.target.value)}
                    placeholder="https://maps.google.com/..."
                    className={inputClass}
                    style={{ ...inputStyle, paddingRight: '2rem',
                      borderColor: linkMapsRetiroOk === true ? '#10b981' : linkMapsRetiroOk === false ? '#E52322' : '#e8edf8' }} />
                  {linkMapsRetiroOk === true && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: '#10b981' }}>✓</span>}
                  {linkMapsRetiroOk === false && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm" style={{ color: '#E52322' }}>✕</span>}
                </div>
                {linkMapsRetiroOk === false && <p className="text-xs mt-1" style={{ color: '#E52322' }}>No se encontraron coordenadas en el link</p>}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Sucursal <span style={{ color: '#E52322' }}>*</span></label>
                  <select value={formRetiro.sucursal} onChange={e => setFormRetiro(p => ({ ...p, sucursal: e.target.value }))} required
                    className={inputClass} style={inputStyle}>
                    <option value="">Seleccionar sucursal...</option>
                    <option value="LP520">LP520</option>
                    <option value="LP139">LP139</option>
                    <option value="Guernica">Guernica</option>
                    <option value="Cañuelas">Cañuelas</option>
                    <option value="Pinamar">Pinamar</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>
                    Fecha estimada <span style={{ color: '#B9BBB7', fontWeight: 400 }}>(orientativa)</span>
                  </label>
                  <input type="date" value={formRetiro.fecha_estimada} onChange={e => setFormRetiro(p => ({ ...p, fecha_estimada: e.target.value }))}
                    className={inputClass} style={inputStyle} />
                </div>
              </div>
            </div>

            {/* Productos a retirar */}
            <div className="bg-white rounded-xl shadow-sm p-6 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>Productos a retirar</p>
              <p className="text-xs" style={{ color: '#B9BBB7' }}>Buscá por código de producto (mismo código del sistema de abastecimiento).</p>

              <div className="space-y-3">
                {itemsRetiro.map((item, idx) => (
                  <div key={idx} className="border rounded-xl p-4 space-y-3" style={{ borderColor: '#e8edf8' }}>
                    <div className="flex gap-3 items-start">
                      {/* Código */}
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs" style={{ color: '#B9BBB7' }}>Código</span>
                        <input
                          value={item._codigo ?? ''}
                          onChange={e => {
                            const upd = [...itemsRetiro]
                            upd[idx] = { ...upd[idx], _codigo: e.target.value, _encontrado: false, _noEncontrado: false }
                            setItemsRetiro(upd)
                          }}
                          onBlur={e => buscarPorCodigoRetiro(e.target.value, idx)}
                          placeholder="ej: 1234"
                          className="w-20 border rounded px-2 py-1.5 text-xs text-center focus:outline-none"
                          style={{ borderColor: item._encontrado ? '#bbf7d0' : item._noEncontrado ? '#fca5a5' : '#e8edf8' }} />
                      </div>

                      {/* Nombre */}
                      <div className="flex flex-col gap-0.5 flex-1">
                        <span className="text-xs flex items-center gap-1" style={{ color: '#B9BBB7' }}>
                          Producto
                          {item._encontrado && <span className="text-xs px-1 rounded" style={{ background: '#d1fae5', color: '#065f46' }}>✓ maestro</span>}
                          {item._noEncontrado && <span className="text-xs px-1 rounded" style={{ background: '#fef3c7', color: '#b45309' }}>manual</span>}
                        </span>
                        <input
                          value={item.nombre_producto}
                          readOnly={item._encontrado}
                          onChange={e => {
                            const upd = [...itemsRetiro]; upd[idx] = { ...upd[idx], nombre_producto: e.target.value }; setItemsRetiro(upd)
                          }}
                          placeholder={item._noEncontrado ? 'Ingresá el nombre del producto' : 'Nombre o buscá por código'}
                          className="flex-1 border rounded px-2.5 py-1.5 text-xs focus:outline-none"
                          style={{ borderColor: '#e8edf8', background: item._encontrado ? '#f0fdf4' : 'white', color: '#1a1a1a' }} />
                      </div>

                      {/* Cantidad */}
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs" style={{ color: '#B9BBB7' }}>Cant.</span>
                        <input type="number" min={1}
                          value={item.cantidad}
                          onChange={e => {
                            const upd = [...itemsRetiro]; upd[idx] = { ...upd[idx], cantidad: parseInt(e.target.value) || 1 }; setItemsRetiro(upd)
                          }}
                          className="w-16 border rounded px-2 py-1.5 text-xs text-center focus:outline-none"
                          style={{ borderColor: '#e8edf8' }} />
                      </div>

                      {/* Eliminar */}
                      {itemsRetiro.length > 1 && (
                        <button type="button" onClick={() => setItemsRetiro(prev => prev.filter((_, i) => i !== idx))}
                          className="mt-5 text-xs px-2 py-1.5 rounded"
                          style={{ color: '#E52322', background: '#fde8e8' }}>✕</button>
                      )}
                    </div>

                    {item._noEncontrado && !item.nombre_producto && (
                      <p className="text-xs" style={{ color: '#b45309' }}>
                        ⚠ Código no encontrado en el maestro — ingresá el nombre manualmente.
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <button type="button"
                onClick={() => setItemsRetiro(prev => [...prev, { nombre_producto: '', cantidad: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }])}
                className="w-full py-2 text-xs rounded-lg border-dashed border"
                style={{ borderColor: '#e8edf8', color: '#B9BBB7' }}>
                + Agregar producto
              </button>
            </div>

            {/* Notas */}
            <div className="bg-white rounded-xl shadow-sm p-6">
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Notas adicionales</label>
              <textarea value={formRetiro.notas} onChange={e => setFormRetiro(p => ({ ...p, notas: e.target.value }))} rows={3}
                className={inputClass} style={inputStyle}
                placeholder="Ej: pallets vacíos en el depósito, horario de acceso, contacto en obra, etc." />
            </div>

            {errorRetiro && (
              <div className="rounded-lg px-4 py-3 text-sm font-medium" style={{ background: '#fde8e8', color: '#E52322' }}>
                {errorRetiro}
              </div>
            )}

            <button type="submit" disabled={loadingRetiro}
              className="w-full py-3 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-50"
              style={{ background: loadingRetiro ? '#5eada3' : '#0f766e' }}>
              {loadingRetiro ? 'Guardando...' : '🔄 Confirmar solicitud de retiro'}
            </button>
          </form>
        )}

      </main>
    </div>
  )
}