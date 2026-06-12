create table if not exists vueltas_cerradas_manual (
  fecha       date        not null,
  sucursal    text        not null,
  vuelta      integer     not null,  -- 0 = fuera de programación, 1-5 = vuelta normal
  cerrada_por uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (fecha, sucursal, vuelta)
);

alter table vueltas_cerradas_manual enable row level security;

-- Ruteadores y gerencia pueden leer y escribir
create policy "ruteador_write" on vueltas_cerradas_manual
  for all using (true) with check (true);
