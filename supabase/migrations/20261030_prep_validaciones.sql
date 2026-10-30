-- Preparación: validación física de lo que hay que despachar, por sucursal, día de entrega y producto.
-- Reemplaza a la verificación contra el stock importado: el depósito dice qué tiene físicamente.
--   validada: cantidad acumulada que el depósito confirmó que tiene (si entran más pedidos, valida solo la diferencia)
--   faltante: cantidad que el depósito declaró que NO tiene (queda pendiente hasta que entre mercadería)
--   decision: qué se resolvió con el faltante ('transferencia' = se pidió a otra sucursal, 'esperar' = se espera mercadería)

create table if not exists public.prep_validaciones (
  id uuid primary key default gen_random_uuid(),
  sucursal text not null,
  fecha date not null,
  clave text not null,
  nombre text not null,
  codigo text,
  unidad text,
  validada numeric not null default 0 check (validada >= 0),
  faltante numeric not null default 0 check (faltante >= 0),
  validado_por uuid references auth.users(id),
  validado_en timestamptz,
  decision text check (decision in ('transferencia', 'esperar')),
  decision_nota text,
  decision_req_id uuid,
  decision_por uuid references auth.users(id),
  decision_en timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sucursal, fecha, clave)
);

create index if not exists prep_validaciones_fecha_idx on public.prep_validaciones (fecha, sucursal);

-- Quién puede validar: gerencia y admin de flota en cualquier sucursal; depósito solo en la suya
-- (o en todas si su usuario tiene "Todas las sucursales")
create or replace function public.puede_validar_prep(suc text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.tiene_rol(array['gerencia', 'admin_flota'])
      or (public.tiene_rol(array['deposito'])
          and exists (select 1 from public.usuarios u where u.id = auth.uid() and (u.sucursal is null or u.sucursal = suc)));
$$;

alter table public.prep_validaciones enable row level security;
drop policy if exists prep_validaciones_select on public.prep_validaciones;
drop policy if exists prep_validaciones_insert on public.prep_validaciones;
drop policy if exists prep_validaciones_update on public.prep_validaciones;
create policy prep_validaciones_select on public.prep_validaciones for select to authenticated using (true);
create policy prep_validaciones_insert on public.prep_validaciones for insert to authenticated
  with check (public.puede_validar_prep(sucursal));
create policy prep_validaciones_update on public.prep_validaciones for update to authenticated
  using (public.puede_validar_prep(sucursal)) with check (public.puede_validar_prep(sucursal));

create or replace function public.prep_validaciones_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists prep_validaciones_touch on public.prep_validaciones;
create trigger prep_validaciones_touch before update on public.prep_validaciones
  for each row execute function public.prep_validaciones_touch();

notify pgrst, 'reload schema';
