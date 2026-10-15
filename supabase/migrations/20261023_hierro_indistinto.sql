-- Hierros: tercera opción "indistinto" (al cliente le da igual derecho o doblado).
alter table public.pedido_items drop constraint if exists pedido_items_forma_hierro_check;
alter table public.pedido_items add constraint pedido_items_forma_hierro_check
  check (forma_hierro in ('derecho', 'doblado', 'indistinto'));

comment on column public.pedido_items.forma_hierro is
  'derecho | doblado | indistinto. Solo para hierro redondo (6, 8, 10, 12, 16, 20, 25, 32 mm); null en otros productos.';
