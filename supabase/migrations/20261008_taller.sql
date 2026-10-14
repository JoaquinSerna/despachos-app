-- Módulo Taller: órdenes de trabajo con inicio/cierre, tareas con tiempos, catálogo con tiempo estándar

CREATE TABLE IF NOT EXISTS taller_mecanicos (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  timestamptz DEFAULT now(),
  nombre      text        NOT NULL,
  sucursal    text,
  activo      boolean     NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS taller_catalogo (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  grupo            text        NOT NULL,   -- service | camion | hidrogrua | acoplado | general
  sistema          text        NOT NULL,
  nombre           text        NOT NULL,
  minutos_estandar int         CHECK (minutos_estandar IS NULL OR minutos_estandar > 0),
  orden            int         NOT NULL DEFAULT 0,
  activo           boolean     NOT NULL DEFAULT true,
  UNIQUE (grupo, sistema, nombre)
);

CREATE TABLE IF NOT EXISTS taller_ordenes (
  id                   uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at           timestamptz DEFAULT now(),
  fecha                date        NOT NULL,
  sucursal             text        NOT NULL,
  unidad_codigo        text        NOT NULL,
  unidad_externa       boolean     NOT NULL DEFAULT false,
  tipo                 text        NOT NULL CHECK (tipo IN ('preventivo', 'correctivo', 'auxilio')),
  estado               text        NOT NULL DEFAULT 'abierta' CHECK (estado IN ('abierta', 'cerrada')),
  inicio               timestamptz NOT NULL,
  fin                  timestamptz,
  minutos_transcurridos int,
  minutos_trabajados   int,
  diferencia_min       int,
  motivo_diferencia    text,
  mecanicos            text[]      NOT NULL DEFAULT '{}',
  observacion          text,
  observacion_cierre   text,
  fotos_antes          text[]      NOT NULL DEFAULT '{}',
  fotos_despues        text[]      NOT NULL DEFAULT '{}',
  registrado_por       uuid        REFERENCES auth.users(id),
  cerrado_por          uuid        REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS taller_ordenes_fecha_idx  ON taller_ordenes (fecha);
CREATE INDEX IF NOT EXISTS taller_ordenes_estado_idx ON taller_ordenes (estado);

CREATE TABLE IF NOT EXISTS taller_orden_tareas (
  id               uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  orden_id         uuid        NOT NULL REFERENCES taller_ordenes(id) ON DELETE CASCADE,
  catalogo_id      uuid        REFERENCES taller_catalogo(id) ON DELETE SET NULL,
  grupo            text        NOT NULL,
  sistema          text        NOT NULL,
  nombre           text        NOT NULL,
  personalizada    boolean     NOT NULL DEFAULT false,
  minutos          int         CHECK (minutos IS NULL OR minutos >= 0),
  minutos_estandar int
);

CREATE INDEX IF NOT EXISTS taller_orden_tareas_orden_idx ON taller_orden_tareas (orden_id);

ALTER TABLE taller_mecanicos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE taller_catalogo     ENABLE ROW LEVEL SECURITY;
ALTER TABLE taller_ordenes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE taller_orden_tareas ENABLE ROW LEVEL SECURITY;

-- Lectura, alta y modificación: cualquier usuario autenticado (el acceso al módulo lo controla la app)
CREATE POLICY "taller_ordenes_select" ON taller_ordenes FOR SELECT TO authenticated USING (true);
CREATE POLICY "taller_ordenes_insert" ON taller_ordenes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "taller_ordenes_update" ON taller_ordenes FOR UPDATE TO authenticated USING (true);

CREATE POLICY "taller_tareas_select" ON taller_orden_tareas FOR SELECT TO authenticated USING (true);
CREATE POLICY "taller_tareas_insert" ON taller_orden_tareas FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "taller_tareas_update" ON taller_orden_tareas FOR UPDATE TO authenticated USING (true);
CREATE POLICY "taller_tareas_delete" ON taller_orden_tareas FOR DELETE TO authenticated USING (true);

CREATE POLICY "taller_mecanicos_select" ON taller_mecanicos FOR SELECT TO authenticated USING (true);
CREATE POLICY "taller_mecanicos_insert" ON taller_mecanicos FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "taller_mecanicos_update" ON taller_mecanicos FOR UPDATE TO authenticated USING (true);

CREATE POLICY "taller_catalogo_select" ON taller_catalogo FOR SELECT TO authenticated USING (true);

-- Borrar órdenes y editar el catálogo: solo gerencia / admin_flota
CREATE POLICY "taller_ordenes_delete" ON taller_ordenes
  FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM usuarios WHERE id = auth.uid() AND rol = 'gerencia'));

CREATE POLICY "taller_catalogo_insert" ON taller_catalogo
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM usuarios WHERE id = auth.uid() AND rol IN ('gerencia', 'admin_flota')));

CREATE POLICY "taller_catalogo_update" ON taller_catalogo
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM usuarios WHERE id = auth.uid() AND rol IN ('gerencia', 'admin_flota')));

-- Fotos (antes / después)
INSERT INTO storage.buckets (id, name, public)
VALUES ('taller-fotos', 'taller-fotos', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "taller_fotos_select" ON storage.objects;
CREATE POLICY "taller_fotos_select" ON storage.objects
  FOR SELECT USING (bucket_id = 'taller-fotos');

DROP POLICY IF EXISTS "taller_fotos_insert" ON storage.objects;
CREATE POLICY "taller_fotos_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'taller-fotos');

DROP POLICY IF EXISTS "taller_fotos_update" ON storage.objects;
CREATE POLICY "taller_fotos_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'taller-fotos');

-- Catálogo inicial (minutos_estandar queda vacío: se completa desde la pestaña Catálogo)
INSERT INTO taller_catalogo (grupo, sistema, nombre, orden)
SELECT g, s, n, (row_number() OVER ())::int
FROM (VALUES
  ('service', 'Service', 'Cambio de aceite de motor'),
  ('service', 'Service', 'Cambio de filtro de aceite'),
  ('service', 'Service', 'Cambio de filtro de aire'),
  ('service', 'Service', 'Cambio de filtro de combustible'),
  ('service', 'Service', 'Cambio de filtro de habitáculo'),
  ('service', 'Service', 'Control de nivel de refrigerante'),
  ('service', 'Service', 'Control de aceite hidráulico (dirección)'),
  ('service', 'Service', 'Control de aceite de caja y diferencial'),
  ('service', 'Service', 'Control de ATF (transmisión automática)'),
  ('service', 'Service', 'Revisión y regulación de frenos'),
  ('service', 'Service', 'Engrase general de articulaciones'),
  ('service', 'Service', 'Control de batería y electrolito'),
  ('service', 'Service', 'Control y ajuste de correas'),
  ('service', 'Service', 'Revisión de luces y señales'),
  ('service', 'Service', 'Control de presión de neumáticos'),
  ('service', 'Service', 'Limpieza de filtro de aire del motor'),
  ('camion', 'Sistema eléctrico', 'Cambio de lámparas'),
  ('camion', 'Sistema eléctrico', 'Reparación de bocina'),
  ('camion', 'Sistema eléctrico', 'Revisión de fusibles y relays'),
  ('camion', 'Sistema eléctrico', 'Reparación / cambio de alternador'),
  ('camion', 'Sistema eléctrico', 'Reparación de cables'),
  ('camion', 'Sistema eléctrico', 'Arreglo de horométro'),
  ('camion', 'Sistema eléctrico', 'Reparación de comando de luces'),
  ('camion', 'Sistema eléctrico', 'Reparación de arranque (burro)'),
  ('camion', 'Sistema eléctrico', 'Reparación de cortacorriente'),
  ('camion', 'Frenos', 'Cambio / reparación de mangueras de aire'),
  ('camion', 'Frenos', 'Cambio de pulmón'),
  ('camion', 'Frenos', 'Cambio de válvula gobernadora'),
  ('camion', 'Frenos', 'Cambio de pastillas'),
  ('camion', 'Frenos', 'Regulación de frenos'),
  ('camion', 'Frenos', 'Reparación de freno de mano'),
  ('camion', 'Dirección / Tren delantero', 'Cambio de extremos de dirección'),
  ('camion', 'Dirección / Tren delantero', 'Cambio de bieletas y bujes'),
  ('camion', 'Dirección / Tren delantero', 'Cambio de barra de dirección'),
  ('camion', 'Dirección / Tren delantero', 'Reparación de tren delantero completo'),
  ('camion', 'Dirección / Tren delantero', 'Reparación de tren trasero'),
  ('camion', 'Dirección / Tren delantero', 'Cambio de perno y buje'),
  ('camion', 'Dirección / Tren delantero', 'Cambio de rótulas'),
  ('camion', 'Motor', 'Ajuste de válvulas'),
  ('camion', 'Motor', 'Cambio de correa / faja de distribución'),
  ('camion', 'Motor', 'Reparación de compresor de aire'),
  ('camion', 'Motor', 'Limpieza de motor'),
  ('camion', 'Motor', 'Reparación de bombin de combustible'),
  ('camion', 'Motor', 'Reparación de turbo'),
  ('camion', 'Motor', 'Cambio de junta de tapa de válvulas'),
  ('camion', 'Sistema hidráulico', 'Cambio de mangueras hidráulicas'),
  ('camion', 'Sistema hidráulico', 'Cambio de depósito hidráulico'),
  ('camion', 'Sistema hidráulico', 'Corrección de pérdidas de aceite'),
  ('camion', 'Sistema hidráulico', 'Adición de aceite hidráulico'),
  ('camion', 'Sistema hidráulico', 'Reparación de bomba'),
  ('camion', 'Caja / Embrague', 'Reparación / cambio de caja de velocidades'),
  ('camion', 'Caja / Embrague', 'Cambio de ruleman de empuje'),
  ('camion', 'Caja / Embrague', 'Cambio de embrague'),
  ('camion', 'Caja / Embrague', 'Cambio de retenes'),
  ('camion', 'Caja / Embrague', 'Cambio de palier'),
  ('camion', 'Caja / Embrague', 'Reparación de selectora de cambios'),
  ('camion', 'Refrigeración', 'Cambio de mangueras de agua'),
  ('camion', 'Refrigeración', 'Adición de refrigerante'),
  ('camion', 'Refrigeración', 'Reparación de junta soplada'),
  ('camion', 'Refrigeración', 'Limpieza del sistema'),
  ('camion', 'Carrocería / Soldadura', 'Soldadura de guardabarros'),
  ('camion', 'Carrocería / Soldadura', 'Reparación / soldadura de paragolpe'),
  ('camion', 'Carrocería / Soldadura', 'Soldadura de estribo'),
  ('camion', 'Carrocería / Soldadura', 'Reparación de caja de carga'),
  ('camion', 'Carrocería / Soldadura', 'Pintura'),
  ('camion', 'Carrocería / Soldadura', 'Reparación de compuertas'),
  ('camion', 'Carrocería / Soldadura', 'Cambio de espejo'),
  ('camion', 'Carrocería / Soldadura', 'Reparación de manija / cerradura'),
  ('camion', 'Cubiertas / Neumáticos', 'Cambio de rueda pinchada'),
  ('camion', 'Cubiertas / Neumáticos', 'Parche de cubierta'),
  ('camion', 'Cubiertas / Neumáticos', 'Colocación de rueda auxilio'),
  ('camion', 'Cubiertas / Neumáticos', 'Envío a gomería'),
  ('camion', 'Combustible', 'Reparación de bombin'),
  ('camion', 'Combustible', 'Corrección de pérdidas'),
  ('camion', 'Combustible', 'Reparación de sensor de nivel'),
  ('camion', 'Combustible', 'Cambio de tapas de depósito'),
  ('hidrogrua', 'Cilindros', 'Soldadura de cilindro de giro'),
  ('hidrogrua', 'Cilindros', 'Reparación de pérdidas'),
  ('hidrogrua', 'Cilindros', 'Cambio de cilindro'),
  ('hidrogrua', 'Cilindros', 'Reparación de vástago doblado'),
  ('hidrogrua', 'Mangueras y conexiones', 'Cambio de mangueras'),
  ('hidrogrua', 'Mangueras y conexiones', 'Reparación de conexiones y acoples'),
  ('hidrogrua', 'Mangueras y conexiones', 'Ajuste de abrazaderas'),
  ('hidrogrua', 'Válvulas', 'Cambio de válvula de bloqueo'),
  ('hidrogrua', 'Válvulas', 'Reparación de válvulas'),
  ('hidrogrua', 'Válvulas', 'Reajuste de conexión de válvula'),
  ('hidrogrua', 'Joystick / Mandos', 'Reparación de joystick'),
  ('hidrogrua', 'Joystick / Mandos', 'Cambio de comando'),
  ('hidrogrua', 'Joystick / Mandos', 'Revisión de controles'),
  ('hidrogrua', 'Estructura', 'Soldadura de pata de hidrogrúa'),
  ('hidrogrua', 'Estructura', 'Reparación de estructura'),
  ('hidrogrua', 'Estructura', 'Cambio de porta cruceta / cardan'),
  ('acoplado', 'Acoplado / Semi', 'Soldadura de lanza de tiro'),
  ('acoplado', 'Acoplado / Semi', 'Reparación de compuertas'),
  ('acoplado', 'Acoplado / Semi', 'Revisión y cambio de luces'),
  ('acoplado', 'Acoplado / Semi', 'Revisión de frenos'),
  ('acoplado', 'Acoplado / Semi', 'Pintura'),
  ('acoplado', 'Acoplado / Semi', 'Reparación de piso'),
  ('general', 'Taller / Infraestructura', 'Limpieza de playa de lavado'),
  ('general', 'Taller / Infraestructura', 'Fabricación de mesas / vallas'),
  ('general', 'Taller / Infraestructura', 'Mantenimiento de herramientas'),
  ('general', 'Taller / Infraestructura', 'Carga de batería'),
  ('general', 'Taller / Infraestructura', 'Trámites (VTV, documentación)')
) AS v(g, s, n)
ON CONFLICT (grupo, sistema, nombre) DO NOTHING;
