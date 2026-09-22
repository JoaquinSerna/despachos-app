'use client'

import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

const CATEGORIAS: Record<string, string[]> = {
  'DEVOLUCION COMERCIAL':   ['Error en NV', 'Error en fecha de entrega', 'Pedido reprogramado sin aviso', 'Precio no coincide', 'Cliente canceló sin avisar'],
  'DEVOLUCION DE CARGA':    ['Material de más o de menos', 'Producto distinto', 'Producto dañado'],
  'DEVOLUCION LOGISTICA':   ['Cliente ausente', 'Confusión de remito', 'Acceso imposible', 'Dirección incorrecta', 'Vehículo inadecuado', 'Fuera de horario'],
  'DEVOLUCION POR COBRO':   ['Sin efectivo', 'Crédito bloqueado', 'Precio no coincide al cobrar'],
  'RETIRA CLIENTE':         ['Material sobrante en obra'],
}

const MAX_FOTOS = 5

type Accion = 'home' | 'salida' | 'ingreso' | 'devolucion' | 'inicio_carga' | 'fin_carga'

interface FotoItem {
  file: File
  preview: string
}

function hoy() { return new Date().toISOString().split('T')[0] }
function horaLocal() { return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) }

function toCSV(rows: any[]): string {
  if (!rows.length) return ''
  const cols = [
    'fecha', 'hora', 'tipo', 'camion_codigo', 'cant_pedidos',
    'tipo_ingreso', 'deposito_desde',
    'chofer_apellido', 'categoria', 'motivo', 'remito', 'nv', 'observacion',
    'cant_posiciones', 'paquetes_hierro',
  ]
  const header = cols.join(';')
  const lines = rows.map(r => {
    const hora = r.created_at
      ? new Date(r.created_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
      : ''
    const vals: Record<string, any> = { ...r, hora }
    return cols.map(c => {
      const v = vals[c] ?? ''
      const s = String(v).replace(/"/g, '""')
      return s.includes(';') || s.includes('\n') ? `"${s}"` : s
    }).join(';')
  })
  return [header, ...lines].join('\n')
}

function descargarCSV(content: string, nombre: string) {
  const bom = '﻿'
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = nombre; a.click()
  URL.revokeObjectURL(url)
}

export default function GuardiaPage() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [rol, setRol] = useState<string>('')
  const [cargando, setCargando] = useState(true)
  const [camiones, setCamiones] = useState<string[]>([])
  const [tab, setTab] = useState<'guardia' | 'deposito'>('guardia')
  const [accion, setAccion] = useState<Accion>('home')
  const [guardando, setGuardando] = useState(false)
  const [exportando, setExportando] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [ultimoEvento, setUltimoEvento] = useState<string | null>(null)

  // Matriz de actividad
  const [matrizFecha, setMatrizFecha] = useState(hoy())
  const [matrizData, setMatrizData] = useState<any[]>([])
  const [matrizLoading, setMatrizLoading] = useState(false)

  // Salida
  const [salCamion, setSalCamion] = useState('')
  const [salCant, setSalCant] = useState('')
  const [salVacio, setSalVacio] = useState(false)
  const [salFotos, setSalFotos] = useState<FotoItem[]>([])
  const salFileRef = useRef<HTMLInputElement>(null)

  // Ingreso
  const [ingCamion, setIngCamion] = useState('')
  const [ingTipo, setIngTipo] = useState<'directo' | 'con_transferencia'>('directo')
  const [ingDeposito, setIngDeposito] = useState('')

  // Devolución
  const [devCamion, setDevCamion] = useState('')
  const [devChofer, setDevChofer] = useState('')
  const [devCategoria, setDevCategoria] = useState('')
  const [devMotivo, setDevMotivo] = useState('')
  const [devRemito, setDevRemito] = useState('')
  const [devNV, setDevNV] = useState('')
  const [devObs, setDevObs] = useState('')
  const [devFotos, setDevFotos] = useState<FotoItem[]>([])
  const devFileRef = useRef<HTMLInputElement>(null)

  // Inicio de carga
  const [icCamion, setIcCamion] = useState('')
  const [icPosiciones, setIcPosiciones] = useState('')
  const [icHierro, setIcHierro] = useState('')

  // Fin de carga
  const [fcCamion, setFcCamion] = useState('')

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data: perfil } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      const rolesPermitidos = ['guardia', 'gerencia', 'admin_flota', 'ruteador', 'deposito']
      if (!rolesPermitidos.includes(perfil?.rol ?? '')) { router.push('/dashboard'); return }
      setUserId(user.id)
      const r = perfil?.rol ?? ''
      setRol(r)
      if (r === 'deposito') setTab('deposito')

      const { data: flota } = await supabase
        .from('camiones_flota')
        .select('codigo')
        .order('codigo')
      setCamiones((flota ?? []).map((c: any) => c.codigo))
      setCargando(false)
    })
  }, [])

  const agregarFotos = (files: FileList | null, setter: React.Dispatch<React.SetStateAction<FotoItem[]>>, current: FotoItem[]) => {
    if (!files) return
    const disponibles = MAX_FOTOS - current.length
    if (disponibles <= 0) { showToast(`Máximo ${MAX_FOTOS} fotos`, 'err'); return }
    const nuevas = Array.from(files).slice(0, disponibles).map(file => ({
      file,
      preview: URL.createObjectURL(file),
    }))
    setter(prev => [...prev, ...nuevas])
  }

  const quitarFoto = (index: number, setter: React.Dispatch<React.SetStateAction<FotoItem[]>>) => {
    setter(prev => {
      URL.revokeObjectURL(prev[index].preview)
      return prev.filter((_, i) => i !== index)
    })
  }

  const subirFotos = async (fotos: FotoItem[], eventoId: string): Promise<string[]> => {
    const urls: string[] = []
    for (let i = 0; i < fotos.length; i++) {
      const ext = fotos[i].file.name.split('.').pop() ?? 'jpg'
      const path = `${eventoId}/${i}.${ext}`
      const { error } = await supabase.storage.from('guardia-fotos').upload(path, fotos[i].file, { upsert: true })
      if (error) throw error
      const { data } = supabase.storage.from('guardia-fotos').getPublicUrl(path)
      urls.push(data.publicUrl)
    }
    return urls
  }

  const resetForms = () => {
    setSalCamion(''); setSalCant(''); setSalVacio(false)
    salFotos.forEach(f => URL.revokeObjectURL(f.preview))
    setSalFotos([])
    setIngCamion(''); setIngTipo('directo'); setIngDeposito('')
    setDevCamion(''); setDevChofer(''); setDevCategoria(''); setDevMotivo('')
    setDevRemito(''); setDevNV(''); setDevObs('')
    devFotos.forEach(f => URL.revokeObjectURL(f.preview))
    setDevFotos([])
    setIcCamion(''); setIcPosiciones(''); setIcHierro('')
    setFcCamion('')
  }

  const exportarRegistros = async () => {
    setExportando(true)
    const { data, error } = await supabase
      .from('guardia_eventos')
      .select('*')
      .order('created_at', { ascending: false })
    setExportando(false)
    if (error || !data?.length) { showToast('Sin registros para exportar', 'err'); return }
    const csv = toCSV(data)
    descargarCSV(csv, `guardia_${hoy()}.csv`)
    showToast(`${data.length} registros exportados`)
  }

  const cargarMatriz = async (fecha: string) => {
    setMatrizLoading(true)
    const { data } = await supabase
      .from('guardia_eventos')
      .select('id, camion_codigo, tipo, created_at, cant_pedidos, tipo_ingreso, cant_posiciones, paquetes_hierro')
      .eq('fecha', fecha)
      .order('created_at', { ascending: true })
    setMatrizData(data ?? [])
    setMatrizLoading(false)
  }

  useEffect(() => {
    if (accion === 'home') cargarMatriz(matrizFecha)
  }, [accion, matrizFecha])

  const registrarSalida = async () => {
    if (!salCamion) { showToast('Seleccioná el camión', 'err'); return }
    if (!salVacio && !salCant) { showToast('Ingresá la cantidad de pedidos', 'err'); return }
    if (!salVacio && salFotos.length === 0) { showToast('Agregá al menos 1 foto', 'err'); return }
    setGuardando(true)
    try {
      const eventoId = crypto.randomUUID()
      const fotosUrls = salFotos.length > 0 ? await subirFotos(salFotos, eventoId) : []
      const { error } = await supabase.from('guardia_eventos').insert({
        id: eventoId, fecha: hoy(), tipo: 'salida',
        camion_codigo: salCamion, cant_pedidos: salVacio ? 0 : Number(salCant),
        fotos_urls: fotosUrls, registrado_por: userId,
      })
      if (error) throw error
      setUltimoEvento(
        salVacio
          ? `✅ ${salCamion} salió vacío — ${horaLocal()}`
          : `✅ ${salCamion} salió con ${salCant} pedido${Number(salCant) !== 1 ? 's' : ''} — ${horaLocal()}`
      )
      resetForms(); setAccion('home')
      showToast(`Salida registrada — ${salCamion}`)
    } catch { showToast('Error al guardar', 'err') }
    finally { setGuardando(false) }
  }

  const registrarIngreso = async () => {
    if (!ingCamion) { showToast('Seleccioná el camión', 'err'); return }
    if (ingTipo === 'con_transferencia' && !ingDeposito) { showToast('Indicá el depósito de origen', 'err'); return }
    setGuardando(true)
    const { error } = await supabase.from('guardia_eventos').insert({
      fecha: hoy(), tipo: 'ingreso', camion_codigo: ingCamion,
      tipo_ingreso: ingTipo, deposito_desde: ingTipo === 'con_transferencia' ? ingDeposito : null,
      registrado_por: userId,
    })
    setGuardando(false)
    if (error) { showToast('Error al guardar', 'err'); return }
    const label = ingTipo === 'con_transferencia' ? `con transferencia desde ${ingDeposito}` : 'directo'
    setUltimoEvento(`✅ ${ingCamion} ingresó ${label} — ${horaLocal()}`)
    resetForms(); setAccion('home')
    showToast(`Ingreso registrado — ${ingCamion}`)
  }

  const registrarDevolucion = async () => {
    if (!devCamion || !devChofer || !devCategoria || !devMotivo) {
      showToast('Completá camión, chofer, categoría y motivo', 'err'); return
    }
    if (devFotos.length === 0) { showToast('Agregá al menos 1 foto', 'err'); return }
    setGuardando(true)
    try {
      const eventoId = crypto.randomUUID()
      const fotosUrls = await subirFotos(devFotos, eventoId)
      const { error } = await supabase.from('guardia_eventos').insert({
        id: eventoId, fecha: hoy(), tipo: 'devolucion',
        camion_codigo: devCamion, chofer_apellido: devChofer,
        categoria: devCategoria, motivo: devMotivo,
        remito: devRemito || null, nv: devNV || null, observacion: devObs || null,
        fotos_urls: fotosUrls, registrado_por: userId,
      })
      if (error) throw error
      setUltimoEvento(`✅ Devolución ${devCamion} — ${devCategoria} — ${horaLocal()}`)
      resetForms(); setAccion('home')
      showToast(`Devolución registrada — ${devCamion}`)
    } catch { showToast('Error al guardar', 'err') }
    finally { setGuardando(false) }
  }

  const registrarInicioCarga = async () => {
    if (!icCamion) { showToast('Seleccioná el camión', 'err'); return }
    if (!icPosiciones && !icHierro) { showToast('Ingresá posiciones o paquetes de hierro', 'err'); return }
    setGuardando(true)
    const { error } = await supabase.from('guardia_eventos').insert({
      fecha: hoy(), tipo: 'inicio_carga', camion_codigo: icCamion,
      cant_posiciones: icPosiciones ? Number(icPosiciones) : null,
      paquetes_hierro: icHierro ? Number(icHierro) : null,
      registrado_por: userId,
    })
    setGuardando(false)
    if (error) { showToast('Error al guardar', 'err'); return }
    const detalle = [icPosiciones && `${icPosiciones} pos.`, icHierro && `${icHierro} paq. hierro`].filter(Boolean).join(' + ')
    setUltimoEvento(`✅ Inicio carga ${icCamion} — ${detalle} — ${horaLocal()}`)
    resetForms(); setAccion('home')
    showToast(`Inicio de carga registrado — ${icCamion}`)
  }

  const registrarFinCarga = async () => {
    if (!fcCamion) { showToast('Seleccioná el camión', 'err'); return }
    setGuardando(true)
    const { error } = await supabase.from('guardia_eventos').insert({
      fecha: hoy(), tipo: 'fin_carga', camion_codigo: fcCamion,
      registrado_por: userId,
    })
    setGuardando(false)
    if (error) { showToast('Error al guardar', 'err'); return }
    setUltimoEvento(`✅ Fin de carga ${fcCamion} — ${horaLocal()}`)
    resetForms(); setAccion('home')
    showToast(`Fin de carga registrado — ${fcCamion}`)
  }

  if (cargando) {
    return (
      <div style={{ minHeight: '100dvh', background: '#f4f4f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#666', fontSize: 15 }}>Cargando…</p>
      </div>
    )
  }

  const esDeposito = rol === 'deposito'
  const verTabs = !['guardia', 'deposito'].includes(rol)
  // Roles que tienen dashboard al que volver
  const tieneDashboard = !['guardia', 'deposito'].includes(rol)

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '14px 12px', fontSize: 16, borderRadius: 12,
    border: '1.5px solid #e0e0e0', background: '#fff', color: '#1a1a1a',
    appearance: 'none', WebkitAppearance: 'none', boxSizing: 'border-box',
  }
  const labelStyle: React.CSSProperties = { fontSize: 13, color: '#666', marginBottom: 6, display: 'block' }
  const fieldStyle: React.CSSProperties = { marginBottom: 16 }
  const btnPrimary: React.CSSProperties = {
    width: '100%', padding: '16px', fontSize: 16, fontWeight: 700,
    borderRadius: 14, border: 'none', background: '#254A96', color: '#fff',
    cursor: 'pointer', marginTop: 8,
  }
  const btnSecondary: React.CSSProperties = {
    width: '100%', padding: '14px', fontSize: 15, fontWeight: 500,
    borderRadius: 14, border: '1.5px solid #e0e0e0', background: '#fff', color: '#444',
    cursor: 'pointer', marginTop: 8,
  }

  const accionTitulo: Record<Accion, string> = {
    home: '🔒 Guardia y Cargas',
    salida: '🚛 Salida de camión',
    ingreso: '🏠 Ingreso de camión',
    devolucion: '📋 Devolución',
    inicio_carga: '📦 Inicio de carga',
    fin_carga: '✅ Fin de carga',
  }

  const FotoSection = ({
    fotos, setter, fileRef, color,
  }: {
    fotos: FotoItem[]
    setter: React.Dispatch<React.SetStateAction<FotoItem[]>>
    fileRef: React.RefObject<HTMLInputElement | null>
    color: string
  }) => (
    <div style={fieldStyle}>
      <label style={labelStyle}>
        Fotos <span style={{ color: '#999' }}>({fotos.length}/{MAX_FOTOS}) — mín. 1 requerida</span>
      </label>
      {fotos.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {fotos.map((f, i) => (
            <div key={i} style={{ position: 'relative', width: 80, height: 80 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.preview} alt={`foto ${i + 1}`}
                style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 10, border: '1.5px solid #e0e0e0' }} />
              <button onClick={() => quitarFoto(i, setter)}
                style={{
                  position: 'absolute', top: -6, right: -6,
                  background: '#ef4444', color: '#fff', border: 'none',
                  borderRadius: '50%', width: 22, height: 22, fontSize: 13,
                  cursor: 'pointer', lineHeight: '22px', textAlign: 'center', padding: 0,
                }}>×</button>
            </div>
          ))}
        </div>
      )}
      {fotos.length < MAX_FOTOS && (
        <>
          <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple
            style={{ display: 'none' }}
            onChange={e => agregarFotos(e.target.files, setter, fotos)} />
          <button onClick={() => fileRef.current?.click()}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '12px 16px', borderRadius: 12, fontSize: 15, fontWeight: 600,
              border: `2px dashed ${color}`, background: '#fafafa', color,
              cursor: 'pointer', width: '100%', justifyContent: 'center',
            }}>
            <span style={{ fontSize: 20 }}>📷</span>
            {fotos.length === 0 ? 'Agregar foto' : 'Agregar otra foto'}
          </button>
        </>
      )}
    </div>
  )

  return (
    <div style={{ minHeight: '100dvh', background: '#f4f4f3', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ background: '#254A96', padding: '16px 20px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', maxWidth: 900, margin: '0 auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {accion !== 'home' ? (
              <button onClick={() => { setAccion('home'); resetForms() }}
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', borderRadius: 10, padding: '6px 12px', fontSize: 18, cursor: 'pointer' }}>
                ‹
              </button>
            ) : tieneDashboard ? (
              <button onClick={() => router.push('/dashboard')}
                style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 10, padding: '6px 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                ← Dashboard
              </button>
            ) : null}
            <div>
              <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, margin: 0 }}>
                {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
              </p>
              <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>
                {accionTitulo[accion]}
              </h1>
            </div>
          </div>

          {/* Exportar — solo en home y para roles con acceso completo */}
          {accion === 'home' && tieneDashboard && (
            <button onClick={exportarRegistros} disabled={exportando}
              style={{
                background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
                color: '#fff', borderRadius: 10, padding: '8px 14px', fontSize: 13,
                fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', opacity: exportando ? 0.6 : 1,
              }}>
              {exportando ? 'Exportando…' : '↓ Exportar CSV'}
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: '20px 16px', maxWidth: accion === 'home' ? 1100 : 480, margin: '0 auto' }}>
        {/* Toast */}
        {toast && (
          <div style={{
            position: 'fixed', top: 80, left: '50%', transform: 'translateX(-50%)',
            background: toast.tipo === 'ok' ? '#166534' : '#991b1b',
            color: '#fff', padding: '12px 20px', borderRadius: 12, fontSize: 14,
            fontWeight: 600, zIndex: 100, whiteSpace: 'nowrap', boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
          }}>
            {toast.msg}
          </div>
        )}

        {/* HOME */}
        {accion === 'home' && (
          <>
            {ultimoEvento && (
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '12px 16px', marginBottom: 16, fontSize: 14, color: '#166534' }}>
                {ultimoEvento}
              </div>
            )}

            {/* Tabs (solo para roles que ven ambos sectores) */}
            {verTabs && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
                {(['guardia', 'deposito'] as const).map(t => (
                  <button key={t} onClick={() => { setTab(t) }}
                    style={{
                      flex: 1, padding: '12px 8px', borderRadius: 12, fontSize: 15, fontWeight: 700,
                      border: tab === t ? '2px solid #254A96' : '1.5px solid #e0e0e0',
                      background: tab === t ? '#254A96' : '#fff',
                      color: tab === t ? '#fff' : '#666', cursor: 'pointer',
                    }}>
                    {t === 'guardia' ? '🔒 Guardia' : '🏭 Depósito'}
                  </button>
                ))}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
              {/* Tab Guardia */}
              {(tab === 'guardia' || !verTabs) && !esDeposito && (
                <>
                  <button onClick={() => setAccion('salida')} style={{
                    background: '#fff', border: '2px solid #254A96', borderRadius: 16, padding: '22px 20px',
                    textAlign: 'left', cursor: 'pointer',
                  }}>
                    <div style={{ fontSize: 32, marginBottom: 6 }}>🚛</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#254A96' }}>Salida</div>
                    <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Registrar salida de camión con pedidos</div>
                  </button>

                  <button onClick={() => setAccion('ingreso')} style={{
                    background: '#fff', border: '2px solid #059669', borderRadius: 16, padding: '22px 20px',
                    textAlign: 'left', cursor: 'pointer',
                  }}>
                    <div style={{ fontSize: 32, marginBottom: 6 }}>🏠</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#059669' }}>Ingreso</div>
                    <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Registrar ingreso de camión</div>
                  </button>

                  <button onClick={() => setAccion('devolucion')} style={{
                    background: '#fff', border: '2px solid #b45309', borderRadius: 16, padding: '22px 20px',
                    textAlign: 'left', cursor: 'pointer',
                  }}>
                    <div style={{ fontSize: 32, marginBottom: 6 }}>📋</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#b45309' }}>Devolución</div>
                    <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Registrar pedido devuelto</div>
                  </button>
                </>
              )}

              {/* Tab Depósito */}
              {(tab === 'deposito' || esDeposito) && (
                <>
                  <button onClick={() => setAccion('inicio_carga')} style={{
                    background: '#fff', border: '2px solid #0891b2', borderRadius: 16, padding: '22px 20px',
                    textAlign: 'left', cursor: 'pointer',
                  }}>
                    <div style={{ fontSize: 32, marginBottom: 6 }}>📦</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#0891b2' }}>Inicio de carga</div>
                    <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Registrar inicio de carga de un camión</div>
                  </button>

                  <button onClick={() => setAccion('fin_carga')} style={{
                    background: '#fff', border: '2px solid #059669', borderRadius: 16, padding: '22px 20px',
                    textAlign: 'left', cursor: 'pointer',
                  }}>
                    <div style={{ fontSize: 32, marginBottom: 6 }}>✅</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#059669' }}>Fin de carga</div>
                    <div style={{ fontSize: 13, color: '#666', marginTop: 4 }}>Registrar que el camión terminó de cargar</div>
                  </button>
                </>
              )}
            </div>

            {/* ── MATRIZ DE ACTIVIDAD ── */}
            {(() => {
              const TIPOS = [
                { key: 'inicio_carga', label: 'Inicio carga', emoji: '📦', color: '#0891b2' },
                { key: 'fin_carga',    label: 'Fin carga',    emoji: '✅', color: '#059669' },
                { key: 'salida',       label: 'Salida',       emoji: '🚛', color: '#254A96' },
                { key: 'ingreso',      label: 'Ingreso',      emoji: '🏠', color: '#059669' },
                { key: 'devolucion',   label: 'Devolución',   emoji: '📋', color: '#b45309' },
              ]
              const fmt = (iso: string) =>
                new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })

              // Agrupar eventos por camion → tipo
              const byKey: Record<string, Record<string, any[]>> = {}
              for (const ev of matrizData) {
                if (!ev.camion_codigo) continue
                if (!byKey[ev.camion_codigo]) byKey[ev.camion_codigo] = {}
                if (!byKey[ev.camion_codigo][ev.tipo]) byKey[ev.camion_codigo][ev.tipo] = []
                byKey[ev.camion_codigo][ev.tipo].push(ev)
              }
              const camionesConActividad = Object.keys(byKey).sort()

              return (
                <div style={{ marginTop: 24, background: '#fff', borderRadius: 16, border: '1px solid #e8edf8', overflow: 'hidden' }}>
                  {/* Header con fecha */}
                  <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#254A96' }}>📊 Actividad del día</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {matrizLoading && (
                        <div className="animate-spin" style={{ width: 16, height: 16, border: '2px solid #254A96', borderTopColor: 'transparent', borderRadius: '50%' }} />
                      )}
                      <input
                        type="date" value={matrizFecha}
                        onChange={e => setMatrizFecha(e.target.value)}
                        style={{ border: '1px solid #e8edf8', borderRadius: 8, padding: '5px 8px', fontSize: 13, color: '#254A96', fontWeight: 600 }}
                      />
                    </div>
                  </div>

                  {camionesConActividad.length === 0 ? (
                    <p style={{ textAlign: 'center', padding: '28px 16px', fontSize: 13, color: '#B9BBB7' }}>
                      {matrizLoading ? 'Cargando…' : 'Sin registros para esta fecha'}
                    </p>
                  ) : (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: '#f9f9f9' }}>
                            <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, color: '#254A96', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: '#f9f9f9', zIndex: 1, borderRight: '1px solid #e8edf8' }}>
                              Camión
                            </th>
                            {TIPOS.map(t => (
                              <th key={t.key} style={{ padding: '10px 12px', textAlign: 'center', fontWeight: 600, color: t.color, whiteSpace: 'nowrap', minWidth: 100 }}>
                                {t.emoji} {t.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {camionesConActividad.map((camion, idx) => (
                            <tr key={camion} style={{ borderTop: '1px solid #f5f5f5', background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                              <td style={{ padding: '10px 14px', fontWeight: 700, color: '#1a1a1a', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: idx % 2 === 0 ? '#fff' : '#fafafa', borderRight: '1px solid #e8edf8', zIndex: 1 }}>
                                {camion}
                              </td>
                              {TIPOS.map(t => {
                                const evs = byKey[camion]?.[t.key] ?? []
                                if (evs.length === 0) {
                                  return (
                                    <td key={t.key} style={{ padding: '10px 12px', textAlign: 'center', color: '#d0d0d0', fontSize: 16 }}>—</td>
                                  )
                                }
                                return (
                                  <td key={t.key} style={{ padding: '8px 12px', textAlign: 'center' }}>
                                    {evs.map((ev: any, i: number) => {
                                      let detalle = ''
                                      if (ev.tipo === 'salida') detalle = ev.cant_pedidos > 0 ? `${ev.cant_pedidos} ped.` : 'vacío'
                                      if (ev.tipo === 'inicio_carga') {
                                        const parts = [ev.cant_posiciones && `${ev.cant_posiciones} pos`, ev.paquetes_hierro && `${ev.paquetes_hierro} H`].filter(Boolean)
                                        detalle = parts.join(' · ')
                                      }
                                      return (
                                        <div key={i} style={{ marginBottom: i < evs.length - 1 ? 4 : 0 }}>
                                          <span style={{ display: 'inline-block', background: t.color + '18', color: t.color, borderRadius: 6, padding: '3px 8px', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>
                                            {fmt(ev.created_at)}{detalle ? ` · ${detalle}` : ''}
                                          </span>
                                        </div>
                                      )
                                    })}
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })()}
          </>
        )}

        {/* SALIDA */}
        {accion === 'salida' && (
          <div style={{ background: '#fff', borderRadius: 16, padding: '20px 16px', border: '1px solid #e0e0e0' }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Camión</label>
              <select value={salCamion} onChange={e => setSalCamion(e.target.value)} style={inputStyle}>
                <option value="">Seleccioná el camión</option>
                {camiones.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            {/* Toggle salida vacío */}
            <button
              onClick={() => { setSalVacio(v => !v); setSalCant('') }}
              style={{
                width: '100%', padding: '14px 16px', borderRadius: 12, marginBottom: 16,
                border: salVacio ? '2px solid #059669' : '2px solid #e0e0e0',
                background: salVacio ? '#f0fdf4' : '#fafafa',
                color: salVacio ? '#059669' : '#888',
                fontWeight: 700, fontSize: 15, textAlign: 'left', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
              <span style={{ fontSize: 20 }}>{salVacio ? '☑️' : '☐'}</span>
              Salida vacío <span style={{ fontWeight: 400, fontSize: 13 }}>(sin pedidos)</span>
            </button>

            {!salVacio && (
              <>
                <div style={fieldStyle}>
                  <label style={labelStyle}>Cantidad de pedidos</label>
                  <input type="number" inputMode="numeric" min={0}
                    value={salCant} onChange={e => setSalCant(e.target.value)}
                    placeholder="ej: 5" style={inputStyle} />
                </div>
                <FotoSection fotos={salFotos} setter={setSalFotos} fileRef={salFileRef} color="#254A96" />
              </>
            )}

            <button onClick={registrarSalida} disabled={guardando} style={btnPrimary}>
              {guardando ? 'Guardando…' : salVacio ? 'Registrar salida vacío' : 'Registrar salida'}
            </button>
            <button onClick={() => { setAccion('home'); resetForms() }} style={btnSecondary}>Cancelar</button>
          </div>
        )}

        {/* INGRESO */}
        {accion === 'ingreso' && (
          <div style={{ background: '#fff', borderRadius: 16, padding: '20px 16px', border: '1px solid #e0e0e0' }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Camión</label>
              <select value={ingCamion} onChange={e => setIngCamion(e.target.value)} style={inputStyle}>
                <option value="">Seleccioná el camión</option>
                {camiones.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Tipo de ingreso</label>
              <div style={{ display: 'flex', gap: 10 }}>
                {(['directo', 'con_transferencia'] as const).map(t => (
                  <button key={t} onClick={() => { setIngTipo(t); if (t === 'directo') setIngDeposito('') }}
                    style={{
                      flex: 1, padding: '14px 8px', borderRadius: 12, fontSize: 14, fontWeight: 600,
                      border: ingTipo === t ? '2px solid #254A96' : '1.5px solid #e0e0e0',
                      background: ingTipo === t ? '#eef2fb' : '#fff',
                      color: ingTipo === t ? '#254A96' : '#666', cursor: 'pointer',
                    }}>
                    {t === 'directo' ? 'Directo' : 'Con transferencia'}
                  </button>
                ))}
              </div>
            </div>
            {ingTipo === 'con_transferencia' && (
              <div style={fieldStyle}>
                <label style={labelStyle}>Depósito de origen</label>
                <select value={ingDeposito} onChange={e => setIngDeposito(e.target.value)} style={inputStyle}>
                  <option value="">Seleccioná el depósito</option>
                  {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            <button onClick={registrarIngreso} disabled={guardando} style={{ ...btnPrimary, background: '#059669' }}>
              {guardando ? 'Guardando…' : 'Registrar ingreso'}
            </button>
            <button onClick={() => { setAccion('home'); resetForms() }} style={btnSecondary}>Cancelar</button>
          </div>
        )}

        {/* DEVOLUCIÓN */}
        {accion === 'devolucion' && (
          <div style={{ background: '#fff', borderRadius: 16, padding: '20px 16px', border: '1px solid #e0e0e0' }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Camión</label>
              <select value={devCamion} onChange={e => setDevCamion(e.target.value)} style={inputStyle}>
                <option value="">Seleccioná el camión</option>
                {camiones.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Apellido del chofer</label>
              <input type="text" value={devChofer} onChange={e => setDevChofer(e.target.value)}
                placeholder="ej: Soto" style={inputStyle} autoCapitalize="words" />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Categoría</label>
              <select value={devCategoria} onChange={e => { setDevCategoria(e.target.value); setDevMotivo('') }} style={inputStyle}>
                <option value="">Seleccioná la categoría</option>
                {Object.keys(CATEGORIAS).map(cat => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
            {devCategoria && (
              <div style={fieldStyle}>
                <label style={labelStyle}>Motivo</label>
                <select value={devMotivo} onChange={e => setDevMotivo(e.target.value)} style={inputStyle}>
                  <option value="">Seleccioná el motivo</option>
                  {CATEGORIAS[devCategoria].map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div style={fieldStyle}>
              <label style={labelStyle}>Remito (opcional)</label>
              <input type="text" inputMode="numeric" value={devRemito} onChange={e => setDevRemito(e.target.value)}
                placeholder="Número de remito" style={inputStyle} />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Nota de venta (opcional)</label>
              <input type="text" inputMode="numeric" value={devNV} onChange={e => setDevNV(e.target.value)}
                placeholder="Número de NV" style={inputStyle} />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Observación (opcional)</label>
              <textarea value={devObs} onChange={e => setDevObs(e.target.value)}
                placeholder="Detalle adicional…" rows={3}
                style={{ ...inputStyle, resize: 'none' }} />
            </div>
            <FotoSection fotos={devFotos} setter={setDevFotos} fileRef={devFileRef} color="#b45309" />
            <button onClick={registrarDevolucion} disabled={guardando} style={{ ...btnPrimary, background: '#b45309' }}>
              {guardando ? 'Guardando…' : 'Registrar devolución'}
            </button>
            <button onClick={() => { setAccion('home'); resetForms() }} style={btnSecondary}>Cancelar</button>
          </div>
        )}

        {/* INICIO DE CARGA */}
        {accion === 'inicio_carga' && (
          <div style={{ background: '#fff', borderRadius: 16, padding: '20px 16px', border: '1px solid #e0e0e0' }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Camión</label>
              <select value={icCamion} onChange={e => setIcCamion(e.target.value)} style={inputStyle}>
                <option value="">Seleccioná el camión</option>
                {camiones.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Cantidad de posiciones <span style={{ color: '#999' }}>(opcional si hay hierro)</span></label>
              <input type="number" inputMode="numeric" min={0}
                value={icPosiciones} onChange={e => setIcPosiciones(e.target.value)}
                placeholder="ej: 12" style={inputStyle} />
            </div>
            <div style={fieldStyle}>
              <label style={labelStyle}>Paquetes de hierro <span style={{ color: '#999' }}>(opcional si hay posiciones)</span></label>
              <input type="number" inputMode="numeric" min={0}
                value={icHierro} onChange={e => setIcHierro(e.target.value)}
                placeholder="ej: 3" style={inputStyle} />
            </div>
            <button onClick={registrarInicioCarga} disabled={guardando} style={{ ...btnPrimary, background: '#0891b2' }}>
              {guardando ? 'Guardando…' : 'Registrar inicio de carga'}
            </button>
            <button onClick={() => { setAccion('home'); resetForms() }} style={btnSecondary}>Cancelar</button>
          </div>
        )}

        {/* FIN DE CARGA */}
        {accion === 'fin_carga' && (
          <div style={{ background: '#fff', borderRadius: 16, padding: '20px 16px', border: '1px solid #e0e0e0' }}>
            <div style={fieldStyle}>
              <label style={labelStyle}>Camión</label>
              <select value={fcCamion} onChange={e => setFcCamion(e.target.value)} style={inputStyle}>
                <option value="">Seleccioná el camión</option>
                {camiones.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button onClick={registrarFinCarga} disabled={guardando} style={{ ...btnPrimary, background: '#059669' }}>
              {guardando ? 'Guardando…' : 'Registrar fin de carga'}
            </button>
            <button onClick={() => { setAccion('home'); resetForms() }} style={btnSecondary}>Cancelar</button>
          </div>
        )}
      </div>
    </div>
  )
}
