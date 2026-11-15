import { isAbsolute, relative, resolve } from "node:path";
import type { PermissionMode } from "../config.ts";
import { paths } from "../paths.ts";

import { decideWith, type Decision, type Risk } from "./policy.ts";

export { isDangerousCommand, isReadOnlyCommand, summarize, type Answer, type ApprovalRequest, type Asker, type Decision, type Risk } from "./policy.ts";

function insideAllowed(path: string, cwd: string) {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return [cwd, paths().home].some((root) => {
    const rel = relative(root, abs);
    return !rel.startsWith("..") && !isAbsolute(rel);
  });
}

export function decide(mode: PermissionMode, risk: Risk, tool: string, args: Record<string, unknown>, cwd: string): Decision {
  return decideWith((path) => insideAllowed(path, cwd), mode, risk, tool, args);
}
