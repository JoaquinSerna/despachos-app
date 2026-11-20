-- Las solicitudes importadas del ERP se escriben solo desde el servidor (service role).
-- Antes no tenian RLS: cualquiera con la clave publica podia leerlas o borrarlas.
ALTER TABLE solicitudes_importadas ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitudes_importadas_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sol_imp_select" ON solicitudes_importadas FOR SELECT TO authenticated USING (true);
CREATE POLICY "sol_imp_items_select" ON solicitudes_importadas_items FOR SELECT TO authenticated USING (true);
