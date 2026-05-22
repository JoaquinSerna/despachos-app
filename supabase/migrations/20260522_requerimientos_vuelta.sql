-- vuelta en requerimientos: permite asignar transferencias a una vuelta del día
ALTER TABLE public.requerimientos
  ADD COLUMN IF NOT EXISTS vuelta INTEGER NOT NULL DEFAULT 1;
