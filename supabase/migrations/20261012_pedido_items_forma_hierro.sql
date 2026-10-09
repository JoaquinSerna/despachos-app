-- Hierros de construcción: cada línea del pedido debe indicar si va derecha o doblada
-- (evita que se doblen barras que tenían que ir derechas, o al revés). Solo aplica a hierro
-- redondo de 6, 8, 10, 12, 16, 20, 25 y 32 mm; el resto de los items queda en null.
alter table public.pedido_items
  add column if not exists forma_hierro text
  check (forma_hierro in ('derecho', 'doblado'));

comment on column public.pedido_items.forma_hierro is
  'derecho | doblado. Solo para hierro redondo (6, 8, 10, 12, 16, 20, 25, 32 mm); null en otros productos.';
