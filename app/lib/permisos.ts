// Módulos con control de permisos editor/visualizador
export const MODULOS = ['despachos', 'pedidos', 'programacion', 'ruteo', 'confirmaciones', 'abastecimiento'] as const
export type Modulo = typeof MODULOS[number]

export const MODULO_LABEL: Record<Modulo, string> = {
  despachos:      'Nueva solicitud de despacho',
  pedidos:        'Listado de pedidos',
  programacion:   'Programación',
  ruteo:          'Ruteo',
  confirmaciones: 'Confirmaciones',
  abastecimiento: 'Abastecimiento',
}

export const MODULO_ICON: Record<Modulo, string> = {
  despachos:      '📄',
  pedidos:        '📋',
  programacion:   '🗓️',
  ruteo:          '🗺️',
  confirmaciones: '📞',
  abastecimiento: '📦',
}

// Qué roles pueden EDITAR cada módulo por defecto (sin override de permisos)
const ROL_EDITOR_DEFAULT: Record<Modulo, string[]> = {
  despachos:      ['gerencia', 'admin_flota', 'ruteador', 'comercial'],
  pedidos:        ['gerencia', 'admin_flota', 'ruteador'],
  programacion:   ['gerencia', 'admin_flota', 'ruteador'],
  ruteo:          ['gerencia', 'admin_flota', 'ruteador'],
  confirmaciones: ['gerencia', 'admin_flota', 'confirmador'],
  abastecimiento: ['gerencia', 'admin_flota', 'deposito', 'ruteador'],
}

/**
 * Determina si un usuario puede editar un módulo.
 * Si tiene un override explícito en `permisos`, lo usa.
 * Si no, cae al default del rol.
 */
export function puedeEditar(
  permisos: Record<string, string> | null | undefined,
  rol: string,
  modulo: Modulo
): boolean {
  if (permisos && modulo in permisos) {
    return permisos[modulo] === 'editor'
  }
  return ROL_EDITOR_DEFAULT[modulo]?.includes(rol) ?? false
}

/**
 * Roles que tienen acceso por defecto a cada módulo (editores + visualizadores de base).
 * Si un rol no está aquí pero tiene un override explícito en permisos, igual tiene acceso.
 */
const ROL_ACCESO_DEFAULT: Record<Modulo, string[]> = {
  despachos:      ['gerencia', 'admin_flota', 'ruteador', 'comercial'],
  pedidos:        ['gerencia', 'admin_flota', 'ruteador'],
  programacion:   ['gerencia', 'admin_flota', 'ruteador'],
  ruteo:          ['gerencia', 'admin_flota', 'ruteador'],
  confirmaciones: ['gerencia', 'admin_flota', 'confirmador'],
  abastecimiento: ['gerencia', 'admin_flota', 'deposito', 'ruteador'],
}

/**
 * Determina si un usuario puede acceder (ver o editar) a un módulo.
 * Accede si su rol tiene acceso por defecto O si tiene un override explícito de permisos.
 */
export function tieneAcceso(
  permisos: Record<string, string> | null | undefined,
  rol: string,
  modulo: Modulo
): boolean {
  if (ROL_ACCESO_DEFAULT[modulo]?.includes(rol)) return true
  if (permisos && modulo in permisos) return true
  return false
}

/**
 * Devuelve el nivel efectivo para mostrar en UI ('editor' | 'viewer')
 */
export function nivelEfectivo(
  permisos: Record<string, string> | null | undefined,
  rol: string,
  modulo: Modulo
): 'editor' | 'viewer' {
  return puedeEditar(permisos, rol, modulo) ? 'editor' : 'viewer'
}
