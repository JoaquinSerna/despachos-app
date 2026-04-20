// Modulos con control de permisos editor/visualizador
export const MODULOS = ['despachos', 'pedidos', 'programacion', 'ruteo', 'confirmaciones', 'abastecimiento', 'metricas', 'flota'] as const
export type Modulo = typeof MODULOS[number]

export const MODULO_LABEL: Record<Modulo, string> = {
  despachos:      'Nueva solicitud de despacho',
  pedidos:        'Listado de pedidos',
  programacion:   'Programacion',
  ruteo:          'Ruteo',
  confirmaciones: 'Confirmaciones',
  abastecimiento: 'Abastecimiento',
  metricas:       'Metricas',
  flota:          'Flota del dia',
}

export const MODULO_ICON: Record<Modulo, string> = {
  despachos:      '📄',
  pedidos:        '📋',
  programacion:   '🗓️',
  ruteo:          '🗺️',
  confirmaciones: '📞',
  abastecimiento: '📦',
  metricas:       '📊',
  flota:          '🚛',
}

// Que roles pueden EDITAR cada modulo por defecto (sin override de permisos)
const ROL_EDITOR_DEFAULT: Record<Modulo, string[]> = {
  despachos:      ['gerencia', 'admin_flota', 'ruteador', 'comercial'],
  pedidos:        ['gerencia', 'admin_flota', 'ruteador'],
  programacion:   ['gerencia', 'admin_flota', 'ruteador'],
  ruteo:          ['gerencia', 'admin_flota', 'ruteador'],
  confirmaciones: ['gerencia', 'admin_flota', 'confirmador'],
  abastecimiento: ['gerencia', 'admin_flota', 'deposito', 'ruteador'],
  metricas:       ['gerencia', 'admin_flota', 'ruteador'],
  flota:          ['gerencia', 'admin_flota'],
}

/**
 * Determina si un usuario puede editar un modulo.
 * Si tiene un override explicito en `permisos`, lo usa.
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
 * Roles que tienen acceso por defecto a cada modulo (editores + visualizadores de base).
 * Si un rol no esta aqui pero tiene un override explicito en permisos, igual tiene acceso.
 */
const ROL_ACCESO_DEFAULT: Record<Modulo, string[]> = {
  despachos:      ['gerencia', 'admin_flota', 'ruteador', 'comercial'],
  pedidos:        ['gerencia', 'admin_flota', 'ruteador'],
  programacion:   ['gerencia', 'admin_flota', 'ruteador'],
  ruteo:          ['gerencia', 'admin_flota', 'ruteador'],
  confirmaciones: ['gerencia', 'admin_flota', 'confirmador'],
  abastecimiento: ['gerencia', 'admin_flota', 'deposito', 'ruteador'],
  metricas:       ['gerencia', 'admin_flota', 'ruteador'],
  flota:          ['gerencia', 'admin_flota'],
}

/**
 * Determina si un usuario puede acceder (ver o editar) a un modulo.
 * Accede si su rol tiene acceso por defecto O si tiene un override explicito de permisos.
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
