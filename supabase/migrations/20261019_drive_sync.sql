-- Registro de la sincronización automática con la carpeta de Drive donde Huemul deja los exports
-- (compras_AAAAMMDD_HHMM.xlsx = órdenes de compra, compras_ingreso_AAAAMMDD_HHMM.xlsx = ingresos).
-- Lo escribe la API con la clave de servicio; Compras lo lee para mostrar cómo viene la sincronización.

create table if not exists public.drive_sync_log (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('ingresos', 'oc', 'general')),
  archivo text,
  exportado_en timestamptz,
  procesado_en timestamptz not null default now(),
  ok boolean not null default true,
  omitido boolean not null default false,
  origen text,                 -- cron | manual
  detalle jsonb
);

create index if not exists drive_sync_log_tipo_idx on public.drive_sync_log (tipo, procesado_en desc);

alter table public.drive_sync_log enable row level security;

drop policy if exists drive_sync_log_select on public.drive_sync_log;
create policy drive_sync_log_select on public.drive_sync_log for select
  using (public.permiso_compras() in ('editor', 'viewer'));

notify pgrst, 'reload schema';
