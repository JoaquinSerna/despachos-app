-- El permiso individual del módulo Compras (Usuarios → permisos) pasa a valer también en la base
-- de datos, no solo en la pantalla:
--   editor → acceso total (leer, crear, editar y borrar) a todo Compras
--   viewer → solo lectura
--   none   → sin acceso (incluso si el rol lo tendría por defecto)
-- Los roles gerencia, admin_flota y compras siguen siendo editores por defecto.
-- Guardia, depósito y ruteador conservan lo que ya podían hacer (cargar ingresos y remitos).

create or replace function public.permiso_compras()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when u.permisos->>'compras' = 'none' then 'none'
    when u.rol in ('gerencia', 'admin_flota', 'compras') then 'editor'
    when u.permisos->>'compras' = 'editor' then 'editor'
    when u.permisos->>'compras' = 'viewer' then 'viewer'
    else 'none'
  end
  from public.usuarios u
  where u.id = auth.uid()
$$;

grant execute on function public.permiso_compras() to authenticated;

-- ── Tablas que solo usa Compras ────────────────────────────────────────────
do $$
declare
  t record;
begin
  for t in
    select * from (values
      ('ordenes_compra',          'oc'),
      ('ordenes_compra_items',    'oc_items'),
      ('producto_alias_proveedor','alias_prov'),
      ('proveedor_remito_items',  'remito_items')
    ) as x(tabla, pref)
  loop
    execute format('drop policy if exists %I on public.%I', t.pref || '_select', t.tabla);
    execute format('drop policy if exists %I on public.%I', t.pref || '_insert', t.tabla);
    execute format('drop policy if exists %I on public.%I', t.pref || '_update', t.tabla);
    execute format('drop policy if exists %I on public.%I', t.pref || '_delete', t.tabla);
    execute format('create policy %I on public.%I for select using (public.permiso_compras() in (''editor'', ''viewer''))', t.pref || '_select', t.tabla);
    execute format('create policy %I on public.%I for insert with check (public.permiso_compras() = ''editor'')', t.pref || '_insert', t.tabla);
    execute format('create policy %I on public.%I for update using (public.permiso_compras() = ''editor'')', t.pref || '_update', t.tabla);
    execute format('create policy %I on public.%I for delete using (public.permiso_compras() = ''editor'')', t.pref || '_delete', t.tabla);
  end loop;
end $$;

-- ── Remito ↔ OC: lo leen también guardia/depósito/ruteador ─────────────────
drop policy if exists remito_ocs_select on public.proveedor_remito_ocs;
drop policy if exists remito_ocs_insert on public.proveedor_remito_ocs;
drop policy if exists remito_ocs_delete on public.proveedor_remito_ocs;
create policy remito_ocs_select on public.proveedor_remito_ocs for select
  using (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() in ('editor', 'viewer'));
create policy remito_ocs_insert on public.proveedor_remito_ocs for insert
  with check (public.permiso_compras() = 'editor');
create policy remito_ocs_delete on public.proveedor_remito_ocs for delete
  using (public.permiso_compras() = 'editor');

-- ── Ingresos de proveedores ────────────────────────────────────────────────
drop policy if exists ingresos_select on public.proveedor_ingresos;
drop policy if exists ingresos_insert on public.proveedor_ingresos;
drop policy if exists ingresos_update on public.proveedor_ingresos;
drop policy if exists ingresos_delete on public.proveedor_ingresos;
create policy ingresos_select on public.proveedor_ingresos for select
  using (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() in ('editor', 'viewer'));
create policy ingresos_insert on public.proveedor_ingresos for insert
  with check (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() = 'editor');
create policy ingresos_update on public.proveedor_ingresos for update
  using (public.permiso_compras() = 'editor' or registrado_por = auth.uid());
create policy ingresos_delete on public.proveedor_ingresos for delete
  using (public.permiso_compras() = 'editor' or (registrado_por = auth.uid() and created_at > now() - interval '24 hours'));

-- ── Remitos ────────────────────────────────────────────────────────────────
drop policy if exists remitos_select on public.proveedor_remitos;
drop policy if exists remitos_insert on public.proveedor_remitos;
drop policy if exists remitos_update on public.proveedor_remitos;
create policy remitos_select on public.proveedor_remitos for select
  using (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() in ('editor', 'viewer'));
create policy remitos_insert on public.proveedor_remitos for insert
  with check (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() = 'editor');
create policy remitos_update on public.proveedor_remitos for update
  using (
    public.permiso_compras() = 'editor'
    or exists (select 1 from public.proveedor_ingresos i where i.id = proveedor_remitos.ingreso_id and i.registrado_por = auth.uid())
  );

-- ── Proveedores (los de guardia/depósito/ruteador entran como "pendiente") ──
drop policy if exists proveedores_select on public.proveedores;
drop policy if exists proveedores_insert on public.proveedores;
drop policy if exists proveedores_update on public.proveedores;
create policy proveedores_select on public.proveedores for select
  using (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() in ('editor', 'viewer'));
create policy proveedores_insert on public.proveedores for insert
  with check (
    public.permiso_compras() = 'editor'
    or (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) and estado = 'pendiente')
  );
create policy proveedores_update on public.proveedores for update
  using (public.permiso_compras() = 'editor');

-- ── Fotos de remitos (almacenamiento) ──────────────────────────────────────
drop policy if exists compras_remitos_select on storage.objects;
drop policy if exists compras_remitos_insert on storage.objects;
drop policy if exists compras_remitos_update on storage.objects;
drop policy if exists compras_remitos_delete on storage.objects;
create policy compras_remitos_select on storage.objects for select
  using (bucket_id = 'compras-remitos'
    and (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() in ('editor', 'viewer')));
create policy compras_remitos_insert on storage.objects for insert
  with check (bucket_id = 'compras-remitos'
    and (public.rol_actual() = any (array['guardia', 'deposito', 'ruteador']) or public.permiso_compras() = 'editor'));
create policy compras_remitos_update on storage.objects for update
  using (bucket_id = 'compras-remitos' and public.permiso_compras() = 'editor');
create policy compras_remitos_delete on storage.objects for delete
  using (bucket_id = 'compras-remitos' and public.permiso_compras() = 'editor');

notify pgrst, 'reload schema';
