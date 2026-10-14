'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../supabase'

const btnLine: React.CSSProperties = { padding: '4px 10px', borderRadius: 10, border: '1.5px solid #d6d6d6', background: '#fff', color: '#444', fontWeight: 600, fontSize: 12, cursor: 'pointer' }

const fmtFechaHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

// Muestra los enlaces del mensaje (por ejemplo el de Google Cloud) como enlaces de verdad
function ConEnlaces({ texto }: { texto: string }) {
  return <>{texto.split(/(https?:\/\/\S+)/g).map((p, i) => /^https?:\/\//.test(p)
    ? <a key={i} href={p} target="_blank" rel="noreferrer" style={{ color: '#254A96', textDecoration: 'underline', wordBreak: 'break-all' }}>{p}</a>
    : <span key={i}>{p}</span>)}</>
}

// Estado de la sincronización automática con la carpeta de Drive donde Huemul deja los exports.
// La corre el servidor todos los días; acá se ve cómo viene y, para editores, se puede disparar a mano.
export default function SyncDrive({ puedeEd, showToast, onSincronizado, mostrar = 'ambos' }: {
  puedeEd: boolean
  showToast: (msg: string, tipo?: 'ok' | 'err') => void
  onSincronizado?: () => void
  mostrar?: 'ambos' | 'ingresos' | 'oc'
}) {
  const [sync, setSync] = useState<any[]>([])
  const [sincronizando, setSincronizando] = useState(false)

  const cargar = useCallback(async () => {
    const { data } = await supabase.from('drive_sync_log').select('*').order('procesado_en', { ascending: false }).limit(12)
    setSync(data ?? [])
  }, [])
  useEffect(() => { cargar() }, [cargar])

  const sincronizarAhora = async () => {
    setSincronizando(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch('/api/drive-sync', { method: 'POST', headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {} })
      const j = await res.json()
      if (!res.ok || j.ok === false) throw new Error(j.error || 'No se pudo sincronizar con Drive')
      const hechos = (j.resultados ?? []).filter((r: any) => r.ok).length
      showToast(hechos ? 'Sincronizado con Drive' : 'No había archivos nuevos en Drive')
      onSincronizado?.()
    } catch (e: any) { showToast(e?.message || 'No se pudo sincronizar con Drive', 'err') }
    await cargar()
    setSincronizando(false)
  }

  const ultimoOk = (tipo: string) => sync.find(s => s.tipo === tipo && s.ok && !s.omitido)
  const ultima = sync[0]
  const tipos = (mostrar === 'ambos' ? ['ingresos', 'oc'] : [mostrar]) as ('ingresos' | 'oc')[]

  return (
    <div style={{ fontSize: 12, color: '#6b7280' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ color: '#254A96' }}>🔄 Sincronización automática con Drive</b>
        <span>todos los días hacia las 7:00</span>
        {puedeEd && (
          <button onClick={sincronizarAhora} disabled={sincronizando} style={{ ...btnLine, opacity: sincronizando ? 0.6 : 1, cursor: sincronizando ? 'wait' : 'pointer' }}>
            {sincronizando ? 'Sincronizando…' : '↻ Sincronizar ahora'}
          </button>
        )}
      </div>
      {sync.length === 0 ? (
        <div style={{ marginTop: 4 }}>Todavía no corrió ninguna vez.</div>
      ) : (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tipos.map(t => {
            const u = ultimoOk(t)
            return <div key={t}>{t === 'ingresos' ? 'Ingresos' : 'Órdenes de compra'}: {u ? <>✅ <b>{u.archivo}</b> · {fmtFechaHora(u.procesado_en)}</> : 'sin importaciones automáticas todavía'}</div>
          })}
          {ultima && !ultima.ok && (
            <div style={{ color: '#b91c1c', fontWeight: 600, lineHeight: 1.5 }}>
              ⚠ La última corrida ({fmtFechaHora(ultima.procesado_en)}) falló: <ConEnlaces texto={ultima.detalle?.mensaje ?? 'error desconocido'} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
