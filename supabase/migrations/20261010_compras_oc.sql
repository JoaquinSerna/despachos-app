-- Compras: órdenes de compra importadas del ERP y asociación con remitos

CREATE TABLE IF NOT EXISTS ordenes_compra (
  id                  integer     PRIMARY KEY,           -- número de OC en el ERP
  estado              text        NOT NULL,              -- waiting_reception | confirmed | cancelled | draft
  proveedor_id        uuid        REFERENCES proveedores(id),
  proveedor_nombre    text,
  cuit                text,
  deposito            text,
  sucursal            text,
  numero_factura      text,
  total               numeric,
  comprado_por        text,
  observaciones       text,
  fecha_creacion      timestamptz,
  fecha_actualizacion timestamptz,
  importado_en        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ordenes_compra_busqueda_idx ON ordenes_compra (proveedor_id, sucursal, estado);

CREATE TABLE IF NOT EXISTS ordenes_compra_items (
  id                bigserial   PRIMARY KEY,
  oc_id             integer     NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  codigo_producto   integer,
  nombre_producto   text,
  marca             text,
  cantidad          numeric,
  cantidad_recibida numeric     NOT NULL DEFAULT 0,
  costo_unitario    numeric
);

CREATE INDEX IF NOT EXISTS ordenes_compra_items_oc_idx ON ordenes_compra_items (oc_id);

ALTER TABLE proveedor_remitos
  ADD COLUMN IF NOT EXISTS oc_id           integer REFERENCES ordenes_compra(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sin_oc          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS oc_asociada_por uuid    REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS oc_asociada_en  timestamptz;

CREATE INDEX IF NOT EXISTS proveedor_remitos_oc_idx ON proveedor_remitos (oc_id);

ALTER TABLE ordenes_compra       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes_compra_items ENABLE ROW LEVEL SECURITY;

-- Solo administración de compras (gerencia, admin_flota, compras)
CREATE POLICY "oc_select" ON ordenes_compra FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "oc_insert" ON ordenes_compra FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "oc_update" ON ordenes_compra FOR UPDATE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "oc_delete" ON ordenes_compra FOR DELETE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));

CREATE POLICY "oc_items_select" ON ordenes_compra_items FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "oc_items_insert" ON ordenes_compra_items FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "oc_items_update" ON ordenes_compra_items FOR UPDATE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "oc_items_delete" ON ordenes_compra_items FOR DELETE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));

-- ── Etapa 2: productos leídos del remito, mapeados al catálogo ──────────────────────────────

ALTER TABLE proveedor_remitos
  ADD COLUMN IF NOT EXISTS items_estado    text NOT NULL DEFAULT 'pendiente' CHECK (items_estado IN ('pendiente', 'ok', 'error')),
  ADD COLUMN IF NOT EXISTS items_leidos_en timestamptz;

CREATE TABLE IF NOT EXISTS proveedor_remito_items (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  remito_id        uuid        NOT NULL REFERENCES proveedor_remitos(id) ON DELETE CASCADE,
  orden            int         NOT NULL DEFAULT 0,
  descripcion      text        NOT NULL,
  codigo_proveedor text,
  cantidad         numeric,
  unidad           text,                 -- normalizada (tn, kg, pallet, unidad, bolsa, ...)
  unidad_original  text,                 -- tal como figura en el remito
  producto_id      integer,              -- productos_catalogo.id (= código del ERP)
  mapeo_origen     text        NOT NULL DEFAULT 'ninguno' CHECK (mapeo_origen IN ('alias', 'auto', 'manual', 'ninguno')),
  mapeo_score      numeric,
  sugerencias      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  cantidad_base    numeric,              -- cantidad convertida a la unidad base del producto
  unidad_base      text,
  regla_conversion text
);

CREATE INDEX IF NOT EXISTS proveedor_remito_items_remito_idx ON proveedor_remito_items (remito_id);

-- Lo que Compras confirma a mano se aprende: la próxima vez ese texto de ese proveedor se mapea solo
CREATE TABLE IF NOT EXISTS producto_alias_proveedor (
  id           uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   timestamptz DEFAULT now(),
  proveedor_id uuid        NOT NULL REFERENCES proveedores(id) ON DELETE CASCADE,
  texto_norm   text        NOT NULL,
  producto_id  integer     NOT NULL,
  creado_por   uuid        REFERENCES auth.users(id),
  UNIQUE (proveedor_id, texto_norm)
);

ALTER TABLE proveedor_remito_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE producto_alias_proveedor ENABLE ROW LEVEL SECURITY;

CREATE POLICY "remito_items_select" ON proveedor_remito_items FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "remito_items_insert" ON proveedor_remito_items FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "remito_items_update" ON proveedor_remito_items FOR UPDATE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "remito_items_delete" ON proveedor_remito_items FOR DELETE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));

CREATE POLICY "alias_prov_select" ON producto_alias_proveedor FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "alias_prov_insert" ON producto_alias_proveedor FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "alias_prov_update" ON producto_alias_proveedor FOR UPDATE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "alias_prov_delete" ON producto_alias_proveedor FOR DELETE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
