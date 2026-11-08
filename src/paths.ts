import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every path LvW writes to. Read on each call so tests can point LVW_HOME at a temp dir. */
export function paths() {
  const home = process.env.LVW_HOME ?? join(homedir(), ".lvw");
  return {
    home,
    models: join(home, "models"),
    runtime: join(home, "runtime"),
    memory: join(home, "memory"),
    skills: join(home, "skills"),
    agents: join(home, "agents"),
    plugins: join(home, "plugins"),
    profiles: join(home, "profiles"),
    logs: join(home, "logs"),
    /** Images, audio, video and meshes LvW made. */
    media: join(home, "media"),
    /** Weights for image, video, 3D and music engines (chat models stay in models/). */
    mediaModels: join(home, "media-models"),
    db: join(home, "lvw.db"),
    config: join(home, "config.json"),
    credentials: join(home, "credentials.json"),
  };
}

export function ensureDirs() {
  const p = paths();
  for (const dir of [p.home, p.models, p.runtime, p.memory, p.skills, p.agents, p.plugins, p.profiles, p.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return p;
}
