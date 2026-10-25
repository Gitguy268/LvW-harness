import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { ensureDirs } from "./paths.ts";

export type Service = "hf" | "gh" | "gl";

const ENV: Record<Service, string[]> = {
  hf: ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"],
  gh: ["GITHUB_TOKEN", "GH_TOKEN"],
  gl: ["GITLAB_TOKEN"],
};

function read(): Partial<Record<Service, string>> {
  const p = ensureDirs();
  return existsSync(p.credentials) ? JSON.parse(readFileSync(p.credentials, "utf8")) : {};
}

/** Environment wins, then the credentials file. Tokens are never logged. */
export function getToken(service: Service): string | undefined {
  for (const name of ENV[service]) if (process.env[name]) return process.env[name];
  return read()[service];
}

export function setToken(service: Service, token: string | undefined) {
  const p = ensureDirs();
  const creds = read();
  if (token) creds[service] = token;
  else delete creds[service];
  writeFileSync(p.credentials, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(p.credentials, 0o600);
}
