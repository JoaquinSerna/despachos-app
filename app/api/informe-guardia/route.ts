import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function toMinutes(hora: string): number {
  const [h, m] = hora.split(':').map(Number)
  return h * 60 + m
}

function getTimeInfo(ev: any): { minutes: number; display: string } | null {
  if (ev.hora_evento) {
    const mins = toMinutes(ev.hora_evento)
    return { minutes: mins, display: ev.hora_evento.slice(0, 5) }
  }
  if (ev.created_at) {
    const d = new Date(ev.created_at)
    const localH = (d.getUTCHours() - 3 + 24) % 24
    const localM = d.getUTCMinutes()
    const mins = localH * 60 + localM
    const display = `${String(localH).padStart(2, '0')}:${String(localM).padStart(2, '0')}`
    return { minutes: mins, display }
  }
  return null
}

function median(arr: number[]): number {
  if (!arr.length) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function avg(arr: number[]): number {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function round1(n: number) { return Math.round(n * 10) / 10 }

function buildCiclos(eventos: any[]) {
  const byFechaCamion: Record<string, any[]> = {}
  for (const ev of eventos) {
    if (!ev.camion_codigo) continue
    const ti = getTimeInfo(ev)
    if (!ti) continue
    ev._ti = ti
    const key = `${ev.fecha}__${ev.camion_codigo}`
    if (!byFechaCamion[key]) byFechaCamion[key] = []
    byFechaCamion[key].push(ev)
  }

  const ciclos: any[] = []

  for (const [key, evs] of Object.entries(byFechaCamion)) {
    const [fecha, camion] = key.split('__')
    const ingresos = evs
      .filter(e => e.tipo === 'ingreso')
      .sort((a, b) => a._ti.minutes - b._ti.minutes)
    const salidas = evs
      .filter(e => e.tipo === 'salida')
      .sort((a, b) => a._ti.minutes - b._ti.minutes)

    const usados = new Set<number>()

    for (const sal of salidas) {
      const salMin = sal._ti.minutes
      const candidatos = ingresos
        .map((ing, idx) => ({ ing, idx }))
        .filter(({ idx }) => !usados.has(idx))
        .filter(({ ing }) => ing._ti.minutes < salMin)

      if (!candidatos.length) continue
      const { ing, idx } = candidatos[candidatos.length - 1]
      usados.add(idx)

      const duracion = salMin - ing._ti.minutes

      let excluido = false
      let motivo_exclusion: string | null = null

      if (sal.deposito_destino) {
        excluido = true
        motivo_exclusion = `Transferencia saliente a ${sal.deposito_destino}`
      } else if (ing.deposito_desde) {
        excluido = true
        motivo_exclusion = `Transferencia entrante de ${ing.deposito_desde}`
      } else if (duracion > 120) {
        excluido = true
        motivo_exclusion = `Ciclo atípico (${duracion} min)`
      }

      ciclos.push({
        fecha,
        camion,
        ingreso: ing._ti.display,
        salida: sal._ti.display,
        duracion_min: duracion,
        excluido,
        motivo_exclusion,
      })
    }
  }

  return ciclos.sort((a, b) =>
    a.fecha.localeCompare(b.fecha) || a.camion.localeCompare(b.camion)
  )
}

function computeResumen(ciclos: any[]) {
  const todas = ciclos.map(c => c.duracion_min)
  const incluidas = ciclos.filter(c => !c.excluido).map(c => c.duracion_min)
  return {
    total_ciclos: ciclos.length,
    ciclos_incluidos: incluidas.length,
    ciclos_excluidos: ciclos.length - incluidas.length,
    mediana_todos: round1(median(todas)),
    promedio_todos: round1(avg(todas)),
    mediana_sin_excluidos: round1(median(incluidas)),
    promedio_sin_excluidos: round1(avg(incluidas)),
  }
}

async function fetchEventos(admin: any, userIds: string[], desde: string, hasta: string) {
  const { data, error } = await admin
    .from('guardia_eventos')
    .select('fecha, tipo, camion_codigo, hora_evento, created_at, deposito_destino, deposito_desde, categoria, motivo')
    .in('registrado_por', userIds)
    .gte('fecha', desde)
    .lte('fecha', hasta)
    .order('fecha', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return data ?? []
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const sucursal = searchParams.get('sucursal')
  const desde = searchParams.get('desde')
  const hasta = searchParams.get('hasta')

  if (!sucursal || !desde || !hasta) {
    return Response.json({ error: 'Parámetros requeridos: sucursal, desde, hasta' }, { status: 400 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data: usuarios, error: uErr } = await admin
    .from('usuarios')
    .select('id')
    .eq('sucursal', sucursal)

  if (uErr) return Response.json({ error: uErr.message }, { status: 500 })
  const userIds = (usuarios ?? []).map((u: any) => u.id)
  if (!userIds.length) return Response.json({ error: `Sin usuarios para ${sucursal}` }, { status: 404 })

  try {
    const eventos = await fetchEventos(admin, userIds, desde, hasta)
    const ciclos = buildCiclos(eventos)
    const resumen = computeResumen(ciclos)

    const devMap: Record<string, number> = {}
    for (const ev of eventos.filter((e: any) => e.tipo === 'devolucion')) {
      const cat = ev.categoria || 'Sin categoría'
      devMap[cat] = (devMap[cat] || 0) + 1
    }
    const devoluciones = Object.entries(devMap)
      .map(([categoria, cantidad]) => ({ categoria, cantidad }))
      .sort((a, b) => b.cantidad - a.cantidad)

    // Período histórico: igual duración, inmediatamente anterior
    const diasPeriodo = Math.round(
      (new Date(hasta).getTime() - new Date(desde).getTime()) / 86400000
    ) + 1
    const hastaHist = new Date(new Date(desde).getTime() - 86400000).toISOString().split('T')[0]
    const desdeHist = new Date(new Date(desde).getTime() - diasPeriodo * 86400000).toISOString().split('T')[0]

    const eventosHist = await fetchEventos(admin, userIds, desdeHist, hastaHist)
    const ciclosHist = buildCiclos(eventosHist)
    const resumenHist = computeResumen(ciclosHist)

    return Response.json({
      sucursal,
      periodo: { desde, hasta },
      ciclos,
      resumen,
      devoluciones,
      historico: {
        periodo: { desde: desdeHist, hasta: hastaHist },
        ...resumenHist,
      },
    })
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 })
  }
}
