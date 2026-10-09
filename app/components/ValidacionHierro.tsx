'use client'

import { useState } from 'react'
import { FORMAS_HIERRO, type FormaHierro } from '../lib/hierro'

interface LineaHierro { idx: number; descripcion: string; cantidad: number; forma: FormaHierro | null }

interface Props {
  lineas: LineaHierro[]
  onConfirmar: (formas: Record<number, FormaHierro>) => void
}

// Ventana obligatoria: no se puede cerrar ni seguir sin elegir derecho o doblado en cada hierro.
export default function ValidacionHierro({ lineas, onConfirmar }: Props) {
  const [elegidas, setElegidas] = useState<Record<number, FormaHierro | null>>(
    () => Object.fromEntries(lineas.map(l => [l.idx, l.forma]))
  )
  const faltan = lineas.filter(l => !elegidas[l.idx]).length

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto', padding: 20 }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 800, color: '#254A96' }}>Hierros: ¿derechos o doblados?</h2>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#6b7280' }}>
          Confirmá con el cliente cómo va cada hierro. Hay que elegir una opción en todas las líneas para poder guardar el pedido.
        </p>

        {lineas.map(l => (
          <div key={l.idx} style={{ border: `1.5px solid ${elegidas[l.idx] ? '#bbf7d0' : '#fecaca'}`, background: elegidas[l.idx] ? '#f0fdf4' : '#fff7f7', borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111', marginBottom: 8 }}>
              {l.descripcion} <span style={{ color: '#6b7280', fontWeight: 500 }}>× {l.cantidad}</span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {FORMAS_HIERRO.map(f => {
                const activa = elegidas[l.idx] === f.valor
                return (
                  <button key={f.valor} type="button" onClick={() => setElegidas(p => ({ ...p, [l.idx]: f.valor }))}
                    style={{ flex: 1, padding: '11px 8px', borderRadius: 10, fontSize: 15, fontWeight: 800, cursor: 'pointer',
                      border: `2px solid ${activa ? '#254A96' : '#d6d6d6'}`, background: activa ? '#254A96' : '#fff', color: activa ? '#fff' : '#374151' }}>
                    {f.etiqueta}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        <button type="button" disabled={faltan > 0}
          onClick={() => onConfirmar(elegidas as Record<number, FormaHierro>)}
          style={{ width: '100%', marginTop: 6, padding: 13, borderRadius: 12, border: 'none', fontSize: 15, fontWeight: 800,
            background: faltan > 0 ? '#d1d5db' : '#254A96', color: '#fff', cursor: faltan > 0 ? 'not-allowed' : 'pointer' }}>
          {faltan > 0 ? `Falta elegir en ${faltan} ${faltan === 1 ? 'línea' : 'líneas'}` : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}
