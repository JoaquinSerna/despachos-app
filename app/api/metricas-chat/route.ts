import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

async function buildContext(sucursal?: string): Promise<string> {
  const admin = getAdmin()
  const desde = new Date()
  desde.setDate(desde.getDate() - 30)
  const desdeStr = desde.toISOString().split('T')[0]
  const hoy = new Date().toISOString().split('T')[0]

  let pedQ = admin.from('pedidos')
    .select('fecha_entrega, sucursal, camion_id, vuelta, estado, peso_total_kg, volumen_total_m3, cliente')
    .gte('fecha_entrega', desdeStr).lte('fecha_entrega', hoy).neq('estado', 'cancelado')
  let flotQ = admin.from('flota_dia')
    .select('fecha, sucursal, camion_codigo, km_ruta')
    .gte('fecha', desdeStr).lte('fecha', hoy).eq('activo', true)
  if (sucursal) { pedQ = pedQ.eq('sucursal', sucursal); flotQ = flotQ.eq('sucursal', sucursal) }

  const [{ data: pedidos }, { data: flota }, { data: camiones }] = await Promise.all([
    pedQ, flotQ,
    admin.from('camiones_flota').select('codigo, tipo_unidad, sucursal, posiciones_total, tonelaje_max_kg').eq('activo', true),
  ])

  const total = (pedidos ?? []).length
  const entregados = (pedidos ?? []).filter(p => p.estado === 'entregado' || p.estado === 'entregado_parcial').length
  const rechazados = (pedidos ?? []).filter(p => p.estado === 'rechazado').length
  const kgTotal = Math.round((pedidos ?? []).reduce((a, p) => a + (p.peso_total_kg ?? 0), 0))

  const camionMap: Record<string, any> = {}
  for (const c of camiones ?? []) camionMap[c.codigo] = c

  const bySucursal: Record<string, { pedidos: number; kg: number; pos: number }> = {}
  for (const p of pedidos ?? []) {
    if (!bySucursal[p.sucursal]) bySucursal[p.sucursal] = { pedidos: 0, kg: 0, pos: 0 }
    bySucursal[p.sucursal].pedidos++; bySucursal[p.sucursal].kg += p.peso_total_kg ?? 0; bySucursal[p.sucursal].pos += p.volumen_total_m3 ?? 0
  }

  const byTruck: Record<string, { dias: number; pedidos: number; kg: number; km: number; capKg: number; capPos: number; pos: number }> = {}
  for (const f of flota ?? []) {
    if (!byTruck[f.camion_codigo]) byTruck[f.camion_codigo] = { dias: 0, pedidos: 0, kg: 0, pos: 0, km: 0, capKg: 0, capPos: 0 }
    byTruck[f.camion_codigo].dias++; byTruck[f.camion_codigo].km += f.km_ruta ?? 0
    const c = camionMap[f.camion_codigo]
    if (c) { byTruck[f.camion_codigo].capKg += c.tonelaje_max_kg; byTruck[f.camion_codigo].capPos += c.posiciones_total }
  }
  for (const p of pedidos ?? []) {
    if (!p.camion_id) continue
    if (!byTruck[p.camion_id]) byTruck[p.camion_id] = { dias: 0, pedidos: 0, kg: 0, pos: 0, km: 0, capKg: 0, capPos: 0 }
    byTruck[p.camion_id].pedidos++; byTruck[p.camion_id].kg += p.peso_total_kg ?? 0; byTruck[p.camion_id].pos += p.volumen_total_m3 ?? 0
  }

  const diasSemana: Record<string, number> = {}
  for (const p of pedidos ?? []) {
    const d = new Date(p.fecha_entrega + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long' })
    diasSemana[d] = (diasSemana[d] ?? 0) + 1
  }
  const byCliente: Record<string, number> = {}
  for (const p of pedidos ?? []) byCliente[p.cliente] = (byCliente[p.cliente] ?? 0) + 1
  const topClientes = Object.entries(byCliente).sort((a, b) => b[1] - a[1]).slice(0, 10)

  const byVuelta: Record<string, number> = {}
  for (const p of pedidos ?? []) {
    const v = p.vuelta === 0 ? 'Sin asignar' : `V${p.vuelta}`
    byVuelta[v] = (byVuelta[v] ?? 0) + 1
  }

  return `Período: ${desdeStr} al ${hoy}${sucursal ? ` · Sucursal: ${sucursal}` : ' · Todas las sucursales'}

RESUMEN (${total} pedidos):
- Entregados: ${entregados} (${total > 0 ? Math.round(entregados/total*100) : 0}%)
- Rechazados: ${rechazados} (${total > 0 ? Math.round(rechazados/total*100) : 0}%)
- Kg despachados: ${kgTotal.toLocaleString()} kg

POR SUCURSAL:
${Object.entries(bySucursal).sort((a,b)=>b[1].pedidos-a[1].pedidos).map(([s,d])=>`- ${s}: ${d.pedidos} ped · ${Math.round(d.kg).toLocaleString()} kg · ${Math.round(d.pos)} pos`).join('\n')}

POR CAMIÓN (por kg):
${Object.entries(byTruck).sort((a,b)=>b[1].kg-a[1].kg).slice(0,20).map(([cod,d])=>{
  const c = camionMap[cod]; const pct = d.capKg>0?Math.round(d.kg/d.capKg*100):0
  return `- ${cod} (${c?.tipo_unidad??'?'}, ${c?.sucursal??'?'}): ${d.dias}d · ${d.pedidos}p · ${Math.round(d.kg).toLocaleString()}kg (${pct}%) · ${Math.round(d.km)}km`
}).join('\n')}

DÍA DE SEMANA:
${Object.entries(diasSemana).sort((a,b)=>b[1]-a[1]).map(([d,n])=>`- ${d}: ${n} pedidos`).join('\n')}

DISTRIBUCIÓN VUELTAS:
${Object.entries(byVuelta).sort((a,b)=>b[1]-a[1]).map(([v,n])=>`- ${v}: ${n}`).join('\n')}

TOP 10 CLIENTES:
${topClientes.map(([c,n])=>`- ${c}: ${n} pedidos`).join('\n')}`
}

export async function POST(request: NextRequest) {
  try {
    const { messages, sucursal } = await request.json()
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const contexto = await buildContext(sucursal || undefined)

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      system: `Sos un asistente de análisis operativo de flota para Construyo al Costo, empresa de materiales de construcción con sucursales en La Plata (LP520, LP139), Guernica, Cañuelas y Pinamar.

Respondé en español rioplatense, con análisis concretos usando números de los datos. Usá listas con guiones y **negritas** para estructurar. Si no tenés datos suficientes, decilo.

DATOS OPERATIVOS (últimos 30 días):
${contexto}`,
      messages: messages.map((m: any) => ({ role: m.role, content: m.content }))
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    return NextResponse.json({ respuesta: text })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
