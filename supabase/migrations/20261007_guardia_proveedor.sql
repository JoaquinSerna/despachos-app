-- Ampliar tipo_ingreso para incluir 'con_proveedor'
ALTER TABLE guardia_eventos DROP CONSTRAINT IF EXISTS guardia_eventos_tipo_ingreso_check;
ALTER TABLE guardia_eventos ADD CONSTRAINT guardia_eventos_tipo_ingreso_check
  CHECK (tipo_ingreso IN ('directo', 'con_transferencia', 'con_proveedor'));
