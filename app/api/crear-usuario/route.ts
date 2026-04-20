import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// GET - listar todos los usuarios (bypasa RLS)
export async function GET() {
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

const EMAILS_ADMIN_PERMISOS = ['joaquin.serna3@gmail.com', 'astaffieri@construyoalcosto.com']

// PATCH - actualizar permisos o estado activo/inactivo
export async function PATCH(req: NextRequest) {
  try {
    const { id, permisos, activo } = await req.json()
    if (!id) return NextResponse.json({ error: 'Falta id' }, { status: 400 })

    // Toggle activo/inactivo
    if (activo !== undefined) {
      const { error } = await getAdmin().from('usuarios').update({ activo }).eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 400 })
      // Banear/desbanear en Supabase Auth para bloquear el login
      const banDuration = activo ? 'none' : '876000h'
      const { error: authErr } = await getAdmin().auth.admin.updateUserById(id, { ban_duration: banDuration })
      if (authErr) return NextResponse.json({ error: authErr.message }, { status: 400 })
      return NextResponse.json({ success: true })
    }

    // Actualizar permisos (solo admins autorizados)
    const authHeader = req.headers.get('authorization')
    if (authHeader) {
      const token = authHeader.replace('Bearer ', '')
      const { data: { user } } = await getAdmin().auth.getUser(token)
      if (!user || !EMAILS_ADMIN_PERMISOS.includes(user.email ?? '')) {
        return NextResponse.json({ error: 'No autorizado' }, { status: 403 })
      }
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
  try {
    const { id } = await req.json()
    await getAdmin().from('usuarios').delete().eq('id', id)
    await getAdmin().auth.admin.deleteUser(id)
    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
