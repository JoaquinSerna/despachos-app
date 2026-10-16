-- Taller: pausas de un trabajo en curso (otra urgencia, imprevistos, almuerzo...). El tiempo pausado se descuenta
-- del tiempo transcurrido de la orden. Requiere 20261008_taller.sql.

create table if not exists public.taller_pausas (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  orden_id uuid not null references public.taller_ordenes(id) on delete cascade,
  inicio timestamptz not null default now(),
  fin timestamptz,
  motivo text not null,
  registrado_por uuid references auth.users(id)
);

create index if not exists taller_pausas_orden_idx on public.taller_pausas (orden_id);

alter table public.taller_pausas enable row level security;
drop policy if exists taller_pausas_select on public.taller_pausas;
drop policy if exists taller_pausas_insert on public.taller_pausas;
drop policy if exists taller_pausas_update on public.taller_pausas;
drop policy if exists taller_pausas_delete on public.taller_pausas;
create policy taller_pausas_select on public.taller_pausas for select to authenticated using (true);
create policy taller_pausas_insert on public.taller_pausas for insert to authenticated with check (true);
create policy taller_pausas_update on public.taller_pausas for update to authenticated using (true);
create policy taller_pausas_delete on public.taller_pausas for delete to authenticated
  using (public.tiene_rol(array['gerencia', 'admin_flota', 'admin_taller']));

alter table public.taller_ordenes add column if not exists minutos_pausa int not null default 0;

notify pgrst, 'reload schema';
