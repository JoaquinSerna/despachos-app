'use client'

import { useMemo, useState } from 'react'
import { coincideTexto, formatCuit, soloDigitos } from '../lib/compras-utils'
import type { ProveedorLite } from '../lib/compras'

interface Props {
  proveedores: ProveedorLite[]
  value: ProveedorLite | null
  onChange: (p: ProveedorLite | null) => void
  onCrear: (nombre: string, cuit: string) => Promise<ProveedorLite | null>
}

const input: React.CSSProperties = {
  width: '100%', padding: '14px 12px', fontSize: 16, borderRadius: 12, border: '1.5px solid #e0e0e0',
  background: '#fff', color: '#1a1a1a', boxSizing: 'border-box',
}

export default function ProveedorPicker({ proveedores, value, onChange, onCrear }: Props) {
  const [q, setQ] = useState('')
  const [abierto, setAbierto] = useState(false)
  const [nuevo, setNuevo] = useState(false)
  const [nNombre, setNNombre] = useState('')
  const [nCuit, setNCuit] = useState('')
  const [creando, setCreando] = useState(false)

  const resultados = useMemo(() => {
    const t = q.trim()
    const dig = soloDigitos(t)
    return proveedores
      .filter(p => !t || coincideTexto(p.nombre, t) || (dig.length >= 3 && (p.cuit ?? '').includes(dig)))
      .slice(0, 40)
  }, [proveedores, q])

  const crear = async () => {
    setCreando(true)
    const p = await onCrear(nNombre, nCuit)
    setCreando(false)
    if (p) { onChange(p); setNuevo(false); setNNombre(''); setNCuit(''); setQ(''); setAbierto(false) }
  }

  if (value && !nuevo) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '12px', background: '#f0f4ff', borderRadius: 12 }}>
        <b style={{ fontSize: 16, color: '#1a1a1a' }}>{value.nombre}</b>
        {value.estado === 'pendiente' && <span style={{ background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 10, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>Pendiente de aprobación</span>}
        {value.cuit && <span style={{ fontSize: 12, color: '#6b7280' }}>{formatCuit(value.cuit)}</span>}
        <button type="button" onClick={() => { onChange(null); setQ('') }}
          style={{ marginLeft: 'auto', border: '1.5px solid #d6d6d6', background: '#fff', borderRadius: 16, padding: '4px 12px', fontSize: 13, cursor: 'pointer' }}>cambiar</button>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <input type="text" value={q} placeholder="🔍 Buscar proveedor por nombre o CUIT…" style={input}
        onChange={e => { setQ(e.target.value); setAbierto(true) }} onFocus={() => setAbierto(true)} />
      {abierto && !nuevo && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setAbierto(false)} />
          <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', marginTop: 4, background: '#fff', border: '1.5px solid #d6d6d6', borderRadius: 12, maxHeight: 260, overflowY: 'auto', zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
            {resultados.map(p => (
              <div key={p.id} onClick={() => { onChange(p); setAbierto(false); setQ('') }}
                style={{ padding: '11px 13px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: 15, color: '#111827' }}>
                {p.nombre}
                {p.estado === 'pendiente' && <span style={{ marginLeft: 8, fontSize: 11, color: '#92400e', fontWeight: 700 }}>pendiente</span>}
                <div style={{ fontSize: 11, color: '#6b7280' }}>{p.cuit ? formatCuit(p.cuit) : 'sin CUIT cargado'}</div>
              </div>
            ))}
            <div onClick={() => { setNuevo(true); setNNombre(q.trim()); setAbierto(false) }}
              style={{ padding: '12px 13px', cursor: 'pointer', color: '#254A96', fontWeight: 700, fontSize: 14 }}>
              ＋ {q.trim() ? `Agregar «${q.trim()}» como proveedor nuevo` : 'No está en la lista: agregar proveedor nuevo'}
            </div>
          </div>
        </>
      )}
      {nuevo && (
        <div style={{ marginTop: 10, padding: 12, border: '1.5px dashed #d97706', borderRadius: 12, background: '#fffbeb' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>Proveedor nuevo</div>
          <input style={{ ...input, marginBottom: 8 }} value={nNombre} onChange={e => setNNombre(e.target.value)} placeholder="Nombre" />
          <input style={{ ...input, marginBottom: 8 }} value={nCuit} onChange={e => setNCuit(e.target.value)} placeholder="CUIT (opcional)" inputMode="numeric" />
          <div style={{ fontSize: 12, color: '#92400e', marginBottom: 10 }}>Queda «pendiente» hasta que Compras lo apruebe. Podés seguir cargando el ingreso igual.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={crear} disabled={creando}
              style={{ flex: 1, padding: 12, borderRadius: 10, border: 'none', background: '#254A96', color: '#fff', fontWeight: 700, cursor: 'pointer', opacity: creando ? 0.6 : 1 }}>
              {creando ? 'Agregando…' : 'Agregar y usar'}
            </button>
            <button type="button" onClick={() => setNuevo(false)}
              style={{ padding: '12px 16px', borderRadius: 10, border: '1.5px solid #d6d6d6', background: '#fff', cursor: 'pointer' }}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  )
}
