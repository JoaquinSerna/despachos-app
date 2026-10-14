-- Taller: carros (SC) y semis (SP) propios como equipos de taller tipo acoplado (según las OT de Guernica).
-- Requiere 20261021_taller_puente_grua.sql.

alter table public.taller_equipos drop constraint if exists taller_equipos_tipo_check;
alter table public.taller_equipos add constraint taller_equipos_tipo_check
  check (tipo in ('autoelevador', 'pala', 'puente_grua', 'acoplado'));

alter table public.taller_ordenes drop constraint if exists taller_ordenes_tipo_equipo_check;
alter table public.taller_ordenes add constraint taller_ordenes_tipo_equipo_check
  check (tipo_equipo in ('camion', 'autoelevador', 'pala', 'puente_grua', 'acoplado', 'externo'));

insert into public.taller_equipos (codigo, tipo)
select c, 'acoplado' from unnest(array['SC-07', 'SC-08', 'SC-09', 'SC-10', 'SC-12', 'SC-15', 'SC-16', 'SC-17', 'SC-18', 'SC-19',
                                       'SP-02', 'SP-04', 'SP-05', 'SP-06']) c
on conflict (codigo) do nothing;

notify pgrst, 'reload schema';
