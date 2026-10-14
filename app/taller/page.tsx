'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../supabase'
import { puedeEditar } from '../lib/permisos'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']
const TOLERANCIA_MIN = 10
const MAX_FOTOS = 5

const GRUPOS = [
  { key: 'service', label: '🛢️ Service' },
  { key: 'camion', label: '🚛 Camión' },
  { key: 'hidrogrua', label: '🏗️ Hidrogrúa' },
  { key: 'acoplado', label: '🔗 Acoplado' },
  { key: 'autoelevador', label: '📦 Autoelevador' },
  { key: 'pala', label: '🚜 Pala cargadora' },
  { key: 'puente_grua', label: '🏗️ Puente grúa' },
  { key: 'general', label: '🏭 General' },
]

const TIPOS = [
  { key: 'preventivo', label: 'Preventivo', icon: '🔧', color: '#059669', bg: '#ecfdf5' },
  { key: 'correctivo', label: 'Correctivo', icon: '⚙️', color: '#254A96', bg: '#eef2fb' },
  { key: 'auxilio', label: 'Auxilio', icon: '🆘', color: '#d97706', bg: '#fffbeb' },
]

const MOTIVOS = [
  'Almuerzo / descanso',
  'Esperando repuesto',
  'Esperando herramienta o equipo',
  'Atendió otra urgencia',
  'Tareas hechas en paralelo (varios mecánicos)',
  'Continuó otro día',
  'Se olvidó de iniciar o cerrar a tiempo',
  'Otro',
]

type Tab = 'abiertas' | 'nueva' | 'actividad' | 'catalogo'

interface CatItem {
  id: string; grupo: string; sistema: string; nombre: string
  minutos_estandar: number | null; orden: number; activo: boolean
}
interface Mecanico { id: string; nombre: string; sucursal: string | null; activo: boolean }
type TipoTaller = 'autoelevador' | 'pala' | 'puente_grua' | 'acoplado'
interface Equipo { id: string; codigo: string; tipo: TipoTaller; sucursal: string | null; activo: boolean }
type TipoEquipo = 'camion' | TipoTaller | 'externo'
const TIPOS_TALLER: { key: TipoTaller; label: string; plural: string; icon: string; prefijo: string }[] = [
  { key: 'autoelevador', label: 'Autoelevador', plural: 'Autoelevadores', icon: '📦', prefijo: 'SA' },
  { key: 'pala', label: 'Pala cargadora', plural: 'Palas cargadoras', icon: '🚜', prefijo: 'CF' },
  { key: 'puente_grua', label: 'Puente grúa', plural: 'Puentes grúa', icon: '🏗️', prefijo: 'PG' },
  { key: 'acoplado', label: 'Carro / semi', plural: 'Carros y semis (SC, SP)', icon: '🔗', prefijo: 'SC' },
]

// Qué grupos de tareas se ofrecen según el equipo (Service y General sirven para todos)
const GRUPOS_POR_EQUIPO: Record<TipoEquipo, string[]> = {
  camion: ['service', 'camion', 'hidrogrua', 'acoplado', 'general'],
  autoelevador: ['service', 'autoelevador', 'general'],
  pala: ['service', 'pala', 'general'],
  puente_grua: ['puente_grua', 'general'],
  acoplado: ['service', 'acoplado', 'general'],
  externo: ['service', 'camion', 'hidrogrua', 'acoplado', 'autoelevador', 'pala', 'puente_grua', 'general'],
}
interface Tarea {
  id: string; orden_id: string; catalogo_id: string | null; grupo: string; sistema: string
  nombre: string; personalizada: boolean; minutos: number | null; minutos_estandar: number | null
}
interface Orden {
  id: string; created_at: string; fecha: string; sucursal: string; unidad_codigo: string
  unidad_externa: boolean; tipo: string; estado: string; inicio: string; fin: string | null
  minutos_transcurridos: number | null; minutos_trabajados: number | null
  diferencia_min: number | null; motivo_diferencia: string | null; mecanicos: string[]
  observacion: string | null; observacion_cierre: string | null
  fotos_antes: string[]; fotos_despues: string[]
  registrado_por: string | null; cerrado_por: string | null
  taller_orden_tareas?: Tarea[]
  tipo_equipo?: string | null
  editado_por?: string | null; editado_en?: string | null
}
interface SelTarea {
  catalogo_id: string | null; grupo: string; sistema: string; nombre: string
  personalizada: boolean; minutos_estandar: number | null
}
interface FotoItem { file: File; preview: string }

const pad = (n: number) => String(n).padStart(2, '0')
const fechaLocal = (d: Date = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const valorDatetimeLocal = (d: Date = new Date()) => `${fechaLocal(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const hhmm = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const ddmm = (iso: string) => { const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` }
const minutosEntre = (a: string | number | Date, b: string | number | Date) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000)

function fmtDur(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—'
  const neg = min < 0
  const m = Math.abs(min)
  const txt = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
  return neg ? `-${txt}` : txt
}

function fmtFin(o: Orden): string {
  if (!o.fin) return '—'
  return fechaLocal(new Date(o.inicio)) === fechaLocal(new Date(o.fin)) ? hhmm(o.fin) : `${ddmm(o.fin)} ${hhmm(o.fin)}`
}

const tareasDe = (o: Orden): Tarea[] => o.taller_orden_tareas ?? []
const tipoInfo = (k: string) => TIPOS.find(t => t.key === k) ?? TIPOS[1]

const comprimirFoto = (file: File): Promise<File> =>
  new Promise(resolve => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const MAX_PX = 1600
      let { width, height } = img
      if (width > MAX_PX || height > MAX_PX) {
        if (width > height) { height = Math.round(height * MAX_PX / width); width = MAX_PX }
        else { width = Math.round(width * MAX_PX / height); height = MAX_PX }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d')!.drawImage(img, 0, 0, width, height)
      canvas.toBlob(blob => {
        resolve(blob ? new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }) : file)
      }, 'image/jpeg', 0.82)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })

function descargarCSV(content: string, nombre: string) {
  const blob = new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = nombre; a.click()
  URL.revokeObjectURL(url)
}

const csvCell = (v: any): string => {
  const s = String(v ?? '').replace(/"/g, '""')
  return s.includes(';') || s.includes('\n') || s.includes('"') ? `"${s}"` : s
}
const decimalAR = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',')

const card: React.CSSProperties = { background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: '16px', marginBottom: 14 }
const labelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 8 }
const inputSt: React.CSSProperties = { width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #d6d6d6', fontSize: 15, background: '#fff', boxSizing: 'border-box', fontFamily: 'inherit' }
const btnPrimary: React.CSSProperties = { width: '100%', padding: 15, borderRadius: 12, border: 'none', background: '#254A96', color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer' }
const btnSecondary: React.CSSProperties = { width: '100%', padding: 13, borderRadius: 12, border: '1.5px solid #d6d6d6', background: '#fff', color: '#666', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 8 }
const chip = (on: boolean, color = '#254A96'): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 20, fontSize: 14, fontWeight: 600, cursor: 'pointer',
  border: `1.5px solid ${on ? color : '#d6d6d6'}`, background: on ? color : '#fff', color: on ? '#fff' : '#555',
})

export default function TallerPage() {
  const router = useRouter()
  const [cargando, setCargando] = useState(true)
  const [userId, setUserId] = useState<string | null>(null)
  const [rol, setRol] = useState('')
  const [permisos, setPermisos] = useState<Record<string, string> | null>(null)
  const [sucursal, setSucursal] = useState('Guernica')
  const [tab, setTab] = useState<Tab>('abiertas')
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [ahora, setAhora] = useState(Date.now())

  const [catalogo, setCatalogo] = useState<CatItem[]>([])
  const [mecanicos, setMecanicos] = useState<Mecanico[]>([])
  const [camiones, setCamiones] = useState<string[]>([])
  const [equipos, setEquipos] = useState<Equipo[]>([])
  const [nuevoEquipo, setNuevoEquipo] = useState<{ prefijo: string; numero: string; tipo: TipoTaller }>({ prefijo: 'SA', numero: '', tipo: 'autoelevador' })
  // Edición de una orden (solo administradores)
  const [edicion, setEdicion] = useState<null | {
    o: Orden; unidad: string; tipo: string; fecha: string; inicioStr: string; finStr: string
    mecs: string[]; obs: string; obsCierre: string; motivo: string; mins: Record<string, string>; quitadas: Set<string>
  }>(null)
  const [abiertas, setAbiertas] = useState<Orden[]>([])
  const [dia, setDia] = useState(fechaLocal())
  const [ordenesDia, setOrdenesDia] = useState<Orden[]>([])
  const [cargandoDia, setCargandoDia] = useState(false)
  const [visor, setVisor] = useState<{ titulo: string; fotos: { url: string; label: string }[] } | null>(null)

  // Nueva orden
  const [unidad, setUnidad] = useState('')
  const [externa, setExterna] = useState(false)
  const [extPref, setExtPref] = useState('')
  const [extNum, setExtNum] = useState('')
  const [buscaUnidad, setBuscaUnidad] = useState('')
  const [tipo, setTipo] = useState('')
  const [inicioStr, setInicioStr] = useState(valorDatetimeLocal())
  const [mecSel, setMecSel] = useState<string[]>([])
  const [nuevoMec, setNuevoMec] = useState('')
  const [sel, setSel] = useState<Record<string, SelTarea>>({})
  const [grupoTab, setGrupoTab] = useState('service')
  const [busqueda, setBusqueda] = useState('')
  const [customTxt, setCustomTxt] = useState('')
  const [obs, setObs] = useState('')
  const [fotosAntes, setFotosAntes] = useState<FotoItem[]>([])
  const [guardando, setGuardando] = useState(false)

  // Cierre
  const [cierre, setCierre] = useState<Orden | null>(null)
  const [finStr, setFinStr] = useState('')
  const [minTarea, setMinTarea] = useState<Record<string, string>>({})
  const [quitadas, setQuitadas] = useState<Set<string>>(new Set())
  const [extras, setExtras] = useState<{ id: string; nombre: string }[]>([])
  const [extraTxt, setExtraTxt] = useState('')
  const [motivoSel, setMotivoSel] = useState('')
  const [motivoTxt, setMotivoTxt] = useState('')
  const [obsCierre, setObsCierre] = useState('')
  const [fotosDespues, setFotosDespues] = useState<FotoItem[]>([])

  // Export / catálogo
  const [expDesde, setExpDesde] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 30); return fechaLocal(d) })
  const [expHasta, setExpHasta] = useState(fechaLocal())
  const [expSucursal, setExpSucursal] = useState('Guernica')
  const [exportando, setExportando] = useState(false)
  const [catGrupo, setCatGrupo] = useState('service')
  const [nuevoCat, setNuevoCat] = useState({ sistema: '', nombre: '', minutos: '' })
  const [catNueva, setCatNueva] = useState(false)
  const [nuevoMecAdmin, setNuevoMecAdmin] = useState('')

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo })
    setTimeout(() => setToast(null), 3200)
  }

  const esAdmin = ['gerencia', 'admin_flota', 'admin_taller'].includes(rol)
  const puedeEd = puedeEditar(permisos, rol, 'taller')

  const cargarCatalogo = useCallback(async () => {
    const { data } = await supabase.from('taller_catalogo').select('*').order('grupo').order('sistema').order('orden')
    setCatalogo((data ?? []) as CatItem[])
  }, [])

  const cargarMecanicos = useCallback(async () => {
    const { data } = await supabase.from('taller_mecanicos').select('*').order('nombre')
    setMecanicos((data ?? []) as Mecanico[])
  }, [])

  const cargarAbiertas = useCallback(async (suc: string) => {
    const { data } = await supabase.from('taller_ordenes')
      .select('*, taller_orden_tareas(*)')
      .eq('estado', 'abierta').eq('sucursal', suc).order('inicio', { ascending: true })
    setAbiertas((data ?? []) as Orden[])
  }, [])

  const cargarDia = useCallback(async (suc: string, fecha: string) => {
    setCargandoDia(true)
    const { data } = await supabase.from('taller_ordenes')
      .select('*, taller_orden_tareas(*)')
      .eq('fecha', fecha).eq('sucursal', suc).order('inicio', { ascending: true })
    setOrdenesDia((data ?? []) as Orden[])
    setCargandoDia(false)
  }, [])

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/'); return }
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/mi-perfil', {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      })
      const { perfil } = await res.json()
      const r = perfil?.rol ?? ''
      const acceso = ['gerencia', 'admin_flota', 'admin_taller', 'mecanico'].includes(r) || (perfil?.permisos && perfil.permisos.taller && perfil.permisos.taller !== 'none')
      if (!acceso || perfil?.permisos?.taller === 'none') { router.push('/dashboard'); return }
      setUserId(user.id); setRol(r); setPermisos(perfil?.permisos ?? null)
      const suc = SUCURSALES.includes(perfil?.sucursal) ? perfil.sucursal : 'Guernica'
      setSucursal(suc); setExpSucursal(suc)
      const { data: flota } = await supabase.from('camiones_flota').select('codigo').order('codigo')
      setCamiones((flota ?? []).map((c: any) => c.codigo))
      const { data: eq } = await supabase.from('taller_equipos').select('*').order('tipo').order('codigo')
      setEquipos((eq ?? []) as Equipo[])
      await Promise.all([cargarCatalogo(), cargarMecanicos()])
      setCargando(false)
    })()
  }, [])

  useEffect(() => { if (!cargando) cargarAbiertas(sucursal) }, [cargando, sucursal, cargarAbiertas])
  useEffect(() => { if (!cargando && tab === 'actividad') cargarDia(sucursal, dia) }, [cargando, tab, sucursal, dia, cargarDia])
  useEffect(() => { const t = setInterval(() => setAhora(Date.now()), 30000); return () => clearInterval(t) }, [])

  const catActivo = useMemo(() => catalogo.filter(c => c.activo), [catalogo])

  const tipoEquipoDe = useCallback((codigo: string, esExterna: boolean): TipoEquipo => {
    if (esExterna) return 'externo'
    return equipos.find(e => e.codigo === codigo)?.tipo ?? 'camion'
  }, [equipos])
  const tipoActual = tipoEquipoDe(unidad, externa)
  const gruposVisibles = useMemo(() => GRUPOS.filter(g => GRUPOS_POR_EQUIPO[tipoActual].includes(g.key)), [tipoActual])
  useEffect(() => {
    // Al elegir un autoelevador o una pala se muestran sus tareas; si el grupo abierto ya no corresponde, se pasa a uno válido
    if (tipoActual !== 'camion' && tipoActual !== 'externo') setGrupoTab(tipoActual === 'acoplado' ? 'acoplado' : tipoActual)
    else if (!gruposVisibles.some(g => g.key === grupoTab)) setGrupoTab('service')
  }, [tipoActual]) // eslint-disable-line react-hooks/exhaustive-deps
  const mecanicosActivos = useMemo(
    () => mecanicos.filter(m => m.activo && (!m.sucursal || m.sucursal === sucursal)),
    [mecanicos, sucursal]
  )

  const sistemasDeGrupo = (items: CatItem[], grupo: string): [string, CatItem[]][] => {
    const m = new Map<string, CatItem[]>()
    for (const c of items.filter(i => i.grupo === grupo)) {
      if (!m.has(c.sistema)) m.set(c.sistema, [])
      m.get(c.sistema)!.push(c)
    }
    return Array.from(m.entries())
  }

  const subirFotos = async (fotos: FotoItem[], ordenId: string, prefijo: string): Promise<string[]> => {
    const urls: string[] = []
    for (let i = 0; i < fotos.length; i++) {
      const path = `${ordenId}/${prefijo}_${i}.jpg`
      const { error } = await supabase.storage.from('taller-fotos').upload(path, fotos[i].file, { upsert: true })
      if (error) throw error
      urls.push(supabase.storage.from('taller-fotos').getPublicUrl(path).data.publicUrl)
    }
    return urls
  }

  const agregarFotos = async (files: FileList | null, actual: FotoItem[], setter: (f: FotoItem[]) => void) => {
    if (!files) return
    const libres = MAX_FOTOS - actual.length
    if (libres <= 0) { showToast(`Máximo ${MAX_FOTOS} fotos`, 'err'); return }
    const nuevas = await Promise.all(Array.from(files).slice(0, libres).map(async f => {
      const c = await comprimirFoto(f)
      return { file: c, preview: URL.createObjectURL(c) }
    }))
    setter([...actual, ...nuevas])
  }

  const quitarFoto = (i: number, actual: FotoItem[], setter: (f: FotoItem[]) => void) => {
    URL.revokeObjectURL(actual[i].preview)
    setter(actual.filter((_, idx) => idx !== i))
  }

  const resetNueva = () => {
    setUnidad(''); setExterna(false); setExtPref(''); setExtNum(''); setBuscaUnidad(''); setTipo('')
    setInicioStr(valorDatetimeLocal()); setMecSel([]); setSel({}); setBusqueda('')
    setCustomTxt(''); setObs('')
    fotosAntes.forEach(f => URL.revokeObjectURL(f.preview)); setFotosAntes([])
  }

  const toggleTarea = (c: CatItem) => {
    setSel(prev => {
      const n = { ...prev }
      if (n[c.id]) delete n[c.id]
      else n[c.id] = { catalogo_id: c.id, grupo: c.grupo, sistema: c.sistema, nombre: c.nombre, personalizada: false, minutos_estandar: c.minutos_estandar }
      return n
    })
  }

  const agregarCustom = () => {
    const t = customTxt.trim()
    if (!t) return
    const sis = GRUPOS.find(g => g.key === grupoTab)?.label.replace(/^\S+\s/, '') ?? grupoTab
    setSel(prev => ({ ...prev, [`c:${crypto.randomUUID()}`]: { catalogo_id: null, grupo: grupoTab, sistema: sis, nombre: t, personalizada: true, minutos_estandar: null } }))
    setCustomTxt('')
  }

  const agregarMecanico = async (nombre: string, seleccionar: boolean) => {
    const n = nombre.trim()
    if (!n) return
    const existente = mecanicos.find(m => m.nombre.toLowerCase() === n.toLowerCase())
    if (existente) {
      if (!existente.activo) await supabase.from('taller_mecanicos').update({ activo: true }).eq('id', existente.id)
      if (seleccionar) setMecSel(p => p.includes(existente.nombre) ? p : [...p, existente.nombre])
      await cargarMecanicos(); return
    }
    const { error } = await supabase.from('taller_mecanicos').insert({ nombre: n, sucursal })
    if (error) { showToast('No se pudo agregar el mecánico', 'err'); return }
    if (seleccionar) setMecSel(p => [...p, n])
    await cargarMecanicos()
  }

  const iniciarTrabajo = async () => {
    const unidadFinal = externa ? (extPref && extNum ? `${extPref}-${extNum}` : '') : unidad
    if (!unidadFinal) { showToast(externa ? 'Indicá el tipo de equipo y el número' : 'Indicá la unidad', 'err'); return }
    if (!tipo) { showToast('Elegí el tipo de intervención', 'err'); return }
    if (!mecSel.length) { showToast('Elegí al menos un mecánico', 'err'); return }
    const claves = Object.keys(sel)
    if (!claves.length) { showToast('Seleccioná al menos una tarea', 'err'); return }
    const inicio = new Date(inicioStr)
    if (isNaN(inicio.getTime())) { showToast('Hora de inicio inválida', 'err'); return }
    if (inicio.getTime() > Date.now() + 60000) { showToast('La hora de inicio no puede ser futura', 'err'); return }
    setGuardando(true)
    try {
      const ordenId = crypto.randomUUID()
      const fotos = fotosAntes.length ? await subirFotos(fotosAntes, ordenId, 'antes') : []
      const { error } = await supabase.from('taller_ordenes').insert({
        id: ordenId, fecha: fechaLocal(inicio), sucursal, unidad_codigo: unidadFinal, unidad_externa: externa, tipo_equipo: tipoEquipoDe(unidadFinal, externa),
        tipo, estado: 'abierta', inicio: inicio.toISOString(), mecanicos: mecSel,
        observacion: obs.trim() || null, fotos_antes: fotos, registrado_por: userId,
      })
      if (error) throw error
      const { error: e2 } = await supabase.from('taller_orden_tareas').insert(claves.map(k => ({
        orden_id: ordenId, catalogo_id: sel[k].catalogo_id, grupo: sel[k].grupo, sistema: sel[k].sistema,
        nombre: sel[k].nombre, personalizada: sel[k].personalizada, minutos_estandar: sel[k].minutos_estandar,
      })))
      if (e2) {
        await supabase.from('taller_ordenes').delete().eq('id', ordenId)
        throw e2
      }
      showToast(`Trabajo iniciado — ${unidadFinal}`)
      resetNueva()
      await cargarAbiertas(sucursal)
      setTab('abiertas')
    } catch (err: any) {
      showToast(err?.message || 'Error al guardar', 'err')
    } finally { setGuardando(false) }
  }

  const abrirCierre = (o: Orden) => {
    setCierre(o); setFinStr(valorDatetimeLocal()); setMinTarea({}); setQuitadas(new Set())
    setExtras([]); setExtraTxt(''); setMotivoSel(''); setMotivoTxt(''); setObsCierre('')
    fotosDespues.forEach(f => URL.revokeObjectURL(f.preview)); setFotosDespues([])
  }

  const cierreCalc = useMemo(() => {
    if (!cierre) return null
    const visibles = [
      ...tareasDe(cierre).filter(t => !quitadas.has(t.id)).map(t => ({ id: t.id, nombre: t.nombre, std: t.minutos_estandar, nueva: false })),
      ...extras.map(e => ({ id: e.id, nombre: e.nombre, std: null as number | null, nueva: true })),
    ]
    const fin = new Date(finStr)
    const transcurrido = isNaN(fin.getTime()) ? 0 : minutosEntre(cierre.inicio, fin)
    const valor = (id: string) => minTarea[id] !== undefined ? minTarea[id] : (visibles.length === 1 ? String(Math.max(transcurrido, 0)) : '')
    const mins = visibles.map(v => ({ ...v, valor: valor(v.id), num: parseInt(valor(v.id), 10) }))
    const completo = mins.length > 0 && mins.every(m => Number.isFinite(m.num) && m.num >= 1)
    const suma = mins.reduce((s, m) => s + (Number.isFinite(m.num) ? m.num : 0), 0)
    const diferencia = transcurrido - suma
    const requiereMotivo = completo && Math.abs(diferencia) > TOLERANCIA_MIN
    return { visibles: mins, transcurrido, suma, diferencia, completo, requiereMotivo, fin }
  }, [cierre, finStr, minTarea, quitadas, extras])

  const repartirIgual = () => {
    if (!cierreCalc || !cierreCalc.visibles.length) return
    const base = Math.floor(Math.max(cierreCalc.transcurrido, 0) / cierreCalc.visibles.length)
    const m: Record<string, string> = {}
    cierreCalc.visibles.forEach(v => { m[v.id] = String(Math.max(base, 1)) })
    setMinTarea(m)
  }

  const finalizarTrabajo = async () => {
    if (!cierre || !cierreCalc) return
    const { visibles, transcurrido, suma, diferencia, completo, requiereMotivo, fin } = cierreCalc
    if (isNaN(fin.getTime())) { showToast('Hora de fin inválida', 'err'); return }
    if (fin.getTime() > Date.now() + 60000) { showToast('La hora de fin no puede ser futura', 'err'); return }
    if (transcurrido < 1) { showToast('La hora de fin debe ser posterior al inicio', 'err'); return }
    if (!visibles.length) { showToast('Debe quedar al menos una tarea', 'err'); return }
    if (!completo) { showToast('Cargá los minutos de cada tarea', 'err'); return }
    let motivo: string | null = null
    if (requiereMotivo) {
      if (!motivoSel) { showToast('Indicá el motivo de la diferencia', 'err'); return }
      if (motivoSel === 'Otro' && !motivoTxt.trim()) { showToast('Escribí el motivo', 'err'); return }
      motivo = motivoTxt.trim() ? `${motivoSel}: ${motivoTxt.trim()}` : motivoSel
    }
    setGuardando(true)
    try {
      const fotos = fotosDespues.length ? await subirFotos(fotosDespues, cierre.id, 'despues') : []
      if (quitadas.size) {
        const { error } = await supabase.from('taller_orden_tareas').delete().in('id', Array.from(quitadas))
        if (error) throw error
      }
      const nuevas = visibles.filter(v => v.nueva)
      if (nuevas.length) {
        const { error } = await supabase.from('taller_orden_tareas').insert(nuevas.map(v => ({
          orden_id: cierre.id, grupo: 'general', sistema: 'Tarea no prevista', nombre: v.nombre,
          personalizada: true, minutos: v.num,
        })))
        if (error) throw error
      }
      for (const v of visibles.filter(x => !x.nueva)) {
        const { error } = await supabase.from('taller_orden_tareas').update({ minutos: v.num }).eq('id', v.id)
        if (error) throw error
      }
      const { error } = await supabase.from('taller_ordenes').update({
        estado: 'cerrada', fin: fin.toISOString(), minutos_transcurridos: transcurrido,
        minutos_trabajados: suma, diferencia_min: diferencia, motivo_diferencia: motivo,
        observacion_cierre: obsCierre.trim() || null,
        fotos_despues: fotos.length ? fotos : cierre.fotos_despues, cerrado_por: userId,
      }).eq('id', cierre.id)
      if (error) throw error
      showToast(`Trabajo finalizado — ${cierre.unidad_codigo} (${fmtDur(suma)})`)
      setCierre(null)
      await cargarAbiertas(sucursal)
    } catch (err: any) {
      showToast(err?.message || 'Error al guardar', 'err')
    } finally { setGuardando(false) }
  }

  const eliminarOrden = async (o: Orden) => {
    if (!window.confirm(`¿Eliminar la orden de ${o.unidad_codigo} del ${o.fecha}? No se puede deshacer.`)) return
    const { error } = await supabase.from('taller_ordenes').delete().eq('id', o.id)
    if (error) { showToast('No se pudo eliminar', 'err'); return }
    showToast('Orden eliminada')
    cargarDia(sucursal, dia); cargarAbiertas(sucursal)
  }

  // ── Edición de una orden por el administrador ──
  const abrirEdicion = (o: Orden) => {
    setEdicion({
      o, unidad: o.unidad_codigo, tipo: o.tipo, fecha: o.fecha, inicioStr: valorDatetimeLocal(new Date(o.inicio)),
      finStr: o.fin ? valorDatetimeLocal(new Date(o.fin)) : '', mecs: [...(o.mecanicos ?? [])],
      obs: o.observacion ?? '', obsCierre: o.observacion_cierre ?? '', motivo: o.motivo_diferencia ?? '',
      mins: Object.fromEntries(tareasDe(o).map(t => [t.id, t.minutos != null ? String(t.minutos) : ''])), quitadas: new Set(),
    })
  }

  const calcEdicion = useMemo(() => {
    if (!edicion) return null
    const cerrada = edicion.o.estado === 'cerrada'
    const inicio = new Date(edicion.inicioStr)
    const fin = edicion.finStr ? new Date(edicion.finStr) : null
    const tareas = tareasDe(edicion.o).filter(t => !edicion.quitadas.has(t.id)).map(t => {
      const num = parseInt(edicion.mins[t.id] ?? '', 10)
      return { t, num }
    })
    const transcurrido = cerrada && fin && !isNaN(fin.getTime()) && !isNaN(inicio.getTime()) ? minutosEntre(inicio, fin) : null
    const suma = cerrada ? tareas.reduce((s, x) => s + (Number.isFinite(x.num) ? x.num : 0), 0) : null
    const diferencia = transcurrido != null && suma != null ? transcurrido - suma : null
    const requiereMotivo = diferencia != null && Math.abs(diferencia) > TOLERANCIA_MIN
    const completo = !cerrada || (tareas.length > 0 && tareas.every(x => Number.isFinite(x.num) && x.num >= 1))
    return { cerrada, inicio, fin, tareas, transcurrido, suma, diferencia, requiereMotivo, completo }
  }, [edicion])

  const guardarEdicion = async () => {
    if (!edicion || !calcEdicion) return
    const { cerrada, inicio, fin, tareas, transcurrido, suma, diferencia, requiereMotivo, completo } = calcEdicion
    const unidadNueva = edicion.unidad.trim()
    if (!unidadNueva) { showToast('Indicá la unidad', 'err'); return }
    if (isNaN(inicio.getTime())) { showToast('Hora de inicio inválida', 'err'); return }
    if (cerrada) {
      if (!fin || isNaN(fin.getTime()) || transcurrido == null || transcurrido < 1) { showToast('La hora de fin debe ser posterior al inicio', 'err'); return }
      if (!completo) { showToast('Cargá los minutos de cada tarea (al menos 1) y dejá una tarea como mínimo', 'err'); return }
      if (requiereMotivo && !edicion.motivo.trim()) { showToast('Indicá el motivo de la diferencia', 'err'); return }
    }
    setGuardando(true)
    try {
      if (edicion.quitadas.size) {
        const { error } = await supabase.from('taller_orden_tareas').delete().in('id', Array.from(edicion.quitadas))
        if (error) throw error
      }
      if (cerrada) {
        for (const x of tareas) {
          const { error } = await supabase.from('taller_orden_tareas').update({ minutos: x.num }).eq('id', x.t.id)
          if (error) throw error
        }
      }
      const { error } = await supabase.from('taller_ordenes').update({
        unidad_codigo: unidadNueva, tipo: edicion.tipo, fecha: edicion.fecha, inicio: inicio.toISOString(),
        ...(cerrada ? {
          fin: fin!.toISOString(), minutos_transcurridos: transcurrido, minutos_trabajados: suma, diferencia_min: diferencia,
          motivo_diferencia: requiereMotivo ? edicion.motivo.trim() : null, observacion_cierre: edicion.obsCierre.trim() || null,
        } : {}),
        mecanicos: edicion.mecs, observacion: edicion.obs.trim() || null,
        tipo_equipo: tipoEquipoDe(unidadNueva, edicion.o.unidad_externa),
        editado_por: userId, editado_en: new Date().toISOString(),
      }).eq('id', edicion.o.id)
      if (error) throw error
      showToast(`Orden actualizada — ${unidadNueva}`)
      setEdicion(null)
      await Promise.all([cargarDia(sucursal, dia), cargarAbiertas(sucursal)])
    } catch (err: any) {
      showToast(err?.message || 'No se pudo guardar la edición', 'err')
    } finally { setGuardando(false) }
  }

  const agregarEquipo = async () => {
    const pref = nuevoEquipo.prefijo.trim().toUpperCase(); const num = nuevoEquipo.numero.trim()
    if (!pref || !num) { showToast('Indicá el tipo de equipo y el número', 'err'); return }
    const codigo = `${pref}-${num}`
    const { data, error } = await supabase.from('taller_equipos').insert({ codigo, tipo: nuevoEquipo.tipo }).select('*').single()
    if (error) { showToast(error.code === '23505' ? 'Ese equipo ya existe' : 'No se pudo agregar', 'err'); return }
    setEquipos(prev => [...prev, data as Equipo].sort((a, b) => a.tipo.localeCompare(b.tipo) || a.codigo.localeCompare(b.codigo)))
    setNuevoEquipo(p => ({ ...p, numero: '' }))
    showToast(`Equipo ${codigo} agregado`)
  }

  const toggleEquipo = async (e: Equipo) => {
    const { error } = await supabase.from('taller_equipos').update({ activo: !e.activo }).eq('id', e.id)
    if (error) { showToast('No se pudo cambiar', 'err'); return }
    setEquipos(prev => prev.map(x => x.id === e.id ? { ...x, activo: !x.activo } : x))
  }

  const exportarCSV = async () => {
    if (!expDesde || !expHasta) { showToast('Indicá el rango de fechas', 'err'); return }
    setExportando(true)
    try {
      let q = supabase.from('taller_ordenes').select('*, taller_orden_tareas(*)')
        .gte('fecha', expDesde).lte('fecha', expHasta).order('fecha').order('inicio')
      if (expSucursal !== 'Todas') q = q.eq('sucursal', expSucursal)
      const { data, error } = await q
      if (error) throw error
      const ordenes = (data ?? []) as Orden[]
      if (!ordenes.length) { showToast('Sin órdenes en ese rango', 'err'); return }
      const uids = [...new Set(ordenes.flatMap(o => [o.registrado_por, o.cerrado_por]).filter(Boolean))] as string[]
      const nombres: Record<string, string> = {}
      if (uids.length) {
        const { data: us } = await supabase.from('usuarios').select('id, nombre').in('id', uids)
        for (const u of (us ?? [])) nombres[(u as any).id] = (u as any).nombre
      }
      const cols = [
        'fecha', 'orden_id', 'sucursal', 'unidad', 'tipo_equipo', 'unidad_otra_empresa', 'tipo', 'estado',
        'inicio', 'fin', 'grupo', 'sistema', 'tarea', 'tarea_no_listada',
        'minutos_tarea', 'minutos_estandar', 'desvio_vs_estandar_min',
        'minutos_transcurridos_orden', 'minutos_trabajados_orden', 'diferencia_orden_min', 'motivo_diferencia',
        'mecanicos', 'cant_mecanicos', 'horas_hombre_orden',
        'observacion_inicio', 'observacion_cierre', 'fotos_antes', 'fotos_despues',
        'registrado_por', 'cerrado_por',
      ]
      const fechaHora = (iso: string | null) => iso ? `${fechaLocal(new Date(iso))} ${hhmm(iso)}` : ''
      const lineas: string[] = [cols.join(';')]
      for (const o of ordenes) {
        const tareas = tareasDe(o)
        const hh = o.minutos_trabajados != null ? decimalAR((o.minutos_trabajados * (o.mecanicos?.length || 1)) / 60) : ''
        for (const t of tareas) {
          const desvio = t.minutos != null && t.minutos_estandar != null ? t.minutos - t.minutos_estandar : ''
          const fila: Record<string, any> = {
            fecha: o.fecha, orden_id: o.id, sucursal: o.sucursal, unidad: o.unidad_codigo,
            tipo_equipo: o.tipo_equipo ?? '', unidad_otra_empresa: o.unidad_externa ? 'si' : 'no', tipo: o.tipo, estado: o.estado,
            inicio: fechaHora(o.inicio), fin: fechaHora(o.fin), grupo: t.grupo, sistema: t.sistema, tarea: t.nombre,
            tarea_no_listada: t.personalizada ? 'si' : 'no', minutos_tarea: t.minutos ?? '',
            minutos_estandar: t.minutos_estandar ?? '', desvio_vs_estandar_min: desvio,
            minutos_transcurridos_orden: o.minutos_transcurridos ?? '', minutos_trabajados_orden: o.minutos_trabajados ?? '',
            diferencia_orden_min: o.diferencia_min ?? '', motivo_diferencia: o.motivo_diferencia ?? '',
            mecanicos: (o.mecanicos ?? []).join(' + '), cant_mecanicos: o.mecanicos?.length ?? 0, horas_hombre_orden: hh,
            observacion_inicio: o.observacion ?? '', observacion_cierre: o.observacion_cierre ?? '',
            fotos_antes: (o.fotos_antes ?? []).join(' '), fotos_despues: (o.fotos_despues ?? []).join(' '),
            registrado_por: nombres[o.registrado_por ?? ''] ?? '', cerrado_por: nombres[o.cerrado_por ?? ''] ?? '',
          }
          lineas.push(cols.map(c => csvCell(fila[c])).join(';'))
        }
      }
      descargarCSV(lineas.join('\n'), `taller_${expDesde}_a_${expHasta}.csv`)
      showToast(`${ordenes.length} órdenes exportadas`)
    } catch (err: any) {
      showToast(err?.message || 'Error al exportar', 'err')
    } finally { setExportando(false) }
  }

  const guardarEstandar = async (c: CatItem, valor: string) => {
    const n = valor.trim() === '' ? null : parseInt(valor, 10)
    if (n !== null && (!Number.isFinite(n) || n < 1)) { showToast('Minutos inválidos', 'err'); return }
    if (n === c.minutos_estandar) return
    const { error } = await supabase.from('taller_catalogo').update({ minutos_estandar: n }).eq('id', c.id)
    if (error) { showToast('No se pudo guardar', 'err'); return }
    setCatalogo(prev => prev.map(x => x.id === c.id ? { ...x, minutos_estandar: n } : x))
  }

  const toggleCatActivo = async (c: CatItem) => {
    const { error } = await supabase.from('taller_catalogo').update({ activo: !c.activo }).eq('id', c.id)
    if (error) { showToast('No se pudo guardar', 'err'); return }
    setCatalogo(prev => prev.map(x => x.id === c.id ? { ...x, activo: !c.activo } : x))
  }

  const agregarACatalogo = async () => {
    const sistema = nuevoCat.sistema.trim(); const nombre = nuevoCat.nombre.trim()
    if (!sistema || !nombre) { showToast('Completá sistema y nombre', 'err'); return }
    const min = nuevoCat.minutos.trim() ? parseInt(nuevoCat.minutos, 10) : null
    if (min !== null && (!Number.isFinite(min) || min < 1)) { showToast('Minutos inválidos', 'err'); return }
    const maxOrden = Math.max(0, ...catalogo.map(c => c.orden))
    const { error } = await supabase.from('taller_catalogo').insert({ grupo: catGrupo, sistema, nombre, minutos_estandar: min, orden: maxOrden + 1 })
    if (error) { showToast(error.message.includes('duplicate') ? 'Esa tarea ya existe' : 'No se pudo agregar', 'err'); return }
    setNuevoCat({ sistema: nuevoCat.sistema, nombre: '', minutos: '' }); setCatNueva(false)
    await cargarCatalogo(); showToast('Tarea agregada al catálogo')
  }

  const toggleMecActivo = async (m: Mecanico) => {
    await supabase.from('taller_mecanicos').update({ activo: !m.activo }).eq('id', m.id)
    await cargarMecanicos()
  }

  const salir = async () => { await supabase.auth.signOut(); router.push('/') }

  if (cargando) {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontFamily: 'system-ui' }}>Cargando…</div>
  }

  const fotosDeOrden = (o: Orden) => [
    ...(o.fotos_antes ?? []).map(url => ({ url, label: 'Antes' })),
    ...(o.fotos_despues ?? []).map(url => ({ url, label: 'Después' })),
  ]

  const renderFotosPicker = (fotos: FotoItem[], setter: (f: FotoItem[]) => void, titulo: string) => (
    <div>
      <label style={labelSt}>{titulo} <span style={{ color: '#999', textTransform: 'none', fontWeight: 400 }}>(opcional, {fotos.length}/{MAX_FOTOS})</span></label>
      {fotos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {fotos.map((f, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={f.preview} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
              <button onClick={() => quitarFoto(i, fotos, setter)}
                style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, border: 'none', background: '#991b1b', color: '#fff', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
          ))}
        </div>
      )}
      {fotos.length < MAX_FOTOS && (
        <label style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 10, border: '1.5px dashed #254A96', color: '#254A96', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
          📷 {fotos.length === 0 ? 'Agregar foto' : 'Agregar otra'}
          <input type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={e => { agregarFotos(e.target.files, fotos, setter); e.target.value = '' }} />
        </label>
      )}
    </div>
  )

  const tabs: { key: Tab; label: string }[] = [
    { key: 'abiertas', label: `🛠️ En curso${abiertas.length ? ` (${abiertas.length})` : ''}` },
    ...(puedeEd ? [{ key: 'nueva' as Tab, label: '➕ Iniciar trabajo' }] : []),
    { key: 'actividad', label: '📊 Actividad' },
    ...(esAdmin ? [{ key: 'catalogo' as Tab, label: '📚 Catálogo' }] : []),
  ]

  const unidadAbierta = !externa && unidad ? abiertas.find(o => o.unidad_codigo === unidad) : undefined
  const resultadosBusqueda = busqueda.trim()
    ? catActivo.filter(c => `${c.nombre} ${c.sistema}`.toLowerCase().includes(busqueda.trim().toLowerCase()))
    : []

  return (
    <div style={{ minHeight: '100dvh', background: '#f4f4f3', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ background: '#254A96', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, maxWidth: 1100, margin: '0 auto', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!['mecanico', 'admin_taller'].includes(rol) && (
              <button onClick={() => router.push('/dashboard')}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 10, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                ← Dashboard
              </button>
            )}
            <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>🔧 Taller</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {esAdmin ? (
              <select value={sucursal} onChange={e => setSucursal(e.target.value)}
                style={{ padding: '7px 10px', borderRadius: 10, border: 'none', fontSize: 14, fontWeight: 600 }}>
                {SUCURSALES.map(s => <option key={s}>{s}</option>)}
              </select>
            ) : (
              <span style={{ color: 'rgba(255,255,255,0.8)', fontSize: 14 }}>{sucursal}</span>
            )}
            {['mecanico', 'admin_taller'].includes(rol) && (
              <button onClick={salir}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 10, padding: '7px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                Salir
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ padding: '16px 14px 40px', maxWidth: tab === 'actividad' ? 1100 : 680, margin: '0 auto' }}>
        {toast && (
          <div style={{
            position: 'fixed', top: 76, left: '50%', transform: 'translateX(-50%)', zIndex: 300,
            background: toast.tipo === 'ok' ? '#166534' : '#991b1b', color: '#fff', padding: '12px 20px',
            borderRadius: 12, fontSize: 14, fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', maxWidth: '92vw',
          }}>{toast.msg}</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' }}>
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                flex: '1 0 auto', padding: '12px 14px', borderRadius: 12, fontSize: 14, fontWeight: 700, whiteSpace: 'nowrap', cursor: 'pointer',
                border: tab === t.key ? '2px solid #254A96' : '1.5px solid #e0e0e0',
                background: tab === t.key ? '#254A96' : '#fff', color: tab === t.key ? '#fff' : '#666',
              }}>{t.label}</button>
          ))}
        </div>

        {/* ───────── EN CURSO ───────── */}
        {tab === 'abiertas' && (
          <>
            {abiertas.length === 0 && (
              <div style={{ ...card, textAlign: 'center', color: '#999', padding: '36px 16px' }}>
                No hay trabajos en curso en {sucursal}.
                {puedeEd && <div style={{ marginTop: 12 }}><button onClick={() => setTab('nueva')} style={{ ...chip(true), border: 'none' }}>➕ Iniciar trabajo</button></div>}
              </div>
            )}
            {abiertas.map(o => {
              const ti = tipoInfo(o.tipo)
              const trans = minutosEntre(o.inicio, ahora)
              const deAyer = fechaLocal(new Date(o.inicio)) !== fechaLocal(new Date(ahora))
              const tareas = tareasDe(o)
              return (
                <div key={o.id} style={{ ...card, borderLeft: `4px solid ${ti.color}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#1a1a1a' }}>{o.unidad_codigo}{o.unidad_externa && <span style={{ fontSize: 12, color: '#888', fontWeight: 600 }}> · otra empresa</span>}</div>
                      <span style={{ display: 'inline-block', marginTop: 4, padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: ti.bg, color: ti.color }}>{ti.icon} {ti.label}</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 13, color: '#666' }}>Inició {deAyer ? `${ddmm(o.inicio)} ` : ''}{hhmm(o.inicio)}</div>
                      <div style={{ fontSize: 18, fontWeight: 800, color: deAyer ? '#b45309' : '#254A96' }}>{fmtDur(trans)}</div>
                      {deAyer && <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700 }}>⚠ abierta desde otro día</div>}
                    </div>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, color: '#555' }}>🧑‍🔧 {(o.mecanicos ?? []).join(', ') || '—'}</div>
                  <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 14, color: '#222' }}>
                    {tareas.map(t => <li key={t.id} style={{ marginBottom: 2 }}>{t.nombre}</li>)}
                  </ul>
                  {o.observacion && <p style={{ margin: '8px 0 0', fontSize: 13, color: '#666' }}>📝 {o.observacion}</p>}
                  <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                    {puedeEd && <button onClick={() => abrirCierre(o)} style={{ ...btnPrimary, background: '#059669', flex: 1, width: 'auto', padding: 13 }}>✅ Finalizar trabajo</button>}
                    {fotosDeOrden(o).length > 0 && (
                      <button onClick={() => setVisor({ titulo: `${o.unidad_codigo} · fotos`, fotos: fotosDeOrden(o) })}
                        style={{ padding: '13px 16px', borderRadius: 12, border: '1.5px solid #d6d6d6', background: '#fff', fontWeight: 600, cursor: 'pointer' }}>📷 {fotosDeOrden(o).length}</button>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}

        {/* ───────── NUEVA ───────── */}
        {tab === 'nueva' && puedeEd && (
          <>
            <div style={card}>
              <label style={labelSt}>Unidad</label>
              {!externa ? (
                <>
                  <input value={buscaUnidad} onChange={e => setBuscaUnidad(e.target.value)} placeholder="🔍 Buscar unidad (ej: 52, SA-10, CF)…" style={{ ...inputSt, marginBottom: 8 }} />
                  <select value={unidad} onChange={e => setUnidad(e.target.value)} style={inputSt}>
                    <option value="">Seleccioná la unidad…</option>
                    {(() => {
                      const q = buscaUnidad.trim().toLowerCase().replace(/[\s-]+/g, '')
                      const coincide = (c: string) => !q || c.toLowerCase().replace(/[\s-]+/g, '').includes(q)
                      const cams = camiones.filter(coincide)
                      return (
                        <>
                          {cams.length > 0 && <optgroup label="🚛 Camiones">{cams.map(c => <option key={c}>{c}</option>)}</optgroup>}
                          {TIPOS_TALLER.map(t => {
                            const lista = equipos.filter(e => e.activo && e.tipo === t.key && coincide(e.codigo))
                            return lista.length > 0 ? <optgroup key={t.key} label={`${t.icon} ${t.plural}`}>{lista.map(e => <option key={e.id}>{e.codigo}</option>)}</optgroup> : null
                          })}
                        </>
                      )
                    })()}
                  </select>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input value={extPref} onChange={e => setExtPref(e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6))}
                    placeholder="MX" aria-label="Tipo de equipo" style={{ ...inputSt, flex: '0 0 96px', width: 96, textAlign: 'center', textTransform: 'uppercase', fontWeight: 700 }} />
                  <span style={{ fontSize: 22, fontWeight: 700, color: '#999' }}>-</span>
                  <input value={extNum} onChange={e => setExtNum(e.target.value.replace(/\D/g, '').slice(0, 5))} inputMode="numeric"
                    placeholder="12" aria-label="Número" style={{ ...inputSt, flex: '1 1 100px', fontWeight: 700 }} />
                </div>
              )}
              {externa && <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>Escribí el tipo de equipo y el número; el guion se pone solo. Ej: MX-12, UC-102.</div>}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 14, color: '#555', cursor: 'pointer' }}>
                <input type="checkbox" checked={externa} onChange={e => setExterna(e.target.checked)} />
                Es de otra empresa o un equipo que no está en la lista
              </label>
              {unidadAbierta && (
                <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 13, color: '#92400e' }}>
                  ⚠ {unidadAbierta.unidad_codigo} ya tiene un trabajo en curso desde las {hhmm(unidadAbierta.inicio)}. Podés iniciar otro igual.
                </div>
              )}
            </div>

            <div style={card}>
              <label style={labelSt}>Tipo de intervención</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {TIPOS.map(t => (
                  <button key={t.key} onClick={() => setTipo(t.key)}
                    style={{ padding: '12px 6px', borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                      border: `2px solid ${tipo === t.key ? t.color : '#e0e0e0'}`, background: tipo === t.key ? t.bg : '#fff', color: tipo === t.key ? t.color : '#666' }}>
                    <div style={{ fontSize: 22 }}>{t.icon}</div>{t.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={card}>
              <label style={labelSt}>Mecánicos</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {mecanicosActivos.map(m => (
                  <button key={m.id} onClick={() => setMecSel(p => p.includes(m.nombre) ? p.filter(x => x !== m.nombre) : [...p, m.nombre])}
                    style={chip(mecSel.includes(m.nombre), '#b45309')}>{m.nombre}</button>
                ))}
                {mecanicosActivos.length === 0 && <span style={{ fontSize: 13, color: '#999' }}>Todavía no hay mecánicos cargados. Agregá el primero acá abajo.</span>}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={nuevoMec} onChange={e => setNuevoMec(e.target.value)} placeholder="＋ Agregar mecánico (nombre)" style={{ ...inputSt, padding: '9px 12px', fontSize: 14 }} />
                <button onClick={() => { agregarMecanico(nuevoMec, true); setNuevoMec('') }}
                  style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
              </div>
              <label style={{ ...labelSt, marginTop: 16 }}>Hora de inicio</label>
              <input type="datetime-local" value={inicioStr} onChange={e => setInicioStr(e.target.value)} style={inputSt} />
              <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>Por defecto es ahora. Cambiala si empezaste antes y te olvidaste de registrar.</div>
            </div>

            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 16px 12px' }}>
                <label style={labelSt}>Tareas a realizar <span style={{ color: '#254A96' }}>{Object.keys(sel).length > 0 ? `· ${Object.keys(sel).length} elegida${Object.keys(sel).length !== 1 ? 's' : ''}` : ''}</span></label>
                <input value={busqueda} onChange={e => setBusqueda(e.target.value)} placeholder="🔍 Buscar tarea…" style={{ ...inputSt, padding: '10px 14px', fontSize: 14, marginBottom: 10 }} />
                {!busqueda.trim() && (
                  <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
                    {gruposVisibles.map(g => (
                      <button key={g.key} onClick={() => setGrupoTab(g.key)} style={{ ...chip(grupoTab === g.key), flexShrink: 0, whiteSpace: 'nowrap' }}>{g.label}</button>
                    ))}
                  </div>
                )}
              </div>

              {busqueda.trim() ? (
                <div style={{ padding: '0 16px 12px' }}>
                  {resultadosBusqueda.length === 0 && <div style={{ fontSize: 13, color: '#999', padding: '8px 0' }}>Sin resultados. Podés agregarla abajo como tarea no listada.</div>}
                  {resultadosBusqueda.map(c => <FilaTarea key={c.id} c={c} on={!!sel[c.id]} onToggle={() => toggleTarea(c)} mostrarSistema />)}
                </div>
              ) : (
                sistemasDeGrupo(catActivo, grupoTab).map(([sistema, items]) => {
                  const n = items.filter(i => sel[i.id]).length
                  return (
                    <details key={sistema} open={n > 0} style={{ borderTop: '1px solid #eee' }}>
                      <summary style={{ padding: '13px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14, display: 'flex', justifyContent: 'space-between', listStyle: 'none' }}>
                        <span>{sistema}</span>
                        {n > 0 && <span style={{ background: '#254A96', color: '#fff', borderRadius: 12, padding: '1px 9px', fontSize: 12 }}>{n}</span>}
                      </summary>
                      <div style={{ padding: '0 16px 10px' }}>
                        {items.map(c => <FilaTarea key={c.id} c={c} on={!!sel[c.id]} onToggle={() => toggleTarea(c)} />)}
                      </div>
                    </details>
                  )
                })
              )}

              <div style={{ padding: '12px 16px', borderTop: '1px dashed #d6d6d6', display: 'flex', gap: 8 }}>
                <input value={customTxt} onChange={e => setCustomTxt(e.target.value)} placeholder="＋ Otra tarea no listada…" style={{ ...inputSt, padding: '9px 12px', fontSize: 14 }}
                  onKeyDown={e => { if (e.key === 'Enter') agregarCustom() }} />
                <button onClick={agregarCustom} style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
              </div>
            </div>

            {Object.keys(sel).length > 0 && (
              <div style={{ ...card, background: '#eef2fb', border: '1.5px solid #dce6f9' }}>
                <label style={{ ...labelSt, color: '#254A96' }}>Tareas elegidas</label>
                {Object.entries(sel).map(([k, t]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', fontSize: 14 }}>
                    <span>{t.personalizada ? '★ ' : ''}{t.nombre}</span>
                    <button onClick={() => setSel(p => { const n = { ...p }; delete n[k]; return n })}
                      style={{ border: 'none', background: 'none', color: '#991b1b', cursor: 'pointer', fontSize: 14 }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <div style={card}>
              {renderFotosPicker(fotosAntes, setFotosAntes, "Fotos antes")}
              <label style={{ ...labelSt, marginTop: 16 }}>Observación <span style={{ color: '#999', textTransform: 'none', fontWeight: 400 }}>(opcional)</span></label>
              <textarea value={obs} onChange={e => setObs(e.target.value)} rows={3} placeholder="Condición del vehículo, falla reportada…" style={{ ...inputSt, resize: 'none' }} />
            </div>

            <button onClick={iniciarTrabajo} disabled={guardando} style={{ ...btnPrimary, opacity: guardando ? 0.6 : 1 }}>
              {guardando ? 'Guardando…' : '▶ Iniciar trabajo'}
            </button>
            <button onClick={() => { resetNueva(); setTab('abiertas') }} style={btnSecondary}>Cancelar</button>
          </>
        )}

        {/* ───────── ACTIVIDAD ───────── */}
        {tab === 'actividad' && (
          <>
            <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#254A96' }}>📊 Trabajos del día — {sucursal}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {cargandoDia && <span style={{ fontSize: 12, color: '#999' }}>Cargando…</span>}
                  <input type="date" value={dia} onChange={e => setDia(e.target.value)}
                    style={{ border: '1px solid #e8edf8', borderRadius: 8, padding: '5px 8px', fontSize: 13, color: '#254A96', fontWeight: 600 }} />
                </div>
              </div>

              {ordenesDia.length > 0 && (() => {
                const cerradas = ordenesDia.filter(o => o.estado === 'cerrada')
                const min = cerradas.reduce((s, o) => s + (o.minutos_trabajados ?? 0), 0)
                const hh = cerradas.reduce((s, o) => s + ((o.minutos_trabajados ?? 0) * (o.mecanicos?.length || 1)), 0)
                return (
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '10px 16px', background: '#f9fafb', fontSize: 13, color: '#444' }}>
                    <span><b>{ordenesDia.length}</b> orden{ordenesDia.length !== 1 ? 'es' : ''} ({ordenesDia.length - cerradas.length} en curso)</span>
                    <span>Tiempo trabajado: <b>{fmtDur(min)}</b></span>
                    <span>Horas-hombre: <b>{decimalAR(hh / 60)} h</b></span>
                  </div>
                )
              })()}

              {ordenesDia.length === 0 ? (
                <p style={{ textAlign: 'center', padding: '28px 16px', fontSize: 13, color: '#B9BBB7' }}>{cargandoDia ? 'Cargando…' : 'Sin trabajos registrados para esta fecha'}</p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f9f9f9', color: '#254A96' }}>
                        {['Unidad', 'Tipo', 'Inicio', 'Fin', 'Tareas (tiempo real · estándar)', 'Trabajado', 'Diferencia', 'Mecánicos', ''].map(h => (
                          <th key={h} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ordenesDia.map((o, idx) => {
                        const ti = tipoInfo(o.tipo)
                        const dif = o.diferencia_min
                        return (
                          <tr key={o.id} style={{ borderTop: '1px solid #f0f0f0', background: idx % 2 ? '#fafafa' : '#fff', verticalAlign: 'top' }}>
                            <td style={{ padding: '10px 12px', fontWeight: 700, whiteSpace: 'nowrap' }}>{o.unidad_codigo}{o.unidad_externa && <div style={{ fontSize: 10, color: '#888', fontWeight: 500 }}>otra empresa</div>}</td>
                            <td style={{ padding: '10px 12px' }}><span style={{ background: ti.bg, color: ti.color, borderRadius: 6, padding: '2px 8px', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>{ti.icon} {ti.label}</span></td>
                            <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{hhmm(o.inicio)}</td>
                            <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{o.estado === 'abierta' ? <span style={{ color: '#b45309', fontWeight: 700 }}>En curso</span> : fmtFin(o)}</td>
                            <td style={{ padding: '10px 12px', minWidth: 240 }}>
                              {tareasDe(o).map(t => {
                                const desv = t.minutos != null && t.minutos_estandar != null ? t.minutos - t.minutos_estandar : null
                                return (
                                  <div key={t.id} style={{ marginBottom: 3 }}>
                                    {t.personalizada ? '★ ' : ''}{t.nombre}
                                    {t.minutos != null && <b style={{ color: '#254A96' }}> · {fmtDur(t.minutos)}</b>}
                                    {t.minutos_estandar != null && <span style={{ color: '#888' }}> · est. {fmtDur(t.minutos_estandar)}</span>}
                                    {desv != null && desv !== 0 && <span style={{ color: desv > 0 ? '#b91c1c' : '#059669', fontWeight: 700 }}> ({desv > 0 ? '+' : ''}{desv})</span>}
                                  </div>
                                )
                              })}
                            </td>
                            <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', fontWeight: 700 }}>{o.estado === 'cerrada' ? fmtDur(o.minutos_trabajados) : '—'}</td>
                            <td style={{ padding: '10px 12px', minWidth: 140 }}>
                              {o.estado === 'cerrada' && dif != null && Math.abs(dif) > TOLERANCIA_MIN ? (
                                <><b style={{ color: '#b45309' }}>{dif > 0 ? '+' : ''}{fmtDur(dif)}</b><div style={{ fontSize: 11, color: '#666' }}>{o.motivo_diferencia}</div></>
                              ) : <span style={{ color: '#ccc' }}>—</span>}
                            </td>
                            <td style={{ padding: '10px 12px' }}>{(o.mecanicos ?? []).join(', ')}</td>
                            <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                              {fotosDeOrden(o).length > 0 && (
                                <button onClick={() => setVisor({ titulo: `${o.unidad_codigo} · ${hhmm(o.inicio)}`, fotos: fotosDeOrden(o) })}
                                  style={{ border: 'none', background: '#eef2fb', color: '#254A96', borderRadius: 6, padding: '3px 8px', cursor: 'pointer', fontWeight: 600 }}>📷 {fotosDeOrden(o).length}</button>
                              )}
                              {esAdmin && (
                                <>
                                  <button onClick={() => abrirEdicion(o)} title="Editar" style={{ border: 'none', background: 'none', cursor: 'pointer', marginLeft: 6 }}>✎</button>
                                  <button onClick={() => eliminarOrden(o)} title="Eliminar" style={{ border: 'none', background: 'none', cursor: 'pointer' }}>🗑</button>
                                </>
                              )}
                              {o.editado_en && <div style={{ fontSize: 10, color: '#92400e', marginTop: 2 }}>✎ editada</div>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {esAdmin && (
            <div style={card}>
              <label style={labelSt}>Exportar CSV (una fila por tarea)</label>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div><div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Desde</div><input type="date" value={expDesde} onChange={e => setExpDesde(e.target.value)} style={{ ...inputSt, width: 'auto', padding: '8px 10px' }} /></div>
                <div><div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Hasta</div><input type="date" value={expHasta} onChange={e => setExpHasta(e.target.value)} style={{ ...inputSt, width: 'auto', padding: '8px 10px' }} /></div>
                {esAdmin && (
                  <div><div style={{ fontSize: 12, color: '#777', marginBottom: 4 }}>Sucursal</div>
                    <select value={expSucursal} onChange={e => setExpSucursal(e.target.value)} style={{ ...inputSt, width: 'auto', padding: '8px 10px' }}>
                      {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                <button onClick={exportarCSV} disabled={exportando}
                  style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: exportando ? 0.6 : 1 }}>
                  {exportando ? 'Exportando…' : '↓ Exportar CSV'}
                </button>
              </div>
              <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>Los datos de la orden (tiempos, diferencia, mecánicos) se repiten en cada tarea: para sumar tiempos por orden usá la columna de la tarea, no la de la orden.</div>
            </div>
            )}
          </>
        )}

        {/* ───────── CATÁLOGO ───────── */}
        {tab === 'catalogo' && esAdmin && (
          <>
            <div style={card}>
              <label style={labelSt}>Tiempo estándar por tarea (minutos)</label>
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 12 }}>
                {GRUPOS.map(g => <button key={g.key} onClick={() => setCatGrupo(g.key)} style={{ ...chip(catGrupo === g.key), flexShrink: 0, whiteSpace: 'nowrap' }}>{g.label}</button>)}
              </div>
              {sistemasDeGrupo(catalogo, catGrupo).map(([sistema, items]) => (
                <div key={sistema} style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#254A96', marginBottom: 4 }}>{sistema}</div>
                  {items.map(c => (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid #f3f3f3', opacity: c.activo ? 1 : 0.45 }}>
                      <span style={{ flex: 1, fontSize: 14 }}>{c.nombre}</span>
                      <input type="number" min={1} defaultValue={c.minutos_estandar ?? ''} placeholder="min"
                        onBlur={e => guardarEstandar(c, e.target.value)}
                        style={{ width: 72, padding: '6px 8px', borderRadius: 8, border: '1.5px solid #d6d6d6', textAlign: 'center', fontSize: 14 }} />
                      <button onClick={() => toggleCatActivo(c)} title={c.activo ? 'Ocultar' : 'Mostrar'}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 16 }}>{c.activo ? '👁' : '🚫'}</button>
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ borderTop: '1px dashed #d6d6d6', paddingTop: 12 }}>
                <label style={labelSt}>Agregar categoría o tarea al catálogo ({GRUPOS.find(g => g.key === catGrupo)?.label})</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!catNueva ? (
                    <select value={nuevoCat.sistema} onChange={e => { if (e.target.value === '__nueva') { setCatNueva(true); setNuevoCat(p => ({ ...p, sistema: '' })) } else setNuevoCat(p => ({ ...p, sistema: e.target.value })) }}
                      style={{ ...inputSt, flex: '1 1 170px', width: 'auto', padding: '9px 12px', fontSize: 14 }}>
                      <option value="">Categoría…</option>
                      {sistemasDeGrupo(catalogo, catGrupo).map(([s]) => <option key={s} value={s}>{s}</option>)}
                      <option value="__nueva">➕ Nueva categoría…</option>
                    </select>
                  ) : (
                    <div style={{ display: 'flex', gap: 4, flex: '1 1 170px' }}>
                      <input autoFocus value={nuevoCat.sistema} onChange={e => setNuevoCat(p => ({ ...p, sistema: e.target.value }))} placeholder="Nombre de la nueva categoría" style={{ ...inputSt, width: 'auto', flex: 1, padding: '9px 12px', fontSize: 14 }} />
                      <button onClick={() => { setCatNueva(false); setNuevoCat(p => ({ ...p, sistema: '' })) }} title="Elegir una existente" style={{ border: '1.5px solid #d6d6d6', background: '#fff', borderRadius: 10, cursor: 'pointer', padding: '0 10px' }}>✕</button>
                    </div>
                  )}
                  <input value={nuevoCat.nombre} onChange={e => setNuevoCat(p => ({ ...p, nombre: e.target.value }))} placeholder="Nombre de la tarea" style={{ ...inputSt, flex: '2 1 200px', width: 'auto', padding: '9px 12px', fontSize: 14 }} />
                  <input type="number" min={1} value={nuevoCat.minutos} onChange={e => setNuevoCat(p => ({ ...p, minutos: e.target.value }))} placeholder="min" style={{ ...inputSt, flex: '0 0 80px', width: 80, padding: '9px 8px', fontSize: 14, textAlign: 'center' }} />
                  <button onClick={agregarACatalogo} style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
                </div>
              </div>
            </div>

            <div style={card}>
              <label style={labelSt}>Equipos</label>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#254A96', marginBottom: 4 }}>🚛 Camiones (CA) <span style={{ color: '#999', fontWeight: 500 }}>· salen de la flota</span></div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {camiones.map(c => <span key={c} style={{ padding: '5px 10px', borderRadius: 14, border: '1.5px solid #d6d6d6', background: '#f4f4f3', color: '#555', fontWeight: 700, fontSize: 13 }}>{c}</span>)}
                </div>
              </div>
              {TIPOS_TALLER.map(t => (
                <div key={t.key} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#254A96', marginBottom: 4 }}>{t.icon} {t.plural} ({t.prefijo})</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {equipos.filter(e => e.tipo === t.key).map(e => (
                      <button key={e.id} onClick={() => toggleEquipo(e)} title={e.activo ? 'Tocá para ocultar' : 'Tocá para mostrar'}
                        style={{ padding: '5px 10px', borderRadius: 14, border: '1.5px solid ' + (e.activo ? '#254A96' : '#d6d6d6'), background: e.activo ? '#eef2fb' : '#f4f4f3', color: e.activo ? '#254A96' : '#999', fontWeight: 700, fontSize: 13, cursor: 'pointer', textDecoration: e.activo ? 'none' : 'line-through' }}>{e.codigo}</button>
                    ))}
                    {!equipos.some(e => e.tipo === t.key) && <span style={{ fontSize: 12, color: '#999' }}>Sin equipos cargados</span>}
                  </div>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select value={nuevoEquipo.tipo} onChange={e => { const t = e.target.value as TipoTaller; setNuevoEquipo(p => ({ ...p, tipo: t, prefijo: TIPOS_TALLER.find(x => x.key === t)!.prefijo })) }} style={{ ...inputSt, flex: '0 0 160px', padding: '9px 12px', fontSize: 14, width: 'auto' }}>
                  {TIPOS_TALLER.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
                <input value={nuevoEquipo.prefijo} onChange={e => setNuevoEquipo(p => ({ ...p, prefijo: e.target.value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 6) }))} placeholder="SA" style={{ ...inputSt, flex: '0 0 70px', width: 70, padding: '9px 8px', fontSize: 14, textAlign: 'center', fontWeight: 700 }} />
                <span style={{ fontWeight: 700, color: '#999' }}>-</span>
                <input value={nuevoEquipo.numero} onChange={e => setNuevoEquipo(p => ({ ...p, numero: e.target.value.replace(/\D/g, '').slice(0, 5) }))} inputMode="numeric" placeholder="22" style={{ ...inputSt, flex: '0 0 80px', width: 80, padding: '9px 8px', fontSize: 14, fontWeight: 700 }} />
                <button onClick={agregarEquipo} style={{ padding: '9px 16px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
              </div>
              <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>Los equipos tildados en azul aparecen al iniciar un trabajo. Los camiones salen de la flota.</div>
            </div>

            <div style={card}>
              <label style={labelSt}>Mecánicos</label>
              {mecanicos.map(m => (
                <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #f3f3f3', opacity: m.activo ? 1 : 0.45 }}>
                  <span style={{ flex: 1, fontSize: 14 }}>{m.nombre} <span style={{ color: '#999', fontSize: 12 }}>{m.sucursal ?? ''}</span></span>
                  <button onClick={() => toggleMecActivo(m)} style={{ border: '1px solid #d6d6d6', background: '#fff', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>{m.activo ? 'Desactivar' : 'Activar'}</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input value={nuevoMecAdmin} onChange={e => setNuevoMecAdmin(e.target.value)} placeholder={`Nuevo mecánico (${sucursal})`} style={{ ...inputSt, padding: '9px 12px', fontSize: 14 }} />
                <button onClick={() => { agregarMecanico(nuevoMecAdmin, false); setNuevoMecAdmin('') }}
                  style={{ padding: '0 16px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ───────── MODAL EDITAR ORDEN (administradores) ───────── */}
      {edicion && calcEdicion && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 210, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => !guardando && setEdicion(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#f4f4f3', width: '100%', maxWidth: 600, maxHeight: '94dvh', overflowY: 'auto', borderRadius: '20px 20px 0 0', padding: '18px 16px 28px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Editar orden — {edicion.o.unidad_codigo}</div>
                <div style={{ fontSize: 13, color: '#666' }}>{edicion.o.estado === 'cerrada' ? 'Orden cerrada' : 'Orden en curso'} · los cambios quedan registrados con tu usuario</div>
              </div>
              <button onClick={() => setEdicion(null)} style={{ border: 'none', background: 'none', fontSize: 22, cursor: 'pointer', color: '#666' }}>✕</button>
            </div>

            <div style={card}>
              <label style={labelSt}>Unidad</label>
              <input list="unidades-edicion" value={edicion.unidad} onChange={e => setEdicion(p => p && ({ ...p, unidad: e.target.value }))} style={inputSt} />
              <datalist id="unidades-edicion">{[...camiones, ...equipos.map(e => e.codigo)].map(u => <option key={u} value={u} />)}</datalist>
              <label style={{ ...labelSt, marginTop: 12 }}>Tipo de intervención</label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {TIPOS.map(t => (
                  <button key={t.key} onClick={() => setEdicion(p => p && ({ ...p, tipo: t.key }))}
                    style={{ padding: '10px 6px', borderRadius: 12, cursor: 'pointer', fontWeight: 700, fontSize: 14,
                      border: `2px solid ${edicion.tipo === t.key ? t.color : '#e0e0e0'}`, background: edicion.tipo === t.key ? t.bg : '#fff', color: edicion.tipo === t.key ? t.color : '#666' }}>{t.icon} {t.label}</button>
                ))}
              </div>
            </div>

            <div style={card}>
              <label style={labelSt}>Fecha</label>
              <input type="date" value={edicion.fecha} onChange={e => setEdicion(p => p && ({ ...p, fecha: e.target.value }))} style={inputSt} />
              <label style={{ ...labelSt, marginTop: 12 }}>Hora de inicio</label>
              <input type="datetime-local" value={edicion.inicioStr} onChange={e => setEdicion(p => p && ({ ...p, inicioStr: e.target.value }))} style={inputSt} />
              {calcEdicion.cerrada && (
                <>
                  <label style={{ ...labelSt, marginTop: 12 }}>Hora de fin</label>
                  <input type="datetime-local" value={edicion.finStr} onChange={e => setEdicion(p => p && ({ ...p, finStr: e.target.value }))} style={inputSt} />
                  <div style={{ marginTop: 8, fontSize: 14, color: '#254A96', fontWeight: 700 }}>Tiempo transcurrido: {calcEdicion.transcurrido != null && calcEdicion.transcurrido > 0 ? fmtDur(calcEdicion.transcurrido) : '—'}</div>
                </>
              )}
            </div>

            <div style={card}>
              <label style={labelSt}>Mecánicos</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[...new Set([...mecanicos.filter(m => m.activo).map(m => m.nombre), ...edicion.mecs])].map(n => (
                  <button key={n} onClick={() => setEdicion(p => p && ({ ...p, mecs: p.mecs.includes(n) ? p.mecs.filter(x => x !== n) : [...p.mecs, n] }))} style={chip(edicion.mecs.includes(n))}>{n}</button>
                ))}
              </div>
            </div>

            <div style={card}>
              <label style={labelSt}>{calcEdicion.cerrada ? 'Tareas y minutos' : 'Tareas'}</label>
              {calcEdicion.tareas.map(({ t }) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <div style={{ flex: 1, fontSize: 14 }}>{t.personalizada ? '★ ' : ''}{t.nombre}<div style={{ fontSize: 11, color: '#999' }}>{t.sistema}</div></div>
                  {calcEdicion.cerrada && (
                    <input type="number" min={1} value={edicion.mins[t.id] ?? ''} onChange={e => setEdicion(p => p && ({ ...p, mins: { ...p.mins, [t.id]: e.target.value } }))}
                      style={{ width: 76, padding: '8px', borderRadius: 8, border: '1.5px solid #d6d6d6', textAlign: 'center', fontSize: 15 }} />
                  )}
                  <button title="Quitar la tarea" onClick={() => setEdicion(p => p && ({ ...p, quitadas: new Set([...p.quitadas, t.id]) }))} style={{ border: 'none', background: 'none', color: '#b91c1c', fontSize: 18, cursor: 'pointer' }}>✕</button>
                </div>
              ))}
              {calcEdicion.tareas.length === 0 && <div style={{ fontSize: 13, color: '#b91c1c' }}>No queda ninguna tarea.</div>}
              {calcEdicion.cerrada && calcEdicion.suma != null && calcEdicion.transcurrido != null && (
                <div style={{ marginTop: 10, fontSize: 13, color: '#444' }}>
                  Suma de tareas: <b>{fmtDur(calcEdicion.suma)}</b> · Diferencia con el tiempo transcurrido: <b style={{ color: calcEdicion.requiereMotivo ? '#b45309' : '#059669' }}>{calcEdicion.diferencia != null && calcEdicion.diferencia > 0 ? '+' : ''}{calcEdicion.diferencia != null ? fmtDur(calcEdicion.diferencia) : '—'}</b>
                </div>
              )}
              {calcEdicion.requiereMotivo && (
                <div style={{ marginTop: 10 }}>
                  <label style={labelSt}>Motivo de la diferencia (obligatorio)</label>
                  <input value={edicion.motivo} onChange={e => setEdicion(p => p && ({ ...p, motivo: e.target.value }))} placeholder="Ej: esperando repuesto, almuerzo…" style={inputSt} />
                </div>
              )}
            </div>

            <div style={card}>
              <label style={labelSt}>Observación de inicio</label>
              <textarea value={edicion.obs} onChange={e => setEdicion(p => p && ({ ...p, obs: e.target.value }))} rows={2} style={{ ...inputSt, resize: 'none' }} />
              {calcEdicion.cerrada && (
                <>
                  <label style={{ ...labelSt, marginTop: 12 }}>Observación de cierre</label>
                  <textarea value={edicion.obsCierre} onChange={e => setEdicion(p => p && ({ ...p, obsCierre: e.target.value }))} rows={2} style={{ ...inputSt, resize: 'none' }} />
                </>
              )}
            </div>

            <button onClick={guardarEdicion} disabled={guardando} style={{ ...btnPrimary, opacity: guardando ? 0.6 : 1 }}>{guardando ? 'Guardando…' : 'Guardar cambios'}</button>
            <button onClick={() => setEdicion(null)} disabled={guardando} style={btnSecondary}>Cancelar</button>
          </div>
        </div>
      )}

      {/* ───────── MODAL FINALIZAR ───────── */}
      {cierre && cierreCalc && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => !guardando && setCierre(null)}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#f4f4f3', width: '100%', maxWidth: 560, maxHeight: '94dvh', overflowY: 'auto', borderRadius: '20px 20px 0 0', padding: '18px 16px 28px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 800 }}>Finalizar — {cierre.unidad_codigo}</div>
                <div style={{ fontSize: 13, color: '#666' }}>Inició {ddmm(cierre.inicio)} {hhmm(cierre.inicio)}</div>
              </div>
              <button onClick={() => setCierre(null)} style={{ border: 'none', background: 'none', fontSize: 22, cursor: 'pointer', color: '#666' }}>✕</button>
            </div>

            <div style={card}>
              <label style={labelSt}>Hora de fin</label>
              <input type="datetime-local" value={finStr} onChange={e => setFinStr(e.target.value)} style={inputSt} />
              <div style={{ marginTop: 8, fontSize: 14, color: '#254A96', fontWeight: 700 }}>Tiempo transcurrido: {cierreCalc.transcurrido > 0 ? fmtDur(cierreCalc.transcurrido) : '—'}</div>
            </div>

            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ ...labelSt, marginBottom: 0 }}>Tiempo de cada tarea (minutos)</label>
                {cierreCalc.visibles.length > 1 && <button onClick={repartirIgual} style={{ border: 'none', background: '#eef2fb', color: '#254A96', borderRadius: 8, padding: '5px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Repartir en partes iguales</button>}
              </div>
              {cierreCalc.visibles.length === 1 && <div style={{ fontSize: 12, color: '#777', marginBottom: 6 }}>Con una sola tarea se calcula solo entre inicio y fin. Podés corregirlo si no fue todo ese tiempo.</div>}
              {cierreCalc.visibles.map(v => (
                <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <div style={{ flex: 1, fontSize: 14 }}>
                    {v.nueva ? '★ ' : ''}{v.nombre}
                    {v.std != null && <div style={{ fontSize: 11, color: '#888' }}>estándar: {fmtDur(v.std)}</div>}
                  </div>
                  <input type="number" inputMode="numeric" min={1} value={v.valor} placeholder="min"
                    onChange={e => setMinTarea(p => ({ ...p, [v.id]: e.target.value }))}
                    style={{ width: 82, padding: '9px 8px', borderRadius: 10, border: '1.5px solid #d6d6d6', textAlign: 'center', fontSize: 16, fontWeight: 700 }} />
                  <button onClick={() => {
                    if (v.nueva) setExtras(p => p.filter(e => e.id !== v.id))
                    else setQuitadas(p => new Set(p).add(v.id))
                  }} title="Quitar (no se hizo)" style={{ border: 'none', background: 'none', color: '#991b1b', cursor: 'pointer', fontSize: 15 }}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={extraTxt} onChange={e => setExtraTxt(e.target.value)} placeholder="＋ Tarea no prevista que también hiciste…" style={{ ...inputSt, padding: '9px 12px', fontSize: 14 }} />
                <button onClick={() => { const t = extraTxt.trim(); if (t) { setExtras(p => [...p, { id: `x:${crypto.randomUUID()}`, nombre: t }]); setExtraTxt('') } }}
                  style={{ padding: '0 14px', borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>Agregar</button>
              </div>
              {quitadas.size > 0 && <div style={{ fontSize: 12, color: '#777', marginTop: 8 }}>{quitadas.size} tarea{quitadas.size !== 1 ? 's' : ''} quitada{quitadas.size !== 1 ? 's' : ''} (no se hizo) <button onClick={() => setQuitadas(new Set())} style={{ border: 'none', background: 'none', color: '#254A96', cursor: 'pointer', fontWeight: 600 }}>deshacer</button></div>}
            </div>

            {cierreCalc.completo && (
              <div style={{ ...card, background: cierreCalc.requiereMotivo ? '#fffbeb' : '#ecfdf5', border: `1.5px solid ${cierreCalc.requiereMotivo ? '#fde68a' : '#bbf7d0'}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: cierreCalc.requiereMotivo ? '#92400e' : '#065f46' }}>
                  Suma de tareas: {fmtDur(cierreCalc.suma)} · Transcurrido: {fmtDur(cierreCalc.transcurrido)}
                </div>
                {cierreCalc.requiereMotivo ? (
                  <>
                    <div style={{ fontSize: 13, color: '#92400e', margin: '6px 0 10px' }}>
                      Hay una diferencia de {fmtDur(Math.abs(cierreCalc.diferencia))} {cierreCalc.diferencia > 0 ? 'sin asignar a tareas' : 'de más respecto al tiempo transcurrido'}. ¿Por qué?
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {MOTIVOS.map(m => <button key={m} onClick={() => setMotivoSel(m)} style={{ ...chip(motivoSel === m, '#b45309'), fontSize: 13, padding: '7px 12px' }}>{m}</button>)}
                    </div>
                    {motivoSel && (
                      <input value={motivoTxt} onChange={e => setMotivoTxt(e.target.value)} placeholder={motivoSel === 'Otro' ? 'Escribí el motivo (obligatorio)' : 'Detalle (opcional)'} style={{ ...inputSt, marginTop: 10, fontSize: 14, padding: '10px 12px' }} />
                    )}
                  </>
                ) : <div style={{ fontSize: 13, color: '#065f46', marginTop: 4 }}>Los tiempos coinciden ✓</div>}
              </div>
            )}

            <div style={card}>
              {renderFotosPicker(fotosDespues, setFotosDespues, "Fotos después")}
              <label style={{ ...labelSt, marginTop: 16 }}>Observación de cierre <span style={{ color: '#999', textTransform: 'none', fontWeight: 400 }}>(opcional)</span></label>
              <textarea value={obsCierre} onChange={e => setObsCierre(e.target.value)} rows={2} placeholder="Trabajos pendientes, repuestos a pedir…" style={{ ...inputSt, resize: 'none' }} />
            </div>

            <button onClick={finalizarTrabajo} disabled={guardando} style={{ ...btnPrimary, background: '#059669', opacity: guardando ? 0.6 : 1 }}>
              {guardando ? 'Guardando…' : '✅ Confirmar finalización'}
            </button>
          </div>
        </div>
      )}

      {/* ───────── VISOR FOTOS ───────── */}
      {visor && (
        <div onClick={() => setVisor(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 400, overflowY: 'auto', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: 600, margin: '0 auto' }}>
            <p style={{ color: '#fff', fontWeight: 700, textAlign: 'center', marginBottom: 12 }}>{visor.titulo}</p>
            {visor.fotos.map((f, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div style={{ color: '#ccc', fontSize: 12, marginBottom: 4 }}>{f.label}</div>
                <img src={f.url} alt="" style={{ width: '100%', borderRadius: 10 }} />
              </div>
            ))}
            <button onClick={() => setVisor(null)} style={{ display: 'block', margin: '0 auto', color: '#fff', background: 'transparent', border: '1px solid rgba(255,255,255,0.4)', borderRadius: 8, padding: '8px 24px', cursor: 'pointer' }}>Cerrar</button>
          </div>
        </div>
      )}
    </div>
  )
}

function FilaTarea({ c, on, onToggle, mostrarSistema }: { c: CatItem; on: boolean; onToggle: () => void; mostrarSistema?: boolean }) {
  return (
    <div onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f3f3f3', cursor: 'pointer' }}>
      <div style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, border: `2px solid ${on ? '#254A96' : '#c8c8c8'}`, background: on ? '#254A96' : '#fff', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700 }}>{on ? '✓' : ''}</div>
      <div style={{ flex: 1, fontSize: 15, lineHeight: 1.3 }}>
        {c.nombre}
        {mostrarSistema && <div style={{ fontSize: 11, color: '#999' }}>{c.sistema}</div>}
      </div>
    </div>
  )
}
