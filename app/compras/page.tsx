'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../supabase'
import { rolesDe } from '../lib/roles'
import { puedeEditar } from '../lib/permisos'
import ProveedorPicker from '../components/ProveedorPicker'
import OrdenesCompra from './OrdenesCompra'
import { BadgeHuemul, CheckHuemul, ESTADO_HUEMUL, estadoHuemulFinal, ImportadorHuemul, ListaIngresosHuemul, useCruceHuemul } from './IngresosHuemul'
import type { RemitoGuardia } from '../lib/huemul-utils'
import ProductosRemito, { type ItemRemito } from './ProductosRemito'
import AsociarOC from './AsociarOC'
import VisorFotoGrande from '../components/VisorFotoGrande'
import {
  coincideTexto, cuitValido, formatCuit, normalizarCuit, normalizarRemito, remitoIgual, soloDigitos,
} from '../lib/compras-utils'
import {
  crearProveedor, eliminarIngreso, ETIQUETA_VALIDACION, fechaLocal, firmarFotos, marcarRemitoHuemul, nombresUsuarios, useProveedores,
  type EstadoValidacion, type ProveedorLite,
} from '../lib/compras'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

type Tab = 'ingresos' | 'oc' | 'proveedores'
type Fila = { ing: any; rem: any | null }

const ESTADO_PROV: Record<string, { label: string; bg: string; fg: string; bd: string }> = {
  aprobado: { label: 'Aprobado', bg: '#ecfdf5', fg: '#065f46', bd: '#bbf7d0' },
  pendiente: { label: 'Pendiente', bg: '#fffbeb', fg: '#92400e', bd: '#fde68a' },
  revisar: { label: 'A revisar', bg: '#fef2f2', fg: '#b91c1c', bd: '#fecaca' },
  fusionado: { label: 'Fusionado', bg: '#f3f4f6', fg: '#6b7280', bd: '#e5e7eb' },
}

const card: React.CSSProperties = { background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: 16, marginBottom: 14 }
const labelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }
const inputSt: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #d6d6d6', fontSize: 14, background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit', color: '#111' }
const btn = (bg = '#254A96', fg = '#fff'): React.CSSProperties => ({ padding: '9px 16px', borderRadius: 10, border: 'none', background: bg, color: fg, fontWeight: 700, fontSize: 14, cursor: 'pointer' })
const btnLine: React.CSSProperties = { padding: '8px 14px', borderRadius: 10, border: '1.5px solid #d6d6d6', background: '#fff', color: '#444', fontWeight: 600, fontSize: 13, cursor: 'pointer' }
const th: React.CSSProperties = { padding: '10px 12px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap', background: '#f9f9f9', color: '#254A96' }
const td: React.CSSProperties = { padding: '10px 12px', borderTop: '1px solid #f0f0f0', verticalAlign: 'top', fontSize: 13 }

const fmtFechaHora = (iso: string) => {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const fmtFecha = (f: string | null) => { if (!f) return ''; const [y, m, d] = f.split('-'); return `${d}/${m}/${y}` }

function badgeProv(estado: string) {
  const e = ESTADO_PROV[estado] ?? ESTADO_PROV.aprobado
  return <span style={{ background: e.bg, color: e.fg, border: `1px solid ${e.bd}`, borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{e.label}</span>
}

function aviso(ing: any, rem: any | null): { texto: string; rojo: boolean } | null {
  const p = ing.proveedores
  if (rem?.cuit_leido && p?.cuit && rem.cuit_leido !== p.cuit) return { texto: 'El CUIT del remito no coincide con el proveedor', rojo: true }
  if (p?.estado === 'pendiente') return { texto: 'Proveedor pendiente de aprobación', rojo: false }
  if (rem?.cuit_leido && p && !p.cuit) return { texto: `Proveedor sin CUIT (el remito dice ${formatCuit(rem.cuit_leido)})`, rojo: false }
  if (rem?.ocr_estado === 'error') return { texto: 'No se pudo leer el remito', rojo: false }
  return null
}

function descargarCSV(contenido: string, nombre: string) {
  const blob = new Blob(['﻿' + contenido], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = nombre; a.click()
  URL.revokeObjectURL(url)
}
const csvCell = (v: any) => {
  const s = String(v ?? '').replace(/"/g, '""')
  return s.includes(';') || s.includes('\n') || s.includes('"') ? `"${s}"` : s
}

export default function ComprasPage() {
  const router = useRouter()
  const [cargando, setCargando] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [rol, setRol] = useState('')
  const [puedeEd, setPuedeEd] = useState(false)
  const [puedeMarcar, setPuedeMarcar] = useState(false)   // check «Lo cargué en Huemul»
  const [marcando, setMarcando] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('ingresos')
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const { lista: proveedoresLista, recargar: recargarProveedores } = useProveedores()

  // Ingresos
  const [desde, setDesde] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return fechaLocal(d) })
  const [hasta, setHasta] = useState(fechaLocal())
  const [sucursal, setSucursal] = useState('Todas')
  const [origen, setOrigen] = useState('todos')
  const [estadoRem, setEstadoRem] = useState('todos')
  const [filtroOC, setFiltroOC] = useState('todos')
  const [filtroRecep, setFiltroRecep] = useState('todos')
  const [filtroHuemul, setFiltroHuemul] = useState('todos')
  const [subIng, setSubIng] = useState<'guardia' | 'huemul'>('guardia')
  const [refreshHuemul, setRefreshHuemul] = useState(0)
  const [nombresVal, setNombresVal] = useState<Record<string, string>>({})
  const [fotosVal, setFotosVal] = useState<string[]>([])
  const [itemsRemito, setItemsRemito] = useState<ItemRemito[]>([])
  const [recargarItems, setRecargarItems] = useState(0)
  const [fotoGrande, setFotoGrande] = useState<{ urls: string[]; i: number } | null>(null)
  const [texto, setTexto] = useState('')
  const [ingresos, setIngresos] = useState<any[]>([])
  const [cargandoIng, setCargandoIng] = useState(false)
  const [sel, setSel] = useState<Fila | null>(null)
  const [fNumero, setFNumero] = useState('')
  const [fProv, setFProv] = useState<ProveedorLite | null>(null)
  const [fObs, setFObs] = useState('')
  const [fotos, setFotos] = useState<{ camion: string[]; remito: string[] } | null>(null)
  const [guardando, setGuardando] = useState(false)

  // Proveedores
  const [todosProv, setTodosProv] = useState<any[]>([])
  const [filtroProv, setFiltroProv] = useState('todos')
  const [textoProv, setTextoProv] = useState('')
  const [editProv, setEditProv] = useState<any | null>(null)
  const [pNombre, setPNombre] = useState('')
  const [pCuit, setPCuit] = useState('')
  const [pNotas, setPNotas] = useState('')
  const [pEstado, setPEstado] = useState('aprobado')
  const [fusion, setFusion] = useState<any | null>(null)
  const [fusionQ, setFusionQ] = useState('')

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo })
    setTimeout(() => setToast(null), 3200)
  }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/'); return }
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/mi-perfil', { headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} })
      const { perfil } = await res.json()
      const r = perfil?.rol ?? ''
      const roles = rolesDe(r, perfil?.roles_extra)
      const permisos = perfil?.permisos ?? null
      const acceso = roles.some(x => ['gerencia', 'admin_flota', 'compras'].includes(x)) || (permisos?.compras && permisos.compras !== 'none') || permisos?.huemul === 'editor'
      if (!acceso || permisos?.compras === 'none') { router.push('/dashboard'); return }
      setUserId(user.id); setRol(r); setPuedeEd(puedeEditar(permisos, roles, 'compras'))
      setPuedeMarcar(puedeEditar(permisos, roles, 'compras') || permisos?.huemul === 'editor')
      setCargando(false)
    })()
  }, [])

  const cargarIngresos = useCallback(async () => {
    setCargandoIng(true)
    let q = supabase.from('proveedor_ingresos')
      .select('*, proveedores(id, nombre, cuit, estado), proveedor_remitos(*, proveedor_remito_ocs(oc_id))')
      .gte('fecha', desde).lte('fecha', hasta).order('hora_ingreso', { ascending: false }).limit(500)
    if (sucursal !== 'Todas') q = q.eq('sucursal', sucursal)
    if (origen !== 'todos') q = q.eq('origen', origen)
    const { data } = await q
    setIngresos(data ?? [])
    setNombresVal(await nombresUsuarios((data ?? []).flatMap((i: any) => [i.validado_por, ...(i.proveedor_remitos ?? []).map((r: any) => r.huemul_cargado_por)])))
    setCargandoIng(false)
  }, [desde, hasta, sucursal, origen])

  const cargarTodosProv = useCallback(async () => {
    const { data } = await supabase.from('proveedores').select('*').order('nombre')
    setTodosProv(data ?? [])
  }, [])

  useEffect(() => { if (!cargando && tab === 'ingresos') cargarIngresos() }, [cargando, tab, cargarIngresos])
  useEffect(() => { if (!cargando && tab === 'proveedores') cargarTodosProv() }, [cargando, tab, cargarTodosProv])

  // Cada remito de guardia contra lo que hay cargado en Huemul
  const remitosGuardia: RemitoGuardia[] = useMemo(() => ingresos.flatMap(ing =>
    (ing.proveedor_remitos ?? []).map((rem: any) => ({
      id: rem.id as string, numero_remito: rem.numero_remito as string, fecha: ing.fecha as string,
      proveedor_id: (ing.proveedor_id ?? null) as string | null, proveedor_nombre: (ing.proveedores?.nombre ?? null) as string | null,
    }))), [ingresos])
  const { cruce: cruceHuemul, ultima: ultimaHuemul } = useCruceHuemul(remitosGuardia, refreshHuemul)
  // Mientras el jefe de depósito no valida la recepción, el remito no se le pide a quien carga en Huemul
  const estadoDe = useCallback((rem: any, ing?: any) => {
    const e = estadoHuemulFinal(rem, rem ? cruceHuemul.get(rem.id) : undefined, ultimaHuemul?.exportado_en ?? null, !!ultimaHuemul)
    if (ing?.validacion_estado === 'pendiente' && (e === 'sin_cargar' || e === 'posterior_al_export' || e === 'sin_numero')) return 'espera_validacion' as const
    return e
  }, [cruceHuemul, ultimaHuemul])

  const filas: Fila[] = useMemo(() => {
    const todas = ingresos.flatMap(ing => (ing.proveedor_remitos?.length ? ing.proveedor_remitos : [null]).map((rem: any) => ({ ing, rem })))
    return todas.filter(({ ing, rem }) => {
      if (estadoRem !== 'todos' && (rem?.estado ?? 'registrado') !== estadoRem) return false
      if (filtroRecep !== 'todos' && (ing.validacion_estado ?? 'sin') !== filtroRecep) return false
      if (filtroHuemul !== 'todos') {
        const e = estadoDe(rem, ing)
        // "Sin cargar" incluye lo que llegó después del último export (todavía no puede estar en el archivo);
        // "Marcados" son los que alguien tildó como cargados y el export todavía no confirmó
        const coincide = filtroHuemul === 'sin_cargar' ? (e === 'sin_cargar' || e === 'posterior_al_export')
          : filtroHuemul === 'marcado' ? (e === 'marcado' || e === 'marcado_no_figura')
          : e === filtroHuemul
        if (!coincide) return false
      }
      const nOC = rem?.proveedor_remito_ocs?.length ?? 0
      if (filtroOC === 'sin' && (nOC > 0 || rem?.sin_oc)) return false
      if (filtroOC === 'asociadas' && nOC === 0) return false
      if (filtroOC === 'sinoc' && !rem?.sin_oc) return false
      if (!texto.trim()) return true
      const hay = [ing.proveedores?.nombre, rem?.numero_remito, rem?.numero_remito_leido, ing.patente, ing.camion_codigo, ing.chofer].filter(Boolean).join(' ')
      return coincideTexto(hay, texto)
    })
  }, [ingresos, estadoRem, filtroOC, filtroRecep, filtroHuemul, estadoDe, texto])

  const marcarHuemul = async (rem: any, valor: boolean) => {
    if (!rem?.id) return
    setMarcando(rem.id)
    try {
      await marcarRemitoHuemul(rem.id, valor)
      const cambios = { huemul_cargado_por: valor ? userId : null, huemul_cargado_en: valor ? new Date().toISOString() : null }
      setIngresos(prev => prev.map(ing => ({ ...ing, proveedor_remitos: (ing.proveedor_remitos ?? []).map((r: any) => r.id === rem.id ? { ...r, ...cambios } : r) })))
      setSel(prev => (prev && prev.rem?.id === rem.id ? { ...prev, rem: { ...prev.rem, ...cambios } } : prev))
      if (valor && userId) nombresUsuarios([userId]).then(nm => setNombresVal(prev => ({ ...prev, ...nm })))
      showToast(valor ? 'Marcado como cargado en Huemul' : 'Marca quitada')
    } catch (e: any) { showToast(e?.message || 'No se pudo guardar la marca', 'err') }
    setMarcando(null)
  }

  const abrirDetalle = async (f: Fila) => {
    setSel(f); setFNumero(f.rem?.numero_remito ?? ''); setFObs(f.rem?.observacion_compras ?? '')
    setFProv(f.ing.proveedores ? { id: f.ing.proveedores.id, nombre: f.ing.proveedores.nombre, cuit: f.ing.proveedores.cuit, estado: f.ing.proveedores.estado } : null)
    setFotos(null); setItemsRemito([]); setFotosVal([])
    const [camion, remito] = await Promise.all([firmarFotos(f.ing.fotos_camion ?? []), firmarFotos(f.rem?.fotos ?? [])])
    setFotos({ camion, remito })
    setFotosVal(await firmarFotos(f.ing.validacion_fotos ?? []))
  }

  const guardarDetalle = async (marcar?: 'revisado' | 'registrado') => {
    if (!sel) return
    const { ing, rem } = sel
    if (rem && !fNumero.trim()) { showToast('El número de remito no puede quedar vacío', 'err'); return }
    setGuardando(true)
    try {
      if (rem) {
        const nuevo = normalizarRemito(fNumero).valor
        const cambios: any = {
          numero_remito: nuevo,
          remito_corregido: rem.numero_remito_leido ? !remitoIgual(nuevo, rem.numero_remito_leido) : rem.remito_corregido,
          observacion_compras: fObs.trim() || null,
        }
        if (marcar) {
          cambios.estado = marcar
          cambios.revisado_por = marcar === 'revisado' ? userId : null
          cambios.revisado_en = marcar === 'revisado' ? new Date().toISOString() : null
        }
        const { error } = await supabase.from('proveedor_remitos').update(cambios).eq('id', rem.id)
        if (error) throw error
      }
      if (fProv && fProv.id !== ing.proveedor_id) {
        const { error } = await supabase.from('proveedor_ingresos').update({ proveedor_id: fProv.id }).eq('id', ing.id)
        if (error) throw error
      }
      showToast(marcar === 'revisado' ? 'Marcado como revisado' : 'Cambios guardados')
      setSel(null)
      cargarIngresos()
    } catch (e: any) {
      showToast(e?.message || 'No se pudo guardar', 'err')
    } finally { setGuardando(false) }
  }

  const eliminarSel = async () => {
    if (!sel || !window.confirm('¿Eliminar este ingreso con todos sus remitos? No se puede deshacer.')) return
    if (await eliminarIngreso(sel.ing.id)) { showToast('Ingreso eliminado'); setSel(null); cargarIngresos() }
    else showToast('No se pudo eliminar', 'err')
  }

  const crearDesdeDetalle = async (nombre: string, cuit: string) => {
    const r = await crearProveedor(nombre, cuit, true, userId)
    if (r.error) { showToast(r.error, 'err'); return null }
    if (r.existente) { showToast(`Ya existe «${r.existente.nombre}», se usa ese`); return r.existente }
    await recargarProveedores()
    return r.proveedor ?? null
  }

  const exportarCSV = () => {
    const cols = ['fecha', 'hora', 'sucursal', 'proveedor', 'cuit_proveedor', 'estado_proveedor', 'origen', 'patente', 'camion_propio', 'chofer',
      'numero_remito', 'numero_leido', 'corregido_por_guardia', 'cuit_leido', 'oc_citada', 'oc_asociadas', 'sin_oc', 'fecha_remito', 'estado_remito', 'observacion_compras', 'cant_fotos',
      'recepcion', 'recepcion_nota', 'recepcion_validada_por', 'recepcion_fecha_hora', 'huemul', 'ingresos_huemul', 'huemul_marcado_por', 'huemul_marcado_en']
    const lineas = [cols.join(';')]
    for (const { ing, rem } of filas) {
      const hora = new Date(ing.hora_ingreso)
      const fila: Record<string, any> = {
        fecha: ing.fecha, hora: `${String(hora.getHours()).padStart(2, '0')}:${String(hora.getMinutes()).padStart(2, '0')}`,
        sucursal: ing.sucursal, proveedor: ing.proveedores?.nombre, cuit_proveedor: ing.proveedores?.cuit,
        estado_proveedor: ing.proveedores?.estado, origen: ing.origen, patente: ing.patente, camion_propio: ing.camion_codigo, chofer: ing.chofer,
        numero_remito: rem?.numero_remito, numero_leido: rem?.numero_remito_leido, corregido_por_guardia: rem ? (rem.remito_corregido ? 'si' : 'no') : '',
        cuit_leido: rem?.cuit_leido, oc_citada: rem?.oc_numero_leido, oc_asociadas: (rem?.proveedor_remito_ocs ?? []).map((x: any) => x.oc_id).join(' + '), sin_oc: rem ? (rem.sin_oc ? 'si' : 'no') : '', fecha_remito: rem?.fecha_remito, estado_remito: rem?.estado,
        observacion_compras: rem?.observacion_compras, cant_fotos: (rem?.fotos?.length ?? 0) + (ing.fotos_camion?.length ?? 0),
        recepcion: ing.validacion_estado ? ETIQUETA_VALIDACION[ing.validacion_estado as EstadoValidacion] : 'sin validación', recepcion_nota: ing.validacion_nota,
        recepcion_validada_por: nombresVal[ing.validado_por], recepcion_fecha_hora: ing.validado_en ? new Date(ing.validado_en).toLocaleString('es-AR') : '',
        huemul: rem && estadoDe(rem, ing) ? ESTADO_HUEMUL[estadoDe(rem, ing)!].corto : '', ingresos_huemul: ((rem ? cruceHuemul.get(rem.id)?.ingresos : undefined) ?? []).join(' + '),
        huemul_marcado_por: rem ? nombresVal[rem.huemul_cargado_por] : '', huemul_marcado_en: rem?.huemul_cargado_en ? new Date(rem.huemul_cargado_en).toLocaleString('es-AR') : '',
      }
      lineas.push(cols.map(c => csvCell(fila[c])).join(';'))
    }
    descargarCSV(lineas.join('\n'), `ingresos_proveedores_${desde}_a_${hasta}.csv`)
  }

  // ── Proveedores ──
  const provFiltrados = useMemo(() => todosProv.filter(p => {
    if (filtroProv !== 'todos' && p.estado !== filtroProv) return false
    if (filtroProv === 'todos' && p.estado === 'fusionado') return false
    if (!textoProv.trim()) return true
    const dig = soloDigitos(textoProv)
    return coincideTexto(p.nombre, textoProv) || (dig.length >= 3 && (p.cuit ?? '').includes(dig))
  }), [todosProv, filtroProv, textoProv])

  const conteo = (e: string) => todosProv.filter(p => p.estado === e).length

  const abrirEditProv = (p: any | 'nuevo') => {
    if (p === 'nuevo') { setEditProv({ id: null }); setPNombre(''); setPCuit(''); setPNotas(''); setPEstado('aprobado'); return }
    setEditProv(p); setPNombre(p.nombre); setPCuit(p.cuit ?? ''); setPNotas(p.notas ?? ''); setPEstado(p.estado)
  }

  const guardarProv = async () => {
    const nombre = pNombre.trim().replace(/\s+/g, ' ')
    if (!nombre) { showToast('Ingresá el nombre', 'err'); return }
    let cuit: string | null = null
    if (pCuit.trim()) {
      cuit = normalizarCuit(pCuit)
      if (!cuit) { showToast('El CUIT debe tener 11 dígitos', 'err'); return }
      if (!cuitValido(cuit) && !window.confirm('El dígito verificador de ese CUIT no es válido. ¿Guardarlo igual?')) return
      const otro = todosProv.find(p => p.cuit === cuit && p.id !== editProv?.id && p.estado !== 'fusionado')
      if (otro && !window.confirm(`El CUIT ya está cargado en «${otro.nombre}». ¿Guardarlo igual?`)) return
    }
    setGuardando(true)
    const fila = { nombre, cuit, notas: pNotas.trim() || null, estado: pEstado }
    const { error } = editProv?.id
      ? await supabase.from('proveedores').update(fila).eq('id', editProv.id)
      : await supabase.from('proveedores').insert({ ...fila, creado_por: userId })
    setGuardando(false)
    if (error) { showToast(error.message.includes('duplicate') ? 'Ya existe un proveedor con ese nombre' : 'No se pudo guardar', 'err'); return }
    showToast('Proveedor guardado'); setEditProv(null); cargarTodosProv(); recargarProveedores()
  }

  const aprobarProv = async (p: any) => {
    const { error } = await supabase.from('proveedores').update({ estado: 'aprobado' }).eq('id', p.id)
    if (error) { showToast('No se pudo aprobar', 'err'); return }
    showToast(`«${p.nombre}» aprobado`); cargarTodosProv(); recargarProveedores()
  }

  const confirmarFusion = async (destino: any) => {
    if (!fusion) return
    if (!window.confirm(`Todos los ingresos de «${fusion.nombre}» pasan a «${destino.nombre}», y «${fusion.nombre}» queda fusionado. ¿Confirmás?`)) return
    setGuardando(true)
    try {
      const { error: e1 } = await supabase.from('proveedor_ingresos').update({ proveedor_id: destino.id }).eq('proveedor_id', fusion.id)
      if (e1) throw e1
      if (!destino.cuit && fusion.cuit) {
        await supabase.from('proveedores').update({ cuit: fusion.cuit }).eq('id', destino.id)
      }
      const { error: e2 } = await supabase.from('proveedores').update({ estado: 'fusionado', fusionado_en: destino.id }).eq('id', fusion.id)
      if (e2) throw e2
      showToast('Proveedores fusionados'); setFusion(null); setFusionQ(''); cargarTodosProv(); recargarProveedores()
    } catch (e: any) { showToast(e?.message || 'No se pudo fusionar', 'err') }
    finally { setGuardando(false) }
  }

  if (cargando) return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontFamily: 'system-ui' }}>Cargando…</div>

  const candidatosFusion = fusion
    ? todosProv.filter(p => p.id !== fusion.id && p.estado !== 'fusionado' && (!fusionQ.trim() || coincideTexto(p.nombre, fusionQ))).slice(0, 12)
    : []

  return (
    <div style={{ minHeight: '100dvh', background: '#f4f4f3', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#254A96', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, maxWidth: 1200, margin: '0 auto' }}>
          {rol !== 'compras' && (
            <button onClick={() => router.push('/dashboard')} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 10, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>← Dashboard</button>
          )}
          <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>🧾 Compras</h1>
          {rol === 'compras' && (
            <button onClick={async () => { await supabase.auth.signOut(); router.push('/') }}
              style={{ marginLeft: 'auto', background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 10, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Salir</button>
          )}
        </div>
      </div>

      <div style={{ padding: '16px 14px 40px', maxWidth: 1200, margin: '0 auto' }}>
        {toast && (
          <div style={{ position: 'fixed', top: 76, left: '50%', transform: 'translateX(-50%)', zIndex: 400, background: toast.tipo === 'ok' ? '#166534' : '#991b1b', color: '#fff', padding: '12px 20px', borderRadius: 12, fontSize: 14, fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', maxWidth: '92vw' }}>{toast.msg}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {([['ingresos', '📥 Ingresos'], ['oc', '📑 Órdenes de compra'], ['proveedores', '🏢 Proveedores']] as [Tab, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{
              padding: '11px 20px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
              border: tab === k ? '2px solid #254A96' : '1.5px solid #e0e0e0', background: tab === k ? '#254A96' : '#fff', color: tab === k ? '#fff' : '#666',
            }}>{l}</button>
          ))}
        </div>

        {/* ───────── INGRESOS ───────── */}
        {tab === 'ingresos' && (
          <>
            <ImportadorHuemul puedeEd={puedeEd} showToast={showToast} onImportado={() => setRefreshHuemul(k => k + 1)} />
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {([['guardia', '📋 Remitos de guardia sin cargar en Huemul'], ['huemul', '📦 Ingresos de Huemul']] as ['guardia' | 'huemul', string][]).map(([k, l]) => (
                <button key={k} onClick={() => setSubIng(k)} style={{
                  flex: 1, padding: '10px 8px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  border: subIng === k ? '2px solid #254A96' : '1.5px solid #e0e0e0', background: subIng === k ? '#eef2fb' : '#fff', color: subIng === k ? '#254A96' : '#666',
                }}>{l}</button>
              ))}
            </div>
            {subIng === 'huemul' && <ListaIngresosHuemul showToast={showToast} refreshKey={refreshHuemul} />}
            {subIng === 'guardia' && (
            <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
              <input type="date" value={desde} onChange={e => setDesde(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
              <input type="date" value={hasta} onChange={e => setHasta(e.target.value)} style={{ ...inputSt, width: 'auto' }} />
              <select value={sucursal} onChange={e => setSucursal(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
              </select>
              <select value={estadoRem} onChange={e => setEstadoRem(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                <option value="todos">Todos los estados</option><option value="registrado">Por revisar</option><option value="revisado">Revisado</option>
              </select>
              <select value={filtroOC} onChange={e => setFiltroOC(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                <option value="todos">Con y sin OC</option><option value="sin">OC sin asociar</option><option value="asociadas">OC asociada</option><option value="sinoc">Marcados sin OC</option>
              </select>
              <select value={filtroHuemul} onChange={e => setFiltroHuemul(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                <option value="todos">Todos (cargados y sin cargar en Huemul)</option><option value="sin_cargar">❌ Sin cargar en Huemul</option><option value="espera_validacion">⏳ Esperando validación de depósito</option><option value="marcado">🟡 Marcados como cargados (falta confirmar)</option><option value="cargado">✅ Confirmados en el export</option><option value="sin_numero">❓ Sin número</option>
              </select>
              <select value={filtroRecep} onChange={e => setFiltroRecep(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                <option value="todos">Toda recepción</option><option value="con_rotura">⚠️ Con rotura</option><option value="pendiente">⏳ Pendiente de recepción</option><option value="ok">✅ Recibido OK</option>
              </select>
              <select value={origen} onChange={e => setOrigen(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                <option value="todos">Externo y propio</option><option value="externo">Externo</option><option value="propio">Propio</option>
              </select>
              <input value={texto} onChange={e => setTexto(e.target.value)} placeholder="🔍 Proveedor, remito, patente…" style={{ ...inputSt, flex: 1, minWidth: 200, width: 'auto' }} />
              <button onClick={exportarCSV} disabled={!filas.length} style={{ ...btnLine, opacity: filas.length ? 1 : 0.5 }}>↓ CSV</button>
            </div>
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1140 }}>
                  <thead><tr>{['Fecha / hora', 'Sucursal', 'Proveedor', 'Origen', 'N° remito', 'OC', 'Huemul', 'Aviso', 'Estado', 'Recepción', 'Fotos'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {filas.map(({ ing, rem }, i) => {
                      const av = aviso(ing, rem)
                      const nFotos = (rem?.fotos?.length ?? 0) + (ing.fotos_camion?.length ?? 0)
                      return (
                        <tr key={`${ing.id}-${rem?.id ?? i}`} onClick={() => abrirDetalle({ ing, rem })} style={{ cursor: 'pointer' }}>
                          <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtFechaHora(ing.hora_ingreso)}</td>
                          <td style={td}>{ing.sucursal}</td>
                          <td style={td}><b>{ing.proveedores?.nombre ?? '—'}</b> {ing.proveedores && ing.proveedores.estado !== 'aprobado' && badgeProv(ing.proveedores.estado)}</td>
                          <td style={td}>{ing.origen === 'propio' ? `Propio · ${ing.camion_codigo ?? ''}` : `Externo${ing.patente ? ` · ${ing.patente}` : ''}`}</td>
                          <td style={td}>
                            <b>{rem?.numero_remito ?? '—'}</b>
                            {rem?.remito_corregido && <div style={{ fontSize: 11, color: '#92400e' }}>✎ corregido por guardia (leído: {rem.numero_remito_leido})</div>}
                          </td>
                          <td style={td}>{(rem?.proveedor_remito_ocs?.length ?? 0) > 0 ? <b>{rem.proveedor_remito_ocs.map((x: any) => `OC ${x.oc_id}`).join(' + ')}</b> : rem?.sin_oc ? <span style={{ color: '#666' }}>Sin OC</span> : <span style={{ color: '#aaa' }}>sin asociar</span>}</td>
                          <td style={td}>
                            <BadgeHuemul estado={estadoDe(rem, ing)} ingresos={rem ? cruceHuemul.get(rem.id)?.ingresos : undefined} marca={rem ? { por: nombresVal[rem.huemul_cargado_por] ?? null, en: rem.huemul_cargado_en } : undefined} />
                            {puedeMarcar && rem && estadoDe(rem, ing) !== 'cargado' && estadoDe(rem, ing) !== 'espera_validacion' && (
                              <div><CheckHuemul marcado={!!rem.huemul_cargado_en} trabajando={marcando === rem.id} onCambiar={v => marcarHuemul(rem, v)} /></div>
                            )}
                          </td>
                          <td style={{ ...td, color: av?.rojo ? '#b91c1c' : '#92400e', fontSize: 12 }}>{av?.texto ?? ''}</td>
                          <td style={td}><span style={{ background: rem?.estado === 'revisado' ? '#ecfdf5' : '#fffbeb', color: rem?.estado === 'revisado' ? '#065f46' : '#92400e', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>{rem?.estado === 'revisado' ? 'Revisado' : 'Por revisar'}</span></td>
                          <td style={td}>{ing.validacion_estado ? <span style={{ borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', background: ing.validacion_estado === 'con_rotura' ? '#fef2f2' : ing.validacion_estado === 'ok' ? '#ecfdf5' : '#fffbeb', color: ing.validacion_estado === 'con_rotura' ? '#b91c1c' : ing.validacion_estado === 'ok' ? '#065f46' : '#92400e' }}>{ETIQUETA_VALIDACION[ing.validacion_estado as EstadoValidacion]}</span> : <span style={{ color: '#B9BBB7' }}>—</span>}{ing.validacion_estado === 'con_rotura' && ing.validacion_nota && <div style={{ marginTop: 4, fontSize: 15, fontWeight: 800, color: '#b91c1c', maxWidth: 220, overflowWrap: 'anywhere' }}>{ing.validacion_nota}</div>}</td>
                          <td style={td}>📷 {nFotos}</td>
                        </tr>
                      )
                    })}
                    {filas.length === 0 && <tr><td colSpan={11} style={{ ...td, textAlign: 'center', color: '#B9BBB7', padding: 28 }}>{cargandoIng ? 'Cargando…' : 'Sin ingresos para los filtros elegidos'}</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            </>
            )}
          </>
        )}

        {/* ───────── PROVEEDORES ───────── */}

        {tab === 'oc' && <OrdenesCompra puedeEd={puedeEd} showToast={showToast} onImportado={() => { recargarProveedores(); cargarTodosProv() }} />}

        {tab === 'proveedores' && (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {[['Aprobados', conteo('aprobado'), '#065f46'], ['Pendientes', conteo('pendiente'), '#92400e'], ['A revisar', conteo('revisar'), '#b91c1c']].map(([l, n, c]) => (
                <div key={l as string} style={{ flex: '1 1 140px', background: '#fff', border: '1px solid #e0e0e0', borderRadius: 14, padding: '12px 14px' }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: c as string }}>{n}</div><div style={{ fontSize: 12, color: '#777' }}>{l}</div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <select value={filtroProv} onChange={e => setFiltroProv(e.target.value)} style={{ ...inputSt, width: 'auto' }}>
                <option value="todos">Todos</option><option value="pendiente">Pendientes</option><option value="revisar">A revisar</option><option value="aprobado">Aprobados</option><option value="fusionado">Fusionados</option>
              </select>
              <input value={textoProv} onChange={e => setTextoProv(e.target.value)} placeholder="🔍 Nombre o CUIT…" style={{ ...inputSt, flex: 1, minWidth: 200, width: 'auto' }} />
              {puedeEd && <button onClick={() => abrirEditProv('nuevo')} style={btn()}>＋ Nuevo proveedor</button>}
            </div>
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
                  <thead><tr>{['Proveedor', 'CUIT', 'Estado', 'Nota', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {provFiltrados.map(p => (
                      <tr key={p.id}>
                        <td style={td}><b>{p.nombre}</b></td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>{p.cuit ? formatCuit(p.cuit) : <span style={{ color: '#aaa' }}>—</span>}{p.cuit && !cuitValido(p.cuit) && <div style={{ fontSize: 11, color: '#b91c1c' }}>dígito verificador inválido</div>}</td>
                        <td style={td}>{badgeProv(p.estado)}</td>
                        <td style={{ ...td, fontSize: 12, color: '#666' }}>{p.notas}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          {puedeEd && p.estado !== 'fusionado' && (
                            <>
                              {(p.estado === 'pendiente' || p.estado === 'revisar') && <button onClick={() => aprobarProv(p)} style={{ ...btn('#059669'), padding: '6px 12px', fontSize: 13, marginRight: 6 }}>Aprobar</button>}
                              <button onClick={() => abrirEditProv(p)} style={{ ...btnLine, marginRight: 6 }}>Editar</button>
                              <button onClick={() => { setFusion(p); setFusionQ('') }} style={btnLine}>Fusionar en…</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                    {provFiltrados.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: 'center', color: '#B9BBB7', padding: 28 }}>Sin proveedores para ese filtro</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ───────── MODAL DETALLE INGRESO ───────── */}
      {sel && (
        <div onClick={() => !guardando && setSel(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, overflowY: 'auto', padding: '24px 14px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#f4f4f3', maxWidth: 920, margin: '0 auto', borderRadius: 18, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 18, fontWeight: 800 }}>{sel.ing.proveedores?.nombre ?? 'Proveedor'}</div>
                  <span style={{ background: '#254A96', color: '#fff', borderRadius: 10, padding: '3px 14px', fontSize: 22, fontWeight: 900, letterSpacing: '.02em' }}>{sel.ing.sucursal}</span>
                </div>
                <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>
                  {fmtFechaHora(sel.ing.hora_ingreso)} · {sel.ing.origen === 'propio' ? `Camión propio ${sel.ing.camion_codigo ?? ''}` : `Externo${sel.ing.patente ? ` · ${sel.ing.patente}` : ''}`}{sel.ing.chofer ? ` · ${sel.ing.chofer}` : ''}
                </div>
              </div>
              <button onClick={() => setSel(null)} style={btnLine}>✕</button>
            </div>

            {(() => { const av = aviso(sel.ing, sel.rem); return av ? <div style={{ background: av.rojo ? '#fef2f2' : '#fffbeb', border: `1px solid ${av.rojo ? '#fecaca' : '#fde68a'}`, color: av.rojo ? '#b91c1c' : '#92400e', borderRadius: 10, padding: '9px 12px', fontSize: 13, marginBottom: 12 }}>⚠ {av.texto}</div> : null })()}

            <div style={card}>
              <label style={labelSt}>Fotos</label>
              {!fotos && <div style={{ fontSize: 13, color: '#999' }}>Cargando fotos…</div>}
              {fotos && fotos.camion.length + fotos.remito.length === 0 && <div style={{ fontSize: 13, color: '#999' }}>Sin fotos</div>}
              {fotos && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {fotos.remito.map((u, i) => <img key={`r${i}`} src={u} alt="remito" title="Tocá para ampliar" onClick={() => setFotoGrande({ urls: [...fotos.remito, ...fotos.camion], i })} style={{ width: 130, height: 130, objectFit: 'cover', borderRadius: 10, border: '1px solid #ddd', cursor: 'zoom-in' }} />)}
                  {fotos.camion.map((u, i) => <img key={`c${i}`} src={u} alt="camión" title="Tocá para ampliar" onClick={() => setFotoGrande({ urls: [...fotos.remito, ...fotos.camion], i: fotos.remito.length + i })} style={{ width: 130, height: 130, objectFit: 'cover', borderRadius: 10, border: '1px solid #ddd', cursor: 'zoom-in' }} />)}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>Tocá una foto para verla grande.</div>
            </div>

            {sel.rem && (
              <div style={card}>
                <label style={labelSt}>Huemul</label>
                <BadgeHuemul estado={estadoDe(sel.rem, sel.ing)} ingresos={cruceHuemul.get(sel.rem.id)?.ingresos} marca={{ por: nombresVal[sel.rem.huemul_cargado_por] ?? null, en: sel.rem.huemul_cargado_en }} />
                {puedeMarcar && estadoDe(sel.rem, sel.ing) !== 'cargado' && estadoDe(sel.rem, sel.ing) !== 'espera_validacion' && (
                  <div><CheckHuemul grande marcado={!!sel.rem.huemul_cargado_en} trabajando={marcando === sel.rem.id} onCambiar={v => marcarHuemul(sel.rem, v)} /></div>
                )}
              </div>
            )}

            {sel.ing.validacion_estado && (
              <div style={{ ...card, borderColor: sel.ing.validacion_estado === 'con_rotura' ? '#fecaca' : undefined, background: sel.ing.validacion_estado === 'con_rotura' ? '#fef2f2' : undefined }}>
                <label style={labelSt}>Recepción en depósito</label>
                <div style={{ fontSize: 14, fontWeight: 700, color: sel.ing.validacion_estado === 'con_rotura' ? '#b91c1c' : sel.ing.validacion_estado === 'ok' ? '#065f46' : '#92400e' }}>
                  {ETIQUETA_VALIDACION[sel.ing.validacion_estado as EstadoValidacion]}
                </div>
                {sel.ing.validado_en && (
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    Validó {nombresVal[sel.ing.validado_por] ?? '—'} · {new Date(sel.ing.validado_en).toLocaleString('es-AR')}
                  </div>
                )}
                {sel.ing.validacion_nota && (
                  <div style={{ margin: '10px 0 0', background: '#fff', border: '2px solid #dc2626', borderRadius: 12, padding: '10px 14px' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '.06em' }}>Mercadería rota</div>
                    <div style={{ fontSize: 28, fontWeight: 900, color: '#b91c1c', lineHeight: 1.2, marginTop: 2, overflowWrap: 'anywhere' }}>{sel.ing.validacion_nota}</div>
                  </div>
                )}
                {fotosVal.length > 0 && (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                    {fotosVal.map((u, i) => <img key={i} src={u} alt="rotura" title="Tocá para ampliar" onClick={() => setFotoGrande({ urls: fotosVal, i })} style={{ width: 110, height: 110, objectFit: 'cover', borderRadius: 10, border: '1px solid #ddd', cursor: 'zoom-in' }} />)}
                  </div>
                )}
              </div>
            )}

            {sel.rem && (
              <div style={card}>
                <label style={labelSt}>Lo que leyó el sistema</label>
                <div style={{ fontSize: 13, lineHeight: 1.7 }}>
                  <div><b>N° remito:</b> {sel.rem.numero_remito_leido ?? 'no se leyó'}</div>
                  <div><b>CUIT:</b> {sel.rem.cuit_leido ? `${formatCuit(sel.rem.cuit_leido)}${sel.rem.proveedor_leido ? ` · ${sel.rem.proveedor_leido}` : ''}` : '—'}</div>
                  <div><b>Fecha del remito:</b> {sel.rem.fecha_remito ? fmtFecha(sel.rem.fecha_remito) : '—'}</div>
                  <div><b>OC citada:</b> {sel.rem.oc_numero_leido ?? '—'}</div>
                </div>
              </div>
            )}

            {sel.rem && (
              <ProductosRemito key={sel.rem.id} remito={sel.rem} proveedorId={fProv?.id ?? sel.ing.proveedor_id} userId={userId} puedeEd={puedeEd} showToast={showToast} onItems={setItemsRemito} recargarKey={recargarItems} />
            )}
            {sel.rem && (
              <AsociarOC key={`oc-${sel.rem.id}`} ing={sel.ing} rem={sel.rem} items={itemsRemito} userId={userId} puedeEd={puedeEd} showToast={showToast} onItemsAgregados={() => setRecargarItems(k => k + 1)}
                onChanged={({ oc_ids, sin_oc }) => {
                  const cambios = { sin_oc, proveedor_remito_ocs: oc_ids.map(oc_id => ({ oc_id })) }
                  setSel(prev => prev ? { ...prev, rem: { ...prev.rem, ...cambios } } : prev)
                  setIngresos(prev => prev.map(i => i.id === sel.ing.id ? { ...i, proveedor_remitos: (i.proveedor_remitos ?? []).map((r: any) => r.id === sel.rem.id ? { ...r, ...cambios } : r) } : i))
                }} />
            )}

            <div style={card}>
              {sel.rem && (<>
                <label style={labelSt}>Número de remito</label>
                <input value={fNumero} onChange={e => setFNumero(e.target.value)} onBlur={() => fNumero.trim() && setFNumero(normalizarRemito(fNumero).valor)} style={{ ...inputSt, fontWeight: 800, fontSize: 16 }} disabled={!puedeEd} />
              </>)}
              <label style={{ ...labelSt, marginTop: 14 }}>Proveedor</label>
              {puedeEd
                ? <ProveedorPicker proveedores={proveedoresLista} value={fProv} onChange={setFProv} onCrear={crearDesdeDetalle} />
                : <div style={{ fontSize: 14 }}>{fProv?.nombre}</div>}
              <label style={{ ...labelSt, marginTop: 14 }}>Observación de compras</label>
              <textarea value={fObs} onChange={e => setFObs(e.target.value)} rows={2} style={{ ...inputSt, resize: 'none' }} disabled={!puedeEd} />
              {sel.ing.observacion && <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>📝 Observación del guardia: {sel.ing.observacion}</div>}
            </div>

            {puedeEd && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {sel.rem?.estado === 'revisado'
                  ? <button onClick={() => guardarDetalle('registrado')} disabled={guardando} style={btnLine}>↩ Reabrir</button>
                  : <button onClick={() => guardarDetalle('revisado')} disabled={guardando || !sel.rem} style={{ ...btn('#059669'), opacity: guardando ? 0.6 : 1 }}>✔ Marcar revisado</button>}
                <button onClick={() => guardarDetalle()} disabled={guardando} style={{ ...btn(), opacity: guardando ? 0.6 : 1 }}>Guardar cambios</button>
                <button onClick={eliminarSel} style={{ ...btnLine, marginLeft: 'auto', color: '#991b1b' }}>🗑 Eliminar</button>
              </div>
            )}
          </div>
        </div>
      )}

      {fotoGrande && <VisorFotoGrande urls={fotoGrande.urls} inicio={fotoGrande.i} onCerrar={() => setFotoGrande(null)} />}

      {/* ───────── MODAL EDITAR PROVEEDOR ───────── */}
      {editProv && (
        <div onClick={() => !guardando && setEditProv(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, overflowY: 'auto', padding: '40px 14px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', maxWidth: 480, margin: '0 auto', borderRadius: 18, padding: 20 }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 14 }}>{editProv.id ? 'Editar proveedor' : 'Nuevo proveedor'}</div>
            <label style={labelSt}>Nombre</label>
            <input value={pNombre} onChange={e => setPNombre(e.target.value)} style={inputSt} />
            <label style={{ ...labelSt, marginTop: 12 }}>CUIT</label>
            <input value={pCuit} onChange={e => setPCuit(e.target.value)} placeholder="30-12345678-9" style={inputSt} inputMode="numeric" />
            <label style={{ ...labelSt, marginTop: 12 }}>Estado</label>
            <select value={pEstado} onChange={e => setPEstado(e.target.value)} style={inputSt}>
              <option value="aprobado">Aprobado</option><option value="pendiente">Pendiente</option><option value="revisar">A revisar</option>
            </select>
            <label style={{ ...labelSt, marginTop: 12 }}>Notas</label>
            <textarea value={pNotas} onChange={e => setPNotas(e.target.value)} rows={2} style={{ ...inputSt, resize: 'none' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button onClick={guardarProv} disabled={guardando} style={{ ...btn(), flex: 1, opacity: guardando ? 0.6 : 1 }}>Guardar</button>
              <button onClick={() => setEditProv(null)} style={btnLine}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ───────── MODAL FUSIONAR ───────── */}
      {fusion && (
        <div onClick={() => !guardando && setFusion(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 200, overflowY: 'auto', padding: '40px 14px' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', maxWidth: 480, margin: '0 auto', borderRadius: 18, padding: 20 }}>
            <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Fusionar «{fusion.nombre}»</div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>Elegí el proveedor correcto. Sus ingresos se pasan a ese y este queda como fusionado.</div>
            <input value={fusionQ} onChange={e => setFusionQ(e.target.value)} placeholder="🔍 Buscar proveedor destino…" style={inputSt} autoFocus />
            <div style={{ marginTop: 8, maxHeight: 280, overflowY: 'auto', border: '1px solid #eee', borderRadius: 10 }}>
              {candidatosFusion.map(p => (
                <div key={p.id} onClick={() => confirmarFusion(p)} style={{ padding: '10px 12px', borderBottom: '1px solid #f3f3f3', cursor: 'pointer', fontSize: 14 }}>
                  {p.nombre} <span style={{ fontSize: 11, color: '#888' }}>{p.cuit ? formatCuit(p.cuit) : 'sin CUIT'}</span>
                </div>
              ))}
              {candidatosFusion.length === 0 && <div style={{ padding: 14, fontSize: 13, color: '#999' }}>Sin resultados</div>}
            </div>
            <button onClick={() => setFusion(null)} style={{ ...btnLine, marginTop: 14 }}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  )
}
