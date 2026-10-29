This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## API: lectura de pedidos para el Tablero de Abastecimiento

`GET /api/pedidos-export?desde=AAAA-MM-DD&hasta=AAAA-MM-DD`

Solo lectura. Devuelve los pedidos programados (misma consulta que la hoja "Pedidos" del export Excel de Métricas: por fecha de entrega, sin cancelados) con la **sucursal desde la que realmente sale cada pedido**, para vincularla por SD con lo que figura en Huemul.

- **Autenticación:** header `x-api-secret` con el valor de la variable de entorno `DESPACHOS_PEDIDOS_SECRET` (Vercel). Sin secreto o con uno incorrecto responde `401`. Si la variable no está configurada, siempre `401`.
- **Parámetros:** `desde` y `hasta` sobre la fecha de entrega. Por defecto, de hace 45 días a 30 días hacia adelante. Formato inválido → `400`.
- **Respuesta:** `generadoEn`, `desde`, `hasta`, `total`, `truncado` (tope de 20.000 filas) y `pedidos[]` con `sd` (texto; puede tener letra, p. ej. `50008B`), `nv` (número), `sucursal` (`Guernica`, `Cañuelas`, `Pinamar`, `LP520`, `LP139`), `fecha`, `vuelta` (`V1`, `V2`… o `Sin asignar`), `camion`, `estado`, `tipo` (`entrega` o `retiro`) y `creadoEn`. Una fila por pedido: una SD con entregas divididas devuelve varias filas.
- No incluye datos personales ni de ubicación (cliente, dirección, coordenadas, notas). La tabla `pedidos` no guarda fecha de modificación, por eso no hay `actualizadoEn` ni filtro `actualizadoDesde`.
- `Cache-Control: no-store`.

```bash
curl -H "x-api-secret: $DESPACHOS_PEDIDOS_SECRET" \
  "https://despachos-app-omega.vercel.app/api/pedidos-export?desde=2026-10-19&hasta=2026-10-25"
```
