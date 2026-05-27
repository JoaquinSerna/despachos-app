import { NextRequest, NextResponse } from 'next/server'

// Proxy server-side para cálculo de rutas via Valhalla (OpenStreetMap DE).
// OSRM demo bloquea las IPs de AWS/Vercel; probamos las 3 instancias públicas de Valhalla.
// Formato de entrada: coords=lng1,lat1;lng2,lat2;... (orden OSRM, igual que antes)

const VALHALLA_HOSTS = [
  'https://valhalla1.openstreetmap.de/route',
  'https://valhalla2.openstreetmap.de/route',
  'https://valhalla3.openstreetmap.de/route',
]

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

  const body = JSON.stringify({
    locations: parts,
    costing: 'auto',
    directions_options: { units: 'km' },
  })

  let lastError = 'all hosts failed'
  for (const host of VALHALLA_HOSTS) {
    try {
      const res = await fetch(host, {
        method: 'POST',
        signal: AbortSignal.timeout(9000),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'despachos-app/1.0',
        },
        body,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        lastError = `Valhalla ${res.status}: ${(err as any).error ?? ''}`
        continue  // intentar siguiente host
      }

      const data = await res.json()
      // trip.summary.length en km, trip.summary.time en segundos
      const distanciaKm: number | null = data.trip?.summary?.length ?? null
      const distanciaM = distanciaKm !== null ? Math.round(distanciaKm * 1000) : null
      const duracionSeg: number | null = data.trip?.summary?.time ?? null
      const duracionMin = duracionSeg !== null ? Math.round(duracionSeg / 60) : null
      return NextResponse.json({ distanciaM, duracionMin })
    } catch (e: any) {
      lastError = e.message ?? 'timeout'
      // continuar con siguiente host
    }
  }

  return NextResponse.json({ error: lastError }, { status: 502 })
}
