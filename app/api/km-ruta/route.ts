import { NextRequest, NextResponse } from 'next/server'

// Proxy server-side para OSRM — evita CORS y centraliza el manejo de errores
// Reintenta hasta 3 veces con backoff para tolerar 429/504 del servidor demo
export async function GET(request: NextRequest) {
  const coords = request.nextUrl.searchParams.get('coords')
  if (!coords) return NextResponse.json({ error: 'coords required' }, { status: 400 })

  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`

  let lastError = 'timeout'
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Backoff: 1s después del 1er intento, 2s después del 2do
      await new Promise(r => setTimeout(r, 1000 * attempt))
    }
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'despachos-app/1.0' },
      })
      if (res.ok) {
        const data = await res.json()
        const distanciaM: number | null = data.routes?.[0]?.distance ?? null
        return NextResponse.json({ distanciaM })
      }
      lastError = `OSRM error ${res.status}`
      // Solo reintenta en rate-limit o gateway timeout
      if (res.status !== 429 && res.status !== 504) break
    } catch (e: any) {
      lastError = e.message ?? 'timeout'
    }
  }
  return NextResponse.json({ error: lastError }, { status: 502 })
}
