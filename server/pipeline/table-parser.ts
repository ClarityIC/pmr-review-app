/**
 * Shared Markdown table parser used by Step 4 (Table 1) and Step 5 (Table 2).
 *
 * Converts Gemini's Markdown table response into an array of plain objects.
 * Rows that have no non-empty cells are filtered out.
 */

export function parseMarkdownTable(md: string): Record<string, string>[] {
  const lines = md.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('|'));

  if (lines.length < 2) return []; // need header + separator at minimum

  const headers = lines[0]
    .split('|')
    .filter((_, i, a) => i > 0 && i < a.length - 1)
    .map(h => h.trim());

  // lines[1] is the separator row (|---|---|), skip it
  const dataLines = lines.slice(2);

  return dataLines
    .filter(line => line.replace(/\|/g, '').trim().length > 0) // drop blank rows
    .map(line => {
      const cells = line
        .split('|')
        .filter((_, i, a) => i > 0 && i < a.length - 1)
        .map(c => c.trim());

      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
      return row;
    });
}
