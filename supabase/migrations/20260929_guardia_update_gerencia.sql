CREATE POLICY "guardia_update_gerencia" ON guardia_eventos
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM usuarios
      WHERE id = auth.uid() AND rol = 'gerencia'
    )
  );
