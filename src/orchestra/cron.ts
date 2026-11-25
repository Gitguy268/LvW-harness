/** Five-field cron matching. Browser-safe. */
function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let [lo, hi] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (hi === undefined) hi = stepStr ? max : lo;
    if ([lo, hi, step].some((n) => Number.isNaN(n)) || lo < min || hi > max || step < 1) throw new Error(`Bad cron field "${spec}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields, got "${expr}"`);
  const [m, h, dom, mon, dow] = parts;
  const days = field(dow, 0, 7);
  if (days.has(7)) days.add(0);
  return { minute: field(m, 0, 59), hour: field(h, 0, 23), dom: field(dom, 1, 31), month: field(mon, 1, 12), dow: days, domAny: dom === "*", dowAny: dow === "*" };
}

export function cronMatches(expr: string, d: Date): boolean {
  const c = parseCron(expr);
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // Like cron: when both day fields are restricted, either may match.
  return c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
}
