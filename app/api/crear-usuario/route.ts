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
    const { id, nombre, email, password, rol, sucursal } = await req.json()

    // Actualizar auth (email y/o password) si se enviaron
    const authUpdates: Record<string, string> = {}
    if (email) authUpdates.email = email
    if (password) authUpdates.password = password
    if (Object.keys(authUpdates).length > 0) {
      const { error: authError } = await getAdmin().auth.admin.updateUserById(id, authUpdates)
      if (authError) return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    // Actualizar tabla usuarios
    const dbUpdates: Record<string, string> = { nombre, rol, sucursal: sucursal || 'LP520' }
    if (email) dbUpdates.email = email
    const { error } = await getAdmin().from('usuarios').update(dbUpdates).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 400 })

    return NextResponse.json({ success: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// PATCH - actualizar permisos de un usuario
export async function PATCH(req: NextRequest) {
  try {
    const { id, permisos } = await req.json()
    if (!id) return NextResponse.json({ error: 'Falta id' }, { status: 400 })
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
