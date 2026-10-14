-- Roles combinados: un usuario tiene un rol principal (usuarios.rol) y puede tener roles
-- adicionales (usuarios.roles_extra). Los permisos son la unión de todos sus roles.
-- Ejemplo: Genaro Eloiza y Matías Albarracin son ruteador (principal) y depósito (adicional).

alter table public.usuarios
  add column if not exists roles_extra text[] not null default '{}';

alter table public.usuarios drop constraint if exists usuarios_roles_extra_check;
alter table public.usuarios add constraint usuarios_roles_extra_check
  check (roles_extra <@ array['gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial', 'confirmador', 'chofer', 'guardia', 'compras']::text[]);

-- ¿Tiene el usuario alguno de estos roles (principal o adicional)?
create or replace function public.tiene_rol(p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.usuarios u
    where u.id = auth.uid()
      and (u.rol = any (p_roles) or u.roles_extra && p_roles)
  )
$$;

grant execute on function public.tiene_rol(text[]) to authenticated;

-- Las reglas que miraban solo el rol principal (rol_actual() = ANY (ARRAY[...])) pasan a mirar todos los roles
do $$
declare
  pol record;
  q text;
  wc text;
  patron constant text := 'rol_actual\(\) = ANY \(ARRAY\[([^\]]*)\]\)';
begin
  for pol in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname in ('public', 'storage')
      and (qual ~ 'rol_actual\(\)' or with_check ~ 'rol_actual\(\)')
  loop
    q := case when pol.qual is null then null else regexp_replace(pol.qual, patron, 'public.tiene_rol(ARRAY[\1])', 'g') end;
    wc := case when pol.with_check is null then null else regexp_replace(pol.with_check, patron, 'public.tiene_rol(ARRAY[\1])', 'g') end;
    if q is not null and wc is not null then
      execute format('alter policy %I on %I.%I using (%s) with check (%s)', pol.policyname, pol.schemaname, pol.tablename, q, wc);
    elsif q is not null then
      execute format('alter policy %I on %I.%I using (%s)', pol.policyname, pol.schemaname, pol.tablename, q);
    elsif wc is not null then
      execute format('alter policy %I on %I.%I with check (%s)', pol.policyname, pol.schemaname, pol.tablename, wc);
    end if;
  end loop;
end $$;

-- Permiso de Compras: los roles gerencia, admin_flota y compras (principal o adicional) son editores
create or replace function public.permiso_compras()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when u.permisos->>'compras' = 'none' then 'none'
    when u.rol in ('gerencia', 'admin_flota', 'compras')
      or u.roles_extra && array['gerencia', 'admin_flota', 'compras'] then 'editor'
    when u.permisos->>'compras' = 'editor' then 'editor'
    when u.permisos->>'compras' = 'viewer' then 'viewer'
    else 'none'
  end
  from public.usuarios u
  where u.id = auth.uid()
$$;

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
        or u.roles_extra && array['gerencia', 'admin_flota']
        or (
          u.permisos->>'recepcion' = 'editor'
          and (coalesce(u.sucursal, '') = '' or u.sucursal = p_sucursal)
        )
      )
  )
$$;

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
  if v.validacion_estado <> 'pendiente'
     and v.validado_por is distinct from auth.uid()
     and not public.tiene_rol(array['gerencia', 'admin_flota']) then
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

-- Combinados que se piden hoy: ruteador + jefe de depósito
update public.usuarios
set roles_extra = array['deposito']
where email in ('geloiza@construyoalcosto.com', 'malbarracin@construyoalcosto.com');

-- Matías valida los ingresos de LP139 (Genaro ya tenía el permiso)
update public.usuarios
set permisos = coalesce(permisos, '{}'::jsonb) || jsonb_build_object('recepcion', 'editor')
where email = 'malbarracin@construyoalcosto.com';

notify pgrst, 'reload schema';
