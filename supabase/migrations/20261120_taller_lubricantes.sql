-- Taller: carga rápida de lubricantes, aceites, agua y urea por unidad (reemplaza la planilla de consumos)

-- Productos que se cargan (se pueden agregar otros desde la app)
CREATE TABLE IF NOT EXISTS taller_lubricantes_prod (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  nombre     text        NOT NULL UNIQUE,
  familia    text        NOT NULL DEFAULT 'aceite' CHECK (familia IN ('aceite', 'urea', 'agua')),
  orden      int         NOT NULL DEFAULT 0,
  activo     boolean     NOT NULL DEFAULT true
);

-- Cada carga: qué unidad, qué producto, cuántos litros y por qué (service / consumo / auxilio)
CREATE TABLE IF NOT EXISTS taller_lubricantes (
  id             uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at     timestamptz DEFAULT now(),
  fecha          date        NOT NULL,
  sucursal       text        NOT NULL,
  unidad_codigo  text        NOT NULL,
  unidad_externa boolean     NOT NULL DEFAULT false,
  dominio        text,
  producto       text        NOT NULL,
  familia        text        NOT NULL DEFAULT 'aceite',
  litros         numeric     NOT NULL CHECK (litros > 0),
  motivo         text        NOT NULL CHECK (motivo IN ('service', 'consumo', 'auxilio')),
  mecanico       text,
  observacion    text,
  registrado_por uuid        REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS taller_lubricantes_fecha_idx ON taller_lubricantes (fecha);
CREATE INDEX IF NOT EXISTS taller_lubricantes_unidad_idx ON taller_lubricantes (unidad_codigo);

-- Dominio (patente) de cada unidad: se completa solo la primera vez que se carga
CREATE TABLE IF NOT EXISTS taller_dominios (
  unidad_codigo text PRIMARY KEY,
  dominio       text NOT NULL
);

ALTER TABLE taller_lubricantes_prod ENABLE ROW LEVEL SECURITY;
ALTER TABLE taller_lubricantes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE taller_dominios         ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tlub_prod_select" ON taller_lubricantes_prod FOR SELECT TO authenticated USING (true);
CREATE POLICY "tlub_prod_insert" ON taller_lubricantes_prod FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tlub_prod_update" ON taller_lubricantes_prod FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM usuarios WHERE id = auth.uid() AND rol IN ('gerencia', 'admin_flota', 'admin_taller')));

CREATE POLICY "tlub_select" ON taller_lubricantes FOR SELECT TO authenticated USING (true);
CREATE POLICY "tlub_insert" ON taller_lubricantes FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tlub_update" ON taller_lubricantes FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM usuarios WHERE id = auth.uid() AND rol IN ('gerencia', 'admin_flota', 'admin_taller')));
CREATE POLICY "tlub_delete" ON taller_lubricantes FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM usuarios WHERE id = auth.uid() AND rol IN ('gerencia', 'admin_flota', 'admin_taller')));

CREATE POLICY "tdom_select" ON taller_dominios FOR SELECT TO authenticated USING (true);
CREATE POLICY "tdom_insert" ON taller_dominios FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tdom_update" ON taller_dominios FOR UPDATE TO authenticated USING (true);

INSERT INTO taller_lubricantes_prod (nombre, familia, orden) VALUES
  ('15W40', 'aceite', 1), ('H68', 'aceite', 2), ('H46', 'aceite', 3), ('80W90', 'aceite', 4),
  ('5W30', 'aceite', 5), ('75W90', 'aceite', 6), ('ATF', 'aceite', 7), ('SAE10W', 'aceite', 8),
  ('10W40', 'aceite', 9), ('SAE30', 'aceite', 10), ('REFRIGERANTE', 'aceite', 11), ('DOT', 'aceite', 12),
  ('UREA', 'urea', 13), ('AGUA', 'agua', 14)
ON CONFLICT (nombre) DO NOTHING;

-- Dominios que ya figuran en la planilla de consumos
INSERT INTO taller_dominios (unidad_codigo, dominio) VALUES
  ('CA-08','IYR800'), ('CA-76','AG701TI'), ('UC-100','AC005OZ'), ('CA-69','AG404DE'), ('UC-87','AC012VD'),
  ('UC-51','AA417CZ'), ('CA-92','LBL151'), ('CA-98','IIO565'), ('CA-49','MUR911'), ('CA-48','LPN786'),
  ('CA-70','AG358NT'), ('CA-09','KOL765'), ('CA-62','AF679GZ'), ('CA-50','GPP173'), ('CA-94','AH287BA'),
  ('CA-64','AF878SR'), ('CA-73','AG583GA'), ('CA-97','AH287BN'), ('CA-84','AG926HX'), ('CA-77','AG757EV'),
  ('CA-63','AF878SS'), ('CA-74','AG595BZ')
ON CONFLICT (unidad_codigo) DO NOTHING;
