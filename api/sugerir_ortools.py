"""Sugerir 2: reparto de pedidos en camiones con Google OR-Tools (corre como función de Python en Vercel).

POST /api/sugerir_ortools
  { sucursal, deposito: {lat, lng}, pedidos: [...], camiones: [...], ya_asignados: [...], segundos? }
Devuelve { asignacion: {pedido_id: camion|null}, ordenEntrega: {pedido_id: n}, rutas, sin_asignar, ... }

Qué hace distinto del botón Sugerir:
  - Los pedidos que van al mismo lugar (misma dirección, mismo punto a menos de 300 m, o mismo cliente a menos de 2 km)
    se tratan como UNA parada y viajan juntos en el mismo camión.
  - Si ese lugar ya tiene un pedido asignado a un camión, el pedido nuevo se suma a ese camión (si entra).
  - Reparte con distancias por calle (Valhalla) y suma un costo por cada camión extra que se usa,
    para no mandar varios camiones a lo mismo.
"""
import json, math, re, time, unicodedata
from http.server import BaseHTTPRequestHandler

import requests
from ortools.constraint_solver import pywrapcp, routing_enums_pb2

HIERRO = ['hierro', 'barra', 'varilla', 'malla', 'vigueta', 'alambre', 'pretensado', 'armadura', 'chapa', 'perfil', 'caño', 'tubo', 'canal', 'angulo', 'ángulo', 'zingueria', 'upn', 'ipn']
LARGO = ['chapa', 'perfil', 'caño', 'tubo', 'canal', 'angulo', 'ángulo', 'zingueria', 'upn', 'ipn']
LARGO_EXCL = ['cloacal', 'pluvial', 'sanitario', 'desague', 'desagüe']
COSTO_CAMION_EXTRA_M = 20000   # sacar un camión más "cuesta" como 20 km de ruta
PENALIDAD_SIN_ASIGNAR = 10_000_000
VALHALLA = ['https://valhalla1.openstreetmap.de', 'https://valhalla2.openstreetmap.de', 'https://valhalla3.openstreetmap.de']


def norm(s):
    s = unicodedata.normalize('NFD', (s or '').lower())
    s = ''.join(c for c in s if unicodedata.category(c) != 'Mn')
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', ' ', s)).strip()


def norm_cliente(s):
    return re.sub(r'\b(s ?a|s ?r ?l|sas)\b', '', norm(s)).strip()


def haversine_m(a, b):
    r = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


class UnionFind:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, i):
        while self.p[i] != i:
            self.p[i] = self.p[self.p[i]]
            i = self.p[i]
        return i

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def preparar_pedido(p):
    nombres = [str(n).lower() for n in (p.get('items') or [])]
    volcador = bool(p.get('requiere_volcador'))
    solo_hierro = bool(nombres) and all(any(k in n for k in HIERRO) for n in nombres)
    largo = any(any(k in n for k in LARGO) and not any(x in n for x in LARGO_EXCL) for n in nombres)
    lat, lng = p.get('latitud'), p.get('longitud')
    return {
        'id': p['id'], 'nv': p.get('nv'), 'camion': p.get('camion_id'),
        'xy': (float(lat), float(lng)) if lat is not None and lng is not None else None,
        'dir': norm(p.get('direccion')), 'cli': norm_cliente(p.get('cliente')),
        'kg': float(p.get('peso_total_kg') or 0), 'pos': float(p.get('volumen_total_m3') or 0),
        'volcador': volcador, 'grua': (not volcador) and (not solo_hierro), 'largo': largo,
    }


def agrupar(todos):
    """Une los pedidos que van al mismo lugar. Devuelve listas de índices."""
    n = len(todos)
    uf = UnionFind(n)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = todos[i], todos[j]
            if a['dir'] and a['dir'] == b['dir']:
                uf.union(i, j)
                continue
            d = haversine_m(a['xy'], b['xy']) if a['xy'] and b['xy'] else None
            if d is not None and d < 300:
                uf.union(i, j)
                continue
            if a['cli'] and a['cli'] == b['cli'] and d is not None and d < 2000:
                uf.union(i, j)
    grupos = {}
    for i in range(n):
        grupos.setdefault(uf.find(i), []).append(i)
    return list(grupos.values())


def matriz_calle(puntos):
    """Distancias por calle (m) con Valhalla, en bloques; si no responde, línea recta x 1,35."""
    n = len(puntos)
    locs = [{'lat': p[0], 'lon': p[1]} for p in puntos]
    M = [[0] * n for _ in range(n)]
    bloque = 20
    try:
        for i0 in range(0, n, bloque):
            for j0 in range(0, n, bloque):
                fuentes, destinos = locs[i0:i0 + bloque], locs[j0:j0 + bloque]
                ok = False
                for host in VALHALLA:
                    try:
                        r = requests.post(f'{host}/sources_to_targets', json={'sources': fuentes, 'targets': destinos, 'costing': 'auto'}, timeout=20,
                                          headers={'User-Agent': 'despachos-app/1.0'})
                        if r.ok:
                            m = r.json()['sources_to_targets']
                            for a in range(len(fuentes)):
                                for b in range(len(destinos)):
                                    d = m[a][b].get('distance')
                                    if d is None:
                                        raise ValueError('sin ruta')
                                    M[i0 + a][j0 + b] = int(d * 1000)
                            ok = True
                            break
                    except Exception:
                        continue
                if not ok:
                    raise RuntimeError('Valhalla no respondió')
        return M, 'calle'
    except Exception:
        return [[int(haversine_m(puntos[i], puntos[j]) * 1.35) for j in range(n)] for i in range(n)], 'recta'


def resolver(payload):
    t0 = time.time()
    sucursal = payload.get('sucursal')
    dep = payload.get('deposito') or {}
    deposito = (float(dep.get('lat')), float(dep.get('lng')))
    camiones = payload['camiones']
    nuevos = [preparar_pedido(p) for p in payload['pedidos']]
    ya = [preparar_pedido(p) for p in payload.get('ya_asignados', []) if p.get('camion_id')]
    segundos = max(2, min(25, int(payload.get('segundos') or 8)))

    por_camion = {c['codigo']: c for c in camiones}
    carga = {c['codigo']: {'kg': 0.0, 'pos': 0.0, 'largo': False, 'nolargo': False, 'n': 0} for c in camiones}
    for p in ya:
        if p['camion'] in carga:
            c = carga[p['camion']]
            c['kg'] += p['kg']; c['pos'] += p['pos']; c['n'] += 1
            c['largo'] = c['largo'] or p['largo']; c['nolargo'] = c['nolargo'] or not p['largo']

    asignacion, sin_asignar, orden, contador = {}, {}, {}, {}

    def cabe(cod, kg, pos):
        c, cg = por_camion[cod], carga[cod]
        if cg['kg'] + kg > c['tonelaje_max_kg']:
            return False
        if c.get('posiciones_total') and pos > 0 and cg['pos'] + pos > c['posiciones_total']:
            return False
        return True

    def puede_llevar(cod, largo, nolargo, volc, grua):
        c, cg = por_camion[cod], carga[cod]
        if volc and not c.get('volcador'):
            return False
        if grua and not c.get('grua_hidraulica'):
            return False
        if largo and cg['nolargo']:
            return False
        if nolargo and cg['largo']:
            return False
        return True

    # 1) Grupos de "mismo lugar" entre pedidos nuevos y ya asignados
    todos = ya + nuevos
    grupos = agrupar(todos)
    libres = []   # paradas a repartir con OR-Tools
    for g in grupos:
        miembros_ya = [todos[i] for i in g if i < len(ya)]
        miembros_nu = [todos[i] for i in g if i >= len(ya)]
        if not miembros_nu:
            continue
        kg = sum(p['kg'] for p in miembros_nu)
        pos = sum(p['pos'] for p in miembros_nu)
        largo = any(p['largo'] for p in miembros_nu)
        nolargo = any(not p['largo'] for p in miembros_nu)
        volc = any(p['volcador'] for p in miembros_nu)
        grua = any(p['grua'] for p in miembros_nu)
        # a) ese lugar ya tiene un camión: se suma ahí si entra
        if miembros_ya:
            cuenta = {}
            for p in miembros_ya:
                if p['camion'] in carga:
                    cuenta[p['camion']] = cuenta.get(p['camion'], 0) + 1
            for cod in sorted(cuenta, key=lambda k: -cuenta[k]):
                if cabe(cod, kg, pos) and puede_llevar(cod, largo, nolargo, volc, grua):
                    for p in miembros_nu:
                        asignacion[p['id']] = cod
                        contador[cod] = contador.get(cod, 0) + 1
                        orden[p['id']] = 1000 + contador[cod]   # después de lo ya armado
                    carga[cod]['kg'] += kg; carga[cod]['pos'] += pos
                    carga[cod]['largo'] = carga[cod]['largo'] or largo; carga[cod]['nolargo'] = carga[cod]['nolargo'] or nolargo
                    break
            else:
                cod = None
            if miembros_nu and miembros_nu[0]['id'] in asignacion:
                continue
        # b) parada libre: necesita un punto para ubicarla
        rep = next((p for p in miembros_nu if p['xy']), None) or next((p for p in miembros_ya if p['xy']), None)
        if rep is None:
            for p in miembros_nu:
                sin_asignar[p['id']] = 'Sin coordenadas ni otro pedido en el mismo lugar'
            continue
        libres.append({'pedidos': miembros_nu, 'xy': rep['xy'], 'kg': kg, 'pos': pos, 'largo': largo, 'nolargo': nolargo, 'volcador': volc, 'grua': grua})

    rutas, distancias = [], 'n/a'
    if libres and camiones:
        puntos = [deposito] + [s['xy'] for s in libres]
        M, distancias = matriz_calle(puntos)
        k = len(libres)
        mgr = pywrapcp.RoutingIndexManager(k + 1, len(camiones), 0)
        rt = pywrapcp.RoutingModel(mgr)
        cb = rt.RegisterTransitCallback(lambda i, j: M[mgr.IndexToNode(i)][mgr.IndexToNode(j)])
        rt.SetArcCostEvaluatorOfAllVehicles(cb)
        for v, c in enumerate(camiones):
            rt.SetFixedCostOfVehicle(0 if carga[c['codigo']]['n'] > 0 else COSTO_CAMION_EXTRA_M, v)
        cap_kg = [max(0, int(c['tonelaje_max_kg'] - carga[c['codigo']]['kg'])) for c in camiones]
        cap_pos = [max(0, int(round((c['posiciones_total'] - carga[c['codigo']]['pos']) * 10))) if c.get('posiciones_total') else 10 ** 9 for c in camiones]
        demanda_kg = [0] + [int(math.ceil(s['kg'])) for s in libres]
        demanda_pos = [0] + [int(round(s['pos'] * 10)) for s in libres]
        rt.AddDimensionWithVehicleCapacity(rt.RegisterUnaryTransitCallback(lambda i: demanda_kg[mgr.IndexToNode(i)]), 0, cap_kg, True, 'kg')
        rt.AddDimensionWithVehicleCapacity(rt.RegisterUnaryTransitCallback(lambda i: demanda_pos[mgr.IndexToNode(i)]), 0, cap_pos, True, 'pos')
        solver = rt.solver()
        for s_i, s in enumerate(libres):
            idx = mgr.NodeToIndex(s_i + 1)
            permitidos = [v for v, c in enumerate(camiones) if puede_llevar(c['codigo'], s['largo'], s['nolargo'], s['volcador'], s['grua'])]
            if not permitidos:
                for p in s['pedidos']:
                    sin_asignar[p['id']] = 'Sin camión elegible (volcador, grúa o tipo de carga)'
                rt.AddDisjunction([idx], 0)
                rt.VehicleVar(idx).SetValues([-1])
                continue
            if len(permitidos) < len(camiones):
                rt.VehicleVar(idx).SetValues(permitidos + [-1])
            rt.AddDisjunction([idx], PENALIDAD_SIN_ASIGNAR)
        # el material largo no viaja con carga común: se exige solo si las dos paradas se hacen
        for a in range(k):
            for b in range(a + 1, k):
                A, B = libres[a], libres[b]
                if (A['largo'] and B['nolargo']) or (A['nolargo'] and B['largo']):
                    va, vb = rt.VehicleVar(mgr.NodeToIndex(a + 1)), rt.VehicleVar(mgr.NodeToIndex(b + 1))
                    solver.Add(solver.Sum([solver.IsDifferentVar(va, vb), solver.IsEqualCstVar(va, -1), solver.IsEqualCstVar(vb, -1)]) >= 1)

        def resolver_con(estrategia):
            p = pywrapcp.DefaultRoutingSearchParameters()
            p.first_solution_strategy = estrategia
            p.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
            p.time_limit.FromSeconds(segundos)
            return rt.SolveWithParameters(p)

        sol = resolver_con(routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION) or resolver_con(routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC)
        if sol is None:
            for s in libres:
                for p in s['pedidos']:
                    sin_asignar.setdefault(p['id'], 'OR-Tools no encontró una solución')
        else:
            for v, c in enumerate(camiones):
                i = rt.Start(v)
                paradas, metros, previo = [], 0, 0
                while not rt.IsEnd(i):
                    nodo = mgr.IndexToNode(i)
                    siguiente = sol.Value(rt.NextVar(i))
                    metros += M[nodo][mgr.IndexToNode(siguiente)]
                    if nodo:
                        s = libres[nodo - 1]
                        contador[c['codigo']] = contador.get(c['codigo'], 0) + 1
                        for p in s['pedidos']:
                            asignacion[p['id']] = c['codigo']
                            orden[p['id']] = contador[c['codigo']]
                        paradas.append({'nv': [p['nv'] for p in s['pedidos']], 'pedidos': len(s['pedidos'])})
                    i = siguiente
                if paradas:
                    rutas.append({'camion': c['codigo'], 'paradas': len(paradas), 'pedidos': sum(x['pedidos'] for x in paradas), 'km': round(metros / 1000, 1)})
            for s in libres:
                for p in s['pedidos']:
                    if p['id'] not in asignacion:
                        sin_asignar.setdefault(p['id'], 'No entra en ningún camión (capacidad)')

    for p in nuevos:
        asignacion.setdefault(p['id'], None)
    return {
        'asignacion': asignacion, 'ordenEntrega': orden, 'sinAsignar': sin_asignar, 'rutas': rutas,
        'engine': 'ortools', 'distancias': distancias, 'sucursal': sucursal,
        'camionesUsados': len({c for c in asignacion.values() if c}), 'kmTotal': round(sum(r['km'] for r in rutas), 1),
        'paradas': len(libres), 'pedidos': len(nuevos), 'ms': int((time.time() - t0) * 1000),
    }


class handler(BaseHTTPRequestHandler):
    def _responder(self, codigo, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode('utf-8')
        self.send_response(codigo)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(datos)

    def do_POST(self):
        try:
            largo = int(self.headers.get('content-length') or 0)
            payload = json.loads(self.rfile.read(largo) or b'{}')
            if not payload.get('pedidos') or not payload.get('camiones') or not payload.get('deposito'):
                return self._responder(400, {'error': 'Faltan pedidos, camiones o deposito'})
            self._responder(200, resolver(payload))
        except Exception as e:  # noqa: BLE001
            self._responder(500, {'error': f'{type(e).__name__}: {e}'})

    def do_GET(self):
        self._responder(200, {'ok': True, 'engine': 'ortools'})
