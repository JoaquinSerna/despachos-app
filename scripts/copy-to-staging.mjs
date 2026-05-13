// Script para copiar datos de producción a staging
// Uso: node scripts/copy-to-staging.mjs
// Variables de entorno requeridas:
//   SUPABASE_ACCESS_TOKEN, STAGING_REF
//   PROD_SUPABASE_URL, PROD_SERVICE_KEY
//   STAGING_SUPABASE_URL, STAGING_SERVICE_KEY

import { createClient } from '@supabase/supabase-js'

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
const STAGING_REF = process.env.STAGING_REF

const PROD = {
  url: process.env.PROD_SUPABASE_URL,
  serviceKey: process.env.PROD_SERVICE_KEY
}

const STAGING = {
  url: process.env.STAGING_SUPABASE_URL,
  serviceKey: process.env.STAGING_SERVICE_KEY
}

// Validar que todas las variables estén definidas
const required = { ACCESS_TOKEN, STAGING_REF, 'PROD.url': PROD.url, 'PROD.serviceKey': PROD.serviceKey, 'STAGING.url': STAGING.url, 'STAGING.serviceKey': STAGING.serviceKey }
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k)
if (missing.length > 0) {
  console.error('❌ Faltan variables de entorno:', missing.join(', '))
  process.exit(1)
}

const prod = createClient(PROD.url, PROD.serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

const staging = createClient(STAGING.url, STAGING.serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
})

async function runSQL(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query })
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.message || JSON.stringify(json))
  return json
}

async function copiarTabla(nombre) {
  console.log(`\n📦 Copiando tabla: ${nombre}`)

  // Leer en páginas de 1000 para superar el límite de PostgREST
  const PAGE = 1000
  let data = []
  let offset = 0
  while (true) {
    const { data: page, error } = await prod.from(nombre).select('*').range(offset, offset + PAGE - 1)
    if (error) {
      console.error(`  ❌ Error leyendo ${nombre} (offset ${offset}):`, error.message)
      return
    }
    if (!page || page.length === 0) break
    data = [...data, ...page]
    if (page.length < PAGE) break
    offset += PAGE
  }
  console.log(`  ✅ ${data.length} filas leídas de producción`)
  if (data.length === 0) { console.log(`  ⏭️  Tabla vacía`); return }

  // Limpiar staging via SQL para evitar problemas de FK en cascade
  try {
    await runSQL(`DELETE FROM ${nombre};`)
    console.log(`  🧹 Tabla ${nombre} limpiada en staging`)
  } catch (e) {
    console.warn(`  ⚠️  No se pudo limpiar via SQL:`, e.message)
  }

  // Insertar en lotes
  const BATCH = 100
  for (let i = 0; i < data.length; i += BATCH) {
    const lote = data.slice(i, i + BATCH)
    const { error: insertError } = await staging.from(nombre).insert(lote)
    if (insertError) {
      console.error(`  ❌ Error insertando lote ${i}–${i + BATCH}:`, insertError.message)
      return
    }
    console.log(`  ✅ Filas ${i + 1}–${Math.min(i + BATCH, data.length)} insertadas`)
  }

  console.log(`  🎉 ${nombre} copiada`)
}

const STAGING_PASSWORD = 'Staging2025!'

async function copiarAuthUsers() {
  console.log('\n👤 Copiando usuarios de auth...')

  // Listar todos los usuarios de producción
  let allUsers = []
  let page = 1
  while (true) {
    const res = await fetch(`${PROD.url}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { 'Authorization': `Bearer ${PROD.serviceKey}`, 'apikey': PROD.serviceKey }
    })
    const json = await res.json()
    const users = json.users ?? []
    allUsers = [...allUsers, ...users]
    if (users.length < 1000) break
    page++
  }
  console.log(`  ✅ ${allUsers.length} usuarios leídos de producción`)

  // Obtener usuarios ya existentes en staging
  const resExist = await fetch(`${STAGING.url}/auth/v1/admin/users?per_page=1000`, {
    headers: { 'Authorization': `Bearer ${STAGING.serviceKey}`, 'apikey': STAGING.serviceKey }
  })
  const existJson = await resExist.json()
  const emailsExistentes = new Set((existJson.users ?? []).map((u) => u.email))

  let creados = 0, omitidos = 0, errores = 0
  for (const user of allUsers) {
    if (emailsExistentes.has(user.email)) { omitidos++; continue }
    const res = await fetch(`${STAGING.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STAGING.serviceKey}`, 'apikey': STAGING.serviceKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: user.id,                          // mismo UUID que producción
        email: user.email,
        password: STAGING_PASSWORD,
        email_confirm: true,
        user_metadata: user.user_metadata ?? {},
      })
    })
    if (res.ok) { creados++ } else {
      const err = await res.json()
      console.warn(`  ⚠️  ${user.email}: ${err.message ?? JSON.stringify(err)}`)
      errores++
    }
  }
  console.log(`  ✅ ${creados} creados, ${omitidos} ya existían, ${errores} errores`)
  console.log(`  🔑 Contraseña temporal para todos: ${STAGING_PASSWORD}`)
}

async function main() {
  console.log('🚀 Iniciando copia producción → staging\n')

  // Paso 1: Dropear FK constraints en staging para poder insertar libremente
  console.log('🔧 Removiendo FK constraints en staging...')
  try {
    await runSQL(`
      ALTER TABLE IF EXISTS pedidos DROP CONSTRAINT IF EXISTS pedidos_vendedor_id_fkey;
      ALTER TABLE IF EXISTS pedidos DROP CONSTRAINT IF EXISTS pedidos_repartidor_id_fkey;
      ALTER TABLE IF EXISTS pedidos DROP CONSTRAINT IF EXISTS pedidos_sucursal_fkey;
      ALTER TABLE IF EXISTS usuarios DROP CONSTRAINT IF EXISTS usuarios_id_fkey;
      ALTER TABLE IF EXISTS flota_dia DROP CONSTRAINT IF EXISTS flota_dia_camion_codigo_fkey;
      ALTER TABLE IF EXISTS pedido_items DROP CONSTRAINT IF EXISTS pedido_items_pedido_id_fkey;
    `)
    console.log('  ✅ FK constraints removidas')
  } catch (e) {
    console.error('  ❌ Error removiendo constraints:', e.message)
    process.exit(1)
  }

  // Paso 2: Copiar auth users
  await copiarAuthUsers()

  // Paso 3: Copiar tablas en orden
  await copiarTabla('usuarios')
  await copiarTabla('pedidos')
  await copiarTabla('camiones_flota')
  await copiarTabla('camiones')
  await copiarTabla('flota_dia')
  await copiarTabla('materiales')
  await copiarTabla('pedido_items')
  await copiarTabla('vueltas_config')
  await copiarTabla('stock_sucursal')
  await copiarTabla('cupos')

  // Paso final: sincronizar IDs de usuarios con auth.users
  console.log('\n🔁 Sincronizando IDs de usuarios con auth...')
  try {
    await runSQL(`
      UPDATE usuarios
      SET id = auth.users.id
      FROM auth.users
      WHERE auth.users.email = usuarios.email
      AND usuarios.id != auth.users.id;
    `)
    console.log('  ✅ IDs sincronizados')
  } catch (e) {
    console.warn('  ⚠️  No se pudo sincronizar IDs:', e.message)
  }

  console.log('\n✅ Listo! Datos copiados a staging.')
  console.log('   Todos los usuarios pueden entrar con su email y contraseña: Staging2025!')
  console.log('   (Los 6 usuarios que ya existían conservan su contraseña anterior)')
}

main().catch(console.error)
