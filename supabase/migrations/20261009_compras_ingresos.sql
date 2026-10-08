-- Compras: ingresos de proveedores (remitos) y maestro de proveedores

-- Nuevo rol 'compras' (la restricción actual no lo admite)
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol = ANY (ARRAY[
  'gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial', 'confirmador', 'chofer', 'guardia', 'compras'
]));

-- Rol del usuario autenticado (SECURITY DEFINER: evita depender de las políticas de `usuarios`)
CREATE OR REPLACE FUNCTION public.rol_actual()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT rol FROM public.usuarios WHERE id = auth.uid()
$$;

CREATE TABLE IF NOT EXISTS proveedores (
  id            uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    timestamptz DEFAULT now(),
  nombre        text        NOT NULL,
  cuit          text        CHECK (cuit IS NULL OR cuit ~ '^[0-9]{11}$'),
  estado        text        NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('aprobado', 'pendiente', 'revisar', 'fusionado')),
  notas         text,
  fusionado_en  uuid        REFERENCES proveedores(id),
  creado_por    uuid        REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS proveedores_nombre_uq ON proveedores (lower(nombre));
CREATE INDEX IF NOT EXISTS proveedores_cuit_idx ON proveedores (cuit);

-- Un ingreso = una visita de un camión (externo, o propio que vuelve cargado de un proveedor)
CREATE TABLE IF NOT EXISTS proveedor_ingresos (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at        timestamptz DEFAULT now(),
  fecha             date        NOT NULL,
  hora_ingreso      timestamptz NOT NULL DEFAULT now(),
  sucursal          text        NOT NULL,
  origen            text        NOT NULL CHECK (origen IN ('externo', 'propio')),
  proveedor_id      uuid        REFERENCES proveedores(id),
  patente           text,
  chofer            text,
  camion_codigo     text,
  guardia_evento_id uuid,
  fotos_camion      text[]      NOT NULL DEFAULT '{}',
  observacion       text,
  registrado_por    uuid        REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS proveedor_ingresos_fecha_idx ON proveedor_ingresos (fecha);
CREATE INDEX IF NOT EXISTS proveedor_ingresos_prov_idx  ON proveedor_ingresos (proveedor_id);

-- Un ingreso puede traer varios remitos
CREATE TABLE IF NOT EXISTS proveedor_remitos (
  id                  uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at          timestamptz DEFAULT now(),
  ingreso_id          uuid        NOT NULL REFERENCES proveedor_ingresos(id) ON DELETE CASCADE,
  numero_remito       text        NOT NULL,
  numero_remito_leido text,
  remito_corregido    boolean     NOT NULL DEFAULT false,
  cuit_leido          text,
  proveedor_leido     text,
  fecha_remito        date,
  oc_numero_leido     text,
  ocr_estado          text        NOT NULL DEFAULT 'omitido' CHECK (ocr_estado IN ('ok', 'error', 'omitido')),
  fotos               text[]      NOT NULL DEFAULT '{}',
  estado              text        NOT NULL DEFAULT 'registrado' CHECK (estado IN ('registrado', 'revisado')),
  revisado_por        uuid        REFERENCES auth.users(id),
  revisado_en         timestamptz,
  observacion_compras text
);

CREATE INDEX IF NOT EXISTS proveedor_remitos_ingreso_idx ON proveedor_remitos (ingreso_id);
CREATE INDEX IF NOT EXISTS proveedor_remitos_numero_idx  ON proveedor_remitos (numero_remito);

ALTER TABLE proveedores        ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedor_ingresos ENABLE ROW LEVEL SECURITY;
ALTER TABLE proveedor_remitos  ENABLE ROW LEVEL SECURITY;

-- Guardia / depósito / ruteador cargan; gerencia, admin_flota y compras administran.
CREATE POLICY "proveedores_select" ON proveedores FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

CREATE POLICY "proveedores_insert" ON proveedores FOR INSERT TO authenticated
  WITH CHECK (
    public.rol_actual() IN ('gerencia', 'admin_flota', 'compras')
    OR (public.rol_actual() IN ('guardia', 'deposito', 'ruteador') AND estado = 'pendiente')
  );

CREATE POLICY "proveedores_update" ON proveedores FOR UPDATE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras'));

CREATE POLICY "ingresos_select" ON proveedor_ingresos FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

CREATE POLICY "ingresos_insert" ON proveedor_ingresos FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

CREATE POLICY "ingresos_update" ON proveedor_ingresos FOR UPDATE TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras') OR registrado_por = auth.uid());

-- Borrar: administración, o quien lo cargó dentro de las 24 hs (para corregir una carga equivocada)
CREATE POLICY "ingresos_delete" ON proveedor_ingresos FOR DELETE TO authenticated
  USING (
    public.rol_actual() IN ('gerencia', 'admin_flota', 'compras')
    OR (registrado_por = auth.uid() AND created_at > now() - interval '24 hours')
  );

CREATE POLICY "remitos_select" ON proveedor_remitos FOR SELECT TO authenticated
  USING (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

CREATE POLICY "remitos_insert" ON proveedor_remitos FOR INSERT TO authenticated
  WITH CHECK (public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

CREATE POLICY "remitos_update" ON proveedor_remitos FOR UPDATE TO authenticated
  USING (
    public.rol_actual() IN ('gerencia', 'admin_flota', 'compras')
    OR EXISTS (SELECT 1 FROM proveedor_ingresos i WHERE i.id = ingreso_id AND i.registrado_por = auth.uid())
  );

-- Fotos de remitos: bucket PRIVADO (traen CUIT y a veces precios); se leen con URL firmada
INSERT INTO storage.buckets (id, name, public)
VALUES ('compras-remitos', 'compras-remitos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "compras_remitos_select" ON storage.objects;
CREATE POLICY "compras_remitos_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'compras-remitos' AND public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

DROP POLICY IF EXISTS "compras_remitos_insert" ON storage.objects;
CREATE POLICY "compras_remitos_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'compras-remitos' AND public.rol_actual() IN ('gerencia', 'admin_flota', 'compras', 'guardia', 'deposito', 'ruteador'));

-- Maestro inicial de proveedores (historial de OC del ERP, ene-oct 2026).
-- 'revisar' = CUIT faltante, inválido o repetido en otro proveedor: compras lo corrige desde Compras → Proveedores.
INSERT INTO proveedores (nombre, cuit, estado, notas) VALUES
  ('ACERO PERFIL S.A.', '30712258825', 'aprobado', NULL),
  ('ACINDAR', '30501199253', 'aprobado', NULL),
  ('AGROPLASTIC SRL', '30718383788', 'aprobado', NULL),
  ('ARIDOS CANUELAS', '30716308886', 'aprobado', NULL),
  ('ARIDOS DE SANTA FE', '30714348201', 'aprobado', NULL),
  ('ARIDOS DE VILLA CONSTITUCIÓN S.A.', '30717727300', 'aprobado', NULL),
  ('ARIDOS SANTA FE', NULL, 'revisar', 'Sin CUIT en el ERP'),
  ('ATRIMA', '30709466387', 'aprobado', NULL),
  ('Ardal S.A.', NULL, 'revisar', 'CUIT inválido en el ERP (3368898580)'),
  ('Azpeitia Pedro', '20049948558', 'aprobado', NULL),
  ('BAIRESMAT', '20382682212', 'aprobado', NULL),
  ('BARONE CARLOS OMAR', '20046438060', 'aprobado', NULL),
  ('BAUKRAFT S.R.L', '30708301007', 'aprobado', NULL),
  ('BIOGAS S.R.L.', '30699947136', 'aprobado', NULL),
  ('BULONERA 32', '20188102507', 'aprobado', NULL),
  ('CALRAD BOLTON S.A.', '30712002189', 'aprobado', NULL),
  ('CANSUR', '30710019130', 'aprobado', NULL),
  ('CANTERAS YARAVI SA', '30502168866', 'aprobado', NULL),
  ('CEDIMAD', NULL, 'revisar', 'CUIT inválido en el ERP (11111111111)'),
  ('CEFAS', '30677250905', 'aprobado', NULL),
  ('CEMENTOS AVELLANEDA', '30526047792', 'aprobado', NULL),
  ('CERAMICA ALBERDI S.A', '33500908519', 'aprobado', NULL),
  ('CERAMICA CTIBOR S.A.', '30678026456', 'aprobado', NULL),
  ('CERAMICA FANELLI', '30629895619', 'aprobado', NULL),
  ('CERAMICA QUILMES', '30502202169', 'aprobado', NULL),
  ('CERAMICOS SPEGAZZINI', '30676228108', 'aprobado', NULL),
  ('CERRO NEGRO', '30501010053', 'aprobado', NULL),
  ('CHAPAFERRO S.A.', '30585727152', 'aprobado', NULL),
  ('CHIODINI LUCIANO JESUS', '20281944895', 'aprobado', NULL),
  ('CIC COMPAÑIA INTEGRAL DE COMERCIO', '30714815225', 'aprobado', NULL),
  ('CIMA', '27428887730', 'aprobado', NULL),
  ('COMERCIAL CMP SA', '33630659219', 'aprobado', NULL),
  ('COMERCIAL GEA SA', '30717826589', 'aprobado', NULL),
  ('CRECCHIO SRL', '30712049479', 'aprobado', NULL),
  ('CRISTIAN GALERA', NULL, 'revisar', 'Sin CUIT en el ERP'),
  ('CROMO S.A', '30648072097', 'aprobado', NULL),
  ('CURIA S.A.C.I.', '30529946631', 'aprobado', NULL),
  ('Campichuelo', '30660620040', 'aprobado', NULL),
  ('DAMICON S.A', NULL, 'revisar', 'CUIT inválido en el ERP (3071421315)'),
  ('DAMTEC', '30719156076', 'aprobado', NULL),
  ('DISTRIBUIDORA MEI', '30717581985', 'aprobado', NULL),
  ('DOMEC S.A', '30501999470', 'aprobado', NULL),
  ('Di Toro Hnos SA', NULL, 'revisar', 'CUIT inválido en el ERP (3070284357)'),
  ('EL COCO LOGISTICA SRL', '30715372386', 'aprobado', NULL),
  ('EL GALGO SA', '30519165496', 'aprobado', NULL),
  ('ELECTRO PEREIRA', NULL, 'revisar', 'CUIT inválido en el ERP (3071683246)'),
  ('ELECTROBOMBAS Y EQUIPOS S.A', '30708665351', 'aprobado', NULL),
  ('ELECTROPLAT', '33639759879', 'aprobado', NULL),
  ('FABRILAND S.A.', '30663950769', 'aprobado', NULL),
  ('FARREFUL (TOWER IMPORT SRL)', '30719014328', 'aprobado', NULL),
  ('FERRUM', '30525341263', 'aprobado', NULL),
  ('FV S.A.', '30500987878', 'aprobado', NULL),
  ('GERDAU', '30503245988', 'aprobado', NULL),
  ('GRUPO ESTISOL', '30504726173', 'aprobado', NULL),
  ('Herpaco Sa', '30633100140', 'aprobado', NULL),
  ('IMPERIO DEL CERAMICO S.R.L.', '30711517541', 'aprobado', NULL),
  ('INDUSTRIA ARGENTINA DE AISLACIONES S.A.', '33715465839', 'aprobado', NULL),
  ('INDUSTRIAS SALADILLO S.A', NULL, 'revisar', 'CUIT inválido en el ERP (3064592271)'),
  ('IRIGOITI GERARDO', '20144177267', 'aprobado', NULL),
  ('ITALOMIX', '23447095289', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('Industrias SICA S.A.I.C. (Dateas)', '30502891584', 'aprobado', NULL),
  ('JANDOGUY PABLO', '20284934114', 'aprobado', NULL),
  ('JOSE ANACLETO E HIJOS S.A', '30559880120', 'aprobado', NULL),
  ('Jonatan Edgardo Biras', '20307509041', 'aprobado', NULL),
  ('KALFAIAN HNOS SRL', '30678264969', 'aprobado', NULL),
  ('KANKIN', '27321127822', 'aprobado', NULL),
  ('KARTONSEC S.A', '30519591606', 'aprobado', NULL),
  ('KOPRUCH', '30695558135', 'aprobado', NULL),
  ('KRAVCHUK LUCAS GABRIEL', '23447095289', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('LA CASA DEL TECHADO', '30708559152', 'aprobado', NULL),
  ('LA PLATA LED', '30716688131', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('LA PONDEROSA', '30711123780', 'aprobado', NULL),
  ('LADRILLOS FOSCO', NULL, 'revisar', 'Sin CUIT en el ERP'),
  ('LEANVAL', '30599479127', 'aprobado', NULL),
  ('LOMA NEGRA C-I.A.S.A.', '30500530851', 'aprobado', NULL),
  ('La Plata Ceramicos S.A', '30559854022', 'aprobado', NULL),
  ('MACROPLAST S.A.', '30651861299', 'aprobado', NULL),
  ('MAD PACKAGING S.R.L.', '33715429859', 'aprobado', NULL),
  ('MADERERA BALLESTER', '33680627989', 'aprobado', NULL),
  ('MADERSAT (SHISAT SRL)', '30715475363', 'aprobado', NULL),
  ('MARBLOCK S.A', '30709660655', 'aprobado', NULL),
  ('MATYLAD S.A', '30710177755', 'aprobado', NULL),
  ('MOLDEADOS BB', '30516526706', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('MOTORARG S.A.I.C.F.I.A.', '30503243454', 'aprobado', NULL),
  ('NORVIGUET SRL', '33659968679', 'aprobado', NULL),
  ('NOVAHOGAR S.A', '30709906158', 'aprobado', NULL),
  ('NOVATRANS SA', '30716337541', 'aprobado', NULL),
  ('OMAR CRISTALES', '30598232187', 'aprobado', NULL),
  ('PACK POINT', '30710696299', 'aprobado', NULL),
  ('PALITO S.A.', NULL, 'revisar', 'CUIT inválido en el ERP (3371564260)'),
  ('PALMAR MAR DEL PLATA S.A', '30504287269', 'aprobado', NULL),
  ('PAPELERA TECNOEMBALMS', '20251461830', 'aprobado', NULL),
  ('PIAZZA', '30713678909', 'aprobado', NULL),
  ('PINTURERIAS GARCÍA SUCURSAL 13', '30677223983', 'aprobado', NULL),
  ('PLASTICOS SAAVEDRA S.R.L', '30715252828', 'aprobado', NULL),
  ('PLOMIPLAS', NULL, 'revisar', 'CUIT inválido en el ERP (2005532030)'),
  ('POSE', NULL, 'revisar', 'Sin CUIT en el ERP'),
  ('PRADECON S.A.', '30709081353', 'aprobado', NULL),
  ('PREI Premoldeados', '20225325880', 'aprobado', NULL),
  ('PREMOLDEADOS BB', '30516526706', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('PRETAN', '30710090552', 'aprobado', NULL),
  ('PROKRETE ARGENTINA S.A.', '30696874375', 'aprobado', NULL),
  ('Pinturerias REX S.A', '30646512952', 'aprobado', NULL),
  ('Polotexar SRL', '30719278783', 'aprobado', NULL),
  ('Pringles San Luis S.A.', '30657842008', 'aprobado', NULL),
  ('QUERANDI ARENERA', '27171323377', 'aprobado', NULL),
  ('RECUPALLETS S.A.', '30717240177', 'aprobado', NULL),
  ('RODIMAR', NULL, 'revisar', 'CUIT inválido en el ERP (23229317609)'),
  ('RODRIGUEZ MARIO JESUS', '30716688131', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('ROTOPLAS', '30690827065', 'aprobado', NULL),
  ('Rukko importación y distribución', '33715336109', 'aprobado', NULL),
  ('SAINT GOBIAN', '30500529071', 'aprobado', NULL),
  ('SANITARIOS SAN MARTIN', '30718092511', 'aprobado', NULL),
  ('SEARA REFRIGERACION', '33691421819', 'aprobado', NULL),
  ('SEGUNOR SEGURIDAD INDUSTRIAL SA', '30716688131', 'revisar', 'CUIT repetido en otro proveedor del ERP'),
  ('SHAP S.A.', '30547445321', 'aprobado', NULL),
  ('SIKA ARGENTINA S.A.I.C', '33501880049', 'aprobado', NULL),
  ('SILKE BLOCK', '30710967969', 'aprobado', NULL),
  ('SINTEPLAST', '30564066784', 'aprobado', NULL),
  ('SOLUCIONES POSITIVAS S.A.', NULL, 'revisar', 'CUIT inválido en el ERP (307166881)'),
  ('Servicios Sanitarios Integrales SRL', '30716005468', 'aprobado', NULL),
  ('TDMA S.R.L', '30714094285', 'aprobado', NULL),
  ('TECNO AISLANTES', '30696164513', 'aprobado', NULL),
  ('TECNO HIDRO', NULL, 'revisar', 'Sin CUIT en el ERP'),
  ('TERNIUM ARGENTINA S.A.', '30516888241', 'aprobado', NULL),
  ('TEXBAGSUR S.R.L', '30718646282', 'aprobado', NULL),
  ('TEXTUM S.A.', '30714187526', 'aprobado', NULL),
  ('TIERRA MORENA', '20183082559', 'aprobado', NULL),
  ('TIGRE ARGENTINA S.A.', '30649705786', 'aprobado', NULL),
  ('TOOLSGAS', '30715306839', 'aprobado', NULL),
  ('TRANSPORTES LOKI', NULL, 'revisar', 'CUIT inválido en el ERP (27228981719)'),
  ('TRANSPORTES M@ER', NULL, 'revisar', 'CUIT inválido en el ERP (2020313341)'),
  ('TREFILADOS MGM S.A', '30711915598', 'aprobado', NULL),
  ('UNIKE GROUP S.A.', '30714255750', 'aprobado', NULL),
  ('Yayi distribuidora', '20287686103', 'aprobado', NULL),
  ('ZINGUERIA GEA', '27352309090', 'aprobado', NULL)
ON CONFLICT DO NOTHING;
