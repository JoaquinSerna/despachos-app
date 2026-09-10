import nodemailer from 'nodemailer'

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
})

export async function enviarMailReprogramacion({
  destinatario,
  nombre,
  nv,
  cliente,
  mensaje,
}: {
  destinatario: string
  nombre: string
  nv: string
  cliente: string
  mensaje: string
}) {
  await transporter.sendMail({
    from: `"Despachos CAC" <${process.env.GMAIL_USER}>`,
    to: destinatario,
    subject: `📅 Reprogramación — NV ${nv} (${cliente})`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px;">
        <img src="https://despachos-app-omega.vercel.app/logo.png" alt="Construyo al Costo" style="height: 40px; margin-bottom: 20px;" />
        <h2 style="color: #254A96; margin: 0 0 8px;">Reprogramación de pedido</h2>
        <p style="color: #555; margin: 0 0 20px;">Hola ${nombre},</p>
        <div style="background: #e8edf8; border-left: 4px solid #254A96; padding: 14px 18px; border-radius: 8px; margin-bottom: 20px;">
          <p style="margin: 0; color: #1a1a1a; font-size: 15px;">${mensaje}</p>
        </div>
        <p style="color: #999; font-size: 12px; margin: 0;">
          Este mail fue generado automáticamente por el sistema de despachos de Construyo al Costo.<br/>
          Podés ver el estado de tus pedidos en
          <a href="https://despachos-app-omega.vercel.app" style="color: #254A96;">despachos-app-omega.vercel.app</a>
        </p>
      </div>
    `,
  })
}
