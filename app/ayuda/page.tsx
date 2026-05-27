'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/app/supabase'

type RolKey = 'gerencia' | 'admin_flota' | 'ruteador' | 'deposito' | 'comercial' | 'confirmador' | 'chofer'

const ROL_LABEL: Record<RolKey, string> = {
  gerencia: 'Gerencia', admin_flota: 'Admin de Flota', ruteador: 'Ruteador',
  deposito: 'Depósito', comercial: 'Comercial', confirmador: 'Confirmador', chofer: 'Chofer',
}
const ROL_COLOR: Record<RolKey, string> = {
  gerencia: '#7c3aed', admin_flota: '#d97706', ruteador: '#254A96',
  deposito: '#0f766e', comercial: '#065f46', confirmador: '#0891b2', chofer: '#666',
}
const ROL_BG: Record<RolKey, string> = {
  gerencia: '#ede9fe', admin_flota: '#fef3c7', ruteador: '#e8edf8',
  deposito: '#ccfbf1', comercial: '#d1fae5', confirmador: '#e0f2fe', chofer: '#f4f4f3',
}

// ─── Pasos por rol ────────────────────────────────────────
interface Paso { icono: string; titulo: string; desc: string; tips?: string[] }

const PASOS: Record<RolKey, Paso[]> = {
  comercial: [
    { icono: '📦', titulo: 'Ir a "Nueva solicitud"', desc: 'Desde el dashboard hacé clic en el módulo "Nueva solicitud".', tips: ['Solo podés ver y gestionar tus propios pedidos.'] },
    { icono: '✏️', titulo: 'Completar los datos del pedido', desc: 'Ingresá: cliente, número de venta (NV), sucursal, dirección, fecha de entrega deseada y los productos con sus cantidades.', tips: ['El NV es el número de venta del sistema ERP.', 'Podés buscar la dirección en el mapa o ingresarla manualmente.'] },
    { icono: '💾', titulo: 'Guardar el pedido', desc: 'El pedido queda en estado "Pendiente". El ruteador lo va a revisar y programar para una fecha de entrega.', tips: ['Vas a poder ver el estado en Dashboard → "Mis pedidos".'] },
    { icono: '👁️', titulo: 'Seguir el estado', desc: 'Desde el Dashboard podés ver si tu pedido está Pendiente, Programado, En camino o Entregado.', tips: ['Si necesitás reprogramar, usá el botón "Reprog." en Mis pedidos.', 'Para cancelar, usá el botón "Cancelar" (solo si está Pendiente o Programado).'] },
  ],
  confirmador: [
    { icono: '📞', titulo: 'Ir a "Confirmaciones"', desc: 'El sistema te va a abrir automáticamente la pantalla de confirmaciones al iniciar sesión.', tips: ['Aparecen solo los pedidos programados para hoy.'] },
    { icono: '📋', titulo: 'Ver los pedidos del día', desc: 'Ves la lista de clientes con sus pedidos programados, horario estimado de entrega y datos de contacto.', tips: ['Los pedidos están ordenados por vuelta y orden de entrega.'] },
    { icono: '☎️', titulo: 'Llamar al cliente', desc: 'Contactá a cada cliente para confirmar que va a estar disponible en el horario de entrega.', tips: ['Si el cliente no atiende, dejá nota en observaciones.'] },
    { icono: '✅', titulo: 'Confirmar o reprogramar', desc: 'Marcá el pedido como "Confirmado" si el cliente acepta, o coordiná un nuevo horario/fecha con el ruteador.', tips: ['Las confirmaciones se reflejan en tiempo real para el ruteador.'] },
  ],
  chofer: [
    { icono: '📱', titulo: 'Abrir la app en el celular', desc: 'Iniciá sesión con tu usuario. La app te lleva directo a tu ruteo del día.', tips: ['Si no te aparece nada, significa que todavía no te asignaron pedidos para hoy.'] },
    { icono: '🗺️', titulo: 'Ver tu recorrido', desc: 'Ves todos los pedidos asignados a tu camión, en el orden de entrega establecido, con dirección, cliente y observaciones.', tips: ['El orden está optimizado por el ruteador — respetalo salvo fuerza mayor.'] },
    { icono: '🚚', titulo: 'Salir a entregar', desc: 'A medida que entregás, el estado de los pedidos se va actualizando. El ruteador ve el progreso en tiempo real.', tips: ['Si hay un problema con una entrega, avisá al ruteador.'] },
    { icono: '🏠', titulo: 'Fin del día', desc: 'Cuando terminás tu recorrido, el ruteador registra los pedidos no entregados para reprogramarlos.', tips: [] },
  ],
  admin_flota: [
    { icono: '⚙️', titulo: 'Configurar la flota base (una sola vez)', desc: 'En "Flota base" cargá todos los camiones con su código, tipo, capacidad de carga (posiciones y peso), y los choferes habituales.', tips: ['Solo hay que hacerlo una vez. Después solo actualizás si cambia algo.', 'El peso máximo y las posiciones son clave para que el ruteador no sobrecargue.'] },
    { icono: '🚛', titulo: 'Configurar la flota del día (cada mañana)', desc: 'En "Flota del día" activá los camiones que salen ese día y asigná el chofer a cada uno.', tips: ['Hacelo antes de las 8 AM para que el ruteador pueda empezar a programar.', 'Podés clonar la configuración de un día anterior.'] },
    { icono: '👥', titulo: 'Asignar choferes', desc: 'Para cada camión activo, confirmá qué chofer lo maneja ese día. Si hay un reemplazante, actualizalo acá.', tips: ['Los choferes ven su recorrido en la app al iniciar sesión.'] },
    { icono: '🗺️', titulo: 'Monitorear en Ruteo', desc: 'Durante el día podés ver en "Ruteo" el estado de cada camión, sus entregas completadas y pendientes.', tips: ['Las métricas de ocupación de flota se pueden ver en el módulo "Métricas".'] },
  ],
  ruteador: [
    { icono: '📅', titulo: 'Revisar la flota del día', desc: 'Antes de programar, verificá en "Flota del día" que admin_flota ya configuró los camiones y choferes disponibles.', tips: ['Sin flota configurada no podés asignar pedidos.'] },
    { icono: '📋', titulo: 'Ir a Programación', desc: 'Elegí la fecha y la sucursal. Ves todos los pedidos pendientes a la izquierda y los camiones disponibles a la derecha.', tips: ['Filtrá por sucursal para no mezclar pedidos de distintas bases.'] },
    { icono: '➕', titulo: 'Asignar pedidos a camiones', desc: 'Arrastrá pedidos a los camiones o usá el botón de asignación. Respetá la capacidad de peso y posiciones de cada camión.', tips: ['El sistema te avisa si superás la capacidad.', 'Podés usar "Separar pedido" para dividir una entrega grande en dos camiones.', 'Usá "Stock" para verificar disponibilidad antes de asignar.'] },
    { icono: '🔢', titulo: 'Definir el orden de entrega', desc: 'Dentro de cada camión, ordená las entregas por cercanía o eficiencia de recorrido.', tips: ['La vuelta 1 sale primero, vuelta 2 después del regreso al depósito.'] },
    { icono: '✅', titulo: 'Confirmar programación', desc: 'Los pedidos pasan a estado "Programado". Los confirmadores pueden empezar a llamar a los clientes.', tips: [] },
    { icono: '🌙', titulo: 'Fin del día', desc: 'Al cierre, usá "Fin del día" para ver los pedidos no entregados y reprogramarlos para la fecha siguiente.', tips: ['Podés reprogramar en masa o uno por uno.'] },
    { icono: '🏭', titulo: 'Gestionar transferencias', desc: 'En "Abastecimiento" ves los requerimientos de transferencia entre sucursales. Podés sugerir camiones que ya van a esa sucursal.', tips: ['El ruteador no cambia el estado de los requerimientos — solo los revisa y asigna camión.'] },
  ],
  deposito: [
    { icono: '📥', titulo: 'Ver requerimientos pendientes', desc: 'En "Abastecimiento" → tab "Pendientes" aparecen todos los pedidos de transferencia que necesitan atención.', tips: ['Un requerimiento puede ser de tipo Pedido, Abastecimiento o Movimiento.'] },
    { icono: '🔍', titulo: 'Verificar el stock disponible', desc: 'Abrí cada requerimiento y revisá si tenés en origen los productos solicitados en las cantidades pedidas.', tips: ['Podés importar el stock actualizado del ERP en el tab "Importar".', 'Si hay stock parcial, podés aprobar una cantidad menor en cada ítem.'] },
    { icono: '✅', titulo: 'Confirmar o rechazar stock', desc: 'Si hay stock: cambiá el estado a "Conf. Stock". Si no hay: cambiá a "Rechazado" con una nota explicando el motivo.', tips: [] },
    { icono: '📦', titulo: 'Preparar la mercadería', desc: 'Juntá los productos. Cambiá el estado a "En preparación". Cargá el N° de viaje del ERP (N° TRANS).', tips: [] },
    { icono: '🚛', titulo: 'Asignar camión y despachar', desc: 'Ingresá el código del vehículo. El sistema te sugiere camiones que ya van hacia la sucursal destino. Cambiá a "En tránsito".', tips: ['La sugerencia de camión se basa en la programación del día.'] },
    { icono: '📬', titulo: 'Registrar la recepción', desc: 'Cuando el depósito destino confirma que recibió, cambiá el estado a "Entregado" con la fecha de recepción y el tipo de entrega.', tips: [] },
    { icono: '📊', titulo: 'Historial y seguimiento', desc: 'En el tab "Historial" podés ver todas las transferencias pasadas, filtrar por sucursal y fechas.', tips: [] },
  ],
  gerencia: [
    { icono: '👁️', titulo: 'Acceso completo', desc: 'Tenés acceso a todos los módulos del sistema. Podés operar como cualquier otro rol.', tips: [] },
    { icono: '👥', titulo: 'Gestión de usuarios', desc: 'En "Usuarios" podés crear, editar y desactivar usuarios, y asignarles roles.', tips: ['Cada rol tiene acceso solo a los módulos que necesita.'] },
    { icono: '📊', titulo: 'Métricas', desc: 'En "Métricas" ves la ocupación de la flota, tiempos promedio de entrega y estadísticas operativas.', tips: [] },
    { icono: '📥', titulo: 'Carga masiva', desc: 'En "Carga masiva" podés importar múltiples pedidos desde un PDF del ERP de una sola vez.', tips: ['Útil para cargar el lote completo del día de un sistema externo.'] },
    { icono: '🏭', titulo: 'Supervisar abastecimiento', desc: 'En "Abastecimiento" tenés visibilidad completa de todas las transferencias entre sucursales.', tips: [] },
  ],
}

// ─── Diagrama de flujo vertical ───────────────────────────
type NodeType = 'action' | 'state' | 'start' | 'end' | 'decision'

interface VNode {
  type: NodeType
  label: string
  sub?: string
  rol?: RolKey
}
interface VDecision extends VNode {
  type: 'decision'
  yesLabel: string
  noLabel: string
  yesBranch: VStep[]
  noBranch: VStep[]
}
type VStep = VNode | VDecision

function isDecision(s: VStep): s is VDecision { return s.type === 'decision' }

const NODE_STYLE: Record<NodeType, { bg: string; border: string; text: string; shape?: string }> = {
  action:   { bg: '#ffffff', border: '#d1d5db', text: '#1a1a1a' },
  state:    { bg: '#e8edf8', border: '#254A96', text: '#254A96' },
  start:    { bg: '#ede9fe', border: '#7c3aed', text: '#7c3aed' },
  end:      { bg: '#d1fae5', border: '#059669', text: '#065f46' },
  decision: { bg: '#fef3c7', border: '#f59e0b', text: '#92400e' },
}

function RolBadge({ rol }: { rol: RolKey }) {
  return (
    <span className="inline-block text-xs px-2 py-0.5 rounded-full font-semibold mt-1"
      style={{ background: ROL_BG[rol], color: ROL_COLOR[rol] }}>
      {ROL_LABEL[rol]}
    </span>
  )
}

function Arrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center" style={{ minHeight: 28 }}>
      {label && <span className="text-xs font-semibold mb-0.5" style={{ color: '#888' }}>{label}</span>}
      <div style={{ width: 2, flex: 1, minHeight: 12, background: '#cbd5e1' }} />
      <div style={{ width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '8px solid #cbd5e1' }} />
    </div>
  )
}

function FlowNode({ step }: { step: VStep }) {
  const s = NODE_STYLE[step.type]
  const isState = step.type === 'state'
  const isEnd = step.type === 'end' || step.type === 'start'
  return (
    <div
      className="flex flex-col items-center px-5 py-3 text-center"
      style={{
        background: s.bg,
        border: `2px solid ${s.border}`,
        borderRadius: isEnd ? 999 : isState ? 8 : 12,
        minWidth: isState || isEnd ? 160 : 220,
        maxWidth: 300,
        boxShadow: step.type === 'action' ? '0 1px 4px rgba(0,0,0,0.07)' : 'none',
      }}>
      {step.type === 'decision' && (
        <span className="text-xs font-bold uppercase tracking-wide mb-0.5" style={{ color: '#d97706' }}>⬡ Decisión</span>
      )}
      <span className="font-semibold text-sm leading-tight" style={{ color: s.text }}>{step.label}</span>
      {step.sub && <span className="text-xs mt-0.5 leading-tight" style={{ color: '#888' }}>{step.sub}</span>}
      {step.rol && <RolBadge rol={step.rol} />}
    </div>
  )
}

function VerticalFlow({ steps }: { steps: VStep[] }) {
  return (
    <div className="flex flex-col items-center w-full gap-0">
      {steps.map((step, i) => (
        <div key={i} className="flex flex-col items-center w-full">
          {isDecision(step) ? (
            <>
              <FlowNode step={step} />
              <div className="flex w-full mt-0" style={{ gap: 0 }}>
                {/* Rama Sí */}
                <div className="flex-1 flex flex-col items-center pt-0"
                  style={{ borderRight: '1px dashed #cbd5e1' }}>
                  <Arrow label={step.yesLabel} />
                  <VerticalFlow steps={step.yesBranch} />
                </div>
                {/* Rama No */}
                <div className="flex-1 flex flex-col items-center pt-0"
                  style={{ borderLeft: '1px dashed #cbd5e1' }}>
                  <Arrow label={step.noLabel} />
                  <VerticalFlow steps={step.noBranch} />
                </div>
              </div>
            </>
          ) : (
            <>
              <FlowNode step={step} />
              {i < steps.length - 1 && <Arrow />}
            </>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Definición de los 3 diagramas ────────────────────────
interface DiagramDef {
  titulo: string
  desc: string
  rolesVisibles: RolKey[]
  steps: VStep[]
}

const DIAGRAMAS: DiagramDef[] = [
  {
    titulo: 'Ciclo completo de un pedido',
    desc: 'Desde que el comercial carga un pedido hasta que se entrega al cliente.',
    rolesVisibles: ['gerencia', 'ruteador', 'comercial', 'confirmador', 'chofer', 'admin_flota'],
    steps: [
      { type: 'action',   label: 'Comercial carga el pedido',        sub: 'Nueva solicitud',     rol: 'comercial' },
      { type: 'state',    label: 'PENDIENTE' },
      { type: 'action',   label: 'Admin configura flota del día',    sub: 'Flota del día',        rol: 'admin_flota' },
      { type: 'action',   label: 'Ruteador asigna pedidos',          sub: 'Programación',         rol: 'ruteador' },
      { type: 'state',    label: 'PROGRAMADO' },
      { type: 'action',   label: 'Confirmador llama al cliente',     sub: 'Confirmaciones',       rol: 'confirmador' },
      { type: 'action',   label: 'Chofer sale a entregar',           sub: 'En camino',            rol: 'chofer' },
      {
        type: 'decision', label: '¿Se pudo entregar?', sub: '', rol: undefined,
        yesLabel: 'Sí ✓', noLabel: 'No ✗',
        yesBranch: [
          { type: 'end', label: 'ENTREGADO ✓', sub: 'Proceso finalizado' },
        ],
        noBranch: [
          { type: 'action', label: 'Ruteador reprograma',  sub: 'Fin del día',  rol: 'ruteador' },
          { type: 'state',  label: 'PENDIENTE', sub: 'Nueva fecha asignada' },
        ],
      } as VDecision,
    ],
  },
  {
    titulo: 'Transferencia entre sucursales',
    desc: 'Proceso completo desde que se detecta una necesidad de stock hasta que se recibe en destino.',
    rolesVisibles: ['gerencia', 'ruteador', 'deposito'],
    steps: [
      { type: 'start',    label: 'Se detecta necesidad de stock',    sub: 'Solicitud de cliente o falta de mercadería' },
      { type: 'action',   label: 'Depósito crea requerimiento',      sub: 'Módulo Abastecimiento',  rol: 'deposito' },
      { type: 'state',    label: 'PENDIENTE' },
      { type: 'action',   label: 'Depósito verifica stock en origen', sub: 'Cantidad disponible',  rol: 'deposito' },
      {
        type: 'decision', label: '¿Hay stock disponible?', sub: '', rol: undefined,
        yesLabel: 'Sí ✓', noLabel: 'No ✗',
        yesBranch: [
          { type: 'state',  label: 'CONF. STOCK' },
          { type: 'action', label: 'Preparar mercadería', sub: 'N° TRANS del ERP',     rol: 'deposito' },
          { type: 'state',  label: 'EN PREPARACIÓN' },
          { type: 'action', label: 'Ruteador asigna camión', sub: 'Sugerencia automática', rol: 'ruteador' },
          { type: 'state',  label: 'EN TRÁNSITO' },
          { type: 'action', label: 'Destino confirma recepción', sub: 'Fecha + tipo de entrega', rol: 'deposito' },
          { type: 'end',    label: 'ENTREGADO ✓', sub: 'Transferencia completada' },
        ],
        noBranch: [
          { type: 'end',    label: 'RECHAZADO ✗', sub: 'Se notifica al solicitante' },
        ],
      } as VDecision,
    ],
  },
  {
    titulo: 'Gestión de flota diaria',
    desc: 'Configuración y monitoreo de la flota desde la mañana hasta el cierre del día.',
    rolesVisibles: ['gerencia', 'ruteador', 'admin_flota', 'chofer'],
    steps: [
      { type: 'start',  label: 'Inicio del día operativo' },
      { type: 'action', label: 'Admin activa flota del día',         sub: 'Camiones disponibles',     rol: 'admin_flota' },
      { type: 'action', label: 'Admin asigna choferes',              sub: 'Flota del día',            rol: 'admin_flota' },
      { type: 'action', label: 'Ruteador programa y ordena pedidos', sub: 'Programación',             rol: 'ruteador' },
      { type: 'state',  label: 'PEDIDOS PROGRAMADOS' },
      { type: 'action', label: 'Choferes ven su recorrido y salen', sub: 'App Ruteo',                 rol: 'chofer' },
      { type: 'state',  label: 'ENTREGAS EN CURSO' },
      { type: 'action', label: 'Admin y Ruteador monitorean',        sub: 'Ruteo / Métricas',         rol: 'admin_flota' },
      { type: 'action', label: 'Ruteador cierra el día',             sub: 'Fin del día — reprograma no entregados', rol: 'ruteador' },
      { type: 'end',    label: 'DÍA CERRADO ✓' },
    ],
  },
]

// ─── Componente PasoCard ──────────────────────────────────
function PasoCard({ paso, num }: { paso: Paso; num: number }) {
  const [abierto, setAbierto] = useState(false)
  return (
    <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: '#f0f0f0' }}>
      <button className="w-full flex items-center gap-4 p-4 text-left" onClick={() => setAbierto(v => !v)}>
        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0 text-white"
          style={{ background: '#254A96' }}>{num}</div>
        <span className="text-xl shrink-0">{paso.icono}</span>
        <span className="font-semibold text-sm flex-1" style={{ color: '#1a1a1a' }}>{paso.titulo}</span>
        <span className="text-lg shrink-0" style={{ color: '#B9BBB7' }}>{abierto ? '↑' : '↓'}</span>
      </button>
      {abierto && (
        <div className="px-4 pb-4 space-y-2 border-t" style={{ borderColor: '#f4f4f3' }}>
          <p className="text-sm mt-3" style={{ color: '#444' }}>{paso.desc}</p>
          {paso.tips && paso.tips.length > 0 && (
            <ul className="space-y-1 mt-2">
              {paso.tips.map((tip, i) => (
                <li key={i} className="text-xs flex gap-2" style={{ color: '#666' }}>
                  <span className="shrink-0" style={{ color: '#254A96' }}>💡</span>{tip}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Página principal ─────────────────────────────────────
export default function AyudaPage() {
  const router = useRouter()
  const [rol, setRol] = useState<RolKey | null>(null)
  const [rolVista, setRolVista] = useState<RolKey | null>(null)
  const [tab, setTab] = useState<'pasos' | 'diagramas'>('pasos')

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      const r = (data?.rol ?? 'comercial') as RolKey
      setRol(r); setRolVista(r)
    })
  }, [])

  if (!rol || !rolVista) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  const esGerencia = rol === 'gerencia'
  const pasos = PASOS[rolVista] ?? []
  const diagramas = DIAGRAMAS.filter(d => d.rolesVisibles.includes(rolVista))

  return (
    <div className="min-h-screen" style={{ fontFamily: 'Barlow, sans-serif', background: '#f4f4f3' }}>

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/dashboard"
              className="text-sm font-medium px-3 py-1.5 rounded-lg"
              style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</Link>
            <img src="/logo.png" alt="" className="h-7 w-auto rounded-lg hidden sm:block" />
            <span className="font-semibold text-sm hidden sm:block" style={{ color: '#254A96' }}>Manual de uso</span>
          </div>
          <RolBadge rol={rolVista} />
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* Header */}
        <div className="bg-white rounded-2xl p-6 border" style={{ borderColor: '#f0f0f0' }}>
          <h1 className="text-xl font-bold mb-1" style={{ color: '#254A96' }}>
            📖 Manual de uso — {ROL_LABEL[rolVista]}
          </h1>
          <p className="text-sm" style={{ color: '#B9BBB7' }}>
            Guía paso a paso y diagramas del proceso completo, adaptados a tu rol.
          </p>
          {esGerencia && (
            <div className="mt-4">
              <p className="text-xs font-semibold mb-2" style={{ color: '#B9BBB7' }}>VER MANUAL COMO:</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(ROL_LABEL) as RolKey[]).map(r => (
                  <button key={r} onClick={() => setRolVista(r)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                    style={{ background: rolVista === r ? ROL_COLOR[r] : ROL_BG[r], color: rolVista === r ? 'white' : ROL_COLOR[r] }}>
                    {ROL_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-2">
          {([['pasos', '📋 Paso a paso'], ['diagramas', '🔀 Diagramas de flujo']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className="px-4 py-2 rounded-xl text-sm font-semibold"
              style={{ background: tab === k ? '#254A96' : 'white', color: tab === k ? 'white' : '#666', border: tab === k ? 'none' : '1px solid #f0f0f0' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Paso a paso */}
        {tab === 'pasos' && (
          <div className="max-w-2xl space-y-3">
            <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#B9BBB7' }}>
              {pasos.length} pasos — {ROL_LABEL[rolVista]}
            </p>
            {pasos.map((paso, i) => <PasoCard key={i} paso={paso} num={i + 1} />)}
            <div className="rounded-xl p-4 border" style={{ background: '#f0fdf4', borderColor: '#bbf7d0' }}>
              <p className="text-xs font-semibold mb-1" style={{ color: '#065f46' }}>💡 Consejo general</p>
              <p className="text-sm" style={{ color: '#065f46' }}>
                Si algo no funciona o no encontrás una opción, revisá que tu usuario tenga el rol correcto.
                Contactá a un usuario de Gerencia para cambiar permisos.
              </p>
            </div>
          </div>
        )}

        {/* Diagramas */}
        {tab === 'diagramas' && (
          <div className={`grid gap-6 ${diagramas.length >= 2 ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 max-w-2xl'}`}>
            {diagramas.length === 0 && (
              <div className="bg-white rounded-xl p-8 text-center border" style={{ borderColor: '#f0f0f0' }}>
                <p className="text-4xl mb-3">🔀</p>
                <p className="text-sm" style={{ color: '#B9BBB7' }}>No hay diagramas disponibles para este rol.</p>
              </div>
            )}
            {diagramas.map((d, i) => (
              <div key={i} className="bg-white rounded-2xl p-6 border flex flex-col" style={{ borderColor: '#f0f0f0' }}>
                <h3 className="font-bold text-sm mb-0.5" style={{ color: '#254A96' }}>🔀 {d.titulo}</h3>
                <p className="text-xs mb-5" style={{ color: '#B9BBB7' }}>{d.desc}</p>
                <VerticalFlow steps={d.steps} />

                {/* Leyenda */}
                <div className="flex flex-wrap gap-3 mt-5 pt-4 border-t" style={{ borderColor: '#f4f4f3' }}>
                  {([
                    ['action',   'Acción',            '#f9f9f9', '#d1d5db'],
                    ['state',    'Estado del sistema', '#e8edf8', '#254A96'],
                    ['decision', 'Decisión',           '#fef3c7', '#f59e0b'],
                    ['end',      'Resultado final',    '#d1fae5', '#059669'],
                  ] as const).map(([, label, bg, border]) => (
                    <div key={label} className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm" style={{ background: bg, border: `1.5px solid ${border}` }} />
                      <span className="text-xs" style={{ color: '#888' }}>{label}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
