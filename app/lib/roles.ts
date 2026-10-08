export const ROLES = ['gerencia', 'admin_flota', 'ruteador', 'deposito', 'comercial', 'confirmador', 'chofer', 'compras'] as const
export type Rol = typeof ROLES[number]

export const ROL_LABEL: Record<string, string> = {
  gerencia:     'Gerencia',
  admin_flota:  'Admin de Flota',
  ruteador:     'Ruteador',
  deposito:     'Depósito',
  comercial:    'Comercial',
  confirmador:  'Confirmador',
  chofer:       'Chofer',
  compras:      'Compras',
}

export const ROL_DESCRIPCION: Record<string, string> = {
  gerencia:     'Ve y edita todo el sistema',
  admin_flota:  'Configura flota del día y asigna choferes',
  ruteador:     'Confirma programación y orden de rutas',
  deposito:     'Gestiona transferencias entre sucursales y abastecimiento',
  comercial:    'Carga solicitudes de despacho y ve estado de sus pedidos',
  confirmador:  'Llama a clientes para confirmar horario de entrega',
  chofer:       'Ve su recorrido diario asignado',
  compras:      'Revisa ingresos de proveedores y remitos',
}

export const ROL_COLOR: Record<string, string> = {
  gerencia:     '#7c3aed',
  admin_flota:  '#d97706',
  ruteador:     '#254A96',
  deposito:     '#0f766e',
  comercial:    '#065f46',
  confirmador:  '#0891b2',
  chofer:       '#666',
  compras:      '#0e7490',
}

export const ROL_BG: Record<string, string> = {
  gerencia:     '#ede9fe',
  admin_flota:  '#fef3c7',
  ruteador:     '#e8edf8',
  deposito:     '#ccfbf1',
  comercial:    '#d1fae5',
  confirmador:  '#e0f2fe',
  chofer:       '#f4f4f3',
  compras:      '#cffafe',
}

// Qué páginas puede acceder cada rol
export const ROL_PAGINAS: Record<string, string[]> = {
  gerencia:     ['/despachos', '/flota', '/programacion', '/ruteo', '/confirmaciones', '/usuarios', '/metricas', '/abastecimiento'],
  admin_flota:  ['/flota', '/ruteo'],
  ruteador:     ['/despachos', '/programacion', '/ruteo', '/abastecimiento'],
  deposito:     ['/abastecimiento'],
  comercial:    ['/despachos'],
  confirmador:  ['/confirmaciones'],
  chofer:       ['/ruteo'],
  compras:      ['/compras'],
}
