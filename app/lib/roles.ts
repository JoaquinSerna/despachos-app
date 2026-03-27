export const ROLES = ['gerencia', 'admin_flota', 'ruteador', 'comercial', 'confirmador', 'chofer'] as const
export type Rol = typeof ROLES[number]

export const ROL_LABEL: Record<string, string> = {
  gerencia:     'Gerencia',
  admin_flota:  'Admin de Flota',
  ruteador:     'Ruteador',
  comercial:    'Comercial',
  confirmador:  'Confirmador',
  chofer:       'Chofer',
}

export const ROL_DESCRIPCION: Record<string, string> = {
  gerencia:     'Ve y edita todo el sistema',
  admin_flota:  'Configura flota del día y asigna choferes',
  ruteador:     'Confirma programación y orden de rutas',
  comercial:    'Carga solicitudes de despacho y ve estado de sus pedidos',
  confirmador:  'Llama a clientes para confirmar horario de entrega',
  chofer:       'Ve su recorrido diario asignado',
}

export const ROL_COLOR: Record<string, string> = {
  gerencia:     '#7c3aed',
  admin_flota:  '#d97706',
  ruteador:     '#254A96',
  comercial:    '#065f46',
  confirmador:  '#0891b2',
  chofer:       '#666',
}

export const ROL_BG: Record<string, string> = {
  gerencia:     '#ede9fe',
  admin_flota:  '#fef3c7',
  ruteador:     '#e8edf8',
  comercial:    '#d1fae5',
  confirmador:  '#e0f2fe',
  chofer:       '#f4f4f3',
}

// Qué páginas puede acceder cada rol
export const ROL_PAGINAS: Record<string, string[]> = {
  gerencia:     ['/despachos', '/flota', '/programacion', '/ruteo', '/confirmaciones', '/usuarios', '/metricas'],
  admin_flota:  ['/flota', '/ruteo'],
  ruteador:     ['/despachos', '/programacion', '/ruteo'],
  comercial:    ['/despachos'],
  confirmador:  ['/confirmaciones'],
  chofer:       ['/ruteo'],
}
