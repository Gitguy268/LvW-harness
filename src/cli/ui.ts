import { createInterface } from "node:readline/promises";
import { formatBytes } from "../models/disk.ts";

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export function table(rows: string[][], header?: string[]) {
  const all = header ? [header, ...rows] : rows;
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = all[0]?.map((_, i) => Math.max(...all.map((r) => strip(r[i] ?? "").length))) ?? [];
  const line = (r: string[]) => r.map((cell, i) => cell + " ".repeat(widths[i] - strip(cell).length)).join("  ").trimEnd();
  if (header) console.log(c.dim(line(header)));
  for (const r of rows) console.log(line(r));
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, def = false): Promise<boolean> {
  if (!process.stdin.isTTY) return def;
  const a = (await ask(`${question} ${def ? "[Y/n]" : "[y/N]"} `)).toLowerCase();
  return a ? a.startsWith("y") : def;
}

/** Read a secret without echoing it. */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return (await new Response(Bun.stdin.stream()).text()).trim();
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  let value = "";
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString()) {
      if (ch === "\r" || ch === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        return value;
      }
      if (ch === "\u0003") process.exit(130);
      if (ch === "\u007f") value = value.slice(0, -1);
      else value += ch;
    }
  }
  return value;
}

export function progressBar() {
  let last = 0;
  let startedAt = Date.now();
  return {
    update(label: string, done: number, total: number) {
      const now = Date.now();
      if (now - last < 100 && done < total) return;
      last = now;
      const width = 28;
      const frac = total ? Math.min(1, done / total) : 0;
      const bar = "█".repeat(Math.round(frac * width)).padEnd(width, "░");
      const rate = done / Math.max(1, (now - startedAt) / 1000);
      const text = `${bar} ${(frac * 100).toFixed(0).padStart(3)}%  ${formatBytes(done)}/${formatBytes(total)}  ${formatBytes(rate)}/s  ${c.dim(label.slice(0, 40))}`;
      if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${text}`);
    },
    reset() {
      startedAt = Date.now();
    },
    end() {
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
    },
  };
}

export function fail(msg: string): never {
  console.error(c.red("error: ") + msg);
  process.exit(1);
}
