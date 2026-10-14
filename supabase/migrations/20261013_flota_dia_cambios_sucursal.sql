-- Un camión puede cambiar de sucursal las veces que haga falta en el día.
-- cambios_sucursal = [{"desde_vuelta": 2, "sucursal": "Cañuelas"}, {"desde_vuelta": 3, "sucursal": "Guernica"}]
-- La sucursal de arranque sigue siendo flota_dia.sucursal (desde la vuelta 1).
alter table public.flota_dia
  add column if not exists cambios_sucursal jsonb not null default '[]'::jsonb;

-- Pasa el único cambio que permitía el esquema anterior a la lista nueva
update public.flota_dia
set cambios_sucursal = jsonb_build_array(jsonb_build_object(
      'desde_vuelta', coalesce(sucursal_extra_desde_vuelta, 2),
      'sucursal', sucursal_extra))
where sucursal_extra is not null and sucursal_extra <> ''
  and cambios_sucursal = '[]'::jsonb;

notify pgrst, 'reload schema';
