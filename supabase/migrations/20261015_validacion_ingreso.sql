-- Recepción de mercadería: después del ingreso de guardia, el jefe de depósito/playa de la sucursal
-- valida el ingreso y aclara si hay mercadería rota (nota y fotos).
--   validacion_estado: null = ingreso anterior a esta función (no se valida) | pendiente | ok | con_rotura
-- Los ingresos que ya existían quedan en null; los nuevos nacen "pendiente".

alter table public.proveedor_ingresos
  add column if not exists validacion_estado text check (validacion_estado in ('pendiente', 'ok', 'con_rotura')),
  add column if not exists validado_por uuid,
  add column if not exists validado_en timestamptz,
  add column if not exists validacion_nota text,
  add column if not exists validacion_fotos text[] not null default '{}';

alter table public.proveedor_ingresos alter column validacion_estado set default 'pendiente';

create index if not exists proveedor_ingresos_validacion_idx
  on public.proveedor_ingresos (sucursal, validacion_estado);

-- ¿Puede el usuario validar ingresos de esta sucursal?
--   gerencia y admin_flota: todas. Resto: permiso individual "recepcion" = editor, en su sucursal
--   (o en todas si no tiene sucursal asignada).
create or replace function public.puede_validar_ingreso(p_sucursal text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid()
      and (
        u.rol in ('gerencia', 'admin_flota')
        or (
          u.permisos->>'recepcion' = 'editor'
          and (coalesce(u.sucursal, '') = '' or u.sucursal = p_sucursal)
        )
      )
  )
$$;

grant execute on function public.puede_validar_ingreso(text) to authenticated;

-- Las columnas de validación solo se escriben a través de validar_ingreso():
-- evita que alguien (por ejemplo quien registró el ingreso) se valide a sí mismo.
create or replace function public.proteger_validacion_ingreso()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.validacion_estado := 'pendiente';
    new.validado_por := null;
    new.validado_en := null;
    new.validacion_nota := null;
    new.validacion_fotos := '{}';
  elsif coalesce(current_setting('app.validando', true), '') <> 'on' and (
      new.validacion_estado is distinct from old.validacion_estado
      or new.validado_por is distinct from old.validado_por
      or new.validado_en is distinct from old.validado_en
      or new.validacion_nota is distinct from old.validacion_nota
      or new.validacion_fotos is distinct from old.validacion_fotos
  ) then
    raise exception 'La validación del ingreso solo se puede registrar desde Recepción';
  end if;
  return new;
end;
$$;

drop trigger if exists proteger_validacion_ingreso on public.proveedor_ingresos;
create trigger proteger_validacion_ingreso
  before insert or update on public.proveedor_ingresos
  for each row execute function public.proteger_validacion_ingreso();

create or replace function public.validar_ingreso(
  p_ingreso uuid,
  p_estado text,
  p_nota text default null,
  p_fotos text[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v public.proveedor_ingresos;
  fotos text[] := coalesce(p_fotos, '{}');
begin
  if p_estado not in ('ok', 'con_rotura') then
    raise exception 'Estado de validación inválido';
  end if;
  select * into v from public.proveedor_ingresos where id = p_ingreso for update;
  if not found then
    raise exception 'El ingreso no existe';
  end if;
  if not public.puede_validar_ingreso(v.sucursal) then
    raise exception 'No tenés permiso para validar ingresos de %', v.sucursal;
  end if;
  if v.validacion_estado is null then
    raise exception 'Este ingreso es anterior a la validación y no se valida';
  end if;
  -- Solo se valida una vez; después solo puede corregir quien lo validó o gerencia/admin de flota
  if v.validacion_estado <> 'pendiente'
     and v.validado_por is distinct from auth.uid()
     and coalesce(public.rol_actual(), '') not in ('gerencia', 'admin_flota') then
    raise exception 'Este ingreso ya fue validado por otra persona';
  end if;
  if p_estado = 'con_rotura' and coalesce(btrim(p_nota), '') = '' then
    raise exception 'Aclará qué mercadería llegó rota';
  end if;
  if exists (select 1 from unnest(fotos) f where f not like p_ingreso::text || '/%') then
    raise exception 'Las fotos no corresponden a este ingreso';
  end if;

  perform set_config('app.validando', 'on', true);
  update public.proveedor_ingresos
  set validacion_estado = p_estado,
      validado_por = auth.uid(),
      validado_en = now(),
      validacion_nota = nullif(btrim(p_nota), ''),
      validacion_fotos = case when p_estado = 'con_rotura' then fotos else '{}' end
  where id = p_ingreso;
  perform set_config('app.validando', 'off', true);
end;
$$;

grant execute on function public.validar_ingreso(uuid, text, text, text[]) to authenticated;

-- Jefes de depósito/playa que validan los ingresos de su sucursal
update public.usuarios
set permisos = coalesce(permisos, '{}'::jsonb) || jsonb_build_object('recepcion', 'editor')
where email in (
  'narrieta@construyoalcosto.com',
  'gmolina@construyoalcosto.com',
  'lleonardi@construyoalcosto.com',
  'ecampana@construyoalcosto.com',
  'gdacunha@construyoal.costo.com',
  'geloiza@construyoalcosto.com'
);

notify pgrst, 'reload schema';
