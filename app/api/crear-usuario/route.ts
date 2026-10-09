import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// Todas las operaciones usan la clave de servicio (saltean RLS): solo puede llamarlas un usuario
// con sesión válida, activo y con rol gerencia. Devuelve el id del que llama, o la respuesta de error.
async function exigirGerencia(req: NextRequest): Promise<{ id: string } | NextResponse> {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  const admin = getAdmin()
  const { data: { user }, error } = await admin.auth.getUser(token)
  if (error || !user) return NextResponse.json({ error: 'Sesión inválida' }, { status: 401 })
  const { data: fila } = await admin.from('usuarios').select('rol, activo').eq('id', user.id).single()
  if (!fila || fila.rol !== 'gerencia' || fila.activo === false) {
    return NextResponse.json({ error: 'No autorizado — se requiere rol gerencia' }, { status: 403 })
  }
  return { id: user.id }
}

// GET - listar todos los usuarios (bypasa RLS)
export async function GET(req: NextRequest) {
  const acceso = await exigirGerencia(req)
  if (acceso instanceof NextResponse) return acceso
  try {
    const { data, error } = await getAdmin()
      .from('usuarios')
      .select('*')
      .order('nombre')
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ usuarios: data })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// POST - crear usuario
export async function POST(req: NextRequest) {
  const acceso = await exigirGerencia(req)
  if (acceso instanceof NextResponse) return acceso
  try {
    const { nombre, email, password, rol, sucursal } = await req.json()
    if (!nombre || !email || !password || !rol)
      return NextResponse.json({ error: 'Faltan campos requeridos' }, { status: 400 })

    const { data: authData, error: authError } = await getAdmin().auth.admin.createUser({
      email, password, email_confirm: true,
    })
    if (authError) return NextResponse.json({ error: authError.message }, { status: 400 })

    const { error: dbError } = await getAdmin().from('usuarios').insert({
      id: authData.user.id,
      nombre,
      email,
      rol,
      sucursal: sucursal || 'LP520', // default LP520 si no se elige sucursal
    })
    if (dbError) {
      await getAdmin().auth.admin.deleteUser(authData.user.id)
      return NextResponse.json({ error: dbError.message }, { status: 400 })
    }
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// PUT - editar usuario
export async function PUT(req: NextRequest) {
  const acceso = await exigirGerencia(req)
  if (acceso instanceof NextResponse) return acceso
  try {
    const { id, emailAnterior, nombre, email, password, rol, sucursal } = await req.json()

    // Solo actualizar Auth si el email o password cambiaron realmente
    // (evita disparar triggers/confirmaciones innecesarias que pueden sobreescribir la tabla)
    const authUpdates: Record<string, string> = {}
    if (password) authUpdates.password = password
    if (email && email !== emailAnterior) authUpdates.email = email
    if (Object.keys(authUpdates).length > 0) {
      const { error: authError } = await getAdmin().auth.admin.updateUserById(id, authUpdates)
      if (authError) return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    // Actualizar tabla usuarios — usar .select() para confirmar que realmente se actualizó
    const dbUpdates: Record<string, any> = {
      nombre,
      rol,
      sucursal: sucursal || null,   // '' → null = "Todas las sucursales"
    }
    if (email && email !== emailAnterior) dbUpdates.email = email
    const { data: updated, error } = await getAdmin()
      .from('usuarios')
      .update(dbUpdates)
      .eq('id', id)
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    if (!updated || updated.length === 0)
      return NextResponse.json({ error: 'No se encontró el usuario' }, { status: 404 })

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// PATCH - actualizar permisos o estado activo/inactivo
export async function PATCH(req: NextRequest) {
  const acceso = await exigirGerencia(req)
  if (acceso instanceof NextResponse) return acceso
  try {
    const { id, permisos, activo } = await req.json()
    if (!id) return NextResponse.json({ error: 'Falta id' }, { status: 400 })

    // Toggle activo/inactivo
    if (activo !== undefined) {
      if (id === acceso.id && activo === false) {
        return NextResponse.json({ error: 'No podés inactivar tu propio usuario' }, { status: 400 })
      }
      const { error } = await getAdmin().from('usuarios').update({ activo }).eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      // Banear/desbanear en Supabase Auth para bloquear el login
      const banDuration = activo ? 'none' : '876000h'
      const { error: authErr } = await getAdmin().auth.admin.updateUserById(id, { ban_duration: banDuration })
      if (authErr) return NextResponse.json({ error: authErr.message }, { status: 400 })
      return NextResponse.json({ success: true })
    }

    const { error } = await getAdmin().from('usuarios').update({ permisos }).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// DELETE - eliminar usuario
export async function DELETE(req: NextRequest) {
  const acceso = await exigirGerencia(req)
  if (acceso instanceof NextResponse) return acceso
  try {
    const { id } = await req.json()
    if (!id) return NextResponse.json({ error: 'Falta id' }, { status: 400 })
    if (id === acceso.id) return NextResponse.json({ error: 'No podés eliminar tu propio usuario' }, { status: 400 })
    await getAdmin().from('usuarios').delete().eq('id', id)
    await getAdmin().auth.admin.deleteUser(id)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
