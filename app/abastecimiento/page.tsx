'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/app/supabase'
import { tieneAcceso } from '@/app/lib/permisos'

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

const ESTADO_LABEL: Record<string, string> = {
  pendiente:    'Pendiente',
  conf_stock:   'Conf. Stock',
  preparacion:  'En preparación',
  en_transito:  'En tránsito',
  entregado:    'Entregado',
  rechazado:    'Rechazado',
}
const ESTADO_COLOR: Record<string, { bg: string; text: string }> = {
  pendiente:   { bg: '#fef3c7', text: '#b45309' },
  conf_stock:  { bg: '#e0f2fe', text: '#0369a1' },
  preparacion: { bg: '#ede9fe', text: '#7c3aed' },
  en_transito: { bg: '#dbeafe', text: '#1d4ed8' },
  entregado:   { bg: '#d1fae5', text: '#065f46' },
  rechazado:   { bg: '#fde8e8', text: '#E52322' },
}
const TIPO_ENTREGA_OPTS = ['parcial', 'completa', 'no_llego', 'cancelado', 'devuelto']
const TIPO_ENTREGA_LABEL: Record<string, string> = {
  parcial: 'Parcial', completa: 'Completa', no_llego: 'No llegó', cancelado: 'Cancelado', devuelto: 'Devuelto',
}

// Estados siguientes según el estado actual y el rol
function estadosSiguientes(estado: string, rol: string): string[] {
  if (rol === 'ruteador') return []  // ruteador no cambia estados
  const map: Record<string, string[]> = {
    pendiente:   ['conf_stock', 'rechazado'],
    conf_stock:  ['preparacion', 'rechazado'],
    preparacion: ['en_transito', 'rechazado'],
    en_transito: ['entregado', 'rechazado'],
    entregado:   [],
    rechazado:   [],
  }
  return map[estado] ?? []
}

interface ReqItem {
  id: string
  id_producto: number | null
  nombre_producto: string
  cantidad_solicitada: number
  cantidad_aprobada: number | null
  notas: string | null
}
interface Requerimiento {
  id: string
  tipo: 'pedido' | 'abastecimiento' | 'movimiento'
  pedido_id: string | null
  nv: string | null
  cliente: string | null
  sucursal_origen: string
  sucursal_destino: string
  estado: string
  fecha_req: string
  fecha_solicitada: string | null
  fecha_recepcion: string | null
  tipo_entrega: string | null
  n_viaje: string | null
  cod_vehiculo: string | null
  solicitado_por: string | null
  notas: string | null
  created_at: string
  requerimiento_items: ReqItem[]
}
interface CamionSugerido {
  codigo: string
  tipo_unidad: string
  pedidos_destino: number
  razon: string
}

function hoy() { return new Date().toISOString().split('T')[0] }

function BadgeEstado({ estado }: { estado: string }) {
  const c = ESTADO_COLOR[estado] ?? { bg: '#f4f4f3', text: '#666' }
  return (
    <span className="text-xs px-2 py-0.5 rounded-full font-medium whitespace-nowrap"
      style={{ background: c.bg, color: c.text }}>
      {ESTADO_LABEL[estado] ?? estado}
    </span>
  )
}

function BadgeTipo({ tipo }: { tipo: string }) {
  const map: Record<string, { label: string; bg: string; color: string }> = {
    pedido:        { label: 'Pedido',        bg: '#e8edf8', color: '#254A96' },
    abastecimiento:{ label: 'Abastecim.',    bg: '#fef3c7', color: '#b45309' },
    movimiento:    { label: 'Movimiento',    bg: '#f3e8ff', color: '#7c3aed' },
  }
  const s = map[tipo] ?? { label: tipo, bg: '#f4f4f3', color: '#666' }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded font-medium"
      style={{ background: s.bg, color: s.color }}>{s.label}</span>
  )
}

export default function AbastecimientoPage() {
  const router = useRouter()
  const [rol, setRol] = useState<string>('')
  const [userEmail, setUserEmail] = useState('')
  const [tab, setTab] = useState<'pendientes' | 'transito' | 'historial' | 'importar'>('pendientes')
  const [reqs, setReqs] = useState<Requerimiento[]>([])
  const [cargando, setCargando] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)

  // Filtros
  const [filtroOrigen, setFiltroOrigen] = useState('')
  const [filtroDestino, setFiltroDestino] = useState('')

  // Modal detalle / edición
  const [detalle, setDetalle] = useState<Requerimiento | null>(null)
  const [guardando, setGuardando] = useState(false)
  const [editItems, setEditItems] = useState<Record<string, number | null>>({})
  const [editNotas, setEditNotas] = useState('')
  const [editNViaje, setEditNViaje] = useState('')
  const [editVehiculo, setEditVehiculo] = useState('')
  const [editFechaRec, setEditFechaRec] = useState('')
  const [editTipoEntrega, setEditTipoEntrega] = useState('')
  const [camionesRec, setCamionesRec] = useState<CamionSugerido[]>([])

  // Modal crear requerimiento
  const [modalCrear, setModalCrear] = useState(false)
  const [formCrear, setFormCrear] = useState({
    tipo: 'abastecimiento' as 'pedido' | 'abastecimiento' | 'movimiento',
    nv: '', cliente: '', sucursal_origen: 'Guernica', sucursal_destino: 'LP520',
    fecha_solicitada: '', notas: '',
  })
  const [itemsCrear, setItemsCrear] = useState<{ nombre_producto: string; cantidad_solicitada: number; id_producto: number | null; _codigo?: string; _encontrado?: boolean; _noEncontrado?: boolean }[]>([
    { nombre_producto: '', cantidad_solicitada: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }
  ])
  const [stockConsulta, setStockConsulta] = useState<Record<string, { sucursal: string; cantidad: number }[]>>({})

  // Importar
  const [importandoStock, setImportandoStock] = useState(false)
  const [importandoSolicitudes, setImportandoSolicitudes] = useState(false)
  const [ultimoStock, setUltimoStock] = useState<string | null>(null)
  const [resultImport, setResultImport] = useState<any>(null)
  const [solicitudesNoCargadas, setSolicitudesNoCargadas] = useState<any[]>([])
  const fileStockRef = useRef<HTMLInputElement>(null)
  const fileSolicRef = useRef<HTMLInputElement>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol, email, permisos').eq('id', user.id).single()
      const r = data?.rol ?? ''
      if (!tieneAcceso(data?.permisos, r, 'abastecimiento')) { router.push('/dashboard'); return }
      setRol(r)
      setUserEmail(data?.email ?? user.email ?? '')
      cargarReqs(tab)
      cargarUltimoStock()
    })
  }, [])

  useEffect(() => { if (rol) cargarReqs(tab) }, [tab, filtroOrigen, filtroDestino])

  async function cargarReqs(t: string) {
    setCargando(true)
    const params = new URLSearchParams({ tab: t })
    if (filtroOrigen) params.set('sucursal_origen', filtroOrigen)
    if (filtroDestino) params.set('sucursal_destino', filtroDestino)
    const res = await fetch(`/api/requerimientos?${params}`)
    const data = await res.json()
    setReqs(Array.isArray(data) ? data : [])
    setCargando(false)
  }

  async function cargarUltimoStock() {
    const res = await fetch('/api/stock-import')
    const data = await res.json()
    setUltimoStock(data.ultimo_import ?? null)
  }

  async function abrirDetalle(req: Requerimiento) {
    setDetalle(req)
    setEditItems({})
    setEditNotas(req.notas ?? '')
    setEditNViaje(req.n_viaje ?? '')
    setEditVehiculo(req.cod_vehiculo ?? '')
    setEditFechaRec(req.fecha_recepcion ?? '')
    setEditTipoEntrega(req.tipo_entrega ?? '')
    setCamionesRec([])
    // Cargar sugerencia de camiones si hay fecha
    if (req.fecha_solicitada) cargarCamionesRecomendados(req)
  }

  async function cargarCamionesRecomendados(req: Requerimiento) {
    if (!req.fecha_solicitada) return
    try {
      // Buscar camiones de sucursal_origen activos ese día
      const { data: flota } = await supabase
        .from('flota_dia')
        .select('camion_codigo')
        .eq('fecha', req.fecha_solicitada)
        .eq('sucursal', req.sucursal_origen)
        .eq('activo', true)

      if (!flota?.length) return

      const codigos = flota.map((f: any) => f.camion_codigo)
      const { data: camiones } = await supabase
        .from('camiones_flota')
        .select('codigo, tipo_unidad')
        .in('codigo', codigos)
        .eq('activo', true)

      if (!camiones?.length) return

      // Ver cuántos pedidos tienen programados en sucursal_destino
      const { data: pedidos } = await supabase
        .from('pedidos')
        .select('camion_id')
        .in('camion_id', codigos)
        .eq('fecha_entrega', req.fecha_solicitada)
        .eq('sucursal', req.sucursal_destino)
        .eq('estado', 'programado')

      const pedidosPorCamion: Record<string, number> = {}
      for (const p of (pedidos ?? [])) {
        pedidosPorCamion[p.camion_id] = (pedidosPorCamion[p.camion_id] ?? 0) + 1
      }

      const sugeridos: CamionSugerido[] = camiones.map((c: any) => ({
        codigo: c.codigo,
        tipo_unidad: c.tipo_unidad,
        pedidos_destino: pedidosPorCamion[c.codigo] ?? 0,
        razon: pedidosPorCamion[c.codigo]
          ? `Tiene ${pedidosPorCamion[c.codigo]} entrega${pedidosPorCamion[c.codigo] > 1 ? 's' : ''} en ${req.sucursal_destino} ese día`
          : `Disponible en ${req.sucursal_origen}`,
      })).sort((a, b) => b.pedidos_destino - a.pedidos_destino)

      setCamionesRec(sugeridos)
    } catch {}
  }

  async function cambiarEstado(req: Requerimiento, nuevoEstado: string) {
    setGuardando(true)
    const updates: any = { estado: nuevoEstado }

    // Si pasa a en_transito, guardar viaje y vehículo
    if (nuevoEstado === 'en_transito') {
      updates.n_viaje = editNViaje || req.n_viaje
      updates.cod_vehiculo = editVehiculo || req.cod_vehiculo
    }
    // Si entregado, guardar fecha recepción y tipo entrega
    if (nuevoEstado === 'entregado') {
      updates.fecha_recepcion = editFechaRec || hoy()
      updates.tipo_entrega = editTipoEntrega || 'completa'
    }
    if (editNotas) updates.notas = editNotas

    // Items con cantidades aprobadas modificadas
    const items_update = Object.entries(editItems)
      .filter(([, v]) => v !== null)
      .map(([id, cantidad_aprobada]) => ({ id, cantidad_aprobada }))

    const res = await fetch('/api/requerimientos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: req.id, ...updates, items_update }),
    })
    const data = await res.json()
    setGuardando(false)
    if (!data.success) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`Estado actualizado: ${ESTADO_LABEL[nuevoEstado]}`)
    setDetalle(null)
    cargarReqs(tab)
  }

  async function crearRequerimiento() {
    if (!formCrear.sucursal_origen || !formCrear.sucursal_destino) {
      showToast('Completá origen y destino', 'err'); return
    }
    if (itemsCrear.some(it => !it.nombre_producto)) {
      showToast('Completá el nombre de todos los productos', 'err'); return
    }
    setGuardando(true)
    const res = await fetch('/api/requerimientos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...formCrear,
        fecha_req: hoy(),
        solicitado_por: userEmail,
        estado: 'pendiente',
        items: itemsCrear
          .filter(it => it.nombre_producto)
          .map(({ _codigo: _c, _encontrado: _e, _noEncontrado: _n, ...rest }: any) => rest),
      }),
    })
    const data = await res.json()
    setGuardando(false)
    if (!data.success) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast('Requerimiento creado')
    setModalCrear(false)
    setFormCrear({ tipo: 'abastecimiento', nv: '', cliente: '', sucursal_origen: 'Guernica', sucursal_destino: 'LP520', fecha_solicitada: '', notas: '' })
    setItemsCrear([{ nombre_producto: '', cantidad_solicitada: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }])
    cargarReqs(tab)
  }

  async function consultarStock(nombre: string, idx: number) {
    if (!nombre || nombre.length < 3) return
    const res = await fetch(`/api/stock-import?nombre=${encodeURIComponent(nombre)}`)
    const data = await res.json()
    if (Array.isArray(data)) {
      const byProd: Record<string, { sucursal: string; cantidad: number }[]> = {}
      for (const row of data) {
        if (!byProd[row.nombre]) byProd[row.nombre] = []
        byProd[row.nombre].push({ sucursal: row.sucursal, cantidad: row.cantidad })
      }
      setStockConsulta(prev => ({ ...prev, [idx]: Object.values(byProd)[0] ?? [] }))
    }
  }

  async function buscarPorCodigo(codigo: string, idx: number) {
    const cod = codigo.trim()
    if (!cod || isNaN(Number(cod))) return
    const res = await fetch(`/api/stock-import?id_producto=${cod}`)
    const data = await res.json()
    if (Array.isArray(data) && data.length > 0) {
      const nombre = data[0].nombre
      const id = data[0].id_producto
      // Autofill nombre e id_producto en el item
      setItemsCrear(prev => {
        const upd = [...prev]
        upd[idx] = { ...upd[idx], nombre_producto: nombre, id_producto: id, _encontrado: true, _noEncontrado: false }
        return upd
      })
      // Cargar stock por sucursal (solo los que tienen cantidad > 0)
      const stock = data.filter((r: any) => r.cantidad > 0).map((r: any) => ({ sucursal: r.sucursal, cantidad: r.cantidad }))
      setStockConsulta(prev => ({ ...prev, [idx]: stock }))
    } else {
      // No existe en maestro — modo manual
      setItemsCrear(prev => {
        const upd = [...prev]
        upd[idx] = { ...upd[idx], nombre_producto: '', id_producto: null, _encontrado: false, _noEncontrado: true }
        return upd
      })
      setStockConsulta(prev => ({ ...prev, [idx]: [] }))
    }
  }

  async function importarStock(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportandoStock(true)
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/stock-import', { method: 'POST', body: fd })
    const data = await res.json()
    setImportandoStock(false)
    if (data.error) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`Stock importado: ${data.productos} productos, ${data.registros} registros`)
    setUltimoStock(data.actualizado_en)
    if (fileStockRef.current) fileStockRef.current.value = ''
  }

  async function importarSolicitudes(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportandoSolicitudes(true)
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/solicitudes-import', { method: 'POST', body: fd })
    const data = await res.json()
    setImportandoSolicitudes(false)
    if (data.error) { showToast(`Error: ${data.error}`, 'err'); return }
    showToast(`${data.total} solicitudes procesadas — ${data.no_cargados} sin cargar en app`)
    setResultImport(data)
    setSolicitudesNoCargadas(data.solicitudes_sin_cargar ?? [])
    if (fileSolicRef.current) fileSolicRef.current.value = ''
  }

  const TABS = [
    { key: 'pendientes', label: 'Pendientes' },
    { key: 'transito',   label: 'En tránsito' },
    { key: 'historial',  label: 'Historial' },
    { key: 'importar',   label: '⬆ Importar' },
  ]

  return (
    <div className="min-h-screen flex flex-col" style={{ fontFamily: 'Barlow, sans-serif', background: '#f4f4f3' }}>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b shrink-0" style={{ borderColor: '#e8edf8' }}>
        <div className="px-4 md:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/dashboard')}
              className="text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</button>
            <img src="/logo.png" alt="" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div className="hidden sm:block">
              <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Abastecimiento</span>
              <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>Transferencias entre sucursales</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(rol === 'deposito' || rol === 'gerencia') && (
              <button onClick={() => { setModalCrear(true); setItemsCrear([{ nombre_producto: '', cantidad_solicitada: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }]) }}
                className="px-4 py-2 text-sm font-semibold rounded-lg text-white"
                style={{ background: '#0f766e' }}>
                + Nuevo requerimiento
              </button>
            )}
            <button onClick={() => { supabase.auth.signOut(); router.push('/') }}
              className="px-3 py-1.5 text-sm font-medium rounded-lg"
              style={{ color: '#666', background: '#f4f4f3' }}>
              Salir
            </button>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex px-4 md:px-6 border-t" style={{ borderColor: '#f0f0f0' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key as any)}
              className="px-4 py-2.5 text-sm font-medium border-b-2 transition-colors"
              style={{
                borderBottomColor: tab === t.key ? '#254A96' : 'transparent',
                color: tab === t.key ? '#254A96' : '#B9BBB7',
              }}>{t.label}</button>
          ))}
        </div>
      </nav>

      {/* Filtros (no en tab importar) */}
      {tab !== 'importar' && (
        <div className="bg-white border-b px-4 md:px-6 py-2.5 flex items-center gap-3 flex-wrap" style={{ borderColor: '#f0f0f0' }}>
          <select value={filtroOrigen} onChange={e => setFiltroOrigen(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
            <option value="">Todos los orígenes</option>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <span style={{ color: '#B9BBB7' }}>→</span>
          <select value={filtroDestino} onChange={e => setFiltroDestino(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
            <option value="">Todos los destinos</option>
            {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="text-sm ml-auto" style={{ color: '#B9BBB7' }}>
            {reqs.length} requerimiento{reqs.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Contenido */}
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4">
        {tab === 'importar' ? (
          <TabImportar
            ultimoStock={ultimoStock}
            importandoStock={importandoStock}
            importandoSolicitudes={importandoSolicitudes}
            resultImport={resultImport}
            solicitudesNoCargadas={solicitudesNoCargadas}
            fileStockRef={fileStockRef}
            fileSolicRef={fileSolicRef}
            onImportarStock={importarStock}
            onImportarSolicitudes={importarSolicitudes}
          />
        ) : cargando ? (
          <div className="flex justify-center py-24">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : reqs.length === 0 ? (
          <div className="flex flex-col items-center py-24" style={{ color: '#B9BBB7' }}>
            <div className="text-5xl mb-4">📦</div>
            <p className="font-medium">No hay requerimientos en esta sección</p>
          </div>
        ) : (
          <div className="space-y-2">
            {reqs.map(req => (
              <ReqRow key={req.id} req={req} onClick={() => abrirDetalle(req)} />
            ))}
          </div>
        )}
      </div>

      {/* Modal Detalle */}
      {detalle && (
        <ModalDetalle
          req={detalle}
          rol={rol}
          guardando={guardando}
          editItems={editItems}
          editNotas={editNotas}
          editNViaje={editNViaje}
          editVehiculo={editVehiculo}
          editFechaRec={editFechaRec}
          editTipoEntrega={editTipoEntrega}
          camionesRec={camionesRec}
          setEditItems={setEditItems}
          setEditNotas={setEditNotas}
          setEditNViaje={setEditNViaje}
          setEditVehiculo={setEditVehiculo}
          setEditFechaRec={setEditFechaRec}
          setEditTipoEntrega={setEditTipoEntrega}
          onCambiarEstado={(est: string) => cambiarEstado(detalle, est)}
          onClose={() => setDetalle(null)}
        />
      )}

      {/* Modal Crear */}
      {modalCrear && (
        <ModalCrear
          form={formCrear}
          items={itemsCrear}
          guardando={guardando}
          stockConsulta={stockConsulta}
          rol={rol}
          setForm={setFormCrear}
          setItems={setItemsCrear}
          onConsultarStock={consultarStock}
          onBuscarPorCodigo={buscarPorCodigo}
          onCreate={crearRequerimiento}
          onClose={() => setModalCrear(false)}
        />
      )}
    </div>
  )
}

/* ─── Fila de la lista ──────────────────────────────── */
function ReqRow({ req, onClick }: { req: Requerimiento; onClick: () => void }) {
  const totalItems = req.requerimiento_items?.length ?? 0
  const resumen = req.requerimiento_items?.slice(0, 2).map(it => it.nombre_producto).join(', ')
    + (totalItems > 2 ? ` +${totalItems - 2} más` : '')

  return (
    <div onClick={onClick}
      className="bg-white rounded-xl p-4 cursor-pointer hover:shadow-md transition-shadow border"
      style={{ borderColor: '#f0f0f0' }}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <BadgeTipo tipo={req.tipo} />
          <BadgeEstado estado={req.estado} />
          {req.nv && <span className="text-xs font-medium" style={{ color: '#254A96' }}>NV {req.nv}</span>}
          {req.cliente && <span className="text-xs" style={{ color: '#B9BBB7' }}>{req.cliente}</span>}
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0" style={{ color: '#B9BBB7' }}>
          {req.n_viaje && <span className="font-medium" style={{ color: '#0f766e' }}>Viaje #{req.n_viaje}</span>}
          <span>{req.fecha_solicitada ?? req.fecha_req}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-2 flex-wrap">
        <span className="text-sm font-semibold" style={{ color: '#254A96' }}>{req.sucursal_origen}</span>
        <span className="text-sm" style={{ color: '#B9BBB7' }}>→</span>
        <span className="text-sm font-semibold" style={{ color: '#0f766e' }}>{req.sucursal_destino}</span>
      </div>
      {resumen && (
        <p className="text-xs mt-1.5 leading-tight" style={{ color: '#B9BBB7' }}>{resumen}</p>
      )}
    </div>
  )
}

/* ─── Modal Detalle ─────────────────────────────────── */
function ModalDetalle({ req, rol, guardando, editItems, editNotas, editNViaje, editVehiculo, editFechaRec, editTipoEntrega, camionesRec,
  setEditItems, setEditNotas, setEditNViaje, setEditVehiculo, setEditFechaRec, setEditTipoEntrega, onCambiarEstado, onClose }: any) {

  const siguientes = estadosSiguientes(req.estado, rol)
  const puedeEditar = rol === 'deposito' || rol === 'gerencia'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        style={{ fontFamily: 'Barlow, sans-serif' }}>
        {/* Header */}
        <div className="p-5 border-b flex items-start justify-between gap-3" style={{ borderColor: '#f0f0f0' }}>
          <div>
            <div className="flex items-center gap-2 mb-1">
              <BadgeTipo tipo={req.tipo} />
              <BadgeEstado estado={req.estado} />
            </div>
            <p className="font-semibold text-sm" style={{ color: '#254A96' }}>
              {req.sucursal_origen} → {req.sucursal_destino}
            </p>
            {req.nv && <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>NV {req.nv} {req.cliente ? `· ${req.cliente}` : ''}</p>}
          </div>
          <button onClick={onClose} className="text-lg" style={{ color: '#B9BBB7' }}>×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Fechas */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span style={{ color: '#B9BBB7' }}>Solicitado:</span> <strong>{req.fecha_req}</strong></div>
            <div><span style={{ color: '#B9BBB7' }}>Necesario:</span> <strong>{req.fecha_solicitada ?? '—'}</strong></div>
          </div>

          {/* Productos */}
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: '#254A96' }}>PRODUCTOS</p>
            <div className="space-y-1.5">
              {req.requerimiento_items?.map((item: ReqItem) => (
                <div key={item.id} className="rounded-lg px-3 py-2" style={{ background: '#f9f9f9', border: '1px solid #f0f0f0' }}>
                  <p className="text-sm font-medium">{item.nombre_producto}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>Solicitado: <strong>{item.cantidad_solicitada}</strong></span>
                    {puedeEditar ? (
                      <label className="text-xs flex items-center gap-1.5" style={{ color: '#0f766e' }}>
                        Aprobado:
                        <input type="number" min={0}
                          value={editItems[item.id] ?? item.cantidad_aprobada ?? item.cantidad_solicitada}
                          onChange={e => setEditItems((prev: any) => ({ ...prev, [item.id]: parseInt(e.target.value) || 0 }))}
                          className="w-16 border rounded px-1.5 py-0.5 text-xs focus:outline-none font-bold text-center"
                          style={{ borderColor: '#e8edf8' }} />
                      </label>
                    ) : item.cantidad_aprobada != null ? (
                      <span className="text-xs font-semibold" style={{ color: '#0f766e' }}>Aprobado: {item.cantidad_aprobada}</span>
                    ) : null}
                    {item.cantidad_aprobada != null && item.cantidad_aprobada < item.cantidad_solicitada && (
                      <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#fef3c7', color: '#b45309' }}>Parcial</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Viaje y vehículo (deposito edita) */}
          {puedeEditar && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>N° Viaje (del ERP)</label>
                  <input value={editNViaje} onChange={e => setEditNViaje(e.target.value)}
                    placeholder="ej: 1360"
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Vehículo</label>
                  <input value={editVehiculo} onChange={e => setEditVehiculo(e.target.value)}
                    placeholder="ej: LP142"
                    className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: '#e8edf8' }} />
                </div>
              </div>

              {/* Sugerencias de camiones */}
              {camionesRec.length > 0 && (
                <div className="rounded-lg p-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <p className="text-xs font-semibold mb-2" style={{ color: '#065f46' }}>
                    🚛 Camiones sugeridos para {req.fecha_solicitada}
                  </p>
                  <div className="space-y-1">
                    {camionesRec.map((c: CamionSugerido) => (
                      <button key={c.codigo} onClick={() => setEditVehiculo(c.codigo)}
                        className="w-full text-left rounded px-2 py-1.5 text-xs flex items-center justify-between hover:opacity-80 transition-opacity"
                        style={{ background: c.pedidos_destino > 0 ? '#d1fae5' : '#f4f4f3', color: '#1a1a1a' }}>
                        <span>
                          <strong>{c.codigo}</strong>
                          <span className="ml-1.5" style={{ color: '#666' }}>{c.tipo_unidad}</span>
                        </span>
                        <span style={{ color: c.pedidos_destino > 0 ? '#065f46' : '#B9BBB7' }}>{c.razon}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Recepción */}
              {(req.estado === 'en_transito' || req.estado === 'entregado') && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Fecha recepción</label>
                    <input type="date" value={editFechaRec} onChange={e => setEditFechaRec(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ borderColor: '#e8edf8' }} />
                  </div>
                  <div>
                    <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Tipo entrega</label>
                    <select value={editTipoEntrega} onChange={e => setEditTipoEntrega(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ borderColor: '#e8edf8' }}>
                      <option value="">— seleccionar —</option>
                      {TIPO_ENTREGA_OPTS.map(o => <option key={o} value={o}>{TIPO_ENTREGA_LABEL[o]}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Notas */}
          {puedeEditar && (
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Observaciones</label>
              <textarea value={editNotas} onChange={e => setEditNotas(e.target.value)} rows={2}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
                style={{ borderColor: '#e8edf8' }} />
            </div>
          )}
          {!puedeEditar && req.notas && (
            <p className="text-sm rounded-lg px-3 py-2" style={{ background: '#fef3c7', color: '#b45309' }}>{req.notas}</p>
          )}

          {/* Datos de entrega si ya está resuelto */}
          {(req.n_viaje || req.cod_vehiculo) && !puedeEditar && (
            <div className="grid grid-cols-2 gap-3 text-sm">
              {req.n_viaje && <div><span style={{ color: '#B9BBB7' }}>N° Viaje:</span> <strong>{req.n_viaje}</strong></div>}
              {req.cod_vehiculo && <div><span style={{ color: '#B9BBB7' }}>Vehículo:</span> <strong>{req.cod_vehiculo}</strong></div>}
            </div>
          )}
        </div>

        {/* Footer con acciones */}
        {siguientes.length > 0 && (
          <div className="p-5 border-t flex gap-2 flex-wrap" style={{ borderColor: '#f0f0f0' }}>
            {siguientes.map(sig => (
              <button key={sig} disabled={guardando}
                onClick={() => onCambiarEstado(sig)}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
                style={{ background: sig === 'rechazado' ? '#E52322' : sig === 'entregado' ? '#10b981' : '#254A96' }}>
                {guardando ? '…' : `→ ${ESTADO_LABEL[sig]}`}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Modal Crear ───────────────────────────────────── */
function ModalCrear({ form, items, guardando, stockConsulta, rol, setForm, setItems, onConsultarStock, onBuscarPorCodigo, onCreate, onClose }: any) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col"
        style={{ fontFamily: 'Barlow, sans-serif' }}>
        <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: '#f0f0f0' }}>
          <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>Nuevo requerimiento</h3>
          <button onClick={onClose} style={{ color: '#B9BBB7' }}>×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Tipo */}
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: '#254A96' }}>Tipo</label>
            <div className="flex gap-2">
              {(['abastecimiento', 'movimiento', 'pedido'] as const).map(t => (
                <button key={t} onClick={() => setForm((f: any) => ({ ...f, tipo: t }))}
                  className="flex-1 py-2 rounded-lg text-xs font-medium transition-colors"
                  style={{
                    background: form.tipo === t ? '#0f766e' : '#f4f4f3',
                    color: form.tipo === t ? 'white' : '#666',
                  }}>
                  {t === 'abastecimiento' ? 'Abastecimiento' : t === 'movimiento' ? 'Movimiento' : 'Pedido cliente'}
                </button>
              ))}
            </div>
          </div>
          {/* Origen / Destino */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Desde (origen)</label>
              <select value={form.sucursal_origen} onChange={e => setForm((f: any) => ({ ...f, sucursal_origen: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Hacia (destino)</label>
              <select value={form.sucursal_destino} onChange={e => setForm((f: any) => ({ ...f, sucursal_destino: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }}>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          {/* NV y cliente (si tipo pedido) */}
          {form.tipo === 'pedido' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>NV / Solicitud</label>
                <input value={form.nv} onChange={e => setForm((f: any) => ({ ...f, nv: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Cliente</label>
                <input value={form.cliente} onChange={e => setForm((f: any) => ({ ...f, cliente: e.target.value }))}
                  className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
              </div>
            </div>
          )}
          {/* Fecha necesaria */}
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Fecha en que se necesita en destino</label>
            <input type="date" value={form.fecha_solicitada} onChange={e => setForm((f: any) => ({ ...f, fecha_solicitada: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none" style={{ borderColor: '#e8edf8' }} />
          </div>
          {/* Productos */}
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: '#254A96' }}>PRODUCTOS A TRANSFERIR</p>
            <div className="space-y-3">
              {items.map((item: any, idx: number) => (
                <div key={idx} className="rounded-lg p-3 space-y-2" style={{ background: '#f9f9f9', border: '1px solid #f0f0f0' }}>

                  {/* Fila 1: código + nombre + cantidad + quitar */}
                  <div className="flex gap-2 items-start">
                    {/* Input código */}
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs" style={{ color: '#B9BBB7' }}>Código</span>
                      <input
                        value={item._codigo ?? ''}
                        onChange={e => {
                          const upd = [...items]
                          upd[idx] = { ...upd[idx], _codigo: e.target.value, _encontrado: false, _noEncontrado: false }
                          setItems(upd)
                        }}
                        onBlur={e => onBuscarPorCodigo(e.target.value, idx)}
                        placeholder="ej: 1234"
                        className="w-20 border rounded px-2 py-1.5 text-xs text-center focus:outline-none"
                        style={{ borderColor: item._encontrado ? '#bbf7d0' : item._noEncontrado ? '#fca5a5' : '#e8edf8' }} />
                    </div>

                    {/* Nombre (auto-fill o manual) */}
                    <div className="flex flex-col gap-0.5 flex-1">
                      <span className="text-xs flex items-center gap-1" style={{ color: '#B9BBB7' }}>
                        Producto
                        {item._encontrado && <span className="text-xs px-1 rounded" style={{ background: '#d1fae5', color: '#065f46' }}>✓ maestro</span>}
                        {item._noEncontrado && <span className="text-xs px-1 rounded" style={{ background: '#fef3c7', color: '#b45309' }}>manual</span>}
                      </span>
                      <input
                        value={item.nombre_producto}
                        readOnly={item._encontrado}
                        onChange={e => {
                          const upd = [...items]; upd[idx] = { ...upd[idx], nombre_producto: e.target.value }; setItems(upd)
                        }}
                        onBlur={e => !item._encontrado && onConsultarStock(e.target.value, idx)}
                        placeholder={item._noEncontrado ? 'Ingresá el nombre del producto' : 'Nombre o buscá por código'}
                        className="flex-1 border rounded px-2.5 py-1.5 text-xs focus:outline-none"
                        style={{
                          borderColor: '#e8edf8',
                          background: item._encontrado ? '#f0fdf4' : 'white',
                          color: '#1a1a1a',
                        }} />
                    </div>

                    {/* Cantidad */}
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs" style={{ color: '#B9BBB7' }}>Cant.</span>
                      <input type="number" min={1}
                        value={item.cantidad_solicitada}
                        onChange={e => {
                          const upd = [...items]; upd[idx] = { ...upd[idx], cantidad_solicitada: parseInt(e.target.value) || 1 }; setItems(upd)
                        }}
                        className="w-16 border rounded px-2 py-1.5 text-xs text-center focus:outline-none"
                        style={{ borderColor: '#e8edf8' }} />
                    </div>

                    {/* Quitar */}
                    {items.length > 1 && (
                      <button onClick={() => setItems(items.filter((_: any, i: number) => i !== idx))}
                        className="text-xs px-2 py-1.5 rounded mt-4" style={{ color: '#E52322', background: '#fde8e8' }}>✕</button>
                    )}
                  </div>

                  {/* Mensaje si código no encontrado */}
                  {item._noEncontrado && !item.nombre_producto && (
                    <p className="text-xs" style={{ color: '#b45309' }}>
                      ⚠ Código no encontrado en el maestro de stock — ingresá el nombre manualmente y se guardará igual.
                    </p>
                  )}

                  {/* Stock disponible por sucursal */}
                  {stockConsulta[idx]?.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap">
                      {stockConsulta[idx].map((s: any) => (
                        <span key={s.sucursal} className="text-xs px-1.5 py-0.5 rounded"
                          style={{ background: s.cantidad > 0 ? '#d1fae5' : '#fde8e8', color: s.cantidad > 0 ? '#065f46' : '#E52322' }}>
                          {s.sucursal}: {s.cantidad}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              <button onClick={() => setItems([...items, { nombre_producto: '', cantidad_solicitada: 1, id_producto: null, _codigo: '', _encontrado: false, _noEncontrado: false }])}
                className="w-full py-2 text-xs rounded-lg border-dashed border"
                style={{ borderColor: '#e8edf8', color: '#B9BBB7' }}>
                + Agregar producto
              </button>
            </div>
          </div>
          {/* Notas */}
          <div>
            <label className="text-xs font-medium block mb-1" style={{ color: '#254A96' }}>Observaciones</label>
            <textarea value={form.notas} onChange={e => setForm((f: any) => ({ ...f, notas: e.target.value }))} rows={2}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ borderColor: '#e8edf8' }} />
          </div>
        </div>
        <div className="p-5 border-t flex gap-2" style={{ borderColor: '#f0f0f0' }}>
          <button disabled={guardando} onClick={onCreate}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-40"
            style={{ background: '#0f766e' }}>
            {guardando ? 'Guardando…' : 'Crear requerimiento'}
          </button>
          <button onClick={onClose}
            className="px-5 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: '#f4f4f3', color: '#666' }}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}

/* ─── Tab Importar ──────────────────────────────────── */
function TabImportar({ ultimoStock, importandoStock, importandoSolicitudes, resultImport, solicitudesNoCargadas,
  fileStockRef, fileSolicRef, onImportarStock, onImportarSolicitudes }: any) {

  const fmtDate = (iso: string | null) => {
    if (!iso) return 'Nunca'
    const d = new Date(iso)
    return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* Stock */}
      <div className="bg-white rounded-xl p-5 border" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>📦 Stock por sucursal</h3>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
              Último import: {fmtDate(ultimoStock)}
            </p>
          </div>
          <button onClick={() => fileStockRef.current?.click()}
            disabled={importandoStock}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
            style={{ background: '#0f766e' }}>
            {importandoStock ? 'Importando…' : 'Importar Excel'}
          </button>
          <input ref={fileStockRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onImportarStock} />
        </div>
        <p className="text-xs" style={{ color: '#B9BBB7' }}>
          Exportá el Excel de stock del sistema ERP (hoja "Stock de Productos") y subilo acá.
          Se reemplaza el snapshot anterior. El stock importado se usa para sugerir desde qué sucursal transferir.
        </p>
      </div>

      {/* Solicitudes */}
      <div className="bg-white rounded-xl p-5 border" style={{ borderColor: '#f0f0f0' }}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm" style={{ color: '#254A96' }}>📋 Solicitudes de despacho</h3>
            <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
              Para detectar pedidos no cargados por vendedores
            </p>
          </div>
          <button onClick={() => fileSolicRef.current?.click()}
            disabled={importandoSolicitudes}
            className="px-4 py-2 text-sm font-medium rounded-lg text-white disabled:opacity-40"
            style={{ background: '#254A96' }}>
            {importandoSolicitudes ? 'Procesando…' : 'Importar Excel'}
          </button>
          <input ref={fileSolicRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onImportarSolicitudes} />
        </div>
        <p className="text-xs" style={{ color: '#B9BBB7' }}>
          Exportá el Excel de solicitudes del sistema (con hojas "Solicitudes de Despacho" e "items_solicitudes").
          El sistema cruzará con los pedidos ya cargados en la app y mostrará cuáles faltan.
        </p>

        {/* Resultado del import */}
        {resultImport && (
          <div className="mt-4 rounded-lg p-3" style={{ background: '#f4f4f3' }}>
            <div className="flex gap-4 text-sm flex-wrap">
              <span><strong>{resultImport.total}</strong> <span style={{ color: '#666' }}>total</span></span>
              <span style={{ color: '#10b981' }}><strong>{resultImport.cargados_en_app}</strong> en app</span>
              <span style={{ color: '#E52322' }}><strong>{resultImport.no_cargados}</strong> sin cargar</span>
            </div>
          </div>
        )}
      </div>

      {/* Lista de solicitudes sin cargar */}
      {solicitudesNoCargadas.length > 0 && (
        <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: '#f0f0f0' }}>
          <div className="px-5 py-3 border-b flex items-center justify-between" style={{ borderColor: '#f0f0f0' }}>
            <h4 className="font-semibold text-sm" style={{ color: '#E52322' }}>
              ⚠ {solicitudesNoCargadas.length} solicitudes sin cargar en la app
            </h4>
          </div>
          <div className="divide-y overflow-y-auto max-h-80" style={{ borderColor: '#f0f0f0' }}>
            {solicitudesNoCargadas.map((s: any) => (
              <div key={s.id} className="px-5 py-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{s.cliente || 'Sin nombre'}</p>
                  <p className="text-xs" style={{ color: '#B9BBB7' }}>
                    {s.fecha_despacho} · {s.sucursal} · NV {s.id_venta}
                  </p>
                </div>
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: '#fde8e8', color: '#E52322' }}>Sin cargar</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
