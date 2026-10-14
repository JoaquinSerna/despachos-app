import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { importarOCConCliente } from '../../lib/oc-import'
import { importarHuemulConCliente } from '../../lib/huemul-import'
import { exportadoEnDeNombre } from '../../lib/huemul-utils'
import { rolesDe } from '../../lib/roles'
import {
  carpetaDeposito, descargarArchivo, elegirMasNuevos, listarArchivos, mailCuentaServicio, NOMBRE_CARPETA, tokenDrive,
} from '../../lib/drive'

export const maxDuration = 60

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
}

type Origen = 'cron' | 'manual'

// Vercel llama con "Authorization: Bearer CRON_SECRET"; también vale la clave del script del stock (x-cron-secret).
// Desde la pantalla, un usuario con permiso de editor en Compras.
async function autorizar(req: NextRequest, admin: ReturnType<typeof getAdmin>): Promise<Origen | null> {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  const clave = req.headers.get('x-cron-secret')
  const secretos = [process.env.CRON_SECRET, process.env.STOCK_IMPORT_SECRET, process.env.COMPRAS_SYNC_SECRET].filter(Boolean)
  if ((bearer && secretos.includes(bearer)) || (clave && secretos.includes(clave))) return 'cron'
  if (!bearer || req.method !== 'POST') return null
  const { data: { user } } = await admin.auth.getUser(bearer)
  if (!user) return null
  const { data: perfil } = await admin.from('usuarios').select('rol, roles_extra, permisos, activo').eq('id', user.id).single()
  if (!perfil || perfil.activo === false) return null
  const perm = (perfil.permisos as Record<string, string> | null)?.compras
  const esRolCompras = rolesDe(perfil.rol, perfil.roles_extra).some(r => ['gerencia', 'admin_flota', 'compras'].includes(r))
  return (esRolCompras && perm !== 'none') || perm === 'editor' ? 'manual' : null
}

async function registrar(admin: ReturnType<typeof getAdmin>, fila: {
  tipo: 'ingresos' | 'oc' | 'general'; archivo?: string | null; exportado_en?: string | null; ok: boolean; omitido?: boolean; origen: Origen; detalle?: unknown
}) {
  await admin.from('drive_sync_log').insert({ omitido: false, ...fila })
}

async function ejecutar(req: NextRequest) {
  const admin = getAdmin()
  const origen = await autorizar(req, admin)
  if (!origen) return NextResponse.json({ error: 'No autorizado' }, { status: 401 })

  const inicio = Date.now()
  const resultados: Record<string, unknown>[] = []
  let archivos
  try {
    const token = await tokenDrive()
    const carpeta = await carpetaDeposito(token)
    if (!carpeta) {
      const mail = mailCuentaServicio()
      const mensaje = `No encuentro la carpeta ${NOMBRE_CARPETA} en Drive. Compartila (solo lectura) con ${mail ?? 'la cuenta de servicio de Google'}.`
      await registrar(admin, { tipo: 'general', ok: false, origen, detalle: { mensaje, cuenta_de_servicio: mail } })
      return NextResponse.json({ ok: false, error: mensaje, cuenta_de_servicio: mail }, { status: 200 })
    }
    archivos = { token, ...elegirMasNuevos(await listarArchivos(token, carpeta, 'compras_')) }
  } catch (e: any) {
    const mensaje = e?.message ?? 'No se pudo leer Google Drive'
    await registrar(admin, { tipo: 'general', ok: false, origen, detalle: { mensaje, cuenta_de_servicio: mailCuentaServicio() } })
    return NextResponse.json({ ok: false, error: mensaje }, { status: 200 })
  }

  for (const tipo of ['ingresos', 'oc'] as const) {
    const archivo = archivos[tipo]
    if (!archivo) { resultados.push({ tipo, omitido: true, motivo: 'No hay archivo en la carpeta' }); continue }
    const exportado = exportadoEnDeNombre(archivo.name)
    try {
      // Ya procesado: no se repite
      const { data: previo } = await admin.from('drive_sync_log').select('id').eq('tipo', tipo).eq('archivo', archivo.name).eq('ok', true).eq('omitido', false).limit(1)
      if (previo?.length && origen === 'cron') { resultados.push({ tipo, archivo: archivo.name, omitido: true, motivo: 'Ya estaba importado' }); continue }
      // Se corta antes de arrancar un trabajo largo sin tiempo: la próxima corrida lo retoma
      if (Date.now() - inicio > 35000) {
        await registrar(admin, { tipo, archivo: archivo.name, exportado_en: exportado, ok: true, omitido: true, origen, detalle: { motivo: 'Sin tiempo en esta corrida' } })
        resultados.push({ tipo, archivo: archivo.name, omitido: true, motivo: 'Sin tiempo en esta corrida' }); continue
      }
      const buffer = await descargarArchivo(archivos.token, archivo.id)
      let detalle: unknown
      if (tipo === 'oc') {
        detalle = await importarOCConCliente(admin, XLSX, buffer, null, () => {})
      } else {
        // Un export de ingresos más viejo que el último importado no pisa datos nuevos
        const { data: ultima } = await admin.from('huemul_importaciones').select('exportado_en').not('exportado_en', 'is', null).order('exportado_en', { ascending: false }).limit(1)
        if (exportado && ultima?.[0]?.exportado_en && new Date(exportado) < new Date(ultima[0].exportado_en)) {
          await registrar(admin, { tipo, archivo: archivo.name, exportado_en: exportado, ok: true, omitido: true, origen, detalle: { motivo: 'Ya hay un export más nuevo importado' } })
          resultados.push({ tipo, archivo: archivo.name, omitido: true, motivo: 'Ya hay un export más nuevo importado' }); continue
        }
        detalle = await importarHuemulConCliente(admin, XLSX, buffer, archivo.name, null, () => {})
      }
      await registrar(admin, { tipo, archivo: archivo.name, exportado_en: exportado, ok: true, origen, detalle })
      resultados.push({ tipo, archivo: archivo.name, ok: true, detalle })
    } catch (e: any) {
      const mensaje = e?.message ?? 'Error al importar'
      await registrar(admin, { tipo, archivo: archivo.name, exportado_en: exportado, ok: false, origen, detalle: { mensaje } })
      resultados.push({ tipo, archivo: archivo.name, ok: false, error: mensaje })
    }
  }
  return NextResponse.json({ ok: true, origen, segundos: Math.round((Date.now() - inicio) / 1000), resultados })
}

// GET: lo llama Vercel (cron). POST: botón "Sincronizar ahora" de Compras.
export async function GET(req: NextRequest) { return ejecutar(req) }
export async function POST(req: NextRequest) { return ejecutar(req) }
