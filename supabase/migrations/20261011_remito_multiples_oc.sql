-- Un remito puede traer productos de varias órdenes de compra

CREATE TABLE IF NOT EXISTS proveedor_remito_ocs (
  remito_id    uuid        NOT NULL REFERENCES proveedor_remitos(id) ON DELETE CASCADE,
  oc_id        integer     NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
  asociada_por uuid        REFERENCES auth.users(id),
  asociada_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (remito_id, oc_id)
);

CREATE INDEX IF NOT EXISTS proveedor_remito_ocs_oc_idx ON proveedor_remito_ocs (oc_id);

ALTER TABLE proveedor_remito_ocs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "remito_ocs_select" ON proveedor_remito_ocs FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));
CREATE POLICY "remito_ocs_insert" ON proveedor_remito_ocs FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));
CREATE POLICY "remito_ocs_delete" ON proveedor_remito_ocs FOR DELETE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));

-- Lo que ya estaba asociado pasa a la tabla nueva
INSERT INTO proveedor_remito_ocs (remito_id, oc_id, asociada_por, asociada_en)
SELECT id, oc_id, oc_asociada_por, COALESCE(oc_asociada_en, now())
FROM proveedor_remitos
WHERE oc_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- proveedor_remitos.oc_id queda en desuso (se mantiene un tiempo para no romper versiones anteriores de la app)
COMMENT ON COLUMN proveedor_remitos.oc_id IS 'En desuso: las OC de un remito están en proveedor_remito_ocs';
