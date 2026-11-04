-- Transferencia combinada (ej. LP139 -> Guernica -> Canuelas): el 2do tramo apunta al 1ro
-- y se aprueba solo cuando el 1ro llega (entregado).
alter table public.requerimientos
  add column if not exists requerimiento_previo_id uuid references public.requerimientos(id) on delete set null;
create index if not exists requerimientos_previo_idx on public.requerimientos (requerimiento_previo_id) where requerimiento_previo_id is not null;
