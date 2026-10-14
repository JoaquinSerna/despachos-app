import { GoogleAuth } from 'google-auth-library'

// Lectura de la carpeta de Drive donde Huemul deja los exports diarios.
// Usa la misma cuenta de servicio del export de OTIF (GOOGLE_SERVICE_ACCOUNT_JSON); la carpeta tiene
// que estar compartida con el mail de esa cuenta, solo lectura.

const API = 'https://www.googleapis.com/drive/v3'
export const NOMBRE_CARPETA = '02_Deposito'

export interface ArchivoDrive { id: string; name: string; modifiedTime: string; size?: string }

function credenciales(): { client_email: string } & Record<string, unknown> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) throw new Error('Falta la variable GOOGLE_SERVICE_ACCOUNT_JSON en el servidor.')
  return JSON.parse(raw.trim().replace(/^["']/, '').replace(/["']$/, ''))
}

export const mailCuentaServicio = (): string | null => {
  try { return credenciales().client_email ?? null } catch { return null }
}

export async function tokenDrive(): Promise<string> {
  const auth = new GoogleAuth({ credentials: credenciales(), scopes: ['https://www.googleapis.com/auth/drive.readonly'] })
  const token = await auth.getAccessToken()
  if (!token) throw new Error('No se pudo obtener el acceso a Google Drive.')
  return token
}

// Traduce el error de Google a algo que se pueda resolver
function mensajeDeError(status: number, cuerpo: string): string {
  const proyecto = cuerpo.match(/project[ =](\d{6,})/)?.[1]
  if (/SERVICE_DISABLED|has not been used in project|accessNotConfigured/i.test(cuerpo)) {
    return `Falta activar la API de Google Drive en el proyecto de Google Cloud${proyecto ? ` (${proyecto})` : ''}. Activala en este enlace y reintentá: `
      + `https://console.developers.google.com/apis/api/drive.googleapis.com/overview${proyecto ? `?project=${proyecto}` : ''}`
  }
  if (status === 401) return 'Google rechazó las credenciales de la cuenta de servicio (revisá GOOGLE_SERVICE_ACCOUNT_JSON).'
  if (status === 403) return 'La cuenta de servicio no tiene permiso para leer esa carpeta de Drive. Compartila con ella como Lector.'
  return `Google Drive respondió ${status}: ${cuerpo.slice(0, 200)}`
}

async function pedir(token: string, ruta: string, params: Record<string, string>): Promise<any> {
  const url = `${API}${ruta}?${new URLSearchParams({ supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...params })}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(mensajeDeError(res.status, await res.text()))
  return res.json()
}

// Si se conoce el id de la carpeta (DRIVE_FOLDER_ID) se usa; si no, se busca por nombre entre las compartidas con la cuenta.
export async function carpetaDeposito(token: string): Promise<string | null> {
  if (process.env.DRIVE_FOLDER_ID) return process.env.DRIVE_FOLDER_ID.trim()
  const r = await pedir(token, '/files', {
    q: `name = '${NOMBRE_CARPETA}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)', pageSize: '10',
  })
  return r.files?.[0]?.id ?? null
}

export async function listarArchivos(token: string, carpetaId: string, prefijo: string): Promise<ArchivoDrive[]> {
  const archivos: ArchivoDrive[] = []
  let pagina: string | undefined
  do {
    const r = await pedir(token, '/files', {
      q: `'${carpetaId}' in parents and trashed = false and name contains '${prefijo}'`,
      fields: 'nextPageToken,files(id,name,modifiedTime,size)', pageSize: '200', orderBy: 'modifiedTime desc',
      ...(pagina ? { pageToken: pagina } : {}),
    })
    archivos.push(...(r.files ?? []))
    pagina = r.nextPageToken
  } while (pagina && archivos.length < 1000)
  return archivos
}

export async function descargarArchivo(token: string, id: string): Promise<ArrayBuffer> {
  const url = `${API}/files/${id}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`No se pudo descargar el archivo de Drive (${res.status}).`)
  return res.arrayBuffer()
}

// compras_ingreso_20261014_0600.xlsx → ingresos; compras_20261014_0609.xlsx → órdenes de compra.
// De cada tipo se toma el más nuevo según la fecha y hora del nombre.
export function elegirMasNuevos(archivos: ArchivoDrive[]): { ingresos: ArchivoDrive | null; oc: ArchivoDrive | null } {
  const clave = (a: ArchivoDrive, re: RegExp) => { const m = a.name.match(re); return m ? `${m[1]}${m[2]}` : null }
  const masNuevo = (re: RegExp) => archivos
    .map(a => ({ a, k: clave(a, re) }))
    .filter((x): x is { a: ArchivoDrive; k: string } => !!x.k)
    .sort((x, y) => y.k.localeCompare(x.k))[0]?.a ?? null
  return {
    ingresos: masNuevo(/^compras_ingreso_(\d{8})_(\d{4})\.xlsx$/i),
    oc: masNuevo(/^compras_(\d{8})_(\d{4})\.xlsx$/i),
  }
}
