'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { puedeEditar } from '../lib/permisos'
import { FRANJAS, vultaCerrada, vueltasCerradasPara } from '../lib/franjas'
import { logAuditoria } from '../lib/auditoria'
import type { jsPDF as JsPDFType } from 'jspdf'

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

function MapaPreview({ lat, lng }: { lat: number; lng: number }) {
  const mapRef = useRef<HTMLDivElement>(null)
  const leafletRef = useRef<any>(null)

  useEffect(() => {
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link')
      link.id = 'leaflet-css'; link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
      document.head.appendChild(link)
    }
    function initMap() {
      if (!mapRef.current) return
      const L = (window as any).L
      if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null }
      const map = L.map(mapRef.current).setView([lat, lng], 15)
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OSM', maxZoom: 18,
      }).addTo(map)
      L.marker([lat, lng]).addTo(map)
      leafletRef.current = map
    }
    if ((window as any).L) { setTimeout(initMap, 50) }
    else {
      const script = document.createElement('script')
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
      script.onload = () => setTimeout(initMap, 50)
      document.body.appendChild(script)
    }
    return () => { if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null } }
  }, [lat, lng])

  return <div ref={mapRef} style={{ height: 220, width: '100%' }} />
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
  const [fueraProgramacionCerrada, setFueraProgramacionCerrada] = useState(false)
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
  const RETIRO_FORM_INICIAL = { nv: '', cliente: '', telefono: '', direccion: '', sucursal: '', fecha_estimada: '', notas: '' }
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
    const cerradasHorario = FRANJAS.filter(f => vultaCerrada(form.fecha_entrega, f)).map(f => f.vuelta)

    // También verificar cierres manuales del programador
    const { data: vcmData } = await supabase
      .from('vueltas_cerradas_manual')
      .select('vuelta')
      .eq('fecha', form.fecha_entrega)
      .eq('sucursal', form.sucursal)
    const cerradasManual = (vcmData ?? []).map((r: any) => r.vuelta as number)
    // vuelta=0 en DB = "fuera de programación"
    const fueraCerrada = cerradasManual.includes(0)
    setFueraProgramacionCerrada(fueraCerrada)
    const cerradas = [...new Set([...cerradasHorario, ...cerradasManual.filter(v => v !== 0)])]
    setVueltasCerradas(cerradas)
    // Si todas las vueltas cerraron, auto-seleccionar "fuera de prog" solo si no está cerrada también
    if (cerradas.length === FRANJAS.length && !fueraCerrada) {
      setForm(prev => ({ ...prev, vuelta: 'fuera_prog' }))
    } else if (fueraCerrada && form.vuelta === 'fuera_prog') {
      setForm(prev => ({ ...prev, vuelta: '' }))
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
      if (!data.success) {
        setError(data.error || 'No se pudo leer el archivo.')
        setLeyendoPDF(false)
        return
      }

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
        const [{ data: todosMateriales }, { data: todosAliases }] = await Promise.all([
          supabase.from('materiales').select('*'),
          supabase.from('material_aliases').select('descripcion_pdf, material_id').eq('resuelto', true),
        ])

        const normalizar = (s: string) =>
          s.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/(\d),(\d)/g, '$1.$2')
            .replace(/\s*x\s*/g, 'x')
            .replace(/(\d)\s*(mt|kg|cm|mm|m)\b/g, '$1$2')
            .replace(/\s+/g, ' ').trim()

        // Map alias: descripcion_normalizada → material_id
        const aliasMap: Record<string, number> = {}
        for (const a of todosAliases ?? []) {
          if (a.material_id) aliasMap[normalizar(a.descripcion_pdf)] = a.material_id
        }

        // Similitud por tokens: fracción de tokens del string más corto que aparecen en el más largo
        const tokenSim = (a: string, b: string): number => {
          const ta = a.split(/\s+/).filter(t => t.length > 1)
          const tb = b.split(/\s+/).filter(t => t.length > 1)
          if (!ta.length || !tb.length) return 0
          const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
          const hits = shorter.filter(t => longer.some(lt => lt === t || lt.startsWith(t) || t.startsWith(lt)))
          return hits.length / shorter.length
        }

        const sinMatch: string[] = []
        const productosConDatos = datos.productos.map((p: any) => {
          const nombrePDF = normalizar(p.descripcion)
          // 1. Check alias (human-confirmed)
          const aliasMatId = aliasMap[nombrePDF]
          const materialFromAlias = aliasMatId
            ? (todosMateriales ?? []).find((m: any) => m.id === aliasMatId) ?? null
            : null
          // 2. Fallback: fuzzy scoring
          const material = materialFromAlias ?? (() => {
            const candidatos = (todosMateriales ?? [])
              .map((m: any) => {
                const nt = normalizar(m.nombre)
                let score = 0
                if (nt === nombrePDF) score = 1.0
                else if (nt.includes(nombrePDF) || nombrePDF.includes(nt)) score = 0.9
                else { const s = tokenSim(nombrePDF, nt); if (s >= 0.6) score = s }
                return { m, score }
              })
              .filter(({ score }: { score: number }) => score > 0)
              .sort((a: any, b: any) => b.score - a.score || b.m.nombre.length - a.m.nombre.length)
            return candidatos[0]?.m ?? null
          })()
          if (!material) sinMatch.push(p.descripcion)
          const pesoUnitario = material && material.cant_x_unid_log > 0
            ? material.peso_kg_x_posicion / material.cant_x_unid_log : 0
          const posiciones = material && material.cant_x_unid_log > 0
            ? Math.ceil(p.cantidad / material.cant_x_unid_log) * material.posiciones_x_unid_log : 0
          return { ...p, material, posiciones, peso: material ? p.cantidad * pesoUnitario : 0 }
        })

        // Log unmatched descriptions to material_aliases for review
        for (const desc of [...new Set(sinMatch)]) {
          const { data: existing } = await supabase
            .from('material_aliases')
            .select('id, veces_visto')
            .eq('descripcion_pdf', desc)
            .maybeSingle()
          if (existing) {
            await supabase.from('material_aliases').update({ veces_visto: existing.veces_visto + 1 }).eq('id', existing.id)
          } else {
            await supabase.from('material_aliases').insert({ descripcion_pdf: desc, veces_visto: 1 })
          }
        }

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
    const newValue = type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    setForm(prev => {
      const next = { ...prev, [name]: newValue }
      // Si se activa barrio_cerrado y la vuelta seleccionada no es válida, limpiarla
      if (name === 'barrio_cerrado' && newValue === true) {
        const vueltaNum = parseInt(prev.vuelta)
        if (prev.vuelta === 'fuera_prog' || (!isNaN(vueltaNum) && vueltaNum > 3)) {
          next.vuelta = ''
        }
      }
      return next
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError('')

    // Re-consultar bloqueos al momento del submit para evitar estado desactualizado
    const { data: vcmFresh } = await supabase
      .from('vueltas_cerradas_manual')
      .select('vuelta')
      .eq('fecha', form.fecha_entrega)
      .eq('sucursal', form.sucursal)
    const cerradasManualFresh = (vcmFresh ?? []).map((r: any) => r.vuelta as number)
    const fueraCerradaFresh = cerradasManualFresh.includes(0)
    const cerradasFresh = cerradasManualFresh.filter(v => v !== 0)

    // Validar barrio cerrado: solo V1, V2, V3
    if (form.barrio_cerrado) {
      const vueltaNum = form.vuelta === 'fuera_prog' ? 0 : parseInt(form.vuelta)
      if (form.vuelta === 'fuera_prog' || vueltaNum > 3) {
        setError('Los pedidos de barrio cerrado solo se pueden cargar en V1, V2 o V3 (solo vamos hasta las 15hs).')
        setLoading(false)
        return
      }
    }

    // Validar que "fuera de programación" no esté cerrada manualmente
    if (form.vuelta === 'fuera_prog' && fueraCerradaFresh) {
      setError('La carga de pedidos fuera de programación está cerrada para esta fecha y sucursal.')
      setLoading(false)
      return
    }

    // Validar que la vuelta seleccionada no esté cerrada (por horario o manualmente)
    if (form.vuelta && form.vuelta !== 'fuera_prog') {
      const vueltaNum = parseInt(form.vuelta)
      const franja = FRANJAS.find(f => f.vuelta === vueltaNum)
      const cerradaPorHorario = franja && vultaCerrada(form.fecha_entrega, franja)
      const cerradaManualmente = cerradasFresh.includes(vueltaNum)
      if (cerradaPorHorario || cerradaManualmente) {
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

  // Permite corregir posiciones por producto cuando el match automático es incorrecto o nulo
  function editarPosicionesItem(idx: number, valor: number) {
    const nuevo = productosNV.map((p: any, i: number) => i === idx ? { ...p, posiciones: valor } : p)
    setProductosNV(nuevo)
    setPosicionesTotal(nuevo.reduce((a: number, p: any) => a + p.posiciones, 0))
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
      nv: Number(formRetiro.nv),
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

  const generarPdfRetiro = async () => {
    const { jsPDF } = await import('jspdf')
    const doc: JsPDFType = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

    const azul: [number, number, number]    = [37, 74, 150]
    const verde: [number, number, number]   = [15, 118, 110]
    const gris: [number, number, number]    = [100, 100, 100]
    const grisClaro: [number, number, number] = [245, 245, 247]
    const blanco: [number, number, number]  = [255, 255, 255]
    const negro: [number, number, number]   = [26, 26, 26]

    const margenIzq = 14
    const ancho = 182
    let y = 15

    const ahora = new Date()
    const fechaGen = ahora.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const horaGen  = ahora.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })

    // ── Encabezado ──────────────────────────────────────────────────────────
    doc.setFillColor(...azul)
    doc.rect(margenIzq, y, ancho, 18, 'F')
    doc.setTextColor(...blanco)
    doc.setFontSize(15)
    doc.setFont('helvetica', 'bold')
    doc.text('SOLICITUD DE RETIRO', margenIzq + 4, y + 8)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.text('CAC — Centro de Abastecimiento Cerámico', margenIzq + 4, y + 14)
    doc.text(`Generado: ${fechaGen} ${horaGen}`, margenIzq + ancho - 2, y + 14, { align: 'right' })
    y += 24

    // ── Datos del cliente ────────────────────────────────────────────────────
    doc.setFillColor(...grisClaro)
    doc.rect(margenIzq, y, ancho, 7, 'F')
    doc.setTextColor(...azul)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text('DATOS DEL CLIENTE', margenIzq + 3, y + 4.8)
    y += 9

    const camposDatos: [string, string][] = [
      ['NV (Nota de Venta)', formRetiro.nv || '—'],
      ['Cliente', formRetiro.cliente || '—'],
      ['Teléfono', formRetiro.telefono || '—'],
      ['Dirección de retiro', formRetiro.direccion || '—'],
      ['Sucursal', formRetiro.sucursal || '—'],
      ['Fecha estimada', formRetiro.fecha_estimada ? new Date(formRetiro.fecha_estimada + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'],
    ]

    camposDatos.forEach(([label, valor], i) => {
      if (i % 2 === 0) {
        doc.setFillColor(...blanco)
      } else {
        doc.setFillColor(250, 250, 252)
      }
      doc.rect(margenIzq, y, ancho, 6.5, 'F')
      doc.setTextColor(...gris)
      doc.setFontSize(8)
      doc.setFont('helvetica', 'normal')
      doc.text(label + ':', margenIzq + 3, y + 4.4)
      doc.setTextColor(...negro)
      doc.setFont('helvetica', 'bold')
      doc.text(valor, margenIzq + 55, y + 4.4)
      y += 6.5
    })
    y += 5

    // ── Productos ────────────────────────────────────────────────────────────
    doc.setFillColor(...verde)
    doc.rect(margenIzq, y, ancho, 7, 'F')
    doc.setTextColor(...blanco)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text('PRODUCTOS A RETIRAR', margenIzq + 3, y + 4.8)
    y += 9

    // Cabecera tabla
    doc.setFillColor(...azul)
    doc.rect(margenIzq, y, ancho, 6.5, 'F')
    doc.setTextColor(...blanco)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'bold')
    doc.text('#', margenIzq + 3, y + 4.4)
    doc.text('Código', margenIzq + 12, y + 4.4)
    doc.text('Producto', margenIzq + 32, y + 4.4)
    doc.text('Cant.', margenIzq + ancho - 5, y + 4.4, { align: 'right' })
    y += 6.5

    const itemsValidos = itemsRetiro.filter(it => it.nombre_producto.trim())
    itemsValidos.forEach((item, i) => {
      if (y + 7 > 275) { doc.addPage(); y = 15 }
      const par = i % 2 === 0
      doc.setFillColor(par ? 255 : 248, par ? 255 : 250, par ? 255 : 255)
      doc.rect(margenIzq, y, ancho, 6.5, 'F')
      doc.setTextColor(...gris)
      doc.setFontSize(8)
      doc.setFont('helvetica', 'normal')
      doc.text(String(i + 1), margenIzq + 3, y + 4.4)
      doc.text(item.id_producto ? String(item.id_producto) : '—', margenIzq + 12, y + 4.4)
      doc.setTextColor(...negro)
      doc.setFont('helvetica', 'normal')
      // Truncar nombre si es muy largo
      const nombre = item.nombre_producto.length > 55 ? item.nombre_producto.substring(0, 52) + '…' : item.nombre_producto
      doc.text(nombre, margenIzq + 32, y + 4.4)
      doc.setFont('helvetica', 'bold')
      doc.setTextColor(...azul)
      doc.text(String(item.cantidad), margenIzq + ancho - 5, y + 4.4, { align: 'right' })
      y += 6.5
    })
    y += 5

    // ── Notas ────────────────────────────────────────────────────────────────
    if (formRetiro.notas?.trim()) {
      if (y + 20 > 275) { doc.addPage(); y = 15 }
      doc.setFillColor(...grisClaro)
      doc.rect(margenIzq, y, ancho, 7, 'F')
      doc.setTextColor(...azul)
      doc.setFontSize(9)
      doc.setFont('helvetica', 'bold')
      doc.text('NOTAS', margenIzq + 3, y + 4.8)
      y += 9
      doc.setTextColor(...negro)
      doc.setFontSize(8.5)
      doc.setFont('helvetica', 'normal')
      const lineas = doc.splitTextToSize(formRetiro.notas.trim(), ancho - 6)
      doc.text(lineas, margenIzq + 3, y + 4)
      y += lineas.length * 5 + 4
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    const totalPags = (doc as any).internal.getNumberOfPages()
    for (let p = 1; p <= totalPags; p++) {
      doc.setPage(p)
      doc.setDrawColor(220, 220, 220)
      doc.line(margenIzq, 285, margenIzq + ancho, 285)
      doc.setFontSize(7.5)
      doc.setTextColor(...gris)
      doc.setFont('helvetica', 'normal')
      doc.text(`Solicitud de retiro NV ${formRetiro.nv} — ${formRetiro.cliente} · ${fechaGen}`, margenIzq, 290)
      doc.text(`Pág. ${p} / ${totalPags}`, margenIzq + ancho, 290, { align: 'right' })
    }

    const fileName = `retiro_NV${formRetiro.nv}_${formRetiro.cliente.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}.pdf`
    doc.save(fileName)
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
          <Link href="/dashboard" className="px-6 py-2.5 rounded-lg text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>
            Ir al panel
          </Link>
        </div>
      </div>
    </div>
  )

  if (exitoRetiro) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>
      <div className="bg-white rounded-2xl shadow-lg p-10 text-center max-w-md w-full mx-4">
        <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl mx-auto mb-6" style={{ background: '#d1fae5' }}>🔄</div>
        <h2 className="text-2xl font-semibold mb-2" style={{ color: '#254A96' }}>Retiro solicitado</h2>
        <p className="text-sm mb-2" style={{ color: '#B9BBB7' }}>La solicitud de retiro fue registrada. El ruteador definirá cuándo pasamos a buscarlo.</p>
        {/* Resumen rápido */}
        <div className="rounded-xl px-4 py-3 mb-6 text-left text-sm space-y-1" style={{ background: '#f4f4f3' }}>
          <p style={{ color: '#1a1a1a' }}><strong>NV:</strong> {formRetiro.nv} · <strong>Cliente:</strong> {formRetiro.cliente}</p>
          <p style={{ color: '#666' }}>{formRetiro.sucursal}{formRetiro.fecha_estimada ? ` · ${new Date(formRetiro.fecha_estimada + 'T12:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : ''}</p>
          <p style={{ color: '#666' }}>{itemsRetiro.filter(i => i.nombre_producto).length} producto{itemsRetiro.filter(i => i.nombre_producto).length !== 1 ? 's' : ''} a retirar</p>
        </div>
        <div className="flex flex-col gap-2.5">
          <button onClick={generarPdfRetiro}
            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white flex items-center justify-center gap-2"
            style={{ background: '#0f766e' }}>
            📄 Generar PDF para logística
          </button>
          <div className="flex gap-3">
            <button onClick={resetRetiro} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white" style={{ background: '#254A96' }}>
              Nueva solicitud
            </button>
            <Link href="/dashboard" className="flex-1 py-2.5 rounded-xl text-sm font-medium" style={{ background: '#f4f4f3', color: '#666' }}>
              Ir al panel
            </Link>
          </div>
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
          <Link href="/dashboard"
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg"
            style={{ color: '#254A96', background: '#e8edf8' }}>
            ← Volver
          </Link>
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
          {error && !pdfListo && (
            <div className="mt-3 rounded-lg px-4 py-3 text-sm font-medium flex items-center gap-2" style={{ background: '#fde8e8', color: '#E52322' }}>
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Productos */}
        {productosNV.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="font-semibold text-sm mb-4" style={{ color: '#254A96' }}>📦 Productos del pedido</h2>
            <div className="space-y-2">
              {productosNV.map((p, i) => (
                <div key={i} className="flex justify-between items-start gap-3 text-sm py-2.5 border-b last:border-0" style={{ borderColor: '#f4f4f3' }}>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium" style={{ color: '#1a1a1a' }}>{p.descripcion}</span>
                    <span className="ml-2 text-xs" style={{ color: '#B9BBB7' }}>×{p.cantidad}</span>
                    {!p.material && (
                      <span className="ml-2 text-xs font-medium" style={{ color: '#f59e0b' }}>⚠ sin match en maestro</span>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <div className="flex items-center gap-1" title="Posiciones logísticas — editá si el cálculo automático es incorrecto">
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={p.posiciones}
                        onChange={e => editarPosicionesItem(i, parseFloat(e.target.value) || 0)}
                        className="w-16 text-right border rounded-lg px-2 py-0.5 text-xs focus:outline-none"
                        style={{
                          borderColor: p.posiciones === 0 ? '#fca5a5' : '#e8edf8',
                          color: p.posiciones === 0 ? '#E52322' : '#254A96',
                          fontWeight: 600,
                        }}
                      />
                      <span className="text-xs" style={{ color: '#B9BBB7' }}>pos</span>
                    </div>
                    {p.material && (
                      <span className="text-xs" style={{ color: '#B9BBB7' }}>{(p.peso / 1000).toFixed(1)} tn</span>
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
                    <MapaPreview lat={form.latitud!} lng={form.longitud!} />
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
                      const bloqueadaBarrio = form.barrio_cerrado && vuelta > 3
                      const tieneFlota = vueltasSinCupoConFlota.includes(vuelta)
                      const disponible = cuposDisponibles.includes(vuelta)
                      if (cerrada || bloqueadaBarrio) return <option key={vuelta} value={vuelta} disabled>{label} — {bloqueadaBarrio ? '🏘️ No disponible para barrio cerrado' : '⛔ Fuera de horario'}</option>
                      if (disponible) return <option key={vuelta} value={vuelta}>{label} — {horario}</option>
                      if (tieneFlota) return <option key={vuelta} value={vuelta}>{label} — ⚠️ Sin cupo (cargar igual)</option>
                      return <option key={vuelta} value={vuelta} disabled>{label} — Sin cupo</option>
                    })}
                    <option value="fuera_prog" disabled={fueraProgramacionCerrada || form.barrio_cerrado}>
                      {fueraProgramacionCerrada ? 'Fuera de prog. — 🔒 Cerrado' : form.barrio_cerrado ? 'Fuera de prog. — 🏘️ No disponible para barrio cerrado' : 'Pedido fuera de programación'}
                    </option>
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

              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>NV (Nota de Venta) <span style={{ color: '#E52322' }}>*</span></label>
                <input type="number" value={formRetiro.nv} onChange={e => setFormRetiro(p => ({ ...p, nv: e.target.value }))} required
                  placeholder="Número de NV del pedido original"
                  className={inputClass} style={inputStyle} />
              </div>

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
                  <input type="text" value={linkMapsRetiro}
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