/** MTEXT 格式码清理：只做查看所需的纯文本还原，不解析富文本样式。 */
export function cleanMText(input: string): string {
  return input
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\P/g, '\n')
    .replace(/\\[LOlo]/g, '')
    .replace(/\\[Ff][^;\\]*?\|[^;\\]*;/g, '')
    .replace(/\\[Ff][^;\\]*;/g, '')
    .replace(/\\[AaCcHhKkQqTtWw][^;\\]*;?/g, '')
    .replace(/\\[a-zA-Z]+;?/g, '')
    .replace(/%%c/gi, 'Ø')
    .replace(/%%d/gi, '°')
    .replace(/%%p/gi, '±')
    .replace(/%%%/g, '%')
    .replace(/[{}]/g, '')
    .trim()
}

export function textLines(input: string): string[] {
  return cleanMText(input)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
