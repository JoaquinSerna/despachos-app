-- Peso y posiciones en requerimientos (transferencias y futuros retiros)
ALTER TABLE public.requerimientos
  ADD COLUMN IF NOT EXISTS peso_total_kg  numeric,
  ADD COLUMN IF NOT EXISTS volumen_total_m3 numeric;

-- Vuelta 0 = "sin programar" (no asignada a ninguna vuelta del día todavía)
-- Cambia el DEFAULT de 1 a 0 para nuevas transferencias
ALTER TABLE public.requerimientos
  ALTER COLUMN vuelta SET DEFAULT 0;

-- Transferencias existentes sin camión asignado pasan a vuelta=0 ("sin programar")
UPDATE public.requerimientos
  SET vuelta = 0
  WHERE cod_vehiculo IS NULL
    AND estado IN ('pendiente', 'conf_stock', 'preparacion');
