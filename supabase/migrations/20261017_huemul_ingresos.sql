-- Ingresos de mercadería cargados en Huemul (ERP). Se importan desde el export
-- compras_ingreso_AAAAMMDD_HHMM.xlsx (una fila por línea de producto) para verificar contra los
-- remitos que registró guardia: ¿quedaron remitos sin cargar en Huemul?

create table if not exists public.huemul_importaciones (
  id uuid primary key default gen_random_uuid(),
  archivo text not null,
  exportado_en timestamptz,          -- fecha y hora del export, tomada del nombre del archivo
  importado_en timestamptz not null default now(),
  importado_por uuid,
  filas integer not null default 0,
  ingresos integer not null default 0,
  fecha_desde date,
  fecha_hasta date
);

create table if not exists public.huemul_ingresos (
  id uuid primary key default gen_random_uuid(),
  numero_ingreso integer not null,
  linea integer not null,             -- orden de la línea dentro del ingreso, en el archivo
  numero_remito text,
  punto_remito bigint,                -- punto de venta del remito, sin ceros (null si no tiene)
  nro_remito bigint,                  -- número del remito, sin ceros (null si es "s/n")
  sin_numero boolean not null default false,
  numero_factura text,
  fecha date,
  acopio boolean not null default false,
  codigo_producto integer,
  descripcion text,
  proveedor text,
  proveedor_clave text,               -- nombre del proveedor normalizado, para cruzar
  proveedor_id uuid,                  -- proveedor de la app, si se pudo vincular
  cantidad numeric,
  precio_unitario numeric,
  precio_total numeric,
  usuario text,
  deposito text,
  sucursal text,
  compra integer,                     -- número de la orden de compra
  importacion_id uuid references public.huemul_importaciones(id) on delete set null,
  importado_en timestamptz not null default now(),
  unique (numero_ingreso, linea)
);

create index if not exists huemul_ingresos_remito_idx on public.huemul_ingresos (proveedor_clave, nro_remito);
create index if not exists huemul_ingresos_fecha_idx on public.huemul_ingresos (fecha);
create index if not exists huemul_ingresos_sucursal_idx on public.huemul_ingresos (sucursal);

alter table public.huemul_importaciones enable row level security;
alter table public.huemul_ingresos enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['huemul_importaciones', 'huemul_ingresos'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select using (public.permiso_compras() in (''editor'', ''viewer''))', t || '_select', t);
    execute format('create policy %I on public.%I for insert with check (public.permiso_compras() = ''editor'')', t || '_insert', t);
    execute format('create policy %I on public.%I for update using (public.permiso_compras() = ''editor'')', t || '_update', t);
    execute format('create policy %I on public.%I for delete using (public.permiso_compras() = ''editor'')', t || '_delete', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
