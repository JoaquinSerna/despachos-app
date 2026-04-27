'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../supabase' // solo para auth check
import { useRouter } from 'next/navigation'
import * as XLSX from 'xlsx'
import { ROLES, ROL_LABEL, ROL_DESCRIPCION, ROL_COLOR, ROL_BG } from '../lib/roles'
import { MODULOS, MODULO_LABEL, MODULO_ICON, nivelEfectivo } from '../lib/permisos'
import { logAuditoria } from '../lib/auditoria'

interface Usuario {
  id: string
  nombre: string
  email: string
  rol: string
  sucursal: string | null
  created_at: string
  permisos?: Record<string, string>
  activo?: boolean   // columna en DB: activo boolean DEFAULT true NOT NULL
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
  const [modalPermisos, setModalPermisos] = useState<Usuario | null>(null)
  const [permisosEdit, setPermisosEdit] = useState<Record<string, string>>({})
  const [guardandoPermisos, setGuardandoPermisos] = useState(false)
  const [botonPedidosVisible, setBotonPedidosVisible] = useState(true)
  const [adminId, setAdminId] = useState('')
  const [adminNombre, setAdminNombre] = useState('')

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
      const { data } = await supabase.from('usuarios').select('rol, nombre').eq('id', user.id).single()
      if (data?.rol !== 'gerencia') { router.push('/dashboard'); return }
      setAdminId(user.id)
      setAdminNombre(data?.nombre ?? '')
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

  const abrirPermisos = (u: Usuario) => {
    setPermisosEdit({ ...(u.permisos ?? {}) })
    setModalPermisos(u)
  }

  const togglePermiso = (modulo: string, nivel: 'editor' | 'viewer' | 'none') => {
    setPermisosEdit(prev => ({ ...prev, [modulo]: nivel }))
  }

  const resetPermiso = (modulo: string) => {
    setPermisosEdit(prev => { const n = { ...prev }; delete n[modulo]; return n })
  }

  const guardarPermisos = async () => {
    if (!modalPermisos) return
    setGuardandoPermisos(true)
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch('/api/crear-usuario', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(session?.access_token ? { 'Authorization': `Bearer ${session.access_token}` } : {}),
      },
      body: JSON.stringify({ id: modalPermisos.id, permisos: permisosEdit }),
    })
    const data = await res.json()
    if (data.error) { showToast(data.error, 'err') }
    else {
      setUsuarios(prev => prev.map(u => u.id === modalPermisos.id ? { ...u, permisos: permisosEdit } : u))
      showToast('Permisos actualizados')
      if (adminId) logAuditoria(adminId, adminNombre, 'Actualizó permisos', 'Usuarios', { usuario_email: modalPermisos.email, permisos: permisosEdit })
      setModalPermisos(null)
    }
    setGuardandoPermisos(false)
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
        if (adminId) logAuditoria(adminId, adminNombre, 'Creó usuario', 'Usuarios', { email: form.email, nombre: form.nombre, rol: form.rol, sucursal: form.sucursal })
      } else if (modal?.tipo === 'editar' && modal.usuario) {
        const res = await fetch('/api/crear-usuario', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: modal.usuario.id,
            emailAnterior: modal.usuario.email,
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
        if (adminId) logAuditoria(adminId, adminNombre, 'Editó usuario', 'Usuarios', { email: form.email, nombre: form.nombre, rol: form.rol, sucursal: form.sucursal })
      }
      setModal(null)
      cargarUsuarios()
    } catch (e: any) {
      showToast(e.message, 'err')
    } finally {
      setGuardando(false)
    }
  }

  const darVisualizacionPedidosComerciales = async () => {
    const comerciales = usuarios.filter(u => u.rol === 'comercial' && u.permisos?.['pedidos'] !== 'viewer' && u.permisos?.['pedidos'] !== 'editor')
    if (comerciales.length === 0) { showToast('Todos los comerciales ya tienen acceso a pedidos'); setBotonPedidosVisible(false); return }
    if (!confirm(`¿Dar visualización de pedidos a ${comerciales.length} comerciale${comerciales.length !== 1 ? 's' : ''}?`)) return
    try {
      await Promise.all(comerciales.map(u =>
        fetch('/api/crear-usuario', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: u.id, permisos: { ...(u.permisos ?? {}), pedidos: 'viewer' } }),
        })
      ))
      showToast(`${comerciales.length} comercial${comerciales.length !== 1 ? 'es' : ''} actualizados`)
      setBotonPedidosVisible(false)
      cargarUsuarios()
    } catch { showToast('Error al actualizar', 'err') }
  }

  const resetSucursalComerciales = async () => {
    const comerciales = usuarios.filter(u => u.rol === 'comercial' && u.sucursal !== null)
    if (comerciales.length === 0) { showToast('Todos los comerciales ya tienen "Todas las sucursales"'); return }
    if (!confirm(`¿Asignar "Todas las sucursales" a ${comerciales.length} comerciale${comerciales.length !== 1 ? 's' : ''}?`)) return
    try {
      await Promise.all(comerciales.map(u =>
        fetch('/api/crear-usuario', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: u.id, emailAnterior: u.email, nombre: u.nombre, email: u.email, rol: u.rol, sucursal: '' }),
        })
      ))
      showToast(`${comerciales.length} comercial${comerciales.length !== 1 ? 'es' : ''} actualizados`)
      cargarUsuarios()
    } catch { showToast('Error al actualizar', 'err') }
  }

  const toggleActivo = async (u: Usuario) => {
    const nuevoEstado = !(u.activo !== false)  // undefined → true → false
    const accion = nuevoEstado ? 'activar' : 'inactivar'
    if (!confirm(`¿${nuevoEstado ? 'Activar' : 'Inactivar'} a ${u.nombre}?`)) return
    const res = await fetch('/api/crear-usuario', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: u.id, activo: nuevoEstado }),
    })
    const data = await res.json()
    if (data.error) { showToast(data.error, 'err'); return }
    showToast(`Usuario ${nuevoEstado ? 'activado' : 'inactivado'}`)
    if (adminId) logAuditoria(adminId, adminNombre, nuevoEstado ? 'Activó usuario' : 'Desactivó usuario', 'Usuarios', { email: u.email, nombre: u.nombre })
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

      {/* Modal permisos */}
      {modalPermisos && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="bg-white rounded-2xl w-full max-w-lg p-6 space-y-4">
            <div className="flex justify-between items-start">
              <div>
                <h3 className="font-bold text-base" style={{ color: '#254A96' }}>🔐 Permisos de acceso</h3>
                <p className="text-xs mt-0.5" style={{ color: '#B9BBB7' }}>
                  {modalPermisos.nombre} · <span style={{ color: ROL_COLOR[modalPermisos.rol] }}>{ROL_LABEL[modalPermisos.rol]}</span>
                </p>
              </div>
              <button onClick={() => setModalPermisos(null)} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
            </div>

            <div className="space-y-2">
              {MODULOS.map(modulo => {
                const override = permisosEdit[modulo]
                const efectivo = nivelEfectivo(permisosEdit, modalPermisos.rol, modulo)
                const esDefault = !override
                return (
                  <div key={modulo} className="flex items-center gap-3 rounded-xl px-4 py-3 border"
                    style={{ borderColor: '#e8edf8', background: '#fafafa' }}>
                    <span className="text-base w-6 text-center">{MODULO_ICON[modulo]}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: '#1a1a1a' }}>{MODULO_LABEL[modulo]}</p>
                      {esDefault && (
                        <p className="text-xs" style={{ color: '#B9BBB7' }}>Default del rol ({efectivo === 'editor' ? 'editor' : 'visualizador'})</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => togglePermiso(modulo, 'editor')}
                        className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
                        style={{
                          background: override === 'editor' ? '#254A96' : (esDefault && efectivo === 'editor' ? '#e8edf8' : '#f4f4f3'),
                          color: override === 'editor' ? 'white' : (esDefault && efectivo === 'editor' ? '#254A96' : '#999'),
                        }}>
                        ✏️ Editor
                      </button>
                      <button
                        onClick={() => togglePermiso(modulo, 'viewer')}
                        className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
                        style={{
                          background: override === 'viewer' ? '#6b7280' : (esDefault && efectivo === 'viewer' ? '#e8edf8' : '#f4f4f3'),
                          color: override === 'viewer' ? 'white' : (esDefault && efectivo === 'viewer' ? '#374151' : '#999'),
                        }}>
                        👁️ Ver
                      </button>
                      <button
                        onClick={() => togglePermiso(modulo, 'none')}
                        className="text-xs px-2.5 py-1.5 rounded-lg font-medium transition-colors"
                        style={{
                          background: override === 'none' ? '#E52322' : '#f4f4f3',
                          color: override === 'none' ? 'white' : '#ccc',
                        }}
                        title="Sin acceso — bloquea incluso si el rol lo tiene por default">
                        🚫
                      </button>
                      {!esDefault && (
                        <button onClick={() => resetPermiso(modulo)}
                          className="text-xs px-2 py-1.5 rounded-lg"
                          style={{ background: '#fef3c7', color: '#d97706' }}
                          title="Restaurar default del rol">
                          ↩
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex gap-2 pt-1">
              <button onClick={() => setModalPermisos(null)}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium border"
                style={{ borderColor: '#e8edf8', color: '#666' }}>
                Cancelar
              </button>
              <button onClick={guardarPermisos} disabled={guardandoPermisos}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#254A96' }}>
                {guardandoPermisos ? 'Guardando...' : 'Guardar permisos'}
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
            {botonPedidosVisible && (
              <button onClick={darVisualizacionPedidosComerciales}
                className="text-xs px-3 py-1.5 rounded-lg font-medium border"
                style={{ borderColor: '#bbf7d0', color: '#065f46', background: '#f0fdf4' }}>
                📋 Comerciales → Ver pedidos
              </button>
            )}
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
                .map((u, i, arr) => {
                  const estaActivo = u.activo !== false
                  return (
                  <tr key={u.id} style={{
                    borderBottom: i < arr.length - 1 ? '1px solid #f4f4f3' : 'none',
                    opacity: estaActivo ? 1 : 0.5,
                  }}>
                    <td className="px-4 py-3 font-medium" style={{ color: '#1a1a1a' }}>
                      <div className="flex items-center gap-2">
                        {u.nombre}
                        {!estaActivo && (
                          <span className="text-xs px-1.5 py-0.5 rounded font-medium"
                            style={{ background: '#f4f4f3', color: '#B9BBB7' }}>inactivo</span>
                        )}
                      </div>
                    </td>
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
                        <button onClick={() => abrirPermisos(u)}
                          className="text-xs px-2 py-1 rounded-lg"
                          style={{ background: '#fef3c7', color: '#d97706' }}>
                          🔐 Permisos
                        </button>
                        <button onClick={() => abrirEditar(u)}
                          className="text-xs px-2 py-1 rounded-lg"
                          style={{ background: '#e8edf8', color: '#254A96' }}>
                          Editar
                        </button>
                        <button onClick={() => toggleActivo(u)}
                          className="text-xs px-2 py-1 rounded-lg"
                          style={estaActivo
                            ? { background: '#fde8e8', color: '#E52322' }
                            : { background: '#d1fae5', color: '#065f46' }}>
                          {estaActivo ? 'Inactivar' : 'Activar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  )
                })}
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
