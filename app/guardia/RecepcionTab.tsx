'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import VisorFotoGrande from '../components/VisorFotoGrande'
import {
  comprimirFoto, ETIQUETA_VALIDACION, fechaLocal, firmarFotos, MAX_FOTOS_ROTURA, nombresUsuarios, validarIngreso,
  type EstadoValidacion,
} from '../lib/compras'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

interface Props {
  rol: string
  sucursalUsuario: string
  refreshKey: number
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onCambio: () => void
}

interface Rotura { ingresoId: string; nota: string; fotos: { file: File; preview: string }[]; enviando: boolean }

const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
const fmtFecha = (f: string) => f.split('-').reverse().slice(0, 2).join('/')

// Jefe de depósito/playa: valida el ingreso de mercadería después del ingreso de guardia y aclara si llegó rota.
export default function RecepcionTab({ rol, sucursalUsuario, refreshKey, showToast, onCambio }: Props) {
  const global = rol === 'gerencia' || rol === 'admin_flota' || !sucursalUsuario
  const [sucursal, setSucursal] = useState(sucursalUsuario || 'Todas')
  const [pendientes, setPendientes] = useState<any[]>([])
  const [recientes, setRecientes] = useState<any[]>([])
  const [nombres, setNombres] = useState<Record<string, string>>({})
  const [cargando, setCargando] = useState(false)
  const [rotura, setRotura] = useState<Rotura | null>(null)
  const [visor, setVisor] = useState<string[] | null>(null)
  const [trabajando, setTrabajando] = useState<string | null>(null)

  const cargar = useCallback(async () => {
    setCargando(true)
    const desde = new Date(); desde.setDate(desde.getDate() - 7)
    const campos = '*, proveedores(nombre), proveedor_remitos(id, numero_remito, fotos)'
    let qp = supabase.from('proveedor_ingresos').select(campos).eq('validacion_estado', 'pendiente')
      .order('hora_ingreso', { ascending: true }).limit(100)
    let qr = supabase.from('proveedor_ingresos').select(campos).in('validacion_estado', ['ok', 'con_rotura'])
      .gte('fecha', fechaLocal(desde)).order('validado_en', { ascending: false }).limit(60)
    if (sucursal !== 'Todas') { qp = qp.eq('sucursal', sucursal); qr = qr.eq('sucursal', sucursal) }
    const [{ data: p }, { data: r }] = await Promise.all([qp, qr])
    setPendientes(p ?? []); setRecientes(r ?? [])
    setNombres(await nombresUsuarios((r ?? []).map((x: any) => x.validado_por)))
    setCargando(false)
  }, [sucursal])

  useEffect(() => { cargar() }, [cargar, refreshKey])

  const verFotos = async (ing: any) => {
    const paths = [
      ...(ing.proveedor_remitos ?? []).flatMap((r: any) => r.fotos ?? []),
      ...(ing.fotos_camion ?? []),
      ...(ing.validacion_fotos ?? []),
    ]
    const urls = await firmarFotos(paths)
    if (!urls.length) { showToast('Este ingreso no tiene fotos', 'err'); return }
    setVisor(urls)
  }

  const confirmarOk = async (ing: any) => {
    if (!window.confirm(`¿Confirmás que llegó todo bien de ${ing.proveedores?.nombre ?? 'el proveedor'}?`)) return
    setTrabajando(ing.id)
    try {
      await validarIngreso(ing.id, 'ok', '', [])
      showToast('Ingreso validado: todo OK'); onCambio(); cargar()
    } catch (e: any) { showToast(e?.message || 'No se pudo validar', 'err') }
    setTrabajando(null)
  }

  const agregarFotos = async (files: FileList | null) => {
    if (!files || !rotura) return
    const libres = MAX_FOTOS_ROTURA - rotura.fotos.length
    if (libres <= 0) { showToast(`Máximo ${MAX_FOTOS_ROTURA} fotos`, 'err'); return }
    const nuevas = await Promise.all(Array.from(files).slice(0, libres).map(async f => {
      const c = await comprimirFoto(f)
      return { file: c, preview: URL.createObjectURL(c) }
    }))
    setRotura(prev => prev ? { ...prev, fotos: [...prev.fotos, ...nuevas] } : prev)
  }

  const enviarRotura = async () => {
    if (!rotura) return
    if (!rotura.nota.trim()) { showToast('Aclará qué mercadería llegó rota', 'err'); return }
    setRotura({ ...rotura, enviando: true })
    try {
      await validarIngreso(rotura.ingresoId, 'con_rotura', rotura.nota, rotura.fotos.map(f => f.file))
      rotura.fotos.forEach(f => URL.revokeObjectURL(f.preview))
      setRotura(null)
      showToast('Ingreso validado con rotura: Compras lo va a ver'); onCambio(); cargar()
    } catch (e: any) {
      showToast(e?.message || 'No se pudo guardar', 'err')
      setRotura(prev => prev ? { ...prev, enviando: false } : prev)
    }
  }

  const tarjeta = (ing: any, pendiente: boolean) => {
    const abierto = rotura?.ingresoId === ing.id
    const estado = (ing.validacion_estado ?? 'pendiente') as EstadoValidacion
    return (
      <div key={ing.id} style={{ background: '#fff', border: `1.5px solid ${estado === 'con_rotura' ? '#fecaca' : '#e0e0e0'}`, borderRadius: 14, padding: 12, marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div>
            <b style={{ fontSize: 15 }}>{ing.proveedores?.nombre ?? 'Proveedor'}</b>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {fmtFecha(ing.fecha)} {hora(ing.hora_ingreso)} · {ing.sucursal} · {ing.origen === 'propio' ? `Camión propio ${ing.camion_codigo ?? ''}` : ing.patente ?? 'Camión externo'}{ing.chofer ? ` · ${ing.chofer}` : ''}
            </div>
          </div>
          {!pendiente && (
            <span style={{
              alignSelf: 'flex-start', borderRadius: 10, padding: '2px 9px', fontSize: 11, fontWeight: 700,
              background: estado === 'ok' ? '#ecfdf5' : '#fef2f2', color: estado === 'ok' ? '#065f46' : '#b91c1c',
            }}>
              {ETIQUETA_VALIDACION[estado]}
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          {(ing.proveedor_remitos ?? []).map((r: any) => <span key={r.id} style={{ marginRight: 12 }}>Remito <b>{r.numero_remito}</b></span>)}
        </div>
        {!pendiente && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
            Validó {nombres[ing.validado_por] ?? '—'}{ing.validado_en ? ` · ${fmtFecha(fechaLocal(new Date(ing.validado_en)))} ${hora(ing.validado_en)}` : ''}
          </div>
        )}
        {ing.validacion_nota && (
          <div style={{ margin: '8px 0 0', background: '#fef2f2', border: '2px solid #dc2626', borderRadius: 10, padding: '8px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '.06em' }}>Mercadería rota</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: '#b91c1c', lineHeight: 1.2, overflowWrap: 'anywhere' }}>{ing.validacion_nota}</div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button onClick={() => verFotos(ing)} style={{ border: 'none', background: '#eef2fb', color: '#254A96', borderRadius: 8, padding: '7px 12px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>📷 Ver fotos</button>
          {pendiente && !abierto && (
            <>
              <button onClick={() => confirmarOk(ing)} disabled={trabajando === ing.id}
                style={{ flex: 1, minWidth: 130, border: 'none', background: '#059669', color: '#fff', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontWeight: 800, fontSize: 14, opacity: trabajando === ing.id ? 0.6 : 1 }}>
                ✅ Todo OK
              </button>
              <button onClick={() => setRotura({ ingresoId: ing.id, nota: '', fotos: [], enviando: false })}
                style={{ flex: 1, minWidth: 130, border: '1.5px solid #dc2626', background: '#fff', color: '#dc2626', borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontWeight: 800, fontSize: 14 }}>
                ⚠️ Hay mercadería rota
              </button>
            </>
          )}
        </div>

        {pendiente && abierto && rotura && (
          <div style={{ marginTop: 12, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#991b1b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>
              ¿Qué y cuánto llegó roto? (obligatorio)
            </label>
            <textarea value={rotura.nota} onChange={e => setRotura({ ...rotura, nota: e.target.value })} rows={3}
              placeholder="Ej: 50 pallets de ladrillo hueco 18x18x33 / 4 bolsas de cemento"
              style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 10, border: '1.5px solid #fca5a5', fontSize: 14, fontFamily: 'inherit' }} />
            {rotura.fotos.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {rotura.fotos.map((f, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.preview} alt="" style={{ width: 70, height: 70, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
                    <button type="button"
                      onClick={() => { URL.revokeObjectURL(f.preview); setRotura({ ...rotura, fotos: rotura.fotos.filter((_, j) => j !== i) }) }}
                      style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, border: 'none', background: '#991b1b', color: '#fff', cursor: 'pointer', fontSize: 12 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
            {rotura.fotos.length < MAX_FOTOS_ROTURA && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <label style={{ flex: 2, textAlign: 'center', padding: 10, borderRadius: 10, border: '1.5px solid #b91c1c', background: '#fff', color: '#b91c1c', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  📷 Sacar foto
                  <input type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
                    onChange={e => { agregarFotos(e.target.files); e.target.value = '' }} />
                </label>
                <label style={{ flex: 1, textAlign: 'center', padding: 10, borderRadius: 10, border: '1.5px dashed #b91c1c', color: '#b91c1c', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                  🖼️ Galería
                  <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                    onChange={e => { agregarFotos(e.target.files); e.target.value = '' }} />
                </label>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={() => { rotura.fotos.forEach(f => URL.revokeObjectURL(f.preview)); setRotura(null) }} disabled={rotura.enviando}
                style={{ border: '1.5px solid #d6d6d6', background: '#fff', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', fontWeight: 600 }}>Cancelar</button>
              <button onClick={enviarRotura} disabled={rotura.enviando || !rotura.nota.trim()}
                style={{ flex: 1, border: 'none', background: rotura.nota.trim() ? '#dc2626' : '#d1d5db', color: '#fff', borderRadius: 10, padding: 11, cursor: rotura.nota.trim() ? 'pointer' : 'not-allowed', fontWeight: 800, fontSize: 14 }}>
                {rotura.enviando ? 'Guardando…' : 'Validar con rotura'}
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#254A96' }}>📥 Recepción de mercadería</span>
        {global && (
          <select value={sucursal} onChange={e => setSucursal(e.target.value)}
            style={{ border: '1px solid #e8edf8', borderRadius: 8, padding: '5px 8px', fontSize: 13, color: '#254A96', fontWeight: 600 }}>
            {['Todas', ...SUCURSALES].map(s => <option key={s}>{s}</option>)}
          </select>
        )}
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', margin: '4px 0 8px' }}>Pendientes de validar ({pendientes.length})</div>
      {pendientes.length === 0 && (
        <p style={{ textAlign: 'center', padding: '18px 16px', fontSize: 13, color: '#B9BBB7' }}>{cargando ? 'Cargando…' : 'No hay ingresos pendientes de validar 👌'}</p>
      )}
      {pendientes.map(i => tarjeta(i, true))}

      {recientes.length > 0 && (
        <>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#6b7280', margin: '18px 0 8px' }}>Validados en los últimos 7 días</div>
          {recientes.map(i => tarjeta(i, false))}
        </>
      )}

      {visor && <VisorFotoGrande urls={visor} onCerrar={() => setVisor(null)} />}
    </div>
  )
}
