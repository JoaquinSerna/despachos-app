-- 1. km_max_dia en camiones_flota (default 200, ajustable por camión)
ALTER TABLE camiones_flota
  ADD COLUMN IF NOT EXISTS km_max_dia INTEGER NOT NULL DEFAULT 200;

-- 2. motivo_inactivo en usuarios (ART, vacaciones, etc.)
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS motivo_inactivo TEXT;
