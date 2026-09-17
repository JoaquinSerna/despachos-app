'use client'

import { useEffect, useState } from 'react'
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

type Accion = 'home' | 'salida' | 'ingreso' | 'devolucion'

function hoy() { return new Date().toISOString().split('T')[0] }
function horaLocal() { return new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) }

export default function GuardiaPage() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [cargando, setCargando] = useState(true)
  const [camiones, setCamiones] = useState<string[]>([])
  const [accion, setAccion] = useState<Accion>('home')
  const [guardando, setGuardando] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [ultimoEvento, setUltimoEvento] = useState<string | null>(null)

  // Salida
  const [salCamion, setSalCamion] = useState('')
  const [salCant, setSalCant] = useState('')

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

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo })
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data: perfil } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      const rolesPermitidos = ['guardia', 'gerencia', 'admin_flota', 'ruteador']
      if (!rolesPermitidos.includes(perfil?.rol ?? '')) { router.push('/dashboard'); return }
      setUserId(user.id)

      const { data: flota } = await supabase
        .from('camiones_flota')
        .select('codigo')
        .order('codigo')
      setCamiones((flota ?? []).map((c: any) => c.codigo))
      setCargando(false)
    })
  }, [])

  const resetForms = () => {
    setSalCamion(''); setSalCant('')
    setIngCamion(''); setIngTipo('directo'); setIngDeposito('')
    setDevCamion(''); setDevChofer(''); setDevCategoria(''); setDevMotivo('')
    setDevRemito(''); setDevNV(''); setDevObs('')
  }

  const registrarSalida = async () => {
    if (!salCamion || !salCant) { showToast('Completá todos los campos', 'err'); return }
    setGuardando(true)
    const { error } = await supabase.from('guardia_eventos').insert({
      fecha: hoy(),
      tipo: 'salida',
      camion_codigo: salCamion,
      cant_pedidos: Number(salCant),
      registrado_por: userId,
    })
    setGuardando(false)
    if (error) { showToast('Error al guardar', 'err'); return }
    setUltimoEvento(`✅ ${salCamion} salió con ${salCant} pedido${Number(salCant) !== 1 ? 's' : ''} — ${horaLocal()}`)
    resetForms(); setAccion('home')
    showToast(`Salida registrada — ${salCamion}`)
  }

  const registrarIngreso = async () => {
    if (!ingCamion) { showToast('Seleccioná el camión', 'err'); return }
    if (ingTipo === 'con_transferencia' && !ingDeposito) { showToast('Indicá el depósito de origen', 'err'); return }
    setGuardando(true)
    const { error } = await supabase.from('guardia_eventos').insert({
      fecha: hoy(),
      tipo: 'ingreso',
      camion_codigo: ingCamion,
      tipo_ingreso: ingTipo,
      deposito_desde: ingTipo === 'con_transferencia' ? ingDeposito : null,
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
    setGuardando(true)
    const { error } = await supabase.from('guardia_eventos').insert({
      fecha: hoy(),
      tipo: 'devolucion',
      camion_codigo: devCamion,
      chofer_apellido: devChofer,
      categoria: devCategoria,
      motivo: devMotivo,
      remito: devRemito || null,
      nv: devNV || null,
      observacion: devObs || null,
      registrado_por: userId,
    })
    setGuardando(false)
    if (error) { showToast('Error al guardar', 'err'); return }
    setUltimoEvento(`✅ Devolución ${devCamion} — ${devCategoria} — ${horaLocal()}`)
    resetForms(); setAccion('home')
    showToast(`Devolución registrada — ${devCamion}`)
  }

  if (cargando) {
    return (
      <div style={{ minHeight: '100dvh', background: '#f4f4f3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#666', fontSize: 15 }}>Cargando…</p>
      </div>
    )
  }

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

  return (
    <div style={{ minHeight: '100dvh', background: '#f4f4f3', fontFamily: 'system-ui, sans-serif' }}>
      {/* Header */}
      <div style={{ background: '#254A96', padding: '20px 20px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {accion !== 'home' && (
            <button onClick={() => { setAccion('home'); resetForms() }}
              style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: '#fff', borderRadius: 10, padding: '6px 12px', fontSize: 18, cursor: 'pointer' }}>
              ‹
            </button>
          )}
          <div>
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, margin: 0 }}>
              {new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
            </p>
            <h1 style={{ color: '#fff', fontSize: 20, fontWeight: 700, margin: 0 }}>
              {accion === 'home' ? '🏠 Guardia' : accion === 'salida' ? '🚛 Salida de camión' : accion === 'ingreso' ? '🏠 Ingreso de camión' : '📋 Devolución'}
            </h1>
          </div>
        </div>
      </div>

      <div style={{ padding: '20px 16px', maxWidth: 480, margin: '0 auto' }}>
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
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: '12px 16px', marginBottom: 20, fontSize: 14, color: '#166534' }}>
                {ultimoEvento}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
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
            </div>
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

            <div style={fieldStyle}>
              <label style={labelStyle}>Cantidad de pedidos</label>
              <input
                type="number" inputMode="numeric" min={0}
                value={salCant} onChange={e => setSalCant(e.target.value)}
                placeholder="ej: 5" style={inputStyle}
              />
            </div>

            <button onClick={registrarSalida} disabled={guardando} style={btnPrimary}>
              {guardando ? 'Guardando…' : 'Registrar salida'}
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
              <input
                type="text" value={devChofer} onChange={e => setDevChofer(e.target.value)}
                placeholder="ej: Soto" style={inputStyle} autoCapitalize="words"
              />
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
              <input
                type="text" inputMode="numeric" value={devRemito} onChange={e => setDevRemito(e.target.value)}
                placeholder="Número de remito" style={inputStyle}
              />
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle}>Nota de venta (opcional)</label>
              <input
                type="text" inputMode="numeric" value={devNV} onChange={e => setDevNV(e.target.value)}
                placeholder="Número de NV" style={inputStyle}
              />
            </div>

            <div style={fieldStyle}>
              <label style={labelStyle}>Observación (opcional)</label>
              <textarea
                value={devObs} onChange={e => setDevObs(e.target.value)}
                placeholder="Detalle adicional…"
                rows={3}
                style={{ ...inputStyle, resize: 'none' }}
              />
            </div>

            <button onClick={registrarDevolucion} disabled={guardando} style={{ ...btnPrimary, background: '#b45309' }}>
              {guardando ? 'Guardando…' : 'Registrar devolución'}
            </button>
            <button onClick={() => { setAccion('home'); resetForms() }} style={btnSecondary}>Cancelar</button>
          </div>
        )}
      </div>
    </div>
  )
}
