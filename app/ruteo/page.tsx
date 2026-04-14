'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import { logAuditoria } from '../lib/auditoria'
import type { jsPDF as JsPDFType } from 'jspdf'

interface Pedido {
  id: string
  nv: string
  cliente: string
  direccion: string
  sucursal: string
  vuelta: number
  estado: string
  estado_pago: string
  peso_total_kg: number | null
  notas: string | null
  camion_id: string | null
  orden_entrega: number | null
  latitud: number | null
  longitud: number | null
  telefono: string | null
  items?: { nombre: string; cantidad: number; unidad: string }[]
}

interface CamionDisponible {
  codigo: string
  tipo_unidad: string
  sucursal: string
}

const VUELTA_LABEL: Record<number, string> = {
  1: '8:00 – 10:00hs',
  2: '10:00 – 12:00hs',
  3: '13:00 – 15:00hs',
  4: '15:00 – 17:00hs',
}

function hoy() { return new Date().toISOString().split('T')[0] }

export default function RuteoPage() {
  const router = useRouter()
  const [usuario, setUsuario] = useState<any>(null)
  const [datosUsuario, setDatosUsuario] = useState<{ nombre: string; rol: string } | null>(null)
  const [camionSeleccionado, setCamionSeleccionado] = useState<string | null>(null)
  const [camionesDisponibles, setCamionesDisponibles] = useState<CamionDisponible[]>([])
  const [pedidos, setPedidos] = useState<Pedido[]>([])
  const [fecha, setFecha] = useState(hoy())
  const [vueltaActiva, setVueltaActiva] = useState<number | null>(null)
  const [cargando, setCargando] = useState(true)
  const [cargandoPedidos, setCargandoPedidos] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [horaInicio, setHoraInicio] = useState<string | null>(null)
  const [horaFin, setHoraFin] = useState<string | null>(null)
  const [vueltasIniciadas, setVueltasIniciadas] = useState<Set<number>>(new Set())
  const [kmRuta, setKmRuta] = useState<number | null>(null)
  const [guardandoRuta, setGuardandoRuta] = useState(false)

  // Soporte técnico
  const [modalSoporte, setModalSoporte] = useState(false)
  const [contactosSoporte, setContactosSoporte] = useState<{ id: number; nombre: string; telefono: string; sucursal: string }[]>([])

  // Modal de confirmación
  const [modalPedido, setModalPedido] = useState<Pedido | null>(null)
  const [nota, setNota] = useState('')
  const [fotos, setFotos] = useState<{ file: File; preview: string; label: string }[]>([])
  const [confirmando, setConfirmando] = useState(false)
  const [accionModal, setAccionModal] = useState<'entregar' | 'rechazar'>('entregar')
  const [motivoRechazo, setMotivoRechazo] = useState('')
  const [errorModal, setErrorModal] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const LABELS_FOTO = ['Remito', 'Material en puerta', 'Daño / Roto', 'Otro']

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      setUsuario(user)

      const { data: userData } = await supabase
        .from('usuarios')
        .select('nombre, rol, camion_codigo')
        .eq('id', user.id)
        .single()

      if (!['chofer', 'gerencia', 'admin_flota', 'ruteador'].includes(userData?.rol)) {
        router.push('/dashboard')
        return
      }

      setDatosUsuario({ nombre: userData?.nombre ?? user.email ?? 'Chofer', rol: userData?.rol ?? '' })

      // Si es chofer, buscar el camión asignado para HOY en flota_dia
      if (userData?.rol === 'chofer') {
        const { data: asignacion } = await supabase
          .from('flota_dia')
          .select('camion_codigo')
          .eq('fecha', hoy())
          .eq('chofer_id', user.id)
          .single()
        if (asignacion?.camion_codigo) {
          setCamionSeleccionado(asignacion.camion_codigo)
        }
      }

      setCargando(false)
    })
  }, [])

  useEffect(() => {
    cargarCamionesDisponibles()
  }, [fecha])

  useEffect(() => {
    if (camionSeleccionado) { cargarPedidos(); cargarInfoRuta(); cargarSoporte() }
  }, [camionSeleccionado, fecha])

  const cargarSoporte = async () => {
    if (!camionSeleccionado) return
    // Buscar la sucursal del camión seleccionado
    const { data: camionData } = await supabase
      .from('camiones_flota').select('sucursal').eq('codigo', camionSeleccionado).single()
    const suc = camionData?.sucursal
    if (!suc) return
    const res = await fetch(`/api/soporte-contactos?sucursal=${encodeURIComponent(suc)}`)
    const data = await res.json()
    setContactosSoporte(data.contactos ?? [])
  }

  const cargarCamionesDisponibles = async () => {
    // Traer camiones que tienen pedidos programados para esta fecha
    const { data: pedidosData } = await supabase
      .from('pedidos')
      .select('camion_id')
      .eq('fecha_entrega', fecha)
      .in('estado', ['programado', 'en_camino', 'entregado', 'rechazado'])
      .not('camion_id', 'is', null)

    const codigos = [...new Set((pedidosData ?? []).map((p: any) => p.camion_id))]

    if (codigos.length === 0) {
      setCamionesDisponibles([])
      return
    }

    const { data: camionesData } = await supabase
      .from('camiones_flota')
      .select('codigo, tipo_unidad, sucursal')
      .in('codigo', codigos)
      .order('codigo')

    setCamionesDisponibles(camionesData ?? [])
  }

  const cargarInfoRuta = async () => {
    if (!camionSeleccionado) return
    const { data } = await supabase
      .from('flota_dia')
      .select('hora_inicio, hora_fin, km_ruta')
      .eq('fecha', fecha)
      .eq('camion_codigo', camionSeleccionado)
      .single()
    setHoraInicio(data?.hora_inicio ?? null)
    setHoraFin(data?.hora_fin ?? null)
    setKmRuta(data?.km_ruta ?? null)
  }

  const iniciarRuta = async () => {
    if (!camionSeleccionado || !vueltaActiva) return
    setGuardandoRuta(true)
    const ahora = new Date().toISOString()

    // Solo guardar hora_inicio en flota_dia la primera vez (primera vuelta del día)
    if (!horaInicio) {
      await supabase.from('flota_dia')
        .update({ hora_inicio: ahora })
        .eq('fecha', fecha).eq('camion_codigo', camionSeleccionado)
      setHoraInicio(ahora)
    }

    // Actualizar SOLO los pedidos de esta vuelta por ID — no bulk filter
    const aIniciar = pedidos.filter(p => p.vuelta === vueltaActiva && p.estado === 'programado')
    const errores = await Promise.all(
      aIniciar.map(p =>
        fetch('/api/pedidos', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, estado: 'en_camino' }),
        }).then(r => r.json())
      )
    )
    const hayError = errores.some(r => r.error)
    if (!hayError) {
      setPedidos(prev => prev.map(p =>
        p.vuelta === vueltaActiva && p.estado === 'programado' ? { ...p, estado: 'en_camino' } : p
      ))
      setVueltasIniciadas(prev => new Set([...prev, vueltaActiva!]))
      showToast('Ruta iniciada')
    } else {
      showToast('Error al iniciar ruta', 'err')
    }
    setGuardandoRuta(false)
  }

  const finalizarRuta = async () => {
    if (!camionSeleccionado || horaFin) return
    setGuardandoRuta(true)
    const ahora = new Date().toISOString()
    const { error } = await supabase.from('flota_dia')
      .update({ hora_fin: ahora })
      .eq('fecha', fecha).eq('camion_codigo', camionSeleccionado)
    if (!error) { setHoraFin(ahora); showToast('Ruta finalizada') }
    else showToast('Error al finalizar ruta', 'err')
    setGuardandoRuta(false)
  }

  function formatHora(iso: string) {
    return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
  }

  function duracionRuta(): string | null {
    if (!horaInicio) return null
    const fin = horaFin ? new Date(horaFin) : new Date()
    const min = Math.round((fin.getTime() - new Date(horaInicio).getTime()) / 60000)
    const hs = Math.floor(min / 60); const m = min % 60
    return hs > 0 ? `${hs}h ${m}min` : `${m}min`
  }

  function minPorKm(): string | null {
    if (!horaInicio || !horaFin || !kmRuta || kmRuta === 0) return null
    const min = (new Date(horaFin).getTime() - new Date(horaInicio).getTime()) / 60000
    return `${(min / kmRuta).toFixed(1)} min/km`
  }

  const cargarPedidos = async () => {
    if (!camionSeleccionado) return
    setCargandoPedidos(true)

    const { data } = await supabase
      .from('pedidos')
      .select('*, items:pedido_items(nombre, cantidad, unidad)')
      .eq('fecha_entrega', fecha)
      .eq('camion_id', camionSeleccionado)
      .in('estado', ['programado', 'en_camino', 'entregado', 'rechazado'])
      .order('vuelta')
      .order('orden_entrega', { ascending: true, nullsFirst: false })

    const todosPedidos = data ?? []
    setPedidos(todosPedidos)

    // Marcar vueltas que ya tienen actividad (en_camino o entregado)
    const iniciadas = new Set(
      todosPedidos
        .filter(p => p.estado === 'en_camino' || p.estado === 'entregado' || p.estado === 'rechazado')
        .map(p => p.vuelta as number)
    )
    setVueltasIniciadas(iniciadas)

    const vueltas = [...new Set(todosPedidos.map(p => p.vuelta))].sort()
    const vueltaPendiente = vueltas.find(v =>
      todosPedidos.some(p => p.vuelta === v && p.estado !== 'entregado' && p.estado !== 'rechazado')
    )
    setVueltaActiva(vueltaPendiente ?? vueltas[0] ?? null)
    setCargandoPedidos(false)
  }

  const seleccionarCamion = (codigo: string) => {
    // Solo los choferes tienen un camión fijo; gerencia/ruteador seleccionan para monitoreo
    // sin modificar su perfil en la base de datos
    setCamionSeleccionado(codigo)
  }

  const abrirRecorridoCompleto = () => {
    const paradas = pedidosVuelta
      .filter(p => p.estado !== 'entregado' && p.estado !== 'rechazado' && p.latitud && p.longitud)
      .sort((a, b) => (a.orden_entrega ?? 999) - (b.orden_entrega ?? 999))

    if (paradas.length === 0) return

    const construirUrl = (origin: string) => {
      const destination = `${paradas[paradas.length - 1].latitud},${paradas[paradas.length - 1].longitud}`
      const waypoints = paradas.slice(0, -1).map(p => `${p.latitud},${p.longitud}`).join('|')
      let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`
      if (waypoints) url += `&waypoints=${waypoints}`
      window.open(url, '_blank')
    }

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        pos => construirUrl(`${pos.coords.latitude},${pos.coords.longitude}`),
        () => construirUrl('') // si deniega permisos, Maps usa ubicación actual automáticamente
      )
    } else {
      construirUrl('')
    }
  }

  const abrirMaps = (pedido: Pedido) => {
    if (pedido.latitud && pedido.longitud) {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${pedido.latitud},${pedido.longitud}`, '_blank')
    } else {
      window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pedido.direccion)}`, '_blank')
    }
  }

  const handleFoto = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    files.forEach(file => {
      const reader = new FileReader()
      reader.onload = () => setFotos(prev => [
        ...prev,
        { file, preview: reader.result as string, label: 'Remito' }
      ])
      reader.readAsDataURL(file)
    })
    // Reset input para permitir seleccionar la misma foto de nuevo
    if (fileRef.current) fileRef.current.value = ''
  }

  const eliminarFoto = (idx: number) => setFotos(prev => prev.filter((_, i) => i !== idx))

  const cambiarLabel = (idx: number, label: string) =>
    setFotos(prev => prev.map((f, i) => i === idx ? { ...f, label } : f))

  // Comprime una imagen a JPEG con calidad reducida para no trabar el upload móvil
  const comprimirFoto = (file: File): Promise<Blob> =>
    new Promise(resolve => {
      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        const MAX = 1200
        const ratio = Math.min(MAX / img.width, MAX / img.height, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * ratio)
        canvas.height = Math.round(img.height * ratio)
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
        URL.revokeObjectURL(url)
        canvas.toBlob(blob => resolve(blob ?? file), 'image/jpeg', 0.82)
      }
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
      img.src = url
    })

  const cerrarModal = () => {
    setModalPedido(null); setNota(''); setFotos([])
    setAccionModal('entregar'); setMotivoRechazo(''); setErrorModal('')
  }

  const confirmarEntrega = async (accion: 'entregar' | 'rechazar') => {
    if (!modalPedido) return
    if (fotos.length === 0) { setErrorModal('Necesitás agregar al menos una foto antes de continuar.'); return }
    if (accion === 'rechazar' && !motivoRechazo.trim()) { setErrorModal('Ingresá el motivo del rechazo para continuar.'); return }
    setErrorModal('')
    setConfirmando(true)

    try {
      const formData = new FormData()
      formData.append('pedido_id', modalPedido.id)
      formData.append('estado', accion === 'rechazar' ? 'rechazado' : 'entregado')
      if (nota) formData.append('nota', nota)
      if (accion === 'rechazar') formData.append('motivo_rechazo', motivoRechazo.trim())

      for (let i = 0; i < fotos.length; i++) {
        const blob = await comprimirFoto(fotos[i].file)
        formData.append(`foto_${i}`, blob, `foto_${i}.jpg`)
        formData.append(`label_${i}`, fotos[i].label)
      }

      const res = await fetch('/api/confirmar-entrega', { method: 'POST', body: formData })
      const data = await res.json()

      if (data.success) {
        const nuevoEstado = accion === 'rechazar' ? 'rechazado' : 'entregado'
        showToast(accion === 'rechazar' ? 'Entrega rechazada' : 'Entrega confirmada')
        if (usuario && datosUsuario) {
          await logAuditoria(usuario.id, datosUsuario.nombre,
            accion === 'rechazar' ? 'Rechazó entrega' : 'Confirmó entrega', 'Ruteo', {
              pedido_id: modalPedido.id, nv: modalPedido.nv, cliente: modalPedido.cliente,
              camion: camionSeleccionado, con_nota: !!nota, cant_fotos: fotos.length,
              ...(accion === 'rechazar' ? { motivo: motivoRechazo } : {}),
            })
        }
        setPedidos(prev => prev.map(p =>
          p.id === modalPedido.id ? { ...p, estado: nuevoEstado } : p
        ))
        cerrarModal()
      } else {
        showToast(`Error: ${data.error ?? 'No se pudo guardar'}`, 'err')
      }
    } catch (e: any) {
      showToast(`Error: ${e.message ?? 'No se pudo guardar'}`, 'err')
    }
    setConfirmando(false)
  }

  const pedidosVuelta = pedidos.filter(p => p.vuelta === vueltaActiva)
  const vueltas = [...new Set(pedidos.map(p => p.vuelta))].sort()
  const finalizadosVuelta = pedidosVuelta.filter(p => p.estado === 'entregado' || p.estado === 'rechazado').length
  const entregadosVuelta = finalizadosVuelta
  const totalVuelta = pedidosVuelta.length

  const imprimirVuelta = () => {
    const win = window.open('', '_blank')
    if (!win) return

    // Consolidar totales
    const totales: Record<string, { nombre: string; cantidad: number; unidad: string }> = {}
    pedidosVuelta.forEach(p => {
      ;(p.items ?? []).forEach(item => {
        if (!totales[item.nombre]) totales[item.nombre] = { nombre: item.nombre, cantidad: 0, unidad: item.unidad }
        totales[item.nombre].cantidad += item.cantidad
      })
    })

    const fechaStr = new Date(fecha + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })

    // Cada pedido = su propia <table> con page-break-inside:avoid
    const tablasPorPedido = pedidosVuelta.map((p, idx) => {
      const items = p.items ?? []
      const num = p.orden_entrega ?? idx + 1
      const header = `<td rowspan="${Math.max(items.length,1)}" style="vertical-align:top;font-weight:bold;width:24px">${num}</td><td rowspan="${Math.max(items.length,1)}" style="vertical-align:top;width:38%"><strong>${p.cliente}</strong><br><small style="color:#666">NV ${p.nv}</small><br><small style="color:#888">${p.direccion}</small></td>`
      const filas = items.length === 0
        ? `<tr>${header}<td colspan="3" style="color:#999">Sin items</td></tr>`
        : items.map((item, i) => `<tr>${i === 0 ? header : ''}<td>${item.nombre}</td><td style="text-align:right;font-weight:bold;color:#254A96">${item.cantidad.toLocaleString('es-AR')}</td><td>${item.unidad}</td></tr>`).join('')
      return `<table class="pedido"><thead><tr><th style="width:24px">#</th><th style="width:38%">Cliente / NV / Dirección</th><th>Material</th><th style="text-align:right">Cant.</th><th>U.</th></tr></thead><tbody>${filas}</tbody></table>`
    }).join('')

    win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
      <title>${camionSeleccionado} — V${vueltaActiva} — ${fecha}</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:12px;color:#111;margin:24px}
        h1{font-size:15px;margin:0 0 2px 0;color:#254A96}
        .meta{font-size:11px;color:#666;margin-bottom:14px}
        h2{font-size:12px;margin:14px 0 8px;color:#254A96;border-bottom:1px solid #ccc;padding-bottom:3px;text-transform:uppercase;letter-spacing:.5px}
        table.pedido{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:11px;page-break-inside:avoid}
        thead{display:table-header-group}
        th{background:#254A96;color:#fff;padding:5px 7px;text-align:left}
        td{padding:4px 7px;border-bottom:1px solid #eee}
        table.totales{width:100%;border-collapse:collapse;font-size:11px}
        .qty{text-align:right;font-weight:bold;color:#254A96}
        @media print{@page{margin:15mm}table.pedido{page-break-inside:avoid}}
      </style></head><body>
      <h1>🚛 ${camionSeleccionado} — Vuelta ${vueltaActiva} · ${VUELTA_LABEL[vueltaActiva!] ?? ''}</h1>
      <p class="meta">${fechaStr} · ${pedidosVuelta.length} entregas</p>

      <h2>Detalle por entrega</h2>
      ${tablasPorPedido}

      <h2 style="page-break-before:always">Materiales a preparar (total vuelta)</h2>
      <table class="totales"><thead><tr><th>Material</th><th style="text-align:right">Cantidad</th><th>Unidad</th></tr></thead><tbody>
        ${Object.values(totales).sort((a, b) => a.nombre.localeCompare(b.nombre)).map(t =>
          `<tr><td>${t.nombre}</td><td class="qty">${t.cantidad.toLocaleString('es-AR')}</td><td>${t.unidad}</td></tr>`
        ).join('')}
      </tbody></table>
      <script>window.onload=()=>window.print()</script>
      </body></html>`)
    win.document.close()
  }
  const descargarPDF = async () => {
    const { jsPDF } = await import('jspdf')
    const doc: JsPDFType = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

    const fechaStr = new Date(fecha + 'T12:00:00').toLocaleDateString('es-AR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    })

    const azul: [number, number, number] = [37, 74, 150]
    const gris: [number, number, number] = [100, 100, 100]
    const blanco: [number, number, number] = [255, 255, 255]
    const grisClaro: [number, number, number] = [245, 245, 245]

    let y = 15
    const margenIzq = 14
    const ancho = 182

    // ── Encabezado ──
    doc.setFillColor(...azul)
    doc.rect(margenIzq, y, ancho, 14, 'F')
    doc.setTextColor(...blanco)
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.text(`${camionSeleccionado} — Vuelta ${vueltaActiva} · ${VUELTA_LABEL[vueltaActiva!] ?? ''}`, margenIzq + 3, y + 9)
    y += 16
    doc.setTextColor(...gris)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.text(`${fechaStr} · ${pedidosVuelta.length} entregas`, margenIzq, y)
    y += 8

    // ── Detalle por entrega ──
    doc.setTextColor(...azul)
    doc.setFontSize(10)
    doc.setFont('helvetica', 'bold')
    doc.text('DETALLE POR ENTREGA', margenIzq, y)
    doc.setDrawColor(...azul)
    doc.line(margenIzq, y + 1.5, margenIzq + ancho, y + 1.5)
    y += 6

    pedidosVuelta.forEach((p, idx) => {
      const items = p.items ?? []
      const filas = items.length === 0 ? [['Sin items', '', '']] : items.map(i => [i.nombre, i.cantidad.toLocaleString('es-AR'), i.unidad])
      const numEntrega = p.orden_entrega ?? idx + 1

      // Estimar altura para page break
      const alturaEstimada = 14 + filas.length * 6
      if (y + alturaEstimada > 270) { doc.addPage(); y = 15 }

      // Fila de cabecera del pedido
      doc.setFillColor(...grisClaro)
      doc.rect(margenIzq, y, ancho, 8, 'F')
      doc.setTextColor(...azul)
      doc.setFontSize(9)
      doc.setFont('helvetica', 'bold')
      doc.text(`${numEntrega}. ${p.cliente}`, margenIzq + 2, y + 5.5)
      doc.setFont('helvetica', 'normal')
      doc.setTextColor(...gris)
      doc.setFontSize(8)
      doc.text(`NV ${p.nv} · ${p.direccion ?? ''}`, margenIzq + 60, y + 5.5)
      y += 8

      // Filas de items
      filas.forEach((fila, i) => {
        doc.setFillColor(i % 2 === 0 ? 255 : 250, i % 2 === 0 ? 255 : 250, i % 2 === 0 ? 255 : 250)
        doc.rect(margenIzq, y, ancho, 6, 'F')
        doc.setTextColor(30, 30, 30)
        doc.setFontSize(8.5)
        doc.setFont('helvetica', 'normal')
        doc.text(fila[0], margenIzq + 4, y + 4.2)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(...azul)
        doc.text(fila[1], margenIzq + ancho - 20, y + 4.2, { align: 'right' })
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(...gris)
        doc.text(fila[2], margenIzq + ancho - 2, y + 4.2, { align: 'right' })
        y += 6
      })
      y += 3
    })

    // ── Totales generales ──
    const totales: Record<string, { nombre: string; cantidad: number; unidad: string }> = {}
    pedidosVuelta.forEach(p => {
      ;(p.items ?? []).forEach(item => {
        if (!totales[item.nombre]) totales[item.nombre] = { nombre: item.nombre, cantidad: 0, unidad: item.unidad }
        totales[item.nombre].cantidad += item.cantidad
      })
    })
    const filasTotales = Object.values(totales).sort((a, b) => a.nombre.localeCompare(b.nombre))

    if (filasTotales.length > 0) {
      if (y + filasTotales.length * 6 + 20 > 270) { doc.addPage(); y = 15 }
      y += 3
      doc.setTextColor(...azul)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'bold')
      doc.text('MATERIALES A PREPARAR — TOTAL VUELTA', margenIzq, y)
      doc.setDrawColor(...azul)
      doc.line(margenIzq, y + 1.5, margenIzq + ancho, y + 1.5)
      y += 6

      // Cabecera tabla
      doc.setFillColor(...azul)
      doc.rect(margenIzq, y, ancho, 7, 'F')
      doc.setTextColor(...blanco)
      doc.setFontSize(8.5)
      doc.text('Material', margenIzq + 3, y + 5)
      doc.text('Cantidad', margenIzq + ancho - 25, y + 5, { align: 'right' })
      doc.text('U.', margenIzq + ancho - 2, y + 5, { align: 'right' })
      y += 7

      filasTotales.forEach((t, i) => {
        doc.setFillColor(i % 2 === 0 ? 255 : 250, i % 2 === 0 ? 255 : 250, i % 2 === 0 ? 255 : 250)
        doc.rect(margenIzq, y, ancho, 6, 'F')
        doc.setTextColor(30, 30, 30)
        doc.setFont('helvetica', 'normal')
        doc.text(t.nombre, margenIzq + 3, y + 4.2)
        doc.setFont('helvetica', 'bold')
        doc.setTextColor(...azul)
        doc.text(t.cantidad.toLocaleString('es-AR'), margenIzq + ancho - 25, y + 4.2, { align: 'right' })
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(...gris)
        doc.text(t.unidad, margenIzq + ancho - 2, y + 4.2, { align: 'right' })
        y += 6
      })
    }

    doc.save(`${camionSeleccionado}_V${vueltaActiva}_${fecha}.pdf`)
  }

  // Vuelta iniciada = al menos un pedido ya no está en "programado"
  const vueltaIniciada = vueltaActiva != null && vueltasIniciadas.has(vueltaActiva)

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Modal confirmar entrega */}
      {/* Botón flotante soporte — solo cuando hay camión seleccionado y hay contactos */}
      {camionSeleccionado && contactosSoporte.length > 0 && (
        <button onClick={() => setModalSoporte(true)}
          className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-2xl"
          style={{ background: '#25D366' }}
          title="Contactar soporte">
          🛟
        </button>
      )}

      {/* Modal soporte */}
      {modalSoporte && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base" style={{ color: '#254A96' }}>🛟 Soporte técnico</h3>
              <button onClick={() => setModalSoporte(false)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>
            <p className="text-xs" style={{ color: '#B9BBB7' }}>Contactos disponibles para tu sucursal</p>
            <div className="space-y-3">
              {contactosSoporte.map(c => (
                <div key={c.id} className="rounded-xl p-4 space-y-2" style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                  <p className="font-semibold text-sm" style={{ color: '#1a1a1a' }}>{c.nombre}</p>
                  <div className="flex gap-2">
                    <a href={`https://wa.me/${c.telefono}`} target="_blank" rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white"
                      style={{ background: '#25D366' }}>
                      💬 WhatsApp
                    </a>
                    <a href={`tel:+${c.telefono}`}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white"
                      style={{ background: '#254A96' }}>
                      📞 Llamar
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {modalPedido && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#254A96' }}>Registrar entrega</h3>
                <p className="text-sm mt-0.5" style={{ color: '#B9BBB7' }}>{modalPedido.cliente}</p>
              </div>
              <button onClick={cerrarModal} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
            </div>
            <div className="rounded-xl p-3 text-sm" style={{ background: '#f4f4f3' }}>
              <p className="font-medium" style={{ color: '#1a1a1a' }}>{modalPedido.direccion}</p>
            </div>

            {/* Nota */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>Nota (opcional)</label>
              <textarea value={nota} onChange={e => setNota(e.target.value)} rows={2}
                className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}
                placeholder="Ej: Dejé en portería, firmó el encargado..." />
            </div>

            {/* Fotos — obligatorias */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: '#254A96' }}>
                Foto <span style={{ color: '#E52322' }}>*</span>
                <span className="font-normal ml-1" style={{ color: '#B9BBB7' }}>(obligatoria)</span>
              </label>
              {fotos.length > 0 && (
                <div className="space-y-2 mb-2">
                  {fotos.map((f, idx) => (
                    <div key={idx} className="flex gap-2 items-start rounded-xl p-2" style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                      <img src={f.preview} alt="" className="w-16 h-16 object-cover rounded-lg flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <select value={f.label} onChange={e => cambiarLabel(idx, e.target.value)}
                          className="w-full border rounded-lg px-2 py-1.5 text-xs focus:outline-none mb-1"
                          style={{ borderColor: '#e8edf8' }}>
                          {LABELS_FOTO.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                        <p className="text-xs truncate" style={{ color: '#B9BBB7' }}>{f.file.name}</p>
                      </div>
                      <button onClick={() => eliminarFoto(idx)}
                        className="w-6 h-6 flex-shrink-0 rounded-full flex items-center justify-center text-white text-xs mt-1"
                        style={{ background: '#E52322' }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => fileRef.current?.click()}
                className="w-full border-2 border-dashed rounded-xl py-4 text-center"
                style={{ borderColor: fotos.length === 0 ? '#fca5a5' : '#e8edf8' }}>
                <p className="text-xl mb-0.5">📷</p>
                <p className="text-xs" style={{ color: fotos.length === 0 ? '#E52322' : '#B9BBB7' }}>
                  {fotos.length === 0 ? 'Tocar para sacar foto (requerido)' : '+ Agregar otra foto'}
                </p>
              </button>
              <input ref={fileRef} type="file" accept="image/*" capture="environment"
                multiple onChange={handleFoto} className="hidden" />
            </div>

            {/* Motivo de rechazo — solo visible si se elige rechazar */}
            {accionModal === 'rechazar' && (
              <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: '#E52322' }}>
                  Motivo del rechazo <span style={{ color: '#E52322' }}>*</span>
                </label>
                <textarea value={motivoRechazo} onChange={e => setMotivoRechazo(e.target.value)} rows={2}
                  className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: '#fca5a5' }}
                  placeholder="Ej: Cliente no estaba, no aceptó el pedido, dirección incorrecta..." />
              </div>
            )}

            {/* Error inline */}
            {errorModal && (
              <div className="rounded-xl px-4 py-3 text-sm font-medium flex items-center gap-2"
                style={{ background: '#fde8e8', color: '#E52322', border: '1px solid #fca5a5' }}>
                ⚠️ {errorModal}
              </div>
            )}

            {/* Botones acción */}
            <div className="flex gap-2">
              <button
                onClick={() => { setAccionModal('entregar'); confirmarEntrega('entregar') }}
                disabled={confirmando}
                className="flex-1 py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {confirmando && accionModal === 'entregar' ? 'Guardando...' : '✓ Entregado'}
              </button>
              <button
                onClick={() => accionModal === 'rechazar' ? confirmarEntrega('rechazar') : setAccionModal('rechazar')}
                disabled={confirmando}
                className="flex-1 py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: accionModal === 'rechazar' ? '#E52322' : '#f4f4f3', color: accionModal === 'rechazar' ? 'white' : '#E52322' }}>
                {confirmando && accionModal === 'rechazar' ? 'Guardando...' : accionModal === 'rechazar' ? '✕ Confirmar rechazo' : '✕ Rechazado'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {datosUsuario?.rol !== 'chofer' && (
              <button onClick={() => router.push('/dashboard')}
                className="text-xs px-2 py-1.5 rounded-lg font-medium"
                style={{ background: '#e8edf8', color: '#254A96' }}>
                ← Volver
              </button>
            )}
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>
                {datosUsuario?.rol === 'chofer' ? 'Mis entregas' : 'Ruteo'}
              </span>
              {/* Solo roles no-chofer pueden deseleccionar el camión */}
              {camionSeleccionado && datosUsuario?.rol !== 'chofer' && (
                <button onClick={() => setCamionSeleccionado(null)}
                  className="text-xs ml-2 px-2 py-0.5 rounded-full"
                  style={{ background: '#e8edf8', color: '#254A96' }}>
                  {camionSeleccionado} ✕
                </button>
              )}
              {/* Chofer: mostrar su camión sin opción de cambiar */}
              {camionSeleccionado && datosUsuario?.rol === 'chofer' && (
                <span className="text-xs ml-2 px-2 py-0.5 rounded-full font-medium"
                  style={{ background: '#e8edf8', color: '#254A96' }}>
                  🚛 {camionSeleccionado}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* El chofer siempre ve el día de hoy, no puede cambiar fecha */}
            {datosUsuario?.rol !== 'chofer' && (
              <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
                className="border rounded-lg px-2 py-1 text-xs focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
            )}
            <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
              className="text-xs px-2 py-1.5 rounded-lg" style={{ background: '#fde8e8', color: '#E52322' }}>
              Salir
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-2xl mx-auto px-4 py-4">

        {/* Sin camión seleccionado */}
        {!camionSeleccionado && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            {datosUsuario?.rol === 'chofer' ? (
              /* Chofer sin asignación: mensaje claro, sin lista */
              <div className="text-center py-8">
                <p className="text-5xl mb-4">🚛</p>
                <h2 className="font-semibold text-base mb-2" style={{ color: '#254A96' }}>
                  No tenés camión asignado para hoy
                </h2>
                <p className="text-sm" style={{ color: '#B9BBB7' }}>
                  Contactá al administrador de flota para que te asigne un camión.
                </p>
              </div>
            ) : (
              /* Otros roles: pueden elegir cualquier camión */
              <>
                <h2 className="font-semibold text-base mb-1" style={{ color: '#254A96' }}>¿Qué camión querés ver?</h2>
                <p className="text-xs mb-4" style={{ color: '#B9BBB7' }}>
                  {new Date(fecha + 'T00:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: '2-digit', month: 'long' })}
                </p>
                {camionesDisponibles.length === 0 ? (
                  <div className="text-center py-8" style={{ color: '#B9BBB7' }}>
                    <p className="text-3xl mb-3">🚛</p>
                    <p className="text-sm">No hay camiones con entregas programadas para esta fecha</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {camionesDisponibles.map(c => (
                      <button key={c.codigo} onClick={() => seleccionarCamion(c.codigo)}
                        className="w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all text-left"
                        style={{ borderColor: '#e8edf8' }}
                        onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = '#254A96'}
                        onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = '#e8edf8'}>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-sm"
                            style={{ background: '#254A96' }}>
                            🚛
                          </div>
                          <div>
                            <p className="font-bold text-sm" style={{ color: '#254A96' }}>{c.codigo}</p>
                            <p className="text-xs" style={{ color: '#B9BBB7' }}>{c.tipo_unidad} · {c.sucursal}</p>
                          </div>
                        </div>
                        <span style={{ color: '#B9BBB7' }}>›</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Vista de pedidos */}
        {camionSeleccionado && (
          <>
            {cargandoPedidos ? (
              <div className="flex justify-center py-20">
                <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
              </div>
            ) : (
              <>
                {/* Panel inicio/fin ruta — solo para el chofer */}
                {datosUsuario?.rol === 'chofer' && (
                  <div className="bg-white rounded-xl shadow-sm p-4 mb-4" style={{ border: '2px solid #e8edf8' }}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Estado de ruta</span>
                      {kmRuta && <span className="text-xs px-2 py-1 rounded-full" style={{ background: '#e8edf8', color: '#254A96' }}>🗺️ {kmRuta} km planificados</span>}
                    </div>
                    {!vueltaIniciada ? (
                      <button onClick={iniciarRuta} disabled={guardandoRuta}
                        className="w-full py-3 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                        style={{ background: '#10b981' }}>
                        {guardandoRuta ? 'Guardando...' : `▶ Iniciar V${vueltaActiva}`}
                      </button>
                    ) : (
                      <div className="space-y-3">
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="rounded-lg p-2" style={{ background: '#f4f4f3' }}>
                            <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>Inicio</p>
                            <p className="font-bold text-sm" style={{ color: '#254A96' }}>{formatHora(horaInicio!)}</p>
                          </div>
                          <div className="rounded-lg p-2" style={{ background: '#f4f4f3' }}>
                            <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>Duración</p>
                            <p className="font-bold text-sm" style={{ color: horaFin ? '#065f46' : '#254A96' }}>{duracionRuta()}</p>
                          </div>
                          <div className="rounded-lg p-2" style={{ background: '#f4f4f3' }}>
                            <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>Velocidad</p>
                            <p className="font-bold text-sm" style={{ color: '#254A96' }}>{minPorKm() ?? '—'}</p>
                          </div>
                        </div>
                        {horaFin ? (
                          <div className="text-center py-2 rounded-xl text-sm font-semibold" style={{ background: '#d1fae5', color: '#065f46' }}>
                            ✓ Ruta finalizada a las {formatHora(horaFin)}
                          </div>
                        ) : (
                          <button onClick={finalizarRuta} disabled={guardandoRuta}
                            className="w-full py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                            style={{ background: '#E52322' }}>
                            {guardandoRuta ? 'Guardando...' : '⏹ Finalizar ruta'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Progreso */}
                {totalVuelta > 0 && (
                  <div className="bg-white rounded-xl shadow-sm p-4 mb-4">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-sm font-semibold" style={{ color: '#254A96' }}>
                        Vuelta {vueltaActiva} — {vueltaActiva ? VUELTA_LABEL[vueltaActiva] : ''}
                      </span>
                      <span className="text-sm font-bold" style={{ color: entregadosVuelta === totalVuelta ? '#065f46' : '#254A96' }}>
                        {entregadosVuelta}/{totalVuelta}
                      </span>
                    </div>
                    <div className="w-full rounded-full h-2" style={{ background: '#f0f0f0' }}>
                      <div className="h-2 rounded-full transition-all" style={{
                        width: `${totalVuelta > 0 ? (entregadosVuelta / totalVuelta) * 100 : 0}%`,
                        background: entregadosVuelta === totalVuelta ? '#10b981' : '#254A96'
                      }} />
                    </div>
                  </div>
                )}

                {/* Tabs de vuelta */}
                {vueltas.length > 1 && (
                  <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
                    {vueltas.map(v => {
                      const entregados = pedidos.filter(p => p.vuelta === v && (p.estado === 'entregado' || p.estado === 'rechazado')).length
                      const total = pedidos.filter(p => p.vuelta === v).length
                      return (
                        <button key={v} onClick={() => setVueltaActiva(v)}
                          className="px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap shrink-0"
                          style={{ background: vueltaActiva === v ? '#254A96' : '#f4f4f3', color: vueltaActiva === v ? 'white' : '#666' }}>
                          V{v} <span className="text-xs opacity-70 ml-1">{entregados}/{total}</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Botones imprimir / descargar PDF */}
                {datosUsuario?.rol !== 'chofer' && pedidosVuelta.length > 0 && (
                  <div className="flex gap-2 mb-4">
                    <button onClick={imprimirVuelta}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium"
                      style={{ background: '#f4f4f3', color: '#254A96', border: '1px solid #e8edf8' }}>
                      🖨️ Imprimir — V{vueltaActiva}
                    </button>
                    <button onClick={descargarPDF}
                      className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium"
                      style={{ background: '#e8edf8', color: '#254A96', border: '1px solid #254A96' }}>
                      ⬇️ Descargar PDF
                    </button>
                  </div>
                )}

                {/* Botón recorrido completo */}
                {pedidosVuelta.filter(p => p.estado !== 'entregado' && p.estado !== 'rechazado' && p.latitud && p.longitud).length > 0 && (
                  <button onClick={abrirRecorridoCompleto}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold mb-4"
                    style={{ background: '#254A96', color: 'white' }}>
                    🗺️ Ver recorrido completo en Maps
                  </button>
                )}

                {/* Lista de pedidos */}
                {pedidosVuelta.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-20" style={{ color: '#B9BBB7' }}>
                    <div className="text-5xl mb-4">📦</div>
                    <p className="font-medium">No hay entregas para esta fecha</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {pedidosVuelta.map((pedido, idx) => {
                      const entregado = pedido.estado === 'entregado'
                      const rechazado = pedido.estado === 'rechazado'
                      const finalizado = entregado || rechazado
                      return (
                        <div key={pedido.id}
                          className="bg-white rounded-xl shadow-sm overflow-hidden"
                          style={{ opacity: finalizado ? 0.75 : 1, border: `2px solid ${entregado ? '#d1fae5' : rechazado ? '#fde8e8' : '#f0f0f0'}` }}>
                          <div className="px-4 py-3 flex items-center justify-between"
                            style={{ background: entregado ? '#f0fdf4' : rechazado ? '#fff5f5' : 'white', borderBottom: '1px solid #f4f4f3' }}>
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                                style={{ background: entregado ? '#10b981' : rechazado ? '#E52322' : '#254A96' }}>
                                {entregado ? '✓' : rechazado ? '✕' : (pedido.orden_entrega ?? idx + 1)}
                              </div>
                              <div>
                                <p className="font-semibold text-sm" style={{ color: '#254A96' }}>{pedido.cliente}</p>
                                <p className="text-xs" style={{ color: '#B9BBB7' }}>NV {pedido.nv}</p>
                              </div>
                            </div>
                            <span className="text-xs px-2 py-1 rounded-full font-medium"
                              style={entregado ? { background: '#d1fae5', color: '#065f46' } : rechazado ? { background: '#fde8e8', color: '#E52322' } : { background: '#e8edf8', color: '#254A96' }}>
                              {entregado ? 'Entregado' : rechazado ? 'Rechazado' : 'Pendiente'}
                            </span>
                          </div>
                          <div className="px-4 py-3 space-y-3">
                            <div>
                              <p className="text-xs mb-0.5" style={{ color: '#B9BBB7' }}>Dirección</p>
                              <p className="text-sm font-medium" style={{ color: '#1a1a1a' }}>{pedido.direccion}</p>
                            </div>
                            {pedido.items && pedido.items.length > 0 && (
                              <div className="rounded-lg p-2.5 space-y-1" style={{ background: '#f4f4f3' }}>
                                {pedido.items.map((item, i) => (
                                  <div key={i} className="flex justify-between text-xs" style={{ color: '#666' }}>
                                    <span>{item.nombre}</span>
                                    <span className="font-medium ml-2 shrink-0">{item.cantidad} {item.unidad}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {pedido.notas && !finalizado && (
                              <p className="text-xs rounded-lg px-3 py-2" style={{ background: '#fff8e1', color: '#b45309' }}>
                                ⚠️ {pedido.notas}
                              </p>
                            )}
                            {rechazado && (pedido as any).motivo_rechazo && (
                              <p className="text-xs rounded-lg px-3 py-2" style={{ background: '#fde8e8', color: '#E52322' }}>
                                ✕ {(pedido as any).motivo_rechazo}
                              </p>
                            )}
                            {!finalizado && (
                              <div className="flex gap-2 pt-1">
                                <button onClick={() => abrirMaps(pedido)}
                                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium border"
                                  style={{ borderColor: '#e8edf8', color: '#254A96', background: '#f9f9f9' }}>
                                  🗺️ Abrir Maps
                                </button>
                                <button onClick={() => setModalPedido(pedido)}
                                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white"
                                  style={{ background: '#254A96' }}>
                                  ✓ Confirmar
                                </button>
                              </div>
                            )}
                            {finalizado && pedido.notas && (
                              <p className="text-xs" style={{ color: '#B9BBB7' }}>Nota: {pedido.notas}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}