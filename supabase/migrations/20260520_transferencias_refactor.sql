-- ============================================================
-- MIGRACIÓN: Refactor Transferencias + Catalog + Fleet type
-- Fecha: 2026-05-20
-- Ejecutar en: Supabase SQL Editor (con rol service_role)
-- ============================================================

-- -----------------------------------------------------------
-- 1. sd_decisiones
--    Decisiones por solicitud (o por item) sobre las SDs importadas.
--    Nivel solicitud: id_producto IS NULL
--    Nivel item:      id_producto IS NOT NULL (override)
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sd_decisiones (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  id_solicitud      integer NOT NULL,
  id_producto       integer,           -- NULL = nivel solicitud; set = nivel item
  tipo              text NOT NULL CHECK (tipo IN ('aprobado', 'reasignado', 'rechazado')),
  sucursal_asignada text NOT NULL DEFAULT '',
  fecha_sd          date,              -- fecha_despacho de la solicitud
  operador          text,              -- email del usuario
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Partial unique indexes (permite NULL en id_producto)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sd_dec_sol_nivel_sol
  ON public.sd_decisiones (id_solicitud)
  WHERE id_producto IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sd_dec_sol_nivel_item
  ON public.sd_decisiones (id_solicitud, id_producto)
  WHERE id_producto IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sd_dec_fecha  ON public.sd_decisiones (fecha_sd);
CREATE INDEX IF NOT EXISTS idx_sd_dec_tipo   ON public.sd_decisiones (tipo);

DROP TRIGGER IF EXISTS trg_sd_decisiones_updated ON public.sd_decisiones;
CREATE TRIGGER trg_sd_decisiones_updated
  BEFORE UPDATE ON public.sd_decisiones
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------
-- 2. productos_catalogo
--    Catálogo de productos del ERP con flag activo.
--    Se reimporta desde Excel de productos (productos_export_*.xlsx).
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.productos_catalogo (
  id                  integer PRIMARY KEY,
  codigo_sku          text,
  nombre              text NOT NULL,
  activo              boolean NOT NULL DEFAULT true,
  descripcion         text,
  marca               text,
  tipo                text,
  categoria           text,
  subcategoria        text,
  unidad_medida       text,
  unidad_venta        text,
  codigo_transporte   text,
  posiciones_camion   numeric,
  importado_en        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cat_activo ON public.productos_catalogo (activo);
CREATE INDEX IF NOT EXISTS idx_cat_nombre ON public.productos_catalogo USING gin(to_tsvector('spanish', nombre));

-- -----------------------------------------------------------
-- 3. camiones_flota: agregar campo tipo
--    'cliente'       → puede hacer entregas a clientes Y transferencias
--    'abastecimiento'→ exclusivo para transferencias entre depósitos
-- -----------------------------------------------------------
ALTER TABLE public.camiones_flota
  ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'cliente'
  CHECK (tipo IN ('cliente', 'abastecimiento'));

-- -----------------------------------------------------------
-- 4. RLS desactivado (acceso server-side con service_role)
-- -----------------------------------------------------------
ALTER TABLE public.sd_decisiones      DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.productos_catalogo DISABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------
-- Verificar con:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name IN ('sd_decisiones','productos_catalogo');
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'camiones_flota' AND column_name = 'tipo';
-- -----------------------------------------------------------
