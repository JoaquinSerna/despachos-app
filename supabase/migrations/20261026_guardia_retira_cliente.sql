-- Guardia: salida "Retira cliente" (un cliente que viene a retirar con su propio vehículo).
-- Se guarda como una salida más (tipo 'salida', categoria 'retira_cliente'); camion_codigo lleva la patente o descripción del vehículo.
alter table public.guardia_eventos add column if not exists cliente text;
