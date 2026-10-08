-- Permite a gerencia corregir la hora real de un evento
ALTER TABLE guardia_eventos ADD COLUMN IF NOT EXISTS hora_evento time;
