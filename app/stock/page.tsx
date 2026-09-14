'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from '../supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const SUCURSALES = ['Guernica', 'LP520', 'LP139', 'Cañuelas', 'Pinamar'] as const
type Sucursal = typeof SUCURSALES[number]

interface StockRow {
  id_producto: number
  nombre: string
  tipo: string
  categoria: string
  subcategoria: string
  sucursal: string
  cantidad: number
}

interface ProductoStock {
  id_producto: number
  nombre: string
  tipo: string
  categoria: string
  subcategoria: string
  stock: Record<Sucursal, number>
  total: number
}

interface ComprometidoRow {
  id_producto: number
  sucursal: string
  comprometido: number
}

function agrupar(rows: StockRow[]): ProductoStock[] {
  const map = new Map<number, ProductoStock>()
  for (const r of rows) {
    if (!map.has(r.id_producto)) {
      map.set(r.id_producto, {
        id_producto: r.id_producto,
        nombre: r.nombre,
        tipo: r.tipo,
        categoria: r.categoria,
        subcategoria: r.subcategoria,
        stock: { Guernica: 0, LP520: 0, LP139: 0, Cañuelas: 0, Pinamar: 0 },
        total: 0,
      })
    }
    const prod = map.get(r.id_producto)!
    prod.stock[r.sucursal as Sucursal] = r.cantidad
    prod.total += r.cantidad
  }
  return Array.from(map.values()).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
}

export default function StockPage() {
  const router = useRouter()
  const [verificando, setVerificando] = useState(true)
  const [cargando, setCargando] = useState(false)
  const [productos, setProductos] = useState<ProductoStock[]>([])
  const [categorias, setCategorias] = useState<string[]>([])
  const [categoria, setCategoria] = useState('')
  const [sucursalFiltro, setSucursalFiltro] = useState<Sucursal | ''>('')
  const [busqueda, setBusqueda] = useState('')
  const [ultimoImport, setUltimoImport] = useState<string | null>(null)
  const [totalRows, setTotalRows] = useState(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stock proyectado
  const [verProyectado, setVerProyectado] = useState(false)
  const [comprometido, setComprometido] = useState<Map<string, number>>(new Map())
  const [cargandoProyectado, setCargandoProyectado] = useState(false)

  // Verificar sesión
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) router.push('/')
      else setVerificando(false)
    })
  }, [router])

  // Cargar categorías y último import al montar
  useEffect(() => {
    if (verificando) return
    supabase.from('stock_sucursal').select('categoria').neq('categoria', '').then(({ data }) => {
      if (data) {
        const uniq = [...new Set(data.map((r: any) => r.categoria).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'))
        setCategorias(uniq)
      }
    })
    fetch('/api/stock-import').then(r => r.json()).then(d => {
      if (d.ultimo_import) setUltimoImport(d.ultimo_import)
    }).catch(() => {})
  }, [verificando])

  const buscar = useCallback(async (texto: string, cat: string, suc: Sucursal | '') => {
    setCargando(true)
    try {
      let q = supabase
        .from('stock_sucursal')
        .select('id_producto, nombre, tipo, categoria, subcategoria, sucursal, cantidad')

      if (texto.trim()) q = q.ilike('nombre', `%${texto.trim()}%`)
      if (cat) q = q.eq('categoria', cat)
      if (suc) q = q.eq('sucursal', suc).gt('cantidad', 0)

      const { data, error } = await q.order('nombre').limit(2000)
      if (error || !data) { setCargando(false); return }

      // Si filtramos por sucursal, expandimos a todas las sucursales para ese producto
      let rows = data as StockRow[]
      if (suc && rows.length > 0) {
        const ids = [...new Set(rows.map(r => r.id_producto))]
        let qAll = supabase
          .from('stock_sucursal')
          .select('id_producto, nombre, tipo, categoria, subcategoria, sucursal, cantidad')
          .in('id_producto', ids)
        if (cat) qAll = qAll.eq('categoria', cat)
        const { data: all } = await qAll.order('nombre').limit(ids.length * 5 + 100)
        if (all) rows = all as StockRow[]
      }

      const agrupados = agrupar(rows)
      setProductos(agrupados)
      setTotalRows(agrupados.length)
    } finally {
      setCargando(false)
    }
  }, [])

  // Cargar datos de stock comprometido
  const cargarProyectado = useCallback(async () => {
    setCargandoProyectado(true)
    try {
      const res = await fetch('/api/stock-proyectado')
      if (!res.ok) { setCargandoProyectado(false); return }
      const data: ComprometidoRow[] = await res.json()
      const map = new Map<string, number>()
      for (const row of data) {
        map.set(`${row.id_producto}|${row.sucursal}`, row.comprometido)
      }
      setComprometido(map)
    } finally {
      setCargandoProyectado(false)
    }
  }, [])

  const toggleProyectado = useCallback(async () => {
    const nuevo = !verProyectado
    setVerProyectado(nuevo)
    if (nuevo && comprometido.size === 0) {
      await cargarProyectado()
    }
  }, [verProyectado, comprometido, cargarProyectado])

  // Disparar búsqueda con debounce en texto, inmediato en filtros
  useEffect(() => {
    if (verificando) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => buscar(busqueda, categoria, sucursalFiltro), 350)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [busqueda, categoria, sucursalFiltro, verificando, buscar])

  const fmtFecha = (iso: string) => {
    try {
      return new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
    } catch { return iso }
  }

  const stockColor = (n: number) => {
    if (n === 0) return { color: '#B9BBB7' }
    if (n < 10) return { color: '#e88a00' }
    return { color: '#1a7a3c' }
  }

  // Color para stock proyectado
  const proyectadoColor = (actual: number, comprometidoVal: number) => {
    const proy = actual - comprometidoVal
    if (proy <= 0) return { color: '#E52322' }   // rojo: sin stock proyectado
    if (proy < 10) return { color: '#e88a00' }   // naranja: bajo
    return { color: '#1a7a3c' }                   // verde: ok
  }

  if (verificando) return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#f5f6fa' }}>
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen" style={{ background: '#f5f6fa', fontFamily: 'Barlow, sans-serif' }}>

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-5xl mx-auto px-4 md:px-6 h-14 flex items-center gap-4">
          <Link href="/dashboard"
            className="flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg shrink-0"
            style={{ color: '#254A96', background: '#e8edf8' }}>← Volver</Link>
          <div className="w-px h-5 bg-gray-200" />
          <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
          <span className="font-semibold text-sm" style={{ color: '#254A96' }}>Stock por sucursal</span>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 md:px-6 py-6 space-y-4">

        {/* Aviso fecha de actualización */}
        {(() => {
          if (!ultimoImport) return (
            <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium"
              style={{ background: '#fff3cd', color: '#856404', border: '1px solid #ffc107' }}>
              ⚠️ No hay datos de stock cargados todavía.
            </div>
          )
          const diasAtras = Math.floor((Date.now() - new Date(ultimoImport).getTime()) / 86400000)
          const esViejo = diasAtras >= 3
          return (
            <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl text-sm font-medium"
              style={esViejo
                ? { background: '#fff3cd', color: '#856404', border: '1px solid #ffc107' }
                : { background: '#e8edf8', color: '#254A96', border: '1px solid #c8d8f0' }}>
              {esViejo ? '⚠️' : '📦'}
              <span>
                Stock actualizado el <strong>{fmtFecha(ultimoImport)}</strong>
                {esViejo && <span className="ml-1">(hace {diasAtras} días — puede estar desactualizado)</span>}
              </span>
            </div>
          )
        })()}

        {/* Filtros */}
        <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
          {/* Búsqueda */}
          <input
            type="text"
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar producto por nombre…"
            className="w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2"
            style={{ borderColor: '#e8edf8' }}
          />

          <div className="flex flex-wrap gap-2 items-center">
            {/* Chips de sucursal */}
            <span className="text-xs font-medium shrink-0" style={{ color: '#B9BBB7' }}>Sucursal:</span>
            {SUCURSALES.map(s => (
              <button key={s}
                onClick={() => setSucursalFiltro(sucursalFiltro === s ? '' : s)}
                className="text-xs px-3 py-1.5 rounded-full font-medium border transition-colors"
                style={sucursalFiltro === s
                  ? { background: '#254A96', color: '#fff', borderColor: '#254A96' }
                  : { background: '#f5f6fa', color: '#254A96', borderColor: '#e8edf8' }}>
                {s}
              </button>
            ))}

            {/* Dropdown categoría */}
            <div className="w-px h-4 bg-gray-200 mx-1 hidden sm:block" />
            <select value={categoria} onChange={e => setCategoria(e.target.value)}
              className="text-xs border rounded-lg px-3 py-1.5 focus:outline-none"
              style={{ borderColor: '#e8edf8', color: categoria ? '#254A96' : '#B9BBB7' }}>
              <option value="">Todas las categorías</option>
              {categorias.map(c => <option key={c} value={c}>{c}</option>)}
            </select>

            {(busqueda || categoria || sucursalFiltro) && (
              <button
                onClick={() => { setBusqueda(''); setCategoria(''); setSucursalFiltro('') }}
                className="text-xs px-2.5 py-1.5 rounded-lg"
                style={{ background: '#fde8e8', color: '#E52322' }}>
                Limpiar filtros
              </button>
            )}
          </div>
        </div>

        {/* Resultados */}
        {cargando ? (
          <div className="flex justify-center py-16">
            <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
          </div>
        ) : productos.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <div className="text-4xl mb-3">📦</div>
            <p className="font-semibold text-sm" style={{ color: '#254A96' }}>Sin resultados</p>
            <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>
              {busqueda || categoria || sucursalFiltro ? 'Probá con otros filtros' : 'No hay stock cargado aún'}
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-4 py-2.5 border-b flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: '#f0f0f0', background: '#f9f9f9' }}>
              <span className="text-xs font-medium" style={{ color: '#B9BBB7' }}>
                {totalRows} producto{totalRows !== 1 ? 's' : ''}
                {sucursalFiltro ? ` con stock en ${sucursalFiltro}` : ''}
              </span>

              <div className="flex items-center gap-3 flex-wrap">
                {/* Leyenda colores */}
                {verProyectado ? (
                  <>
                    <span className="text-xs" style={{ color: '#1a7a3c' }}>● proy. ok</span>
                    <span className="text-xs" style={{ color: '#e88a00' }}>● proy. bajo</span>
                    <span className="text-xs" style={{ color: '#E52322' }}>● proy. ≤0</span>
                  </>
                ) : (
                  <>
                    <span className="text-xs" style={{ color: '#1a7a3c' }}>● disponible</span>
                    <span className="text-xs" style={{ color: '#e88a00' }}>● bajo (&lt;10)</span>
                    <span className="text-xs" style={{ color: '#B9BBB7' }}>● sin stock</span>
                  </>
                )}

                {/* Toggle proyectado */}
                <button
                  onClick={toggleProyectado}
                  disabled={cargandoProyectado}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg font-semibold border transition-colors"
                  style={verProyectado
                    ? { background: '#254A96', color: '#fff', borderColor: '#254A96' }
                    : { background: '#f5f6fa', color: '#254A96', borderColor: '#e8edf8' }}>
                  {cargandoProyectado ? (
                    <span className="w-3 h-3 border border-t-transparent rounded-full animate-spin inline-block" style={{ borderColor: verProyectado ? '#fff' : '#254A96', borderTopColor: 'transparent' }} />
                  ) : '📊'}
                  {verProyectado ? 'Stock proyectado' : 'Ver proyectado'}
                </button>
              </div>
            </div>

            {/* Aviso modo proyectado */}
            {verProyectado && (
              <div className="px-4 py-2 text-xs border-b" style={{ background: '#eef2ff', color: '#254A96', borderColor: '#c8d8f0' }}>
                <strong>Modo proyectado:</strong> stock actual menos pedidos pendientes/programados con entrega hoy o posterior.
                El número chico en gris es el comprometido. <span style={{ color: '#E52322' }}>Rojo</span> = sin stock proyectado.
              </div>
            )}

            {/* Tabla */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ background: '#f9f9f9' }}>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold sticky left-0" style={{ color: '#254A96', background: '#f9f9f9', minWidth: 220 }}>Producto</th>
                    <th className="text-left px-3 py-2.5 text-xs font-semibold hidden md:table-cell" style={{ color: '#B9BBB7' }}>Categoría</th>
                    {SUCURSALES.map(s => (
                      <th key={s}
                        className="text-center px-3 py-2.5 text-xs font-semibold"
                        style={{ color: sucursalFiltro === s ? '#254A96' : '#B9BBB7', minWidth: verProyectado ? 90 : 80 }}>
                        {s}
                      </th>
                    ))}
                    <th className="text-center px-3 py-2.5 text-xs font-semibold" style={{ color: '#B9BBB7', minWidth: 60 }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {productos.map((p) => (
                    <tr key={p.id_producto}
                      className="border-t hover:bg-gray-50 transition-colors"
                      style={{ borderColor: '#f0f0f0' }}>
                      <td className="px-4 py-3 sticky left-0 bg-white" style={{ minWidth: 220 }}>
                        <p className="font-medium text-xs leading-snug" style={{ color: '#1a1a1a' }}>{p.nombre}</p>
                        {p.subcategoria && (
                          <p className="text-xs mt-0.5 truncate" style={{ color: '#B9BBB7' }}>{p.subcategoria}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 hidden md:table-cell">
                        <span className="text-xs" style={{ color: '#666' }}>{p.categoria || '—'}</span>
                      </td>
                      {SUCURSALES.map(s => {
                        const actual = p.stock[s]
                        const comp = comprometido.get(`${p.id_producto}|${s}`) ?? 0
                        const proy = actual - comp

                        if (!verProyectado) {
                          return (
                            <td key={s} className="px-3 py-3 text-center">
                              <span className="text-sm font-semibold tabular-nums"
                                style={stockColor(actual)}>
                                {actual > 0 ? actual : '—'}
                              </span>
                            </td>
                          )
                        }

                        // Modo proyectado
                        return (
                          <td key={s} className="px-3 py-2 text-center">
                            {/* Proyectado (grande) */}
                            <span className="text-sm font-bold tabular-nums block leading-tight"
                              style={actual === 0 ? { color: '#B9BBB7' } : proyectadoColor(actual, comp)}>
                              {actual === 0 ? '—' : proy <= 0 ? '0' : proy}
                            </span>
                            {/* Comprometido (chico, gris) */}
                            {actual > 0 && comp > 0 && (
                              <span className="text-xs tabular-nums block leading-tight"
                                style={{ color: '#B9BBB7' }}>
                                -{comp}
                              </span>
                            )}
                          </td>
                        )
                      })}
                      <td className="px-3 py-3 text-center">
                        {!verProyectado ? (
                          <span className="text-xs font-semibold tabular-nums"
                            style={{ color: p.total > 0 ? '#254A96' : '#B9BBB7' }}>
                            {p.total > 0 ? p.total : '—'}
                          </span>
                        ) : (
                          (() => {
                            const totalComp = SUCURSALES.reduce((sum, s) => sum + (comprometido.get(`${p.id_producto}|${s}`) ?? 0), 0)
                            const totalProy = p.total - totalComp
                            return (
                              <div className="text-center">
                                <span className="text-xs font-bold tabular-nums block leading-tight"
                                  style={{ color: totalProy <= 0 ? '#E52322' : totalProy < 10 ? '#e88a00' : '#254A96' }}>
                                  {totalProy <= 0 ? '0' : totalProy}
                                </span>
                                {totalComp > 0 && (
                                  <span className="text-xs tabular-nums block leading-tight" style={{ color: '#B9BBB7' }}>
                                    -{totalComp}
                                  </span>
                                )}
                              </div>
                            )
                          })()
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
