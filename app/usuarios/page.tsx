'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase' // solo para auth check
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { ROLES, ROL_LABEL, ROL_DESCRIPCION, ROL_COLOR, ROL_BG } from '../lib/roles'

interface Usuario {
  id: string
  nombre: string
  email: string
  rol: string
  sucursal: string | null
  created_at: string
}

const SUCURSALES = ['LP139', 'LP520', 'Guernica', 'Cañuelas', 'Pinamar']

interface SoporteContacto {
  id: number
  nombre: string
  telefono: string
  sucursal: string
  activo: boolean
}

export default function UsuariosPage() {
  const router = useRouter()
  const [usuarios, setUsuarios] = useState<Usuario[]>([])
  const [cargando, setCargando] = useState(true)
  const [modal, setModal] = useState<{ tipo: 'crear' | 'editar'; usuario?: Usuario } | null>(null)
  const [form, setForm] = useState({ nombre: '', email: '', password: '', rol: 'comercial', sucursal: '' })
  const [guardando, setGuardando] = useState(false)
  const [toast, setToast] = useState<{ msg: string; tipo: 'ok' | 'err' } | null>(null)
  const [busqueda, setBusqueda] = useState('')

  // Soporte técnico
  const [contactosSoporte, setContactosSoporte] = useState<SoporteContacto[]>([])
  const [formSoporte, setFormSoporte] = useState({ nombre: '', telefono: '', sucursal: 'LP520' })
  const [guardandoSoporte, setGuardandoSoporte] = useState(false)
  const [editSoporte, setEditSoporte] = useState<SoporteContacto | null>(null)

  const showToast = (msg: string, tipo: 'ok' | 'err' = 'ok') => {
    setToast({ msg, tipo }); setTimeout(() => setToast(null), 3500)
  }

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { router.push('/'); return }
      const { data } = await supabase.from('usuarios').select('rol').eq('id', user.id).single()
      if (data?.rol !== 'gerencia') { router.push('/dashboard'); return }
      cargarUsuarios()
      cargarSoporte()
    })
  }, [])

  const cargarSoporte = async () => {
    const res = await fetch('/api/soporte-contactos')
    const data = await res.json()
    setContactosSoporte(data.contactos ?? [])
  }

  const guardarSoporte = async () => {
    if (!formSoporte.nombre.trim() || !formSoporte.telefono.trim()) return
    setGuardandoSoporte(true)
    try {
      if (editSoporte) {
        await fetch('/api/soporte-contactos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editSoporte.id, ...formSoporte }) })
        showToast('Contacto actualizado')
      } else {
        await fetch('/api/soporte-contactos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formSoporte) })
        showToast('Contacto agregado')
      }
      setFormSoporte({ nombre: '', telefono: '', sucursal: 'LP520' })
      setEditSoporte(null)
      cargarSoporte()
    } catch { showToast('Error al guardar', 'err') }
    setGuardandoSoporte(false)
  }

  const eliminarSoporte = async (id: number) => {
    await fetch('/api/soporte-contactos', { method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }) })
    cargarSoporte()
  }

  const toggleActivoSoporte = async (c: SoporteContacto) => {
    await fetch('/api/soporte-contactos', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: c.id, activo: !c.activo }) })
    cargarSoporte()
  }

  const cargarUsuarios = async () => {
    setCargando(true)
    const res = await fetch('/api/crear-usuario')
    const data = await res.json()
    setUsuarios(data.usuarios ?? [])
    setCargando(false)
  }

  const abrirCrear = () => {
    setForm({ nombre: '', email: '', password: '', rol: 'comercial', sucursal: '' })
    setModal({ tipo: 'crear' })
  }

  const abrirEditar = (u: Usuario) => {
    setForm({ nombre: u.nombre, email: u.email, password: '', rol: u.rol, sucursal: u.sucursal ?? '' })
    setModal({ tipo: 'editar', usuario: u })
  }

  const guardar = async () => {
    setGuardando(true)
    try {
      if (modal?.tipo === 'crear') {
        const res = await fetch('/api/crear-usuario', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        showToast('Usuario creado correctamente')
      } else if (modal?.tipo === 'editar' && modal.usuario) {
        const res = await fetch('/api/crear-usuario', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: modal.usuario.id,
            nombre: form.nombre,
            email: form.email,
            password: form.password || undefined,
            rol: form.rol,
            sucursal: form.sucursal,
          }),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error)
        showToast('Usuario actualizado')
      }
      setModal(null)
      cargarUsuarios()
    } catch (e: any) {
      showToast(e.message, 'err')
    } finally {
      setGuardando(false)
    }
  }

  const eliminar = async (u: Usuario) => {
    if (!confirm(`¿Eliminar al usuario ${u.nombre}? Esta acción no se puede deshacer.`)) return
    const res = await fetch('/api/crear-usuario', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id }),
    })
    const data = await res.json()
    if (data.error) { showToast(data.error, 'err'); return }
    showToast('Usuario eliminado')
    cargarUsuarios()
  }

  const exportarExcel = () => {
    const rows = usuarios.map(u => ({
      Nombre: u.nombre,
      Email: u.email,
      Rol: u.rol,
      Sucursal: u.sucursal ?? 'Todas',
      'Fecha de alta': new Date(u.created_at).toLocaleDateString('es-AR'),
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Usuarios')
    XLSX.writeFile(wb, `usuarios_${new Date().toISOString().split('T')[0]}.xlsx`)
  }

  if (cargando) return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
        style={{ borderColor: '#254A96', borderTopColor: 'transparent' }} />
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50" style={{ fontFamily: 'Barlow, sans-serif' }}>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white flex items-center gap-2"
          style={{ background: toast.tipo === 'ok' ? '#254A96' : '#E52322' }}>
          {toast.tipo === 'ok' ? '✓' : '✕'} {toast.msg}
        </div>
      )}

      {/* Modal crear/editar */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-md p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-base" style={{ color: '#254A96' }}>
                {modal.tipo === 'crear' ? 'Nuevo usuario' : 'Editar usuario'}
              </h3>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Nombre completo</label>
                <input type="text" value={form.nombre}
                  onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
                  className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} placeholder="Ej: Juan Pérez" />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Email</label>
                <input type="email" value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} placeholder="correo@construyoalcosto.com"
                  readOnly={modal.tipo === 'editar' ? false : false} />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>
                  {modal.tipo === 'editar' ? 'Nueva contraseña (dejar vacío para no cambiar)' : 'Contraseña inicial'}
                </label>
                <input type="password" value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }} placeholder={modal.tipo === 'editar' ? 'Nueva contraseña...' : 'Mínimo 6 caracteres'} />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Rol</label>
                <select value={form.rol}
                  onChange={e => setForm(f => ({ ...f, rol: e.target.value }))}
                  className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
                  {ROLES.map(r => <option key={r} value={r}>{ROL_LABEL[r]}</option>)}
                </select>
                <p className="text-xs mt-1" style={{ color: '#B9BBB7' }}>
                  {ROL_DESCRIPCION[form.rol] ?? ''}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: '#254A96' }}>Sucursal</label>
                <select value={form.sucursal}
                  onChange={e => setForm(f => ({ ...f, sucursal: e.target.value }))}
                  className="w-full border rounded-xl px-4 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: '#e8edf8' }}>
                  <option value="">Todas las sucursales</option>
                  {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => setModal(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border"
                style={{ borderColor: '#e8edf8', color: '#666' }}>
                Cancelar
              </button>
              <button onClick={guardar}
                disabled={guardando || !form.nombre || (modal.tipo === 'crear' && (!form.email || !form.password))}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardando ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Navbar */}
      <nav className="bg-white border-b sticky top-0 z-40" style={{ borderColor: '#e8edf8' }}>
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => router.push('/dashboard')}
              className="text-xs px-2 py-1.5 rounded-lg font-medium"
              style={{ background: '#e8edf8', color: '#254A96' }}>
              ← Volver
            </button>
            <img src="/logo.png" alt="Construyo al Costo" className="h-7 w-auto rounded-lg hidden sm:block" />
            <div>
              <span className="font-bold text-sm" style={{ color: '#254A96' }}>Gestión de Usuarios</span>
              <span className="text-xs ml-2" style={{ color: '#B9BBB7' }}>{usuarios.length} usuarios</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              placeholder="Buscar por nombre, email o rol…"
              className="text-xs px-3 py-1.5 rounded-lg border focus:outline-none w-52"
              style={{ borderColor: '#e8edf8', color: '#1a1a1a' }}
            />
            <button onClick={exportarExcel}
              className="text-xs px-3 py-1.5 rounded-lg font-medium border"
              style={{ borderColor: '#e8edf8', color: '#254A96' }}>
              ↓ Exportar Excel
            </button>
            <button onClick={abrirCrear}
              className="text-xs px-3 py-1.5 rounded-lg font-semibold text-white"
              style={{ background: '#254A96' }}>
              + Nuevo usuario
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: '#f4f4f3', borderBottom: '1px solid #e8edf8' }}>
                <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Nombre</th>
                <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Email</th>
                <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Rol</th>
                <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Sucursal</th>
                <th className="text-left px-4 py-3 text-xs font-semibold" style={{ color: '#254A96' }}>Alta</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {usuarios
                .filter(u => {
                  if (!busqueda.trim()) return true
                  const q = busqueda.toLowerCase()
                  return (
                    u.nombre?.toLowerCase().includes(q) ||
                    u.email?.toLowerCase().includes(q) ||
                    (ROL_LABEL[u.rol] ?? u.rol)?.toLowerCase().includes(q) ||
                    u.sucursal?.toLowerCase().includes(q)
                  )
                })
                .map((u, i, arr) => (
                  <tr key={u.id} style={{ borderBottom: i < arr.length - 1 ? '1px solid #f4f4f3' : 'none' }}>
                    <td className="px-4 py-3 font-medium" style={{ color: '#1a1a1a' }}>{u.nombre}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: '#666' }}>{u.email}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-1 rounded-full font-medium"
                        style={{ background: ROL_BG[u.rol] ?? '#f4f4f3', color: ROL_COLOR[u.rol] ?? '#666' }}>
                        {ROL_LABEL[u.rol] ?? u.rol}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: '#666' }}>{u.sucursal ?? 'Todas'}</td>
                    <td className="px-4 py-3 text-xs" style={{ color: '#B9BBB7' }}>
                      {new Date(u.created_at).toLocaleDateString('es-AR')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => abrirEditar(u)}
                          className="text-xs px-2 py-1 rounded-lg"
                          style={{ background: '#e8edf8', color: '#254A96' }}>
                          Editar
                        </button>
                        <button onClick={() => eliminar(u)}
                          className="text-xs px-2 py-1 rounded-lg"
                          style={{ background: '#fde8e8', color: '#E52322' }}>
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {usuarios.length === 0 && !cargando && (
            <div className="py-16 text-center" style={{ color: '#B9BBB7' }}>
              <p className="text-3xl mb-2">👤</p>
              <p className="text-sm">No hay usuarios cargados</p>
            </div>
          )}
        </div>

        {/* Soporte técnico */}
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden mt-8">
          <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: '#e8edf8' }}>
            <div>
              <h2 className="font-bold text-sm" style={{ color: '#254A96' }}>🛟 Soporte técnico por sucursal</h2>
              <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>Los choferes ven estos contactos en el módulo de ruteo</p>
            </div>
          </div>

          {/* Lista de contactos agrupados por sucursal */}
          {SUCURSALES.map(suc => {
            const contactosSuc = contactosSoporte.filter(c => c.sucursal === suc)
            if (contactosSuc.length === 0) return null
            return (
              <div key={suc} className="px-6 py-3 border-b" style={{ borderColor: '#f4f4f3' }}>
                <p className="text-xs font-semibold mb-2 uppercase tracking-wider" style={{ color: '#B9BBB7' }}>{suc}</p>
                <div className="space-y-2">
                  {contactosSuc.map(c => (
                    <div key={c.id} className="flex items-center gap-3 rounded-xl px-3 py-2"
                      style={{ background: c.activo ? '#f8faff' : '#f4f4f3', border: '1px solid #e8edf8', opacity: c.activo ? 1 : 0.5 }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium" style={{ color: '#1a1a1a' }}>{c.nombre}</p>
                        <p className="text-xs" style={{ color: '#254A96' }}>+{c.telefono}</p>
                      </div>
                      <button onClick={() => toggleActivoSoporte(c)}
                        className="text-xs px-2 py-1 rounded-lg"
                        style={{ background: c.activo ? '#d1fae5' : '#f4f4f3', color: c.activo ? '#065f46' : '#B9BBB7' }}>
                        {c.activo ? 'Activo' : 'Inactivo'}
                      </button>
                      <button onClick={() => { setEditSoporte(c); setFormSoporte({ nombre: c.nombre, telefono: c.telefono, sucursal: c.sucursal }) }}
                        className="text-xs px-2 py-1 rounded-lg" style={{ background: '#e8edf8', color: '#254A96' }}>
                        Editar
                      </button>
                      <button onClick={() => eliminarSoporte(c.id)}
                        className="text-xs px-2 py-1 rounded-lg" style={{ background: '#fde8e8', color: '#E52322' }}>
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* Formulario agregar / editar */}
          <div className="px-6 py-4">
            <p className="text-xs font-semibold mb-3" style={{ color: '#254A96' }}>
              {editSoporte ? '✎ Editar contacto' : '+ Agregar contacto'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <input type="text" placeholder="Nombre (ej: Juan Soporte)"
                value={formSoporte.nombre} onChange={e => setFormSoporte(f => ({ ...f, nombre: e.target.value }))}
                className="border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
              <input type="tel" placeholder="Teléfono (ej: 5491155554444)"
                value={formSoporte.telefono} onChange={e => setFormSoporte(f => ({ ...f, telefono: e.target.value }))}
                className="border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }} />
              <select value={formSoporte.sucursal} onChange={e => setFormSoporte(f => ({ ...f, sucursal: e.target.value }))}
                className="border rounded-xl px-3 py-2 text-sm focus:outline-none"
                style={{ borderColor: '#e8edf8' }}>
                {SUCURSALES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <button onClick={guardarSoporte} disabled={guardandoSoporte || !formSoporte.nombre || !formSoporte.telefono}
                className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardandoSoporte ? 'Guardando...' : editSoporte ? 'Actualizar' : 'Agregar'}
              </button>
              {editSoporte && (
                <button onClick={() => { setEditSoporte(null); setFormSoporte({ nombre: '', telefono: '', sucursal: 'LP520' }) }}
                  className="px-4 py-2 rounded-xl text-sm font-medium"
                  style={{ background: '#f4f4f3', color: '#666' }}>
                  Cancelar
                </button>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
