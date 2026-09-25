-- Permite a gerencia eliminar registros de guardia_eventos
CREATE POLICY "guardia_delete_gerencia" ON guardia_eventos
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM usuarios
      WHERE id = auth.uid() AND rol = 'gerencia'
    )
  );
