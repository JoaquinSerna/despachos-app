import { NextRequest, NextResponse } from 'next/server'

// Proxy server-side para cálculo de rutas via Valhalla (OpenStreetMap DE).
// OSRM demo bloquea las IPs de AWS/Vercel; Valhalla es más accesible.
// Formato de entrada: coords=lng1,lat1;lng2,lat2;... (orden OSRM, igual que antes)
export async function GET(request: NextRequest) {
  const coords = request.nextUrl.searchParams.get('coords')
  if (!coords) return NextResponse.json({ error: 'coords required' }, { status: 400 })

  // Parsear "lng,lat;lng,lat;..." → array de locations para Valhalla
  const parts = coords.split(';').map(pt => {
    const [lon, lat] = pt.split(',').map(Number)
    return { lon, lat }
  })
  if (parts.length < 2 || parts.some(p => isNaN(p.lat) || isNaN(p.lon))) {
    return NextResponse.json({ error: 'invalid coords' }, { status: 400 })
  }

  try {
    const res = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'despachos-app/1.0',
      },
      body: JSON.stringify({
        locations: parts,
        costing: 'auto',
        directions_options: { units: 'km' },
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return NextResponse.json(
        { error: `Valhalla ${res.status}: ${(err as any).error ?? ''}` },
        { status: 502 }
      )
    }

    const data = await res.json()
    // trip.summary.length está en km (porque pedimos units:"km")
    const distanciaKm: number | null = data.trip?.summary?.length ?? null
    const distanciaM = distanciaKm !== null ? Math.round(distanciaKm * 1000) : null
    return NextResponse.json({ distanciaM })
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'timeout' }, { status: 502 })
  }
}
