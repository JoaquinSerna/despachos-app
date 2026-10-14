-- Check manual "Lo cargué en Huemul": quien carga los ingresos en Huemul marca cada remito como
-- cargado, aunque después se confirme (o no) con el export. Se guarda quién y cuándo.
--   permisos.huemul = 'editor' → puede marcar (gerencia, admin de flota y compras también)

alter table public.proveedor_remitos
  add column if not exists huemul_cargado_por uuid,
  add column if not exists huemul_cargado_en timestamptz;

-- ¿Puede marcar remitos como cargados en Huemul?
create or replace function public.puede_marcar_huemul()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.permiso_compras() = 'editor'
    or exists (
      select 1 from public.usuarios u
      where u.id = auth.uid() and u.permisos->>'huemul' = 'editor'
    )
$$;

grant execute on function public.puede_marcar_huemul() to authenticated;

-- Con el permiso huemul = editor se puede ver Compras (solo lectura) para encontrar los remitos a marcar
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
    when u.permisos->>'huemul' = 'editor' then 'viewer'
    else 'none'
  end
  from public.usuarios u
  where u.id = auth.uid()
$$;

-- Las columnas del check solo se escriben con marcar_remito_huemul(): quien registró el ingreso
-- en guardia no puede marcarlo como cargado con un update directo.
create or replace function public.proteger_marca_huemul()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.huemul_cargado_por := null;
    new.huemul_cargado_en := null;
  elsif coalesce(current_setting('app.marcando_huemul', true), '') <> 'on' and (
      new.huemul_cargado_por is distinct from old.huemul_cargado_por
      or new.huemul_cargado_en is distinct from old.huemul_cargado_en
  ) then
    raise exception 'La marca de Huemul solo se registra desde Compras';
  end if;
  return new;
end;
$$;

drop trigger if exists proteger_marca_huemul on public.proveedor_remitos;
create trigger proteger_marca_huemul
  before insert or update on public.proveedor_remitos
  for each row execute function public.proteger_marca_huemul();

create or replace function public.marcar_remito_huemul(p_remito uuid, p_cargado boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.puede_marcar_huemul() then
    raise exception 'No tenés permiso para marcar remitos como cargados en Huemul';
  end if;
  perform set_config('app.marcando_huemul', 'on', true);
  update public.proveedor_remitos
  set huemul_cargado_por = case when p_cargado then auth.uid() else null end,
      huemul_cargado_en = case when p_cargado then now() else null end
  where id = p_remito;
  if not found then
    perform set_config('app.marcando_huemul', 'off', true);
    raise exception 'El remito no existe';
  end if;
  perform set_config('app.marcando_huemul', 'off', true);
end;
$$;

grant execute on function public.marcar_remito_huemul(uuid, boolean) to authenticated;

-- Quien hace los ingresos en Huemul
update public.usuarios
set permisos = coalesce(permisos, '{}'::jsonb) || jsonb_build_object('huemul', 'editor')
where email = 'jstranieri@construyoalcosto.com';

notify pgrst, 'reload schema';
