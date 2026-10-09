'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  urls: string[]
  inicio?: number
  onCerrar: () => void
}

const NIVELES = [1, 2, 3.5]

const btn: React.CSSProperties = {
  background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', borderRadius: 10, padding: '8px 14px',
  fontSize: 16, fontWeight: 700, cursor: 'pointer', minWidth: 42,
}

// Foto a pantalla completa: zoom (1x, 2x, 3,5x), flechas para pasar de foto y cierre con Esc.
export default function VisorFotoGrande({ urls, inicio = 0, onCerrar }: Props) {
  const [i, setI] = useState(Math.min(Math.max(inicio, 0), Math.max(urls.length - 1, 0)))
  const [nivel, setNivel] = useState(0)
  const toque = useRef<number | null>(null)
  const n = urls.length

  const ir = useCallback((d: number) => {
    setI(prev => (prev + d + n) % n)
    setNivel(0)
  }, [n])

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar()
      else if (e.key === 'ArrowLeft' && n > 1) ir(-1)
      else if (e.key === 'ArrowRight' && n > 1) ir(1)
      else if (e.key === '+' || e.key === '=') setNivel(v => Math.min(v + 1, NIVELES.length - 1))
      else if (e.key === '-') setNivel(v => Math.max(v - 1, 0))
    }
    window.addEventListener('keydown', tecla)
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', tecla); document.body.style.overflow = previo }
  }, [ir, n, onCerrar])

  if (!n) return null
  const escala = NIVELES[nivel]

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.96)', zIndex: 500, display: 'flex', flexDirection: 'column' }}
      onTouchStart={e => { toque.current = e.touches[0].clientX }}
      onTouchEnd={e => {
        if (toque.current === null || nivel > 0 || n < 2) return
        const dx = e.changedTouches[0].clientX - toque.current
        toque.current = null
        if (Math.abs(dx) > 60) ir(dx < 0 ? 1 : -1)
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', color: '#fff' }}>
        <span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{n > 1 ? `Foto ${i + 1} de ${n}` : 'Foto'}</span>
        <button onClick={() => setNivel(v => Math.max(v - 1, 0))} disabled={nivel === 0} style={{ ...btn, opacity: nivel === 0 ? 0.4 : 1 }} title="Alejar">−</button>
        <span style={{ fontSize: 13, minWidth: 40, textAlign: 'center' }}>{escala === 1 ? 'Ajustar' : `${escala}x`}</span>
        <button onClick={() => setNivel(v => Math.min(v + 1, NIVELES.length - 1))} disabled={nivel === NIVELES.length - 1} style={{ ...btn, opacity: nivel === NIVELES.length - 1 ? 0.4 : 1 }} title="Acercar">+</button>
        <button onClick={onCerrar} style={{ ...btn, marginLeft: 8 }} title="Cerrar (Esc)">✕</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'auto', display: 'flex' }}
        onClick={e => { if (e.target === e.currentTarget && nivel === 0) onCerrar() }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={urls[i]} alt={`foto ${i + 1}`} draggable={false}
          onClick={() => setNivel(v => (v + 1) % NIVELES.length)}
          style={escala === 1
            ? { maxWidth: '96vw', maxHeight: 'calc(100vh - 70px)', objectFit: 'contain', margin: 'auto', cursor: 'zoom-in', borderRadius: 6 }
            : { width: `${escala * 96}vw`, maxWidth: 'none', height: 'auto', flexShrink: 0, margin: 'auto', cursor: nivel === NIVELES.length - 1 ? 'zoom-out' : 'zoom-in' }}
        />
        {n > 1 && nivel === 0 && (
          <>
            <button onClick={e => { e.stopPropagation(); ir(-1) }} style={{ ...btn, position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 26, padding: '12px 16px' }} title="Anterior">‹</button>
            <button onClick={e => { e.stopPropagation(); ir(1) }} style={{ ...btn, position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 26, padding: '12px 16px' }} title="Siguiente">›</button>
          </>
        )}
      </div>
      <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)', fontSize: 12, padding: '6px 0 10px' }}>
        Tocá la foto para acercar · {n > 1 ? 'flechas del teclado o deslizá para cambiar de foto · ' : ''}Esc para cerrar
      </div>
    </div>
  )
}
