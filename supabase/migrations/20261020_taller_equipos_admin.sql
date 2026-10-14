-- Taller: dos tipos de equipo más (autoelevador y pala cargadora), rol de administrador de taller
-- y edición de las órdenes. Los trabajos del catálogo salen de las OT de Guernica (10/2025 a 08/2026):
--   autoelevadores = unidades SA-05 a SA-21 (Clark) · palas cargadoras = unidades CF-07, 08, 11, 13, 21 y 23
-- Requiere 20261008_taller.sql.

-- ── Roles nuevos: mecánico y admin de taller ──
alter table public.usuarios drop constraint if exists usuarios_rol_check;
alter table public.usuarios add constraint usuarios_rol_check
  check (rol = any (array['gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial', 'confirmador', 'chofer', 'guardia', 'compras', 'mecanico', 'admin_taller']));

alter table public.usuarios drop constraint if exists usuarios_roles_extra_check;
alter table public.usuarios add constraint usuarios_roles_extra_check
  check (roles_extra <@ array['gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial', 'confirmador', 'chofer', 'guardia', 'compras', 'mecanico', 'admin_taller']::text[]);

-- ── Equipos de taller que no son camiones de la flota ──
create table if not exists public.taller_equipos (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  codigo text not null unique,
  tipo text not null check (tipo in ('autoelevador', 'pala')),
  sucursal text,
  activo boolean not null default true,
  notas text
);

alter table public.taller_equipos enable row level security;
drop policy if exists taller_equipos_select on public.taller_equipos;
drop policy if exists taller_equipos_insert on public.taller_equipos;
drop policy if exists taller_equipos_update on public.taller_equipos;
create policy taller_equipos_select on public.taller_equipos for select to authenticated using (true);
create policy taller_equipos_insert on public.taller_equipos for insert to authenticated
  with check (public.tiene_rol(array['gerencia', 'admin_flota', 'admin_taller']));
create policy taller_equipos_update on public.taller_equipos for update to authenticated
  using (public.tiene_rol(array['gerencia', 'admin_flota', 'admin_taller']));

insert into public.taller_equipos (codigo, tipo)
select 'SA-' || lpad(n::text, 2, '0'), 'autoelevador' from generate_series(5, 21) n
on conflict (codigo) do nothing;

insert into public.taller_equipos (codigo, tipo)
select c, 'pala' from unnest(array['CF-07', 'CF-08', 'CF-11', 'CF-13', 'CF-21', 'CF-23']) c
on conflict (codigo) do nothing;

-- ── Órdenes: tipo de equipo y quién las editó ──
alter table public.taller_ordenes
  add column if not exists tipo_equipo text not null default 'camion'
    check (tipo_equipo in ('camion', 'autoelevador', 'pala', 'externo')),
  add column if not exists editado_por uuid references auth.users(id),
  add column if not exists editado_en timestamptz;

-- El administrador de taller edita datos (órdenes y catálogo) y puede borrar órdenes
drop policy if exists taller_ordenes_delete on public.taller_ordenes;
create policy taller_ordenes_delete on public.taller_ordenes for delete to authenticated
  using (public.tiene_rol(array['gerencia', 'admin_flota', 'admin_taller']));

drop policy if exists taller_catalogo_insert on public.taller_catalogo;
drop policy if exists taller_catalogo_update on public.taller_catalogo;
create policy taller_catalogo_insert on public.taller_catalogo for insert to authenticated
  with check (public.tiene_rol(array['gerencia', 'admin_flota', 'admin_taller']));
create policy taller_catalogo_update on public.taller_catalogo for update to authenticated
  using (public.tiene_rol(array['gerencia', 'admin_flota', 'admin_taller']));

-- ── Mecánicos del taller ──
insert into public.taller_mecanicos (nombre)
select v from unnest(array['Claudio Gomez', 'Matias Gomez', 'Cristian Bañoz', 'Ignacio Bañoz']) v
where not exists (select 1 from public.taller_mecanicos m where lower(m.nombre) = lower(v));

-- ── Catálogo de tareas: autoelevador y pala (minutos estándar a completar desde la pestaña Catálogo) ──
insert into public.taller_catalogo (grupo, sistema, nombre, orden)
select g, s, n, 1000 + (row_number() over ())::int
from (values
  ('autoelevador', 'Torre / Mástil', 'Reparación / cambio de mangueras de la torre'),
  ('autoelevador', 'Torre / Mástil', 'Cambio de rodamientos de torre'),
  ('autoelevador', 'Torre / Mástil', 'Cambio de cadena de elevación'),
  ('autoelevador', 'Torre / Mástil', 'Armado / desarme de torre'),
  ('autoelevador', 'Torre / Mástil', 'Reparación de deslizador / desplazador'),
  ('autoelevador', 'Torre / Mástil', 'Soldadura de guía del desplazador'),
  ('autoelevador', 'Torre / Mástil', 'Soldadura de parrilla porta carga'),
  ('autoelevador', 'Torre / Mástil', 'Ajuste de tornillería de la torre'),
  ('autoelevador', 'Dirección', 'Cambio de extremos / pernos de dirección'),
  ('autoelevador', 'Dirección', 'Cambio de bieletas y bujes'),
  ('autoelevador', 'Dirección', 'Reparación de eje de dirección'),
  ('autoelevador', 'Dirección', 'Reparación de caja de dirección'),
  ('autoelevador', 'Dirección', 'Cambio de orbitrol'),
  ('autoelevador', 'Dirección', 'Cambio de retenes y rodamientos de punta de eje'),
  ('autoelevador', 'Frenos', 'Cambio de patines de freno'),
  ('autoelevador', 'Frenos', 'Reparación de campanas de freno'),
  ('autoelevador', 'Frenos', 'Cambio de bomba / bombín de freno'),
  ('autoelevador', 'Frenos', 'Purga y regulación de frenos'),
  ('autoelevador', 'Transmisión / Comandos', 'Reparación / cambio de comando de marchas y giro'),
  ('autoelevador', 'Transmisión / Comandos', 'Cambio de filtro del convertidor'),
  ('autoelevador', 'Transmisión / Comandos', 'Control de ATF / aceite de transmisión'),
  ('autoelevador', 'Sistema eléctrico', 'Cambio de batería'),
  ('autoelevador', 'Sistema eléctrico', 'Reparación de alternador / cambio de rodamientos'),
  ('autoelevador', 'Sistema eléctrico', 'Cambio de correa de alternador'),
  ('autoelevador', 'Sistema eléctrico', 'Reparación de arranque (burro)'),
  ('autoelevador', 'Sistema eléctrico', 'Cambio de regulador de voltaje'),
  ('autoelevador', 'Sistema eléctrico', 'Revisión de fusibles y relays'),
  ('autoelevador', 'Sistema eléctrico', 'Reparación de luces / cambio de faros y lámparas'),
  ('autoelevador', 'Sistema eléctrico', 'Reparación de llave de luz / cableado'),
  ('autoelevador', 'Sistema eléctrico', 'Limpieza de bornes de batería'),
  ('autoelevador', 'Motor / Refrigeración', 'Limpieza / cambio de radiador'),
  ('autoelevador', 'Motor / Refrigeración', 'Reparación de junta de tapa de cilindros'),
  ('autoelevador', 'Motor / Refrigeración', 'Regulación de válvulas'),
  ('autoelevador', 'Motor / Refrigeración', 'Limpieza / ajuste de inyectores'),
  ('autoelevador', 'Motor / Refrigeración', 'Cambio de mangueras de agua / combustible'),
  ('autoelevador', 'Motor / Refrigeración', 'Cambio de tapa de combustible'),
  ('autoelevador', 'Motor / Refrigeración', 'Cambio de salida de escape'),
  ('autoelevador', 'Ruedas / Cubiertas', 'Parche / cambio de rueda pinchada'),
  ('autoelevador', 'Ruedas / Cubiertas', 'Cambio de ruedas macizas'),
  ('autoelevador', 'Ruedas / Cubiertas', 'Cambio de cubiertas (envío a gomería)'),
  ('autoelevador', 'Ruedas / Cubiertas', 'Cambio de rodamiento y retén de masa'),
  ('autoelevador', 'Ruedas / Cubiertas', 'Cambio de espárragos'),
  ('autoelevador', 'Sistema hidráulico', 'Corrección de pérdidas de aceite hidráulico'),
  ('autoelevador', 'Sistema hidráulico', 'Cambio de mangueras hidráulicas'),
  ('autoelevador', 'Sistema hidráulico', 'Adición de aceite hidráulico'),
  ('autoelevador', 'Seguridad y accesorios', 'Soldadura y colocación de porta matafuegos'),
  ('autoelevador', 'Seguridad y accesorios', 'Cambio de espejo'),
  ('autoelevador', 'Seguridad y accesorios', 'Reparación de bocina / alarma'),
  ('pala', 'Balde', 'Destape y engrase de pernos del balde'),
  ('pala', 'Balde', 'Cambio de cuchilla del balde'),
  ('pala', 'Balde', 'Colocación de alemites nuevos'),
  ('pala', 'Balde', 'Reajuste de tuercas y bulones'),
  ('pala', 'Hidráulico / Comandos', 'Reparación de joystick / distribuidor de aceite'),
  ('pala', 'Hidráulico / Comandos', 'Revisión de orbitrol'),
  ('pala', 'Hidráulico / Comandos', 'Corrección de pérdidas de hidráulico'),
  ('pala', 'Hidráulico / Comandos', 'Reparación de manguera de toma de fuerza'),
  ('pala', 'Hidráulico / Comandos', 'Adición de aceite hidráulico'),
  ('pala', 'Hidráulico / Comandos', 'Cambio de mangueras hidráulicas'),
  ('pala', 'Motor / Refrigeración', 'Cambio de juntas de tapa de cilindros'),
  ('pala', 'Motor / Refrigeración', 'Cambio de camisa y pistón'),
  ('pala', 'Motor / Refrigeración', 'Desarme y limpieza de cárter'),
  ('pala', 'Motor / Refrigeración', 'Reparación / limpieza de radiador y enfriador de aceite'),
  ('pala', 'Motor / Refrigeración', 'Corrección de pérdida de agua / agua en el aceite'),
  ('pala', 'Motor / Refrigeración', 'Regulación de válvulas'),
  ('pala', 'Motor / Refrigeración', 'Reparación de ventilador de aire'),
  ('pala', 'Transmisión', 'Reparación de puente cardan / porta cruceta'),
  ('pala', 'Transmisión', 'Cambio de cardan'),
  ('pala', 'Sistema eléctrico', 'Cambio de carbones del alternador'),
  ('pala', 'Sistema eléctrico', 'Revisión de fusibles y cables'),
  ('pala', 'Sistema eléctrico', 'Activación / cambio de batería'),
  ('pala', 'Sistema eléctrico', 'Soldadura de soporte de óptica'),
  ('pala', 'Sistema eléctrico', 'Reparación de cerradura'),
  ('pala', 'Ruedas / Neumáticos', 'Parche de rueda pinchada'),
  ('pala', 'Ruedas / Neumáticos', 'Desarmado y armado de ruedas'),
  ('pala', 'Ruedas / Neumáticos', 'Colocación de ruedas'),
  ('pala', 'Frenos / Aire', 'Revisión de freno de mano'),
  ('pala', 'Frenos / Aire', 'Reparación de pérdida de aire (no carga aire)'),
  ('pala', 'General', 'Relevamiento de la unidad y engrase general'),
  ('pala', 'General', 'Lavado de la unidad'),
  ('pala', 'General', 'Puesta en valor de la unidad')
) as v(g, s, n)
on conflict (grupo, sistema, nombre) do nothing;

notify pgrst, 'reload schema';
