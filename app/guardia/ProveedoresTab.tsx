'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'
import ProveedorPicker from '../components/ProveedorPicker'
import RemitosEditor from '../components/RemitosEditor'
import VisorFotoGrande from '../components/VisorFotoGrande'
import { normalizarRemito, remitoIgual, ROLES_COMPRAS_ADMIN } from '../lib/compras-utils'
import {
  comprimirFoto, confirmarDuplicados, crearProveedor, eliminarIngreso, fechaLocal, firmarFotos,
  guardarIngresoProveedor, nuevoRemito, useProveedores, validarRemitos,
  type FotoItem, type RemitoDraft,
} from '../lib/compras'

const SUCURSALES = ['LP520', 'LP139', 'Guernica', 'Cañuelas', 'Pinamar']

const labelStyle: React.CSSProperties = { fontSize: 13, color: '#666', marginBottom: 6, display: 'block' }
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '14px 12px', fontSize: 16, borderRadius: 12, border: '1.5px solid #e0e0e0',
  background: '#fff', color: '#1a1a1a', boxSizing: 'border-box',
}
const cardStyle: React.CSSProperties = { background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: '16px', marginBottom: 14 }

interface FormProps {
  userId: string | null
  rol: string
  sucursalUsuario: string
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onDone: (mensaje: string) => void
  onCancel: () => void
  camiones?: string[]
  choferes?: { id: string; nombre: string; camion_codigo: string | null }[]
  inicial?: { origen?: 'externo' | 'propio'; chofer?: string; camion?: string }
}

export function IngresoProveedorForm({ userId, rol, sucursalUsuario, showToast, onDone, onCancel, camiones, choferes, inicial }: FormProps) {
  const { lista, recargar } = useProveedores()
  const puedeAprobar = ROLES_COMPRAS_ADMIN.includes(rol)
  const sucursalFija = rol === 'guardia' && SUCURSALES.includes(sucursalUsuario)
  const [sucursal, setSucursal] = useState(SUCURSALES.includes(sucursalUsuario) ? sucursalUsuario : 'Guernica')
  const [prov, setProv] = useState<any>(null)
  const [patente, setPatente] = useState('')
  const [chofer, setChofer] = useState('')
  const [fotosCamion, setFotosCamion] = useState<FotoItem[]>([])
  const [remitos, setRemitos] = useState<RemitoDraft[]>([nuevoRemito()])
  const [obs, setObs] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [origen, setOrigen] = useState<'externo' | 'propio'>(inicial?.origen ?? 'externo')
  const [choferPropio, setChoferPropio] = useState(inicial?.chofer ?? '')
  const [camionPropio, setCamionPropio] = useState(inicial?.camion ?? '')
  const permitePropio = !!camiones

  const elegirChofer = (v: string) => {
    setChoferPropio(v)
    const c = choferes?.find(ch => ch.nombre === v)
    if (c?.camion_codigo) setCamionPropio(c.camion_codigo)
  }

  const crear = async (nombre: string, cuit: string) => {
    const r = await crearProveedor(nombre, cuit, puedeAprobar, userId)
    if (r.error) { showToast(r.error, 'err'); return null }
    if (r.existente) { showToast(`Ya existe «${r.existente.nombre}», se usa ese`); return r.existente }
    await recargar()
    return r.proveedor ?? null
  }

  const agregarFotoCamion = async (files: FileList | null) => {
    if (!files) return
    const nuevas = await Promise.all(Array.from(files).slice(0, 4 - fotosCamion.length).map(async f => {
      const c = await comprimirFoto(f)
      return { file: c, preview: URL.createObjectURL(c) }
    }))
    setFotosCamion(prev => [...prev, ...nuevas])
  }

  const registrar = async () => {
    if (origen === 'propio' && (!camionPropio || (camiones && !camiones.includes(camionPropio)))) { showToast('Elegí el camión de la lista', 'err'); return }
    if (!prov) { showToast('Elegí el proveedor', 'err'); return }
    const err = validarRemitos(remitos)
    if (err) { showToast(err, 'err'); return }
    if (remitos.some(r => r.ocr === 'leyendo')) { showToast('Esperá que termine de leer el remito', 'err'); return }
    setGuardando(true)
    try {
      if (!(await confirmarDuplicados(prov, remitos))) { setGuardando(false); return }
      const esPropio = origen === 'propio'
      const eventoId = esPropio ? crypto.randomUUID() : undefined
      const ingresoId = await guardarIngresoProveedor({
        userId, sucursal, origen, proveedor: prov, patente: esPropio ? '' : patente, chofer: esPropio ? choferPropio : chofer,
        camionCodigo: esPropio ? camionPropio : undefined, guardiaEventoId: eventoId, fotosCamion, remitos, observacion: obs,
      })
      if (esPropio) {
        // El camión propio también deja su evento de ingreso en guardia (no cambia el informe de ciclos)
        const { error } = await supabase.from('guardia_eventos').insert({
          id: eventoId, fecha: fechaLocal(), tipo: 'ingreso', camion_codigo: camionPropio, chofer_apellido: choferPropio || null,
          tipo_ingreso: 'con_proveedor', deposito_desde: prov.nombre, fotos_urls: [], observacion: obs.trim() || null, registrado_por: userId,
        })
        if (error) { await eliminarIngreso(ingresoId); throw error }
        onDone(`✅ ${camionPropio} ingresó con proveedor ${prov.nombre} (${remitos.length} remito${remitos.length !== 1 ? 's' : ''})`)
      } else {
        onDone(`✅ Ingreso de ${prov.nombre} registrado (${remitos.length} remito${remitos.length !== 1 ? 's' : ''})`)
      }
    } catch (e: any) {
      showToast(e?.message || 'Error al guardar', 'err')
    } finally { setGuardando(false) }
  }

  return (
    <div>
      <div style={cardStyle}>
        {permitePropio && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            {([['externo', '🚚 Camión externo'], ['propio', '🚛 Camión propio']] as const).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setOrigen(k)}
                style={{
                  flex: 1, padding: '12px 6px', borderRadius: 12, fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  border: origen === k ? '2px solid #254A96' : '1.5px solid #e0e0e0',
                  background: origen === k ? '#eef2fb' : '#fff', color: origen === k ? '#254A96' : '#666',
                }}>{l}</button>
            ))}
          </div>
        )}
        {sucursalFija ? (
          <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>Sucursal: <b>{sucursal}</b></div>
        ) : (
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Sucursal</label>
            <select value={sucursal} onChange={e => setSucursal(e.target.value)} style={inputStyle}>
              {SUCURSALES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        )}
        <label style={labelStyle}>Proveedor</label>
        <ProveedorPicker proveedores={lista} value={prov} onChange={setProv} onCrear={crear} />
        {origen === 'externo' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            <div><label style={labelStyle}>Patente <span style={{ color: '#999' }}>(opcional)</span></label>
              <input value={patente} onChange={e => setPatente(e.target.value.toUpperCase())} placeholder="AB123CD" style={inputStyle} /></div>
            <div><label style={labelStyle}>Chofer <span style={{ color: '#999' }}>(opcional)</span></label>
              <input value={chofer} onChange={e => setChofer(e.target.value)} placeholder="Apellido" style={inputStyle} autoCapitalize="words" /></div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            <div><label style={labelStyle}>Chofer</label>
              <input list="dl-choferes-prov" value={choferPropio} onChange={e => elegirChofer(e.target.value)} placeholder="Buscar chofer…" style={inputStyle} />
              <datalist id="dl-choferes-prov">{(choferes ?? []).map(c => <option key={c.id} value={c.nombre} />)}</datalist></div>
            <div><label style={labelStyle}>Camión</label>
              <input list="dl-camiones-prov" value={camionPropio} onChange={e => setCamionPropio(e.target.value)} placeholder="Buscar camión…" style={inputStyle} />
              <datalist id="dl-camiones-prov">{(camiones ?? []).map(c => <option key={c} value={c} />)}</datalist></div>
          </div>
        )}
        <label style={{ ...labelStyle, marginTop: 14 }}>Foto del camión <span style={{ color: '#999' }}>(opcional)</span></label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {fotosCamion.map((f, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={f.preview} alt="" style={{ width: 68, height: 68, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
              <button type="button" onClick={() => { URL.revokeObjectURL(f.preview); setFotosCamion(prev => prev.filter((_, j) => j !== i)) }}
                style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, border: 'none', background: '#991b1b', color: '#fff', cursor: 'pointer', fontSize: 12 }}>✕</button>
            </div>
          ))}
          {fotosCamion.length < 4 && (
            <label style={{ width: 68, height: 68, borderRadius: 8, border: '1.5px dashed #c8c8c8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, cursor: 'pointer', color: '#9ca3af' }}>
              📷<input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={e => { agregarFotoCamion(e.target.files); e.target.value = '' }} />
            </label>
          )}
        </div>
      </div>

      <RemitosEditor remitos={remitos} setRemitos={setRemitos} proveedor={prov} proveedores={lista} onUsarProveedor={setProv} showToast={showToast} />

      <div style={cardStyle}>
        <label style={labelStyle}>Observación <span style={{ color: '#999' }}>(opcional)</span></label>
        <textarea value={obs} onChange={e => setObs(e.target.value)} rows={2} placeholder="Ej: faltó material, camión con lona rota…" style={{ ...inputStyle, resize: 'none' }} />
      </div>

      <button onClick={registrar} disabled={guardando}
        style={{ width: '100%', padding: 16, fontSize: 16, fontWeight: 700, borderRadius: 14, border: 'none', background: '#254A96', color: '#fff', cursor: 'pointer', opacity: guardando ? 0.6 : 1 }}>
        {guardando ? 'Guardando…' : 'Registrar ingreso'}
      </button>
      <button onClick={onCancel}
        style={{ width: '100%', padding: 14, fontSize: 15, fontWeight: 500, borderRadius: 14, border: '1.5px solid #e0e0e0', background: '#fff', color: '#444', cursor: 'pointer', marginTop: 8 }}>
        Cancelar
      </button>
    </div>
  )
}

interface ListaProps {
  userId: string | null
  rol: string
  sucursalUsuario: string
  refreshKey: number
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}

export function IngresosProveedorLista({ userId, rol, sucursalUsuario, refreshKey, showToast }: ListaProps) {
  const [fecha, setFecha] = useState(fechaLocal())
  const [items, setItems] = useState<any[]>([])
  const [cargando, setCargando] = useState(false)
  const [editando, setEditando] = useState<{ id: string; valor: string } | null>(null)
  const [visor, setVisor] = useState<string[] | null>(null)
  const [grande, setGrande] = useState<number | null>(null)
  const esAdmin = ROLES_COMPRAS_ADMIN.includes(rol)

  const cargar = useCallback(async () => {
    setCargando(true)
    let q = supabase.from('proveedor_ingresos')
      .select('*, proveedores(nombre, estado), proveedor_remitos(*)')
      .eq('fecha', fecha).order('hora_ingreso', { ascending: false })
    if (rol === 'guardia' && sucursalUsuario) q = q.eq('sucursal', sucursalUsuario)
    const { data } = await q
    setItems(data ?? [])
    setCargando(false)
  }, [fecha, rol, sucursalUsuario])

  useEffect(() => { cargar() }, [cargar, refreshKey])

  const guardarNumero = async (remito: any) => {
    if (!editando || !editando.valor.trim()) return
    const nuevo = normalizarRemito(editando.valor).valor
    const corregido = remito.numero_remito_leido ? !remitoIgual(nuevo, remito.numero_remito_leido) : false
    const { error } = await supabase.from('proveedor_remitos')
      .update({ numero_remito: nuevo, remito_corregido: corregido }).eq('id', remito.id)
    if (error) { showToast('No se pudo guardar el número', 'err'); return }
    setEditando(null); showToast('Número de remito actualizado'); cargar()
  }

  const verFotos = async (ing: any) => {
    const paths = [...(ing.fotos_camion ?? []), ...(ing.proveedor_remitos ?? []).flatMap((r: any) => r.fotos ?? [])]
    setVisor(await firmarFotos(paths))
  }

  const borrar = async (ing: any) => {
    if (!window.confirm(`¿Eliminar el ingreso de ${ing.proveedores?.nombre ?? 'proveedor'}? No se puede deshacer.`)) return
    if (await eliminarIngreso(ing.id)) { showToast('Ingreso eliminado'); cargar() } else showToast('No se pudo eliminar', 'err')
  }

  const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#254A96' }}>🧾 Ingresos de proveedores</span>
        <input type="date" value={fecha} onChange={e => setFecha(e.target.value)}
          style={{ border: '1px solid #e8edf8', borderRadius: 8, padding: '5px 8px', fontSize: 13, color: '#254A96', fontWeight: 600 }} />
      </div>
      {items.length === 0 && (
        <p style={{ textAlign: 'center', padding: '24px 16px', fontSize: 13, color: '#B9BBB7' }}>{cargando ? 'Cargando…' : 'Sin ingresos de proveedores en esta fecha'}</p>
      )}
      {items.map(ing => {
        const puedeEditar = esAdmin || ing.registrado_por === userId
        const puedeBorrar = esAdmin || (ing.registrado_por === userId && Date.now() - new Date(ing.created_at).getTime() < 24 * 3600 * 1000)
        const nFotos = (ing.fotos_camion?.length ?? 0) + (ing.proveedor_remitos ?? []).reduce((s: number, r: any) => s + (r.fotos?.length ?? 0), 0)
        return (
          <div key={ing.id} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 14, padding: 12, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
              <div>
                <b style={{ fontSize: 15 }}>{hora(ing.hora_ingreso)} · {ing.proveedores?.nombre ?? 'Proveedor'}</b>
                <div style={{ fontSize: 12, color: '#6b7280' }}>
                  {ing.origen === 'propio' ? `Camión propio ${ing.camion_codigo ?? ''}` : ing.patente ?? 'Camión externo'}{ing.chofer ? ` · ${ing.chofer}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {ing.proveedores?.estado === 'pendiente' && <span style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>Proveedor pendiente</span>}
                <span style={{ background: ing.origen === 'propio' ? '#ecfdf5' : '#eef2fb', color: ing.origen === 'propio' ? '#065f46' : '#254A96', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>{ing.origen === 'propio' ? 'Propio' : 'Externo'}</span>
              </div>
            </div>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(ing.proveedor_remitos ?? []).map((r: any) => (
                <div key={r.id} style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {editando && editando.id === r.id ? (
                    <>
                      <input value={editando.valor} onChange={e => setEditando({ id: r.id, valor: e.target.value })} autoFocus
                        style={{ padding: '6px 10px', borderRadius: 8, border: '1.5px solid #254A96', fontSize: 15, fontWeight: 700, width: 170 }} />
                      <button onClick={() => guardarNumero(r)} style={{ border: 'none', background: '#254A96', color: '#fff', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 600 }}>Guardar</button>
                      <button onClick={() => setEditando(null)} style={{ border: '1px solid #d6d6d6', background: '#fff', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>✕</button>
                    </>
                  ) : (
                    <>
                      Remito <b>{r.numero_remito}</b>
                      {r.remito_corregido && <span style={{ fontSize: 11, color: '#92400e' }}>✎ corregido</span>}
                      {puedeEditar && <button onClick={() => setEditando({ id: r.id, valor: r.numero_remito })}
                        style={{ border: '1.5px solid #d6d6d6', background: '#fff', borderRadius: 14, padding: '2px 10px', fontSize: 12, cursor: 'pointer' }}>✎ corregir</button>}
                    </>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              {nFotos > 0 && <button onClick={() => verFotos(ing)} style={{ border: 'none', background: '#eef2fb', color: '#254A96', borderRadius: 8, padding: '4px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>📷 {nFotos}</button>}
              {puedeBorrar && <button onClick={() => borrar(ing)} title="Eliminar" style={{ border: 'none', background: 'none', cursor: 'pointer' }}>🗑</button>}
            </div>
            {ing.observacion && <p style={{ margin: '6px 0 0', fontSize: 12, color: '#666' }}>📝 {ing.observacion}</p>}
          </div>
        )
      })}

      {visor && (
        <div onClick={() => setVisor(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.88)', zIndex: 300, overflowY: 'auto', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ maxWidth: 600, margin: '0 auto' }}>
            {visor.length === 0 && <p style={{ color: '#fff', textAlign: 'center' }}>No se pudieron cargar las fotos</p>}
            {visor.length > 0 && <p style={{ color: 'rgba(255,255,255,.55)', fontSize: 12, textAlign: 'center', marginBottom: 10 }}>Tocá una foto para ampliarla</p>}
            {visor.map((u, i) => <img key={i} src={u} alt="" onClick={() => setGrande(i)} style={{ width: '100%', borderRadius: 10, marginBottom: 14, cursor: 'zoom-in' }} />)}
            <button onClick={() => setVisor(null)} style={{ display: 'block', margin: '0 auto', color: '#fff', background: 'transparent', border: '1px solid rgba(255,255,255,.4)', borderRadius: 8, padding: '8px 24px', cursor: 'pointer' }}>Cerrar</button>
          </div>
        </div>
      )}
      {visor && grande !== null && <VisorFotoGrande urls={visor} inicio={grande} onCerrar={() => setGrande(null)} />}
    </div>
  )
}
