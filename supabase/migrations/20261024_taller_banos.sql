-- Corrige el apellido de los mecánicos: Baños (no Bañoz).
update public.taller_mecanicos set nombre = replace(nombre, 'Bañoz', 'Baños') where nombre like '%Bañoz%';
update public.usuarios set nombre = replace(nombre, 'Bañoz', 'Baños') where nombre like '%Bañoz%';
