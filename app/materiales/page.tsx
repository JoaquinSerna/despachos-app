'use client'

import { useEffect, useState, useMemo, useRef } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const CATEGORIAS = [
  'Accesorios','Adhesivos y Aditivos','Áridos','Cementos','Chapas',
  'Construcción en seco','Electricidad','Gas','Herramientas eléctricas',
  'Herramientas manuales','Hidrofugos','Hierros','Ladrillos','Membranas',
  'Perfiles','Pinturas','Pretensados','Revestimiento','Sanitarios',
  'Sujeciones y fijaciones','Otros',
]
const TIPOS_CARGA = [
  'complementario','volumen','volumetrico_puro','chapa','hierro_suelto','granel','pretensado',
]
const UNIDADES = ['u','kg','m','m2','m3','tn','bolsa','rollo','par','juego','caja','pallet']

interface Alias {
  id: number
  descripcion_pdf: string
  material_id: number | null
  veces_visto: number
  resuelto: boolean
}
interface Material {
  id: number
  nombre: string
  categoria: string
  subcategoria: string | null
  unidad_base: string
  unidad_logistica: string
  cant_x_unid_log: number
  posiciones_x_unid_log: number
  peso_kg_x_posicion: number
  tipo_carga: string
  notas: string | null
}

const FORM_MATERIAL_VACIO = {
  nombre: '', categoria: '', subcategoria: '',
  unidad_base: 'u', unidad_logistica: 'u',
  cant_x_unid_log: 1, posiciones_x_unid_log: 1, peso_kg_x_posicion: 0,
  tipo_carga: 'complementario', notas: '',
}

export default function MaterialesPage() {
  const router = useRouter()
  const [tab, setTab] = useState<'pendientes' | 'maestro'>('pendientes')
  const [aliases, setAliases] = useState<Alias[]>([])
  const [materiales, setMateriales] = useState<Material[]>([])
  const [cargando, setCargando] = useState(true)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)

  // Modal vincular
  const [modalVincular, setModalVincular] = useState<Alias | null>(null)
  const [busquedaVincular, setBusquedaVincular] = useState('')
  const [guardandoVincular, setGuardandoVincular] = useState(false)

  // Modal dar de alta (crea material nuevo + resuelve alias)
  const [modalDarAlta, setModalDarAlta] = useState<Alias | null>(null)
  const [formAlta, setFormAlta] = useState(FORM_MATERIAL_VACIO)
  const [guardandoAlta, setGuardandoAlta] = useState(false)

  // Maestro: edición inline
  const [editandoMat, setEditandoMat] = useState<Material | null>(null)
  const [guardandoMat, setGuardandoMat] = useState(false)
  const [busquedaMaestro, setBusquedaMaestro] = useState('')

  // Auto-match
  interface MatchItem { alias: Alias; material: Material; score: number }
  interface AutoMatchResult { alto: MatchItem[]; medio: MatchItem[]; sinMatch: Alias[] }
  const [autoMatchResult, setAutoMatchResult] = useState<AutoMatchResult | null>(null)
  const [corriendoMatch, setCorriendoMatch] = useState(false)
  const [aplicandoMatch, setAplicandoMatch] = useState(false)
  const [medioAceptados, setMedioAceptados] = useState<Set<number>>(new Set())
  const [importando, setImportando] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  // ── Auto-match helpers ────────────────────────────────────────────────────
  function normalizarDesc(s: string) {
    return s.toLowerCase()
      .replace(/^\d+[\.\-]\s*/, '')
      .replace(/,/g, '.')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ').trim()
  }
  function tokenSim(a: string, b: string): number {
    const aN = normalizarDesc(a), bN = normalizarDesc(b)
    if (aN === bN) return 1
    if (aN.includes(bN) || bN.includes(aN)) return 0.85
    const tokA = new Set(aN.split(/\s+/).filter(t => t.length > 1))
    const tokB = new Set(bN.split(/\s+/).filter(t => t.length > 1))
    if (!tokA.size || !tokB.size) return 0
    let common = 0; for (const t of tokA) if (tokB.has(t)) common++
    return (2 * common) / (tokA.size + tokB.size)
  }

  function correrAutoMatch() {
    setCorriendoMatch(true)
    setTimeout(() => {
      const alto: MatchItem[] = [], medio: MatchItem[] = [], sinMatch: Alias[] = []
      for (const alias of pendientes) {
        let best: { mat: Material; score: number } | null = null
        for (const mat of materiales) {
          const score = tokenSim(alias.descripcion_pdf, mat.nombre)
          if (!best || score > best.score) best = { mat, score }
        }
        if (!best || best.score < 0.5) sinMatch.push(alias)
        else if (best.score >= 0.9) alto.push({ alias, material: best.mat, score: best.score })
        else medio.push({ alias, material: best.mat, score: best.score })
      }
      alto.sort((a, b) => b.score - a.score)
      medio.sort((a, b) => b.score - a.score)
      sinMatch.sort((a, b) => b.veces_visto - a.veces_visto)
      setAutoMatchResult({ alto, medio, sinMatch })
      setMedioAceptados(new Set())
      setCorriendoMatch(false)
    }, 50)
  }

  async function aplicarMatches() {
    if (!autoMatchResult) return
    setAplicandoMatch(true)
    const toResolve = [
      ...autoMatchResult.alto.map(m => ({ aliasId: m.alias.id, materialId: m.material.id })),
      ...autoMatchResult.medio.filter(m => medioAceptados.has(m.alias.id)).map(m => ({ aliasId: m.alias.id, materialId: m.material.id })),
    ]
    if (toResolve.length > 0) {
      await Promise.all(toResolve.map(({ aliasId, materialId }) =>
        supabase.from('material_aliases').update({ material_id: materialId, resuelto: true }).eq('id', aliasId)
      ))
      const resolvedMap = new Map(toResolve.map(r => [r.aliasId, r.materialId]))
      setAliases(prev => prev.map(a => resolvedMap.has(a.id) ? { ...a, material_id: resolvedMap.get(a.id)!, resuelto: true } : a))
      showToast(`${toResolve.length} aliases vinculados`)
    }
    setAutoMatchResult(null)
    setAplicandoMatch(false)
  }

  async function exportarSinMatch() {
    if (!autoMatchResult) return
    const XLSX = await import('xlsx')
    const noAceptados = autoMatchResult.medio.filter(m => !medioAceptados.has(m.alias.id))
    const filas = [
      ...noAceptados.map(m => ({
        descripcion_pdf: m.alias.descripcion_pdf,
        veces_visto: m.alias.veces_visto,
        sugerencia: m.material.nombre,
        confianza: `${Math.round(m.score * 100)}%`,
        nombre: '',
        categoria: '',
        subcategoria: '',
        tipo_carga: 'complementario',
        unidad_base: 'u',
        unidad_logistica: 'u',
        cant_x_unid_log: 1,
        posiciones_x_unid_log: 1,
        peso_kg_x_posicion: 0,
        notas: '',
      })),
      ...autoMatchResult.sinMatch.map(alias => ({
        descripcion_pdf: alias.descripcion_pdf,
        veces_visto: alias.veces_visto,
        sugerencia: '',
        confianza: '',
        nombre: '',
        categoria: '',
        subcategoria: '',
        tipo_carga: 'complementario',
        unidad_base: 'u',
        unidad_logistica: 'u',
        cant_x_unid_log: 1,
        posiciones_x_unid_log: 1,
        peso_kg_x_posicion: 0,
        notas: '',
      })),
    ]
    if (!filas.length) return
    const ws = XLSX.utils.json_to_sheet(filas)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Nuevos Materiales')
    XLSX.writeFile(wb, `materiales_nuevos_${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  async function handleImportarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setImportando(true)
    try {
      const buffer = await file.arrayBuffer()
      const XLSX = await import('xlsx')
      const wb = XLSX.read(buffer)
      const ws = wb.Sheets[wb.SheetNames[0]]
      const raw: any[] = XLSX.utils.sheet_to_json(ws, { defval: '' })
      const rows = raw
        .filter(r => r.nombre?.toString().trim())
        .map(r => ({
          descripcion_pdf: r.descripcion_pdf?.toString().trim() ?? '',
          nombre: r.nombre.toString().trim(),
          categoria: r.categoria?.toString().trim() ?? '',
          subcategoria: r.subcategoria?.toString().trim() || null,
          tipo_carga: r.tipo_carga?.toString().trim() || 'complementario',
          unidad_base: r.unidad_base?.toString().trim() || 'u',
          unidad_logistica: r.unidad_logistica?.toString().trim() || 'u',
          cant_x_unid_log: Number(r.cant_x_unid_log) || 1,
          posiciones_x_unid_log: Number(r.posiciones_x_unid_log) || 1,
          peso_kg_x_posicion: Number(r.peso_kg_x_posicion) || 0,
          notas: r.notas?.toString().trim() || null,
        }))
      if (rows.length === 0) { showToast('No hay filas con nombre completado', 'err'); setImportando(false); return }
      const resp = await fetch('/api/materiales/importar', {
        method: 'POST',
        body: JSON.stringify({ rows }),
        headers: { 'Content-Type': 'application/json' },
      })
      const result = await resp.json()
      if (!resp.ok) showToast(result.error ?? 'Error al importar', 'err')
      else { showToast(`${result.creados} materiales creados, ${result.vinculados} aliases resueltos`); cargar() }
    } catch { showToast('Error al leer el archivo', 'err') }
    setImportando(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      const rolesPermitidos = ['gerencia', 'ruteador', 'admin_flota', 'deposito']
      if (!rolesPermitidos.includes(data?.rol ?? '')) { router.push('/dashboard'); return }
      cargar()
    })
  }, [])

  async function cargar() {
    setCargando(true)
    const [{ data: al }, { data: mat }] = await Promise.all([
      supabase.from('material_aliases').select('*').order('resuelto').order('veces_visto', { ascending: false }),
      supabase.from('materiales').select('*').order('categoria').order('nombre'),
    ])
    setAliases(al ?? [])
    setMateriales(mat ?? [])
    setCargando(false)
  }

  // ── Vincular alias a material existente ───────────────────────────────────────
  const materialesFiltrados = useMemo(() => {
    if (!busquedaVincular.trim()) return materiales.slice(0, 50)
    const q = busquedaVincular.toLowerCase()
    return materiales.filter(m =>
      m.nombre.toLowerCase().includes(q) || m.categoria.toLowerCase().includes(q)
    ).slice(0, 50)
  }, [materiales, busquedaVincular])

  async function vincular(alias: Alias, materialId: number) {
    setGuardandoVincular(true)
    const { error } = await supabase
      .from('material_aliases')
      .update({ material_id: materialId, resuelto: true })
      .eq('id', alias.id)
    if (error) { showToast(error.message, 'err') }
    else {
      setAliases(prev => prev.map(a => a.id === alias.id ? { ...a, material_id: materialId, resuelto: true } : a))
      showToast('Vinculado correctamente')
      setModalVincular(null)
      setBusquedaVincular('')
    }
    setGuardandoVincular(false)
  }

  // ── Dar de alta: crear material nuevo y resolver alias ────────────────────────
  async function darDeAlta() {
    if (!modalDarAlta) return
    if (!formAlta.nombre.trim() || !formAlta.categoria) {
      showToast('Nombre y categoría son obligatorios', 'err'); return
    }
    setGuardandoAlta(true)
    // 1. Insertar nuevo material
    const { data: mat, error: matErr } = await supabase.from('materiales').insert({
      nombre: formAlta.nombre.trim(),
      categoria: formAlta.categoria,
      subcategoria: formAlta.subcategoria.trim() || null,
      unidad_base: formAlta.unidad_base,
      unidad_logistica: formAlta.unidad_logistica,
      cant_x_unid_log: Number(formAlta.cant_x_unid_log),
      posiciones_x_unid_log: Number(formAlta.posiciones_x_unid_log),
      peso_kg_x_posicion: Number(formAlta.peso_kg_x_posicion),
      tipo_carga: formAlta.tipo_carga,
      notas: formAlta.notas.trim() || null,
    }).select('id').single()

    if (matErr) { showToast(matErr.message, 'err'); setGuardandoAlta(false); return }

    // 2. Resolver alias
    const { error: aliasErr } = await supabase
      .from('material_aliases')
      .update({ material_id: mat.id, resuelto: true })
      .eq('id', modalDarAlta.id)

    if (aliasErr) { showToast(aliasErr.message, 'err') }
    else {
      setAliases(prev => prev.map(a => a.id === modalDarAlta.id ? { ...a, material_id: mat.id, resuelto: true } : a))
      setMateriales(prev => [...prev, { ...formAlta, id: mat.id, subcategoria: formAlta.subcategoria || null, notas: formAlta.notas || null, cant_x_unid_log: Number(formAlta.cant_x_unid_log), posiciones_x_unid_log: Number(formAlta.posiciones_x_unid_log), peso_kg_x_posicion: Number(formAlta.peso_kg_x_posicion) } as Material])
      showToast(`Material "${formAlta.nombre}" dado de alta y vinculado`)
      setModalDarAlta(null)
      setFormAlta(FORM_MATERIAL_VACIO)
    }
    setGuardandoAlta(false)
  }

  // ── Editar material del maestro ───────────────────────────────────────────────
  async function guardarMaterial() {
    if (!editandoMat) return
    setGuardandoMat(true)
    const { error } = await supabase.from('materiales').update({
      nombre: editandoMat.nombre,
      categoria: editandoMat.categoria,
      subcategoria: editandoMat.subcategoria || null,
      unidad_base: editandoMat.unidad_base,
      unidad_logistica: editandoMat.unidad_logistica,
      cant_x_unid_log: editandoMat.cant_x_unid_log,
      posiciones_x_unid_log: editandoMat.posiciones_x_unid_log,
      peso_kg_x_posicion: editandoMat.peso_kg_x_posicion,
      tipo_carga: editandoMat.tipo_carga,
      notas: editandoMat.notas,
    }).eq('id', editandoMat.id)
    if (error) { showToast(error.message, 'err') }
    else {
      setMateriales(prev => prev.map(m => m.id === editandoMat.id ? editandoMat : m))
      showToast('Material actualizado')
      setEditandoMat(null)
    }
    setGuardandoMat(false)
  }

  const pendientes = aliases.filter(a => !a.resuelto)
  const resueltos  = aliases.filter(a => a.resuelto)

  const maestroFiltrado = useMemo(() => {
    if (!busquedaMaestro.trim()) return materiales
    const q = busquedaMaestro.toLowerCase()
    return materiales.filter(m =>
      m.nombre.toLowerCase().includes(q) || m.categoria.toLowerCase().includes(q)
    )
  }, [materiales, busquedaMaestro])

  const inputCls = 'w-full border rounded-xl px-3 py-2 text-sm focus:outline-none'
  const inputSt = { borderColor: '#e8edf8' }

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Modal Vincular */}
      {modalVincular && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: '#f0f0f0' }}>
              <h3 className="font-bold text-sm" style={{ color: '#254A96' }}>🔗 Vincular a material existente</h3>
              <p className="text-xs mt-0.5 font-mono px-2 py-1 rounded mt-1 truncate" style={{ background: '#f4f4f3', color: '#555' }}>
                "{modalVincular.descripcion_pdf}"
              </p>
            </div>
            <div className="px-5 pt-3 pb-2">
              <input
                autoFocus
                type="text"
                placeholder="Buscar material..."
                value={busquedaVincular}
                onChange={e => setBusquedaVincular(e.target.value)}
                className={inputCls} style={inputSt}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-3 space-y-1">
              {materialesFiltrados.length === 0
                ? <p className="text-xs text-center py-6" style={{ color: '#B9BBB7' }}>Sin resultados</p>
                : materialesFiltrados.map(m => (
                  <button key={m.id} onClick={() => vincular(modalVincular, m.id)}
                    disabled={guardandoVincular}
                    className="w-full text-left px-3 py-2.5 rounded-xl text-sm hover:opacity-80 transition-opacity"
                    style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                    <div className="font-medium text-xs" style={{ color: '#1a1a1a' }}>{m.nombre}</div>
                    <div className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                      {m.categoria}{m.subcategoria ? ` · ${m.subcategoria}` : ''} ·
                      {' '}{m.posiciones_x_unid_log} pos/ud · {m.peso_kg_x_posicion} kg/pos
                    </div>
                  </button>
                ))
              }
            </div>
            <div className="px-5 py-3 border-t" style={{ borderColor: '#f0f0f0' }}>
              <button onClick={() => { setModalVincular(null); setBusquedaVincular('') }}
                className="w-full py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Dar de alta */}
      {modalDarAlta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: '#f0f0f0' }}>
              <h3 className="font-bold text-sm" style={{ color: '#254A96' }}>➕ Dar de alta en el maestro</h3>
              <p className="text-xs mt-1 font-mono px-2 py-1 rounded truncate" style={{ background: '#f4f4f3', color: '#555' }}>
                "{modalDarAlta.descripcion_pdf}"
              </p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nombre en el maestro <span style={{ color: '#E52322' }}>*</span></label>
                <input type="text" className={inputCls} style={inputSt}
                  value={formAlta.nombre}
                  onChange={e => setFormAlta(p => ({ ...p, nombre: e.target.value }))}
                  placeholder="Ej: Ladrillo hueco 8 huecos" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Categoría <span style={{ color: '#E52322' }}>*</span></label>
                  <select className={inputCls} style={inputSt}
                    value={formAlta.categoria}
                    onChange={e => setFormAlta(p => ({ ...p, categoria: e.target.value }))}>
                    <option value="">Seleccionar...</option>
                    {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Subcategoría</label>
                  <input type="text" className={inputCls} style={inputSt}
                    value={formAlta.subcategoria}
                    onChange={e => setFormAlta(p => ({ ...p, subcategoria: e.target.value }))}
                    placeholder="Ej: Hueco" />
                </div>
              </div>
              <div className="rounded-xl p-3 space-y-3" style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#254A96' }}>Datos logísticos</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Cant. x unidad log.</label>
                    <input type="number" min={0.1} step={0.1} className={inputCls} style={inputSt}
                      value={formAlta.cant_x_unid_log}
                      onChange={e => setFormAlta(p => ({ ...p, cant_x_unid_log: parseFloat(e.target.value) || 1 }))} />
                    <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Ej: 400 ladrillos por pallet</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Posiciones x ud. log.</label>
                    <input type="number" min={0} step={0.5} className={inputCls} style={inputSt}
                      value={formAlta.posiciones_x_unid_log}
                      onChange={e => setFormAlta(p => ({ ...p, posiciones_x_unid_log: parseFloat(e.target.value) || 0 }))} />
                    <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Ej: 1 posición por pallet</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Kg x posición</label>
                    <input type="number" min={0} step={1} className={inputCls} style={inputSt}
                      value={formAlta.peso_kg_x_posicion}
                      onChange={e => setFormAlta(p => ({ ...p, peso_kg_x_posicion: parseFloat(e.target.value) || 0 }))} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Unidad base</label>
                    <select className={inputCls} style={inputSt}
                      value={formAlta.unidad_base}
                      onChange={e => setFormAlta(p => ({ ...p, unidad_base: e.target.value }))}>
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Unidad logística</label>
                    <select className={inputCls} style={inputSt}
                      value={formAlta.unidad_logistica}
                      onChange={e => setFormAlta(p => ({ ...p, unidad_logistica: e.target.value }))}>
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Tipo de carga</label>
                    <select className={inputCls} style={inputSt}
                      value={formAlta.tipo_carga}
                      onChange={e => setFormAlta(p => ({ ...p, tipo_carga: e.target.value }))}>
                      {TIPOS_CARGA.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Notas</label>
                <input type="text" className={inputCls} style={inputSt}
                  value={formAlta.notas}
                  onChange={e => setFormAlta(p => ({ ...p, notas: e.target.value }))}
                  placeholder="Observaciones opcionales" />
              </div>
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button onClick={darDeAlta} disabled={guardandoAlta}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardandoAlta ? 'Guardando...' : '➕ Dar de alta y vincular'}
              </button>
              <button onClick={() => { setModalDarAlta(null); setFormAlta(FORM_MATERIAL_VACIO) }}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal editar material */}
      {editandoMat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <div className="px-5 py-4 border-b" style={{ borderColor: '#f0f0f0' }}>
              <h3 className="font-bold text-sm" style={{ color: '#254A96' }}>✏️ Editar material</h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nombre</label>
                <input type="text" className={inputCls} style={inputSt}
                  value={editandoMat.nombre}
                  onChange={e => setEditandoMat(p => p ? { ...p, nombre: e.target.value } : p)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Categoría</label>
                  <select className={inputCls} style={inputSt}
                    value={editandoMat.categoria}
                    onChange={e => setEditandoMat(p => p ? { ...p, categoria: e.target.value } : p)}>
                    {CATEGORIAS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Subcategoría</label>
                  <input type="text" className={inputCls} style={inputSt}
                    value={editandoMat.subcategoria ?? ''}
                    onChange={e => setEditandoMat(p => p ? { ...p, subcategoria: e.target.value } : p)} />
                </div>
              </div>
              <div className="rounded-xl p-3 space-y-3" style={{ background: '#f8faff', border: '1px solid #e8edf8' }}>
                <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#254A96' }}>Datos logísticos</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Cant. x ud. log.</label>
                    <input type="number" min={0.1} step={0.1} className={inputCls} style={inputSt}
                      value={editandoMat.cant_x_unid_log}
                      onChange={e => setEditandoMat(p => p ? { ...p, cant_x_unid_log: parseFloat(e.target.value) || 1 } : p)} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Pos. x ud. log.</label>
                    <input type="number" min={0} step={0.5} className={inputCls} style={inputSt}
                      value={editandoMat.posiciones_x_unid_log}
                      onChange={e => setEditandoMat(p => p ? { ...p, posiciones_x_unid_log: parseFloat(e.target.value) || 0 } : p)} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Kg x posición</label>
                    <input type="number" min={0} step={1} className={inputCls} style={inputSt}
                      value={editandoMat.peso_kg_x_posicion}
                      onChange={e => setEditandoMat(p => p ? { ...p, peso_kg_x_posicion: parseFloat(e.target.value) || 0 } : p)} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Unidad base</label>
                    <select className={inputCls} style={inputSt}
                      value={editandoMat.unidad_base}
                      onChange={e => setEditandoMat(p => p ? { ...p, unidad_base: e.target.value } : p)}>
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Unidad logística</label>
                    <select className={inputCls} style={inputSt}
                      value={editandoMat.unidad_logistica}
                      onChange={e => setEditandoMat(p => p ? { ...p, unidad_logistica: e.target.value } : p)}>
                      {UNIDADES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1" style={{ color: '#666' }}>Tipo de carga</label>
                    <select className={inputCls} style={inputSt}
                      value={editandoMat.tipo_carga}
                      onChange={e => setEditandoMat(p => p ? { ...p, tipo_carga: e.target.value } : p)}>
                      {TIPOS_CARGA.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Notas</label>
                <input type="text" className={inputCls} style={inputSt}
                  value={editandoMat.notas ?? ''}
                  onChange={e => setEditandoMat(p => p ? { ...p, notas: e.target.value } : p)} />
              </div>
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button onClick={guardarMaterial} disabled={guardandoMat}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardandoMat ? 'Guardando...' : 'Guardar cambios'}
              </button>
              <button onClick={() => setEditandoMat(null)}
                className="px-4 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Auto-match */}
      {autoMatchResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col" style={{ fontFamily: 'Barlow, sans-serif' }}>
            <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#f0f0f0' }}>
              <h3 className="font-bold text-sm" style={{ color: '#254A96' }}>🔍 Resultados del auto-match</h3>
              <span className="text-xs" style={{ color: '#B9BBB7' }}>{pendientes.length} aliases analizados</span>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

              {/* Alta confianza */}
              {autoMatchResult.alto.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: '#d1fae5', color: '#065f46' }}>
                      ✓ Alta confianza ({autoMatchResult.alto.length})
                    </span>
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>Se vincularán automáticamente</span>
                  </div>
                  <div className="rounded-xl overflow-hidden border" style={{ borderColor: '#e8edf8' }}>
                    <div className="max-h-44 overflow-y-auto">
                      <table className="w-full text-xs">
                        <tbody>
                          {autoMatchResult.alto.map(m => (
                            <tr key={m.alias.id} style={{ borderBottom: '1px solid #f4f4f3' }}>
                              <td className="px-3 py-1.5 font-mono" style={{ color: '#888' }}>
                                {m.alias.descripcion_pdf}
                              </td>
                              <td className="px-1 py-1.5 text-center" style={{ color: '#B9BBB7' }}>→</td>
                              <td className="px-3 py-1.5 font-medium" style={{ color: '#065f46' }}>{m.material.nombre}</td>
                              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap" style={{ color: '#B9BBB7' }}>{Math.round(m.score * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Confianza media */}
              {autoMatchResult.medio.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: '#fef3c7', color: '#b45309' }}>
                      ? Confianza media ({autoMatchResult.medio.length})
                    </span>
                    <button
                      onClick={() => setMedioAceptados(prev =>
                        prev.size === autoMatchResult!.medio.length
                          ? new Set()
                          : new Set(autoMatchResult!.medio.map(m => m.alias.id))
                      )}
                      className="text-xs px-2 py-0.5 rounded font-medium"
                      style={{ background: '#f4f4f3', color: '#666' }}>
                      {medioAceptados.size === autoMatchResult.medio.length ? 'Deseleccionar todos' : 'Seleccionar todos'}
                    </button>
                  </div>
                  <div className="rounded-xl overflow-hidden border" style={{ borderColor: '#e8edf8' }}>
                    <div className="max-h-44 overflow-y-auto">
                      <table className="w-full text-xs">
                        <tbody>
                          {autoMatchResult.medio.map(m => (
                            <tr key={m.alias.id}
                              style={{ borderBottom: '1px solid #f4f4f3', background: medioAceptados.has(m.alias.id) ? '#f0fdf4' : 'white', cursor: 'pointer' }}
                              onClick={() => setMedioAceptados(prev => { const n = new Set(prev); n.has(m.alias.id) ? n.delete(m.alias.id) : n.add(m.alias.id); return n })}>
                              <td className="px-3 py-1.5">
                                <input type="checkbox" readOnly checked={medioAceptados.has(m.alias.id)} />
                              </td>
                              <td className="px-2 py-1.5 font-mono" style={{ color: '#888' }}>
                                {m.alias.descripcion_pdf}
                              </td>
                              <td className="px-1 py-1.5 text-center" style={{ color: '#B9BBB7' }}>→</td>
                              <td className="px-3 py-1.5 font-medium" style={{ color: '#1a1a1a' }}>{m.material.nombre}</td>
                              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap" style={{ color: '#b45309' }}>{Math.round(m.score * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* Sin match */}
              {autoMatchResult.sinMatch.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: '#fde8e8', color: '#E52322' }}>
                      ✕ Sin match ({autoMatchResult.sinMatch.length})
                    </span>
                    <button onClick={exportarSinMatch}
                      className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                      style={{ background: '#254A96', color: 'white' }}>
                      📥 Exportar Excel
                    </button>
                  </div>
                  <div className="rounded-xl px-4 py-3 text-xs" style={{ background: '#fde8e8', color: '#b45309' }}>
                    Estos {autoMatchResult.sinMatch.length} productos no están en el maestro. Exportalos, completá los datos logísticos e importalos con el botón "Importar maestro".
                  </div>
                </div>
              )}

              {autoMatchResult.alto.length === 0 && autoMatchResult.medio.length === 0 && autoMatchResult.sinMatch.length === 0 && (
                <p className="text-sm text-center py-6" style={{ color: '#B9BBB7' }}>Sin resultados</p>
              )}
            </div>

            <div className="px-5 py-3 border-t flex gap-2" style={{ borderColor: '#f0f0f0' }}>
              {(autoMatchResult.alto.length + medioAceptados.size) > 0 && (
                <button onClick={aplicarMatches} disabled={aplicandoMatch}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: '#254A96' }}>
                  {aplicandoMatch ? 'Vinculando...' : `Vincular ${autoMatchResult.alto.length + medioAceptados.size} aliases`}
                </button>
              )}
              <button onClick={() => setAutoMatchResult(null)}
                className="px-5 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: '#f4f4f3', color: '#666' }}>
                {(autoMatchResult.alto.length + medioAceptados.size) > 0 ? 'Cancelar' : 'Cerrar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-[1600px] mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/dashboard"
              className="text-xs px-2 py-1.5 rounded-lg font-medium"
              style={{ background: '#e8edf8', color: '#254A96' }}>← Volver</Link>
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <span className="font-bold text-sm" style={{ color: '#254A96' }}>Materiales</span>
          </div>
          <div className="flex gap-2">
            {(['pendientes', 'maestro'] as const).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className="px-4 py-1.5 rounded-lg text-sm font-medium capitalize"
                style={{ background: tab === t ? '#254A96' : '#f4f4f3', color: tab === t ? 'white' : '#666' }}>
                {t === 'pendientes'
                  ? `Pendientes${pendientes.length > 0 ? ` (${pendientes.length})` : ''}`
                  : 'Maestro'}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <main className="max-w-[1600px] mx-auto px-4 py-5">
        {cargando ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : tab === 'pendientes' ? (

          /* ── TAB PENDIENTES ─────────────────────────────────────────────────── */
          <div className="space-y-4">
            {pendientes.length === 0 ? (
              <div className="text-center py-24" style={{ color: '#B9BBB7' }}>
                <p className="text-3xl mb-2">✅</p>
                <p className="text-sm font-medium">Sin productos pendientes de resolver</p>
                <p className="text-xs mt-1">Aparecerán acá cuando se cargue una SD con productos sin match</p>
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="rounded-xl px-4 py-3 text-sm flex items-center gap-2 flex-1 min-w-0" style={{ background: '#fef3c7', color: '#b45309' }}>
                    <span>⚠️</span>
                    <span>Estos productos aparecieron en SDs pero no matchearon con ningún material del maestro. Resolvelos para que los pedidos futuros calculen posiciones correctamente.</span>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={correrAutoMatch} disabled={corriendoMatch}
                      className="text-xs px-3 py-2 rounded-lg font-semibold disabled:opacity-50"
                      style={{ background: '#254A96', color: 'white' }}>
                      {corriendoMatch ? '⏳ Analizando...' : '🔍 Auto-vincular'}
                    </button>
                    <label className={`text-xs px-3 py-2 rounded-lg font-semibold cursor-pointer ${importando ? 'opacity-50 pointer-events-none' : ''}`}
                      style={{ background: '#f0fdf4', color: '#065f46' }}>
                      {importando ? '⏳ Importando...' : '📤 Importar maestro'}
                      <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden"
                        onChange={handleImportarFile} disabled={importando} />
                    </label>
                  </div>
                </div>
                <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr style={{ background: '#f4f4f3', borderBottom: '1px solid #e8edf8' }}>
                        <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Descripción del PDF</th>
                        <th className="text-center px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>Veces visto</th>
                        <th className="px-4 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendientes.map((a, i) => (
                        <tr key={a.id} style={{ borderBottom: i < pendientes.length - 1 ? '1px solid #f4f4f3' : 'none' }}>
                          <td className="px-4 py-3">
                            <code className="text-xs px-2 py-1 rounded" style={{ background: '#f4f4f3', color: '#1a1a1a' }}>
                              {a.descripcion_pdf}
                            </code>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <span className="text-xs font-semibold px-2 py-1 rounded-full" style={{ background: a.veces_visto >= 5 ? '#fde8e8' : '#f4f4f3', color: a.veces_visto >= 5 ? '#E52322' : '#666' }}>
                              {a.veces_visto}×
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex gap-2 justify-end">
                              <button onClick={() => { setModalVincular(a); setBusquedaVincular('') }}
                                className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                                style={{ background: '#e8edf8', color: '#254A96' }}>
                                🔗 Vincular
                              </button>
                              <button onClick={() => { setModalDarAlta(a); setFormAlta({ ...FORM_MATERIAL_VACIO, nombre: a.descripcion_pdf }) }}
                                className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                                style={{ background: '#f0fdf4', color: '#065f46' }}>
                                ➕ Dar de alta
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* Resueltos recientes */}
            {resueltos.length > 0 && (
              <div className="bg-white rounded-xl shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 border-b" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
                  <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>
                    Resueltos ({resueltos.length})
                  </p>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {resueltos.map((a, i) => {
                      const mat = materiales.find(m => m.id === a.material_id)
                      return (
                        <tr key={a.id} style={{ borderBottom: i < resueltos.length - 1 ? '1px solid #f4f4f3' : 'none' }}>
                          <td className="px-4 py-2.5">
                            <code className="text-xs px-2 py-1 rounded" style={{ background: '#f4f4f3', color: '#888' }}>
                              {a.descripcion_pdf}
                            </code>
                          </td>
                          <td className="px-4 py-2.5 text-xs" style={{ color: '#B9BBB7' }}>→</td>
                          <td className="px-4 py-2.5 text-xs font-medium" style={{ color: '#065f46' }}>
                            {mat?.nombre ?? `Material #${a.material_id}`}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-right" style={{ color: '#B9BBB7' }}>
                            {a.veces_visto}× visto
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        ) : (

          /* ── TAB MAESTRO ─────────────────────────────────────────────────────── */
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <input type="text" placeholder="Buscar por nombre o categoría..."
                value={busquedaMaestro} onChange={e => setBusquedaMaestro(e.target.value)}
                className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none max-w-sm"
                style={{ borderColor: '#e8edf8' }} />
              <span className="text-xs" style={{ color: '#B9BBB7' }}>{maestroFiltrado.length} materiales</span>
            </div>
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: '#f4f4f3', borderBottom: '1px solid #e8edf8' }}>
                    {['Nombre', 'Categoría', 'Cant/ud.log', 'Pos/ud.log', 'Kg/pos', 'Tipo', ''].map(h => (
                      <th key={h} className="text-left px-4 py-3 text-xs font-semibold whitespace-nowrap" style={{ color: '#254A96' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {maestroFiltrado.map((m, i) => (
                    <tr key={m.id} style={{ borderBottom: i < maestroFiltrado.length - 1 ? '1px solid #f4f4f3' : 'none' }}>
                      <td className="px-4 py-2.5">
                        <div className="text-xs font-medium" style={{ color: '#1a1a1a' }}>{m.nombre}</div>
                        {m.subcategoria && <div className="text-xs" style={{ color: '#B9BBB7' }}>{m.subcategoria}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: '#666' }}>{m.categoria}</td>
                      <td className="px-4 py-2.5 text-xs font-mono text-center" style={{ color: '#254A96' }}>{m.cant_x_unid_log}</td>
                      <td className="px-4 py-2.5 text-xs font-mono text-center" style={{ color: '#254A96' }}>{m.posiciones_x_unid_log}</td>
                      <td className="px-4 py-2.5 text-xs font-mono text-center" style={{ color: '#666' }}>{m.peso_kg_x_posicion}</td>
                      <td className="px-4 py-2.5 text-xs" style={{ color: '#888' }}>{m.tipo_carga}</td>
                      <td className="px-4 py-2.5">
                        <button onClick={() => setEditandoMat(m)}
                          className="text-xs px-2.5 py-1 rounded-lg font-medium"
                          style={{ background: '#f4f4f3', color: '#254A96' }}>✏️</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
