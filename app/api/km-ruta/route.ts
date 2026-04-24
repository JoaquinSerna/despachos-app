import { NextRequest, NextResponse } from 'next/server'

// Proxy server-side para OSRM — evita CORS y centraliza el manejo de errores
export async function GET(request: NextRequest) {
  const coords = request.nextUrl.searchParams.get('coords')
  if (!coords) return NextResponse.json({ error: 'coords required' }, { status: 400 })

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000), // 8s timeout
      headers: { 'User-Agent': 'despachos-app/1.0' },
    })
    if (!res.ok) {
      return NextResponse.json({ error: `OSRM error ${res.status}` }, { status: 502 })
    }
    const data = await res.json()
    const distanciaM: number | null = data.routes?.[0]?.distance ?? null
    return NextResponse.json({ distanciaM })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'timeout' }, { status: 502 })
  }
}
