// Modulos con control de permisos editor/visualizador
export const MODULOS = ['despachos', 'pedidos', 'programacion', 'ruteo', 'confirmaciones', 'abastecimiento', 'metricas', 'flota', 'flota-base', 'fin-del-dia', 'guardia', 'stock', 'pallets', 'materiales', 'compras', 'recepcion', 'huemul', 'taller'] as const
export type Modulo = typeof MODULOS[number]

// El rol puede venir como un solo rol o como la lista de roles (principal + adicionales) del usuario
const listaRoles = (rol: string | string[] | null | undefined): string[] => Array.isArray(rol) ? rol : rol ? [rol] : []

export const MODULO_LABEL: Record<Modulo, string> = {
  despachos:      'Nueva solicitud de despacho',
  pedidos:        'Listado de pedidos',
  programacion:   'Programacion',
  ruteo:          'Ruteo',
  confirmaciones: 'Confirmaciones',
  abastecimiento: 'Abastecimiento',
  metricas:       'Metricas',
  flota:          'Flota del dia',
  'flota-base':   'Flota base',
  'fin-del-dia':  'Fin del dia',
  guardia:        'Guardia y Cargas',
  stock:          'Stock',
  pallets:        'Pallets',
  materiales:     'Materiales',
  compras:        'Compras',
  recepcion:      'Recepción de mercadería (validar ingresos)',
  huemul:         'Marcar remitos cargados en Huemul',
  taller:         'Taller',
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
  'flota-base':   '⚙️',
  'fin-del-dia':  '🌙',
  guardia:        '🔒',
  stock:          '🏷️',
  pallets:        '📦',
  materiales:     '🏷️',
  compras:        '🧾',
  recepcion:      '📥',
  huemul:         '📦',
  taller:         '🔧',
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
  'flota-base':   ['gerencia', 'admin_flota'],
  'fin-del-dia':  ['gerencia', 'admin_flota', 'ruteador'],
  guardia:        ['gerencia', 'admin_flota', 'deposito'],
  stock:          ['gerencia', 'admin_flota', 'ruteador', 'deposito'],
  pallets:        ['gerencia', 'admin_flota', 'ruteador', 'deposito'],
  materiales:     ['gerencia', 'admin_flota', 'ruteador', 'deposito'],
  compras:        ['gerencia', 'admin_flota', 'compras'],
  recepcion:      ['gerencia', 'admin_flota'],
  huemul:         ['gerencia', 'admin_flota', 'compras'],
  taller:         ['gerencia', 'admin_flota', 'admin_taller', 'mecanico'],
}

/**
 * Determina si un usuario puede editar un modulo.
 * Si tiene un override explicito en `permisos`, lo usa.
 * Si no, cae al default del rol.
 */
export function puedeEditar(
  permisos: Record<string, string> | null | undefined,
  rol: string | string[] | null | undefined,
  modulo: Modulo
): boolean {
  if (permisos && permisos[modulo] === 'none') return false
  if (permisos && modulo in permisos) {
    return permisos[modulo] === 'editor'
  }
  return listaRoles(rol).some(r => ROL_EDITOR_DEFAULT[modulo]?.includes(r))
}

/**
 * Roles que tienen acceso por defecto a cada modulo (editores + visualizadores de base).
 * Si un rol no esta aqui pero tiene un override explicito en permisos, igual tiene acceso.
 */
const ROL_ACCESO_DEFAULT: Record<Modulo, string[]> = {
  despachos:      ['gerencia', 'admin_flota', 'ruteador', 'comercial'],
  pedidos:        ['gerencia', 'admin_flota', 'ruteador'],
  programacion:   ['gerencia', 'admin_flota', 'ruteador', 'deposito'],
  ruteo:          ['gerencia', 'admin_flota', 'ruteador', 'deposito'],
  confirmaciones: ['gerencia', 'admin_flota', 'confirmador'],
  abastecimiento: ['gerencia', 'admin_flota', 'deposito', 'ruteador'],
  metricas:       ['gerencia', 'admin_flota', 'ruteador'],
  flota:          ['gerencia', 'admin_flota'],
  'flota-base':   ['gerencia', 'admin_flota'],
  'fin-del-dia':  ['gerencia', 'admin_flota', 'ruteador'],
  guardia:        ['gerencia', 'admin_flota', 'deposito', 'ruteador'],
  stock:          ['gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial'],
  pallets:        ['gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial'],
  materiales:     ['gerencia', 'admin_flota', 'ruteador', 'deposito'],
  compras:        ['gerencia', 'admin_flota', 'compras'],
  recepcion:      ['gerencia', 'admin_flota'],
  huemul:         ['gerencia', 'admin_flota', 'compras'],
  taller:         ['gerencia', 'admin_flota', 'admin_taller', 'mecanico'],
}

/**
 * Determina si un usuario puede acceder (ver o editar) a un modulo.
 * Accede si su rol tiene acceso por defecto O si tiene un override explicito de permisos.
 * Un override 'none' siempre bloquea el acceso, incluso si el rol lo tendría por default.
 */
export function tieneAcceso(
  permisos: Record<string, string> | null | undefined,
  rol: string | string[] | null | undefined,
  modulo: Modulo
): boolean {
  if (permisos && permisos[modulo] === 'none') return false
  if (listaRoles(rol).some(r => ROL_ACCESO_DEFAULT[modulo]?.includes(r))) return true
  if (permisos && modulo in permisos) return true
  return false
}

/**
 * Devuelve el nivel efectivo para mostrar en UI ('editor' | 'viewer')
 */
export function nivelEfectivo(
  permisos: Record<string, string> | null | undefined,
  rol: string | string[] | null | undefined,
  modulo: Modulo
): 'editor' | 'viewer' {
  return puedeEditar(permisos, rol, modulo) ? 'editor' : 'viewer'
}
