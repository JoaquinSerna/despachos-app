'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/app/supabase'
import { logAuditoria } from '@/app/lib/auditoria'
import { demandaPorDia, estadoLinea, fmtNum, type LineaDemanda, type PickingPedidoPrep, type ValidacionPrep } from '@/app/lib/prep-validacion'

// Check de preparación: por día de entrega y producto, el depósito confirma lo que tiene físicamente.
//  · "Tengo todo" valida lo que falta validar.
//  · "Tengo una parte" valida esa cantidad y deja el resto pendiente.
//  · "No tengo" deja pendiente lo que falta; se resuelve en Faltantes o cuando entra mercadería.
// Si después entran más pedidos del mismo producto, solo se valida la diferencia.

const DOW = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb']
const fmtDia = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${DOW[new Date(`${iso}T12:00:00`).getDay()]} ${d}/${m}/${y}`
}

interface Props {
  pedidos: PickingPedidoPrep[]
  sucursal: string
  desde: string
  hasta: string
  puedeValidar: boolean
  userId: string
  userNombre: string
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}

export default function ValidacionPrepView({ pedidos, sucursal, desde, hasta, puedeValidar, userId, userNombre, showToast }: Props) {
  const [validaciones, setValidaciones] = useState<Record<string, ValidacionPrep>>({})
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState<string | null>(null)
  const [parte, setParte] = useState<{ id: string; valor: string } | null>(null)
  const [verValidados, setVerValidados] = useState(true)

  const dias = useMemo(() => demandaPorDia(pedidos, sucursal), [pedidos, sucursal])
  const fechas = useMemo(() => [...dias.keys()].sort(), [dias])

  const cargar = useCallback(async () => {
    setCargando(true)
    const { data, error } = await supabase.from('prep_validaciones').select('*')
      .eq('sucursal', sucursal).gte('fecha', desde).lte('fecha', hasta)
    if (error) showToast('No se pudieron cargar las validaciones', 'err')
    const mapa: Record<string, ValidacionPrep> = {}
    for (const v of (data ?? []) as ValidacionPrep[]) mapa[`${v.fecha}|${v.clave}`] = v
    setValidaciones(mapa)
    setCargando(false)
  }, [sucursal, desde, hasta]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { cargar() }, [cargar])

  async function guardar(fecha: string, linea: LineaDemanda, cambio: { validada: number; faltante: number }, accion: string) {
    const key = `${fecha}|${linea.clave}`
    const previa = validaciones[key]
    setGuardando(key)
    const faltanteCambia = (previa?.faltante ?? 0) !== cambio.faltante
    const fila = {
      sucursal, fecha, clave: linea.clave, nombre: linea.nombre, codigo: linea.codigo, unidad: linea.unidad,
      validada: cambio.validada, faltante: cambio.faltante,
      validado_por: userId, validado_en: new Date().toISOString(),
      // Si se declara un faltante distinto, la decisión anterior (transferencia / esperar) ya no corresponde
      ...(faltanteCambia || cambio.faltante === 0 ? { decision: null, decision_nota: null, decision_req_id: null, decision_por: null, decision_en: null } : {}),
    }
    const { data, error } = await supabase.from('prep_validaciones').upsert(fila, { onConflict: 'sucursal,fecha,clave' }).select('*').single()
    setGuardando(null)
    if (error || !data) { showToast('No se pudo guardar la validación', 'err'); return }
    setValidaciones(prev => ({ ...prev, [key]: data as ValidacionPrep }))
    setParte(null)
    if (userId) logAuditoria(userId, userNombre, accion, 'Abastecimiento', { sucursal, fecha, producto: linea.nombre, requerida: linea.cantidad, validada: cambio.validada, faltante: cambio.faltante })
  }

  const tengoTodo = (fecha: string, l: LineaDemanda) =>
    guardar(fecha, l, { validada: l.cantidad, faltante: 0 }, 'Validó preparación (tiene todo)')

  const tengoParte = (fecha: string, l: LineaDemanda, x: number) => {
    const v = validaciones[`${fecha}|${l.clave}`]
    const { validada, diferencia } = estadoLinea(l.cantidad, v)
    if (!(x > 0) || x >= diferencia) { showToast(`Ingresá una cantidad mayor a 0 y menor a ${fmtNum(diferencia)}`, 'err'); return }
    return guardar(fecha, l, { validada: validada + x, faltante: diferencia - x }, 'Validó preparación (parcial)')
  }

  const noTengo = (fecha: string, l: LineaDemanda) => {
    const v = validaciones[`${fecha}|${l.clave}`]
    const { validada, diferencia } = estadoLinea(l.cantidad, v)
    return guardar(fecha, l, { validada, faltante: diferencia }, 'Marcó sin stock en preparación')
  }

  const deshacer = (fecha: string, l: LineaDemanda) =>
    guardar(fecha, l, { validada: 0, faltante: 0 }, 'Deshizo validación de preparación')

  if (!fechas.length) {
    return (
      <div className="bg-white rounded-xl border p-8 text-center" style={{ borderColor: '#e8edf8' }}>
        <p className="text-sm" style={{ color: '#B9BBB7' }}>No hay pedidos pendientes de preparar en {sucursal} para ese período.</p>
      </div>
    )
  }

  const boton = (bg: string, fg: string, borde?: string): React.CSSProperties => ({
    padding: '6px 11px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', background: bg, color: fg, border: borde ?? 'none', whiteSpace: 'nowrap',
  })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: '#6b7280' }}>
        <span>
          {puedeValidar
            ? 'Marcá lo que tenés físicamente. Si entran más pedidos del mismo producto, solo vas a validar la diferencia.'
            : 'Solo consulta: la validación la hace el depósito de la sucursal.'}
        </span>
        <label className="flex items-center gap-1.5 ml-auto cursor-pointer">
          <input type="checkbox" checked={verValidados} onChange={e => setVerValidados(e.target.checked)} /> Mostrar ya validados
        </label>
      </div>

      {fechas.map(fecha => {
        const lineas = [...dias.get(fecha)!.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
        const estados = lineas.map(l => estadoLinea(l.cantidad, validaciones[`${fecha}|${l.clave}`]))
        const nComp = estados.filter(e => e.completa).length
        const nFalt = estados.filter(e => e.faltanteDeclarado > 0).length
        const visibles = lineas.filter((l, i) => verValidados || !estados[i].completa)
        return (
          <div key={fecha} className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: '#e8edf8' }}>
            <div className="px-4 py-3 flex flex-wrap items-center gap-3" style={{ background: '#e8edf8' }}>
              <span className="font-bold" style={{ color: '#254A96' }}>📅 {fmtDia(fecha)}</span>
              <span className="text-xs" style={{ color: '#254A96' }}>
                {nComp} de {lineas.length} validados{nFalt > 0 && <> · <b style={{ color: '#b91c1c' }}>{nFalt} con faltante</b></>}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: '#f9fafc' }}>
                  <th className="text-left px-3 py-2 text-xs font-semibold" style={{ color: '#666' }}>Código</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold" style={{ color: '#666' }}>Material</th>
                  <th className="text-right px-3 py-2 text-xs font-semibold" style={{ color: '#666' }}>Pedido</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold" style={{ color: '#666' }}>Validación</th>
                </tr>
              </thead>
              <tbody>
                {visibles.map(l => {
                  const key = `${fecha}|${l.clave}`
                  const v = validaciones[key]
                  const e = estadoLinea(l.cantidad, v)
                  const ocupado = guardando === key
                  return (
                    <tr key={l.clave} style={{ borderTop: '1px solid #f0f0f0', background: e.completa ? '#f0fdf4' : e.faltanteDeclarado > 0 ? '#fff7f7' : '#fff', verticalAlign: 'top' }}>
                      <td className="px-3 py-2.5 font-mono text-xs whitespace-nowrap" style={{ color: l.codigo ? '#4b5563' : '#d1d5db' }}>{l.codigo ?? '—'}</td>
                      <td className="px-3 py-2.5" style={{ color: '#1e1e1e' }}>{l.nombre}</td>
                      <td className="px-3 py-2.5 text-right font-bold whitespace-nowrap" style={{ color: '#254A96' }}>{fmtNum(l.cantidad)} <span className="text-xs font-normal" style={{ color: '#9ca3af' }}>{l.unidad}</span></td>
                      <td className="px-3 py-2.5">
                        {e.completa ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold rounded-full px-2.5 py-1" style={{ background: '#d1fae5', color: '#065f46' }}>✅ Validado {fmtNum(e.validada)}</span>
                            {puedeValidar && <button disabled={ocupado} onClick={() => deshacer(fecha, l)} style={boton('#fff', '#6b7280', '1px solid #d6d6d6')}>Deshacer</button>}
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2 flex-wrap text-xs">
                              {e.validada > 0 && <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: '#d1fae5', color: '#065f46' }}>Validado {fmtNum(e.validada)}</span>}
                              {e.validada > 0 && <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: '#fef3c7', color: '#92400e' }}>faltan validar {fmtNum(e.diferencia)}</span>}
                              {e.faltanteDeclarado > 0 && (
                                <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: '#fee2e2', color: '#b91c1c' }}>⏳ Sin stock: faltan {fmtNum(e.faltanteDeclarado)}</span>
                              )}
                              {e.faltanteDeclarado > 0 && v?.decision === 'transferencia' && <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: '#e0f2fe', color: '#0369a1' }}>🔄 Transferencia pedida</span>}
                              {e.faltanteDeclarado > 0 && v?.decision === 'esperar' && <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: '#ede9fe', color: '#6d28d9' }}>⏳ Esperando mercadería</span>}
                              {!v && <span style={{ color: '#9ca3af' }}>Sin validar</span>}
                            </div>
                            {puedeValidar && (
                              <div className="flex items-center gap-2 flex-wrap">
                                <button disabled={ocupado} onClick={() => tengoTodo(fecha, l)} style={boton('#059669', '#fff')}>
                                  ✅ Tengo {e.validada > 0 || e.faltanteDeclarado > 0 ? `las ${fmtNum(e.diferencia)}` : 'todo'}
                                </button>
                                {e.diferencia > 1 && (
                                  parte?.id === key ? (
                                    <span className="flex items-center gap-1">
                                      <input autoFocus type="number" min={1} max={e.diferencia - 1} value={parte.valor}
                                        onChange={ev => setParte({ id: key, valor: ev.target.value })}
                                        onKeyDown={ev => { if (ev.key === 'Enter') tengoParte(fecha, l, Number(parte.valor)) }}
                                        className="border rounded-lg px-2 py-1 text-sm w-20 text-center" style={{ borderColor: '#d6d6d6' }} placeholder="cuántas" />
                                      <button disabled={ocupado} onClick={() => tengoParte(fecha, l, Number(parte.valor))} style={boton('#254A96', '#fff')}>OK</button>
                                      <button onClick={() => setParte(null)} style={boton('#fff', '#6b7280', '1px solid #d6d6d6')}>✕</button>
                                    </span>
                                  ) : (
                                    <button disabled={ocupado} onClick={() => setParte({ id: key, valor: '' })} style={boton('#fff', '#254A96', '1.5px solid #254A96')}>Tengo una parte…</button>
                                  )
                                )}
                                {e.faltanteDeclarado < e.diferencia && <button disabled={ocupado} onClick={() => noTengo(fecha, l)} style={boton('#fff', '#b91c1c', '1.5px solid #fca5a5')}>❌ No tengo</button>}
                              </div>
                            )}
                          </div>
                        )}
                        {v?.validado_en && (
                          <div className="text-xs mt-1" style={{ color: '#b0b0b0' }}>
                            {new Date(v.validado_en).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}
      {cargando && <div className="text-xs text-center" style={{ color: '#B9BBB7' }}>Cargando validaciones…</div>}
    </div>
  )
}
