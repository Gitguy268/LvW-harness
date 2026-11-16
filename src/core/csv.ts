/** Small RFC 4180 CSV reader and writer for the fan-out tool. Browser-safe. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Rows as objects keyed by the header row. */
export function csvRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const [header = [], ...body] = parseCsv(text);
  return { header, records: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function toCsv(header: string[], records: Record<string, string>[]): string {
  return [header.map(quote).join(","), ...records.map((r) => header.map((h) => quote(r[h] ?? "")).join(","))].join("\n") + "\n";
}

/** Fill {{column}} placeholders from a record. Unknown names stay as they are. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w .-]+?)\s*\}\}/g, (m, k: string) => (k in values ? values[k] : m));
}
