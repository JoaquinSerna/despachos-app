'use client'

import type { Dispatch, SetStateAction } from 'react'
import { formatCuit, normalizarRemito, remitoIgual } from '../lib/compras-utils'
import {
  comprimirFoto, leerRemitoOCR, MAX_FOTOS_REMITO, MAX_REMITOS, nuevoRemito,
  type ProveedorLite, type RemitoDraft,
} from '../lib/compras'

interface Props {
  remitos: RemitoDraft[]
  setRemitos: Dispatch<SetStateAction<RemitoDraft[]>>
  proveedor: ProveedorLite | null
  proveedores: ProveedorLite[]
  onUsarProveedor: (p: ProveedorLite) => void
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
}

const caja = (bg: string, bd: string, fg: string): React.CSSProperties => ({
  background: bg, border: `1px solid ${bd}`, color: fg, borderRadius: 10, padding: '9px 11px', fontSize: 13, margin: '10px 0',
})
const VERDE = caja('#ecfdf5', '#bbf7d0', '#065f46')
const ROJO = caja('#fef2f2', '#fecaca', '#b91c1c')
const AMBAR = caja('#fffbeb', '#fde68a', '#92400e')

export default function RemitosEditor({ remitos, setRemitos, proveedor, proveedores, onUsarProveedor, showToast }: Props) {
  const actualizar = (key: string, cambios: Partial<RemitoDraft>) =>
    setRemitos(prev => prev.map(r => r.key === key ? { ...r, ...cambios } : r))

  const agregarFotos = async (r: RemitoDraft, files: FileList | null) => {
    if (!files || !files.length) return
    const libres = MAX_FOTOS_REMITO - r.fotos.length
    if (libres <= 0) { showToast(`Máximo ${MAX_FOTOS_REMITO} fotos por remito`, 'err'); return }
    const comprimidas = await Promise.all(Array.from(files).slice(0, libres).map(async f => {
      const c = await comprimirFoto(f)
      return { file: c, preview: URL.createObjectURL(c) }
    }))
    const esPrimera = r.fotos.length === 0
    setRemitos(prev => prev.map(x => x.key === r.key ? { ...x, fotos: [...x.fotos, ...comprimidas], ocr: esPrimera ? 'leyendo' : x.ocr } : x))
    if (esPrimera) leer(r.key, comprimidas[0].file)
  }

  const leer = async (key: string, file: File) => {
    actualizar(key, { ocr: 'leyendo' })
    const d = await leerRemitoOCR(file)
    if (!d) { actualizar(key, { ocr: 'error' }); return }
    setRemitos(prev => prev.map(x => {
      if (x.key !== key) return x
      return {
        ...x, ocr: 'ok', leido: d.numero_remito, cuit: d.cuit_emisor, razon: d.razon_social_emisor,
        fecha: d.fecha, oc: d.orden_compra, numero: x.numero.trim() ? x.numero : (d.numero_remito ?? ''),
      }
    }))
  }

  const quitarFoto = (r: RemitoDraft, i: number) => {
    URL.revokeObjectURL(r.fotos[i].preview)
    const fotos = r.fotos.filter((_, idx) => idx !== i)
    actualizar(r.key, fotos.length ? { fotos } : { fotos, ocr: 'idle', leido: null, cuit: null, razon: null, fecha: null, oc: null })
  }

  return (
    <>
      {remitos.map((r, idx) => {
        const sugerido = r.cuit && !proveedor ? proveedores.find(p => p.cuit === r.cuit) : undefined
        const fmt = r.numero ? normalizarRemito(r.numero) : null
        const corregido = !!r.leido && !!r.numero.trim() && !remitoIgual(r.numero, r.leido)
        return (
          <div key={r.key} style={{ background: '#fff', borderRadius: 16, border: '1px solid #e0e0e0', padding: '16px', marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
              <b style={{ flex: 1, fontSize: 15 }}>Remito {idx + 1}</b>
              {remitos.length > 1 && (
                <button type="button" onClick={() => setRemitos(prev => prev.filter(x => x.key !== r.key))}
                  style={{ border: '1.5px solid #d6d6d6', background: '#fff', borderRadius: 14, padding: '3px 11px', fontSize: 12, cursor: 'pointer' }}>quitar</button>
              )}
            </div>

            {r.fotos.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                {r.fotos.map((f, i) => (
                  <div key={i} style={{ position: 'relative' }}>
                    <img src={f.preview} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid #ddd' }} />
                    <button type="button" onClick={() => quitarFoto(r, i)}
                      style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, border: 'none', background: '#991b1b', color: '#fff', cursor: 'pointer', fontSize: 12 }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            {r.fotos.length < MAX_FOTOS_REMITO && (
              <label style={{ display: 'block', textAlign: 'center', padding: '12px', borderRadius: 12, border: '1.5px dashed #254A96', color: '#254A96', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
                📷 {r.fotos.length === 0 ? 'Foto del remito' : 'Agregar otra hoja'}
                <input type="file" accept="image/*" multiple style={{ display: 'none' }}
                  onChange={e => { agregarFotos(r, e.target.files); e.target.value = '' }} />
              </label>
            )}
            {r.fotos.length === 0 && (
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Sacá la foto de la hoja con el número arriba. Si hay varias hojas, podés agregarlas después.</div>
            )}

            {r.ocr === 'leyendo' && <div style={AMBAR}>Leyendo el remito…</div>}
            {r.ocr === 'error' && (
              <div style={AMBAR}>
                No se pudo leer el remito. Tipeá el número a mano.{' '}
                <button type="button" onClick={() => leer(r.key, r.fotos[0].file)}
                  style={{ border: 'none', background: 'none', color: '#254A96', fontWeight: 700, cursor: 'pointer', textDecoration: 'underline' }}>Reintentar</button>
              </div>
            )}
            {r.ocr === 'ok' && (
              <div style={VERDE}>
                <b>Detectado:</b> {r.leido ? `N° ${r.leido}` : 'no se leyó el número'}
                {r.cuit && <> · CUIT {formatCuit(r.cuit)}</>}
                {r.razon && <> · {r.razon}</>}
                {r.oc && <> · cita OC {r.oc}</>}
              </div>
            )}
            {r.cuit && proveedor?.cuit && r.cuit !== proveedor.cuit && (
              <div style={ROJO}>⚠ El CUIT del remito ({formatCuit(r.cuit)}){r.razon ? ` — ${r.razon}` : ''} no coincide con el de <b>{proveedor.nombre}</b>. Revisá que el proveedor sea el correcto.</div>
            )}
            {r.cuit && proveedor && !proveedor.cuit && (
              <div style={AMBAR}>El proveedor no tiene CUIT cargado; el remito indica {formatCuit(r.cuit)}. Compras lo va a completar.</div>
            )}
            {sugerido && (
              <div style={AMBAR}>
                ¿Es <b>{sugerido.nombre}</b>?{' '}
                <button type="button" onClick={() => onUsarProveedor(sugerido)}
                  style={{ border: '1.5px solid #254A96', background: '#fff', color: '#254A96', borderRadius: 14, padding: '2px 11px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Usar este proveedor</button>
              </div>
            )}

            {r.fotos.length > 0 && (
              <>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: '.05em', margin: '12px 0 6px' }}>
                  N° de remito — confirmá o corregí
                </label>
                <input value={r.numero} inputMode="text" placeholder="0001-00012345" autoCapitalize="characters"
                  onChange={e => actualizar(r.key, { numero: e.target.value })}
                  onBlur={() => r.numero.trim() && actualizar(r.key, { numero: normalizarRemito(r.numero).valor })}
                  style={{ width: '100%', padding: 12, fontSize: 21, fontWeight: 800, letterSpacing: '.02em', textAlign: 'center', borderRadius: 12, border: `2px solid ${corregido ? '#d97706' : '#d6d6d6'}`, boxSizing: 'border-box', background: '#fff', color: '#111' }} />
                <div style={{ fontSize: 12, marginTop: 6, color: corregido ? '#92400e' : '#6b7280' }}>
                  {corregido
                    ? `✎ Corregido (el sistema había leído ${r.leido}). Este es el número que usa Compras.`
                    : 'Tiene que coincidir con el papel. Es el número que usa Compras para el cruce.'}
                </div>
                {fmt && !fmt.formatoOk && (
                  <div style={{ fontSize: 12, marginTop: 4, color: '#92400e' }}>Formato inusual: se espera algo como 0001-00012345. Verificalo contra el papel.</div>
                )}
              </>
            )}
          </div>
        )
      })}
      {remitos.length < MAX_REMITOS && (
        <button type="button" onClick={() => setRemitos(prev => [...prev, nuevoRemito()])}
          style={{ width: '100%', padding: 12, borderRadius: 12, border: '1.5px dashed #254A96', background: 'transparent', color: '#254A96', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 14 }}>
          ＋ Agregar otro remito
        </button>
      )}
    </>
  )
}
