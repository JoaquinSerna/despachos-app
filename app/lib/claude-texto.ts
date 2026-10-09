// Junta el texto de la respuesta del modelo sin asumir que content[0] es el bloque de texto:
// algunos modelos devuelven antes otros bloques (p. ej. de razonamiento) y content[0].text quedaba vacío.
export function textoDeRespuesta(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')
}
