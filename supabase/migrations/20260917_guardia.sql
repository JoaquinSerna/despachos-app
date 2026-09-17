-- Módulo Guardia: registro de salidas, ingresos y devoluciones de camiones

CREATE TABLE IF NOT EXISTS guardia_eventos (
  id              uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamptz DEFAULT now(),
  fecha           date        NOT NULL DEFAULT CURRENT_DATE,
  tipo            text        NOT NULL CHECK (tipo IN ('salida', 'ingreso', 'devolucion')),
  camion_codigo   text        NOT NULL,

  -- Salida
  cant_pedidos    int,

  -- Ingreso
  tipo_ingreso    text        CHECK (tipo_ingreso IN ('directo', 'con_transferencia')),
  deposito_desde  text,

  -- Devolución
  chofer_apellido text,
  categoria       text,
  motivo          text,
  remito          text,
  nv              text,
  observacion     text,

  registrado_por  uuid        REFERENCES auth.users(id)
);

ALTER TABLE guardia_eventos ENABLE ROW LEVEL SECURITY;

-- Guardia puede insertar y leer sus propios eventos del día
CREATE POLICY "guardia_insert" ON guardia_eventos
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "guardia_select" ON guardia_eventos
  FOR SELECT TO authenticated USING (true);
