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
    const { id, nombre, rol, sucursal } = await req.json()
    const { error } = await getAdmin()
      .from('usuarios')
      .update({ nombre, rol, sucursal: sucursal || 'LP520' })
      .eq('id', id)
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
