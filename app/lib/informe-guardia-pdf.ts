export interface InformeData {
  sucursal: string
  periodo: { desde: string; hasta: string }
  ciclos: Array<{
    fecha: string
    camion: string
    ingreso: string
    salida: string
    duracion_min: number
    excluido: boolean
    motivo_exclusion: string | null
  }>
  resumen: {
    total_ciclos: number
    ciclos_incluidos: number
    ciclos_excluidos: number
    mediana_todos: number
    promedio_todos: number
    mediana_sin_excluidos: number
    promedio_sin_excluidos: number
  }
  devoluciones: Array<{ categoria: string; cantidad: number }>
  historico: {
    periodo: { desde: string; hasta: string }
    total_ciclos: number
    ciclos_incluidos: number
    mediana_sin_excluidos: number
    promedio_sin_excluidos: number
  }
}

function fmtFecha(iso: string) {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

function fmtMin(min: number) {
  return `${min} min`
}

export async function generarInformeGuardiaPDF(data: InformeData): Promise<void> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const W = 210
  const M = 14          // margin
  const CW = W - 2 * M  // content width
  const AZUL: [number, number, number] = [37, 74, 150]
  const AZUL_CLARO: [number, number, number] = [235, 240, 251]
  const GRIS: [number, number, number] = [107, 114, 128]
  const GRIS_FILA: [number, number, number] = [249, 250, 251]
  const NEGRO: [number, number, number] = [17, 24, 39]
  const BORDE: [number, number, number] = [229, 231, 235]
  const ROJO_CLARO: [number, number, number] = [254, 242, 242]

  let y = 0

  type RGB = [number, number, number]
  const setFill = (c: RGB) => (doc as any).setFillColor(c[0], c[1], c[2])
  const setDraw = (c: RGB) => (doc as any).setDrawColor(c[0], c[1], c[2])
  const setTxt  = (c: RGB) => (doc as any).setTextColor(c[0], c[1], c[2])
  const WHITE: RGB = [255, 255, 255]

  // ── HEADER ──────────────────────────────────────────────
  setFill(AZUL)
  doc.rect(0, 0, W, 28, 'F')
  doc.setTextColor(255, 255, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.text('Informe de Tiempos de Depósito', M, 11)
  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.text(
    `${data.sucursal}   ·   ${fmtFecha(data.periodo.desde)} — ${fmtFecha(data.periodo.hasta)}`,
    M, 21
  )
  y = 36

  // ── KPI BOXES ───────────────────────────────────────────
  const kpis = [
    { label: 'Ciclos totales', value: String(data.resumen.total_ciclos) },
    { label: 'Mediana (s/ excluidos)', value: fmtMin(data.resumen.mediana_sin_excluidos) },
    { label: 'Promedio (s/ excluidos)', value: fmtMin(data.resumen.promedio_sin_excluidos) },
    { label: 'Excluidos', value: String(data.resumen.ciclos_excluidos) },
  ]
  const kW = (CW - 9) / 4
  kpis.forEach((k, i) => {
    const kx = M + i * (kW + 3)
    setFill(AZUL_CLARO)
    doc.roundedRect(kx, y, kW, 20, 2, 2, 'F')
    setTxt(GRIS)
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    doc.text(k.label, kx + kW / 2, y + 6, { align: 'center' })
    setTxt(AZUL)
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.text(k.value, kx + kW / 2, y + 15, { align: 'center' })
  })
  y += 28

  // ── TABLE HELPER ─────────────────────────────────────────
  function drawTableHeader(cols: { label: string; w: number }[], startX: number, ty: number) {
    setFill(AZUL)
    const totalW = cols.reduce((s, c) => s + c.w, 0)
    doc.rect(startX, ty, totalW, 7, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(7.5)
    doc.setFont('helvetica', 'bold')
    let cx = startX
    for (const col of cols) {
      doc.text(col.label, cx + col.w / 2, ty + 4.8, { align: 'center' })
      cx += col.w
    }
    return ty + 7
  }

  function drawTableRow(
    cells: string[],
    cols: { label: string; w: number }[],
    startX: number,
    ty: number,
    even: boolean,
    highlight?: [number, number, number]
  ) {
    const totalW = cols.reduce((s, c) => s + c.w, 0)
    setFill(highlight ?? (even ? GRIS_FILA : WHITE))
    doc.rect(startX, ty, totalW, 6.5, 'F')
    setDraw(BORDE)
    doc.rect(startX, ty, totalW, 6.5, 'S')
    setTxt(NEGRO)
    doc.setFontSize(7.5)
    doc.setFont('helvetica', 'normal')
    let cx = startX
    for (let i = 0; i < cols.length; i++) {
      const text = doc.splitTextToSize(cells[i] ?? '', cols[i].w - 2)
      doc.text(text[0] ?? '', cx + cols[i].w / 2, ty + 4.4, { align: 'center' })
      cx += cols[i].w
    }
    return ty + 6.5
  }

  function sectionTitle(title: string, ty: number) {
    setTxt(AZUL)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'bold')
    doc.text(title, M, ty)
    setDraw(AZUL)
    doc.line(M, ty + 1.5, M + CW, ty + 1.5)
    return ty + 7
  }

  function checkPageBreak(ty: number, needed = 10) {
    if (ty + needed > 280) {
      doc.addPage()
      return 16
    }
    return ty
  }

  // ── SECCIÓN: CICLOS GUARDIA A GUARDIA ───────────────────
  y = sectionTitle('Ciclos guardia a guardia', y)

  const colsCiclos = [
    { label: 'Fecha', w: 22 },
    { label: 'Camión', w: 20 },
    { label: 'Ingreso', w: 20 },
    { label: 'Salida', w: 20 },
    { label: 'Duración', w: 22 },
    { label: 'Estado', w: CW - 104 },
  ]

  y = drawTableHeader(colsCiclos, M, y)

  data.ciclos.forEach((c, i) => {
    y = checkPageBreak(y)
    const estado = c.excluido ? 'Excluido' : 'Incluido'
    const highlight: [number, number, number] | undefined = c.excluido ? ROJO_CLARO : undefined
    y = drawTableRow(
      [fmtFecha(c.fecha), c.camion, c.ingreso, c.salida, fmtMin(c.duracion_min), estado],
      colsCiclos,
      M,
      y,
      i % 2 === 0,
      highlight
    )
  })

  if (!data.ciclos.length) {
    setTxt(GRIS)
    doc.setFontSize(8)
    doc.text('Sin ciclos registrados en el período.', M, y + 5)
    y += 10
  }

  y += 8
  y = checkPageBreak(y, 30)

  // ── SECCIÓN: CASOS EXCLUIDOS ─────────────────────────────
  y = sectionTitle('Casos excluidos (aclaración)', y)

  const excluidos = data.ciclos.filter(c => c.excluido)
  if (excluidos.length) {
    const colsExc = [
      { label: 'Fecha', w: 22 },
      { label: 'Camión', w: 20 },
      { label: 'Duración', w: 22 },
      { label: 'Motivo', w: CW - 64 },
    ]
    y = drawTableHeader(colsExc, M, y)
    excluidos.forEach((c, i) => {
      y = checkPageBreak(y)
      y = drawTableRow(
        [fmtFecha(c.fecha), c.camion, fmtMin(c.duracion_min), c.motivo_exclusion ?? ''],
        colsExc,
        M,
        y,
        i % 2 === 0
      )
    })
  } else {
    setTxt(GRIS)
    doc.setFontSize(8)
    doc.text('Sin casos excluidos.', M, y + 5)
    y += 10
  }

  y += 8
  y = checkPageBreak(y, 30)

  // ── SECCIÓN: DEVOLUCIONES ────────────────────────────────
  y = sectionTitle('Devoluciones por categoría', y)

  if (data.devoluciones.length) {
    const totalDev = data.devoluciones.reduce((s, d) => s + d.cantidad, 0)
    const colsDev = [
      { label: 'Categoría', w: CW - 40 },
      { label: 'Cantidad', w: 20 },
      { label: '% del total', w: 20 },
    ]
    y = drawTableHeader(colsDev, M, y)
    data.devoluciones.forEach((d, i) => {
      y = checkPageBreak(y)
      const pct = totalDev > 0 ? Math.round((d.cantidad / totalDev) * 100) : 0
      y = drawTableRow(
        [d.categoria, String(d.cantidad), `${pct}%`],
        colsDev,
        M,
        y,
        i % 2 === 0
      )
    })
    y = checkPageBreak(y)
    y = drawTableRow(
      ['Total', String(totalDev), '100%'],
      colsDev,
      M,
      y,
      false,
      AZUL_CLARO
    )
  } else {
    setTxt(GRIS)
    doc.setFontSize(8)
    doc.text('Sin devoluciones registradas.', M, y + 5)
    y += 10
  }

  y += 8
  y = checkPageBreak(y, 40)

  // ── SECCIÓN: CONTEXTO HISTÓRICO ──────────────────────────
  y = sectionTitle(
    `Contexto histórico (período anterior: ${fmtFecha(data.historico.periodo.desde)} — ${fmtFecha(data.historico.periodo.hasta)})`,
    y
  )

  const colsHist = [
    { label: 'Métrica', w: CW - 70 },
    { label: 'Período actual', w: 35 },
    { label: 'Período anterior', w: 35 },
  ]
  y = drawTableHeader(colsHist, M, y)

  const histRows = [
    ['Ciclos totales', String(data.resumen.total_ciclos), String(data.historico.total_ciclos)],
    ['Ciclos analizados', String(data.resumen.ciclos_incluidos), String(data.historico.ciclos_incluidos)],
    ['Ciclos excluidos', String(data.resumen.ciclos_excluidos), String(data.historico.ciclos_incluidos > 0 ? data.historico.total_ciclos - data.historico.ciclos_incluidos : 0)],
    ['Mediana (s/ excluidos)', fmtMin(data.resumen.mediana_sin_excluidos), fmtMin(data.historico.mediana_sin_excluidos)],
    ['Promedio (s/ excluidos)', fmtMin(data.resumen.promedio_sin_excluidos), fmtMin(data.historico.promedio_sin_excluidos)],
  ]

  histRows.forEach((row, i) => {
    y = checkPageBreak(y)
    y = drawTableRow(row, colsHist, M, y, i % 2 === 0)
  })

  // ── FOOTER ───────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages()
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p)
    setTxt(GRIS)
    doc.setFontSize(7)
    doc.setFont('helvetica', 'normal')
    doc.text(
      `Generado ${new Date().toLocaleDateString('es-AR')} — ${data.sucursal}`,
      M, 293
    )
    doc.text(`Pág. ${p} / ${pageCount}`, W - M, 293, { align: 'right' })
  }

  const nombre = `informe_guardia_${data.sucursal}_${data.periodo.desde}_${data.periodo.hasta}.pdf`
  doc.save(nombre)
}
