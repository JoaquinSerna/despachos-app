-- Taller: puentes grúa (PG-06 y PG-07 según las OT de Guernica) como tercer tipo de equipo de taller.
-- Requiere 20261020_taller_equipos_admin.sql.

alter table public.taller_equipos drop constraint if exists taller_equipos_tipo_check;
alter table public.taller_equipos add constraint taller_equipos_tipo_check
  check (tipo in ('autoelevador', 'pala', 'puente_grua'));

alter table public.taller_ordenes drop constraint if exists taller_ordenes_tipo_equipo_check;
alter table public.taller_ordenes add constraint taller_ordenes_tipo_equipo_check
  check (tipo_equipo in ('camion', 'autoelevador', 'pala', 'puente_grua', 'externo'));

insert into public.taller_equipos (codigo, tipo)
select c, 'puente_grua' from unnest(array['PG-06', 'PG-07']) c
on conflict (codigo) do nothing;

insert into public.taller_catalogo (grupo, sistema, nombre, orden)
select g, s, n, 2000 + (row_number() over ())::int
from (values
  ('puente_grua', 'Aparejo / Izaje', 'Acortado / cambio de cadenas del aparejo'),
  ('puente_grua', 'Aparejo / Izaje', 'Cambio de campana de freno del aparejo'),
  ('puente_grua', 'Aparejo / Izaje', 'Cambio de gancho'),
  ('puente_grua', 'Aparejo / Izaje', 'Cambio de polea de guía del cable'),
  ('puente_grua', 'Aparejo / Izaje', 'Revisión y engrase de cable de izaje'),
  ('puente_grua', 'Sistema eléctrico', 'Revisión de botonera / comando'),
  ('puente_grua', 'Sistema eléctrico', 'Revisión de finales de carrera'),
  ('puente_grua', 'Traslación', 'Revisión de ruedas y rieles'),
  ('puente_grua', 'Traslación', 'Engrase general')
) as v(g, s, n)
on conflict (grupo, sistema, nombre) do nothing;

notify pgrst, 'reload schema';
