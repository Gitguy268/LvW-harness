# NOTICE

LvW-harness is MIT licensed (see [LICENSE](LICENSE)). It builds on the work below. Licences were checked with the GitHub and npm APIs on 2026-10-25.

## Dependencies (npm)

| Package | Version | Licence | Used for |
|---|---|---|---|
| [@earendil-works/pi-ai, pi-agent-core, pi-tui, pi-mcp, pi-telemetry](https://github.com/earendil-works/pi) | 1.4.0 | MIT | model providers, the agent loop, the terminal UI, the MCP client |
| [playwright-core](https://github.com/microsoft/playwright) | 1.64.1 | Apache-2.0 | the browser tools |

## Bundled skills

Copied unchanged into `skills/`, each folder with its original `LICENSE`.

| Skills | Source | Licence |
|---|---|---|
| ponytail, ponytail-audit, ponytail-review | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | MIT, © 2026 DietrichGebert |
| security-audit | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | MIT, © 2025-2026 Cloudflare, Inc. |
| diagnosing-bugs, grill-me, handoff, research, tdd | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT, © 2026 Matt Pocock |

## Downloaded at run time (not part of this repository)

| Software | Licence | When |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` | MIT | `lvw runtime install`, and baked into the Docker image |
| [Ollama](https://github.com/ollama/ollama) | MIT | optional; LvW talks to a running Ollama |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | BSD-3-Clause | optional; `lvw tool install scrapling` installs it with `uv` |
| Chromium (Debian package) | BSD-3-Clause and others | the Docker image only |
| Models from Hugging Face, GitHub, GitLab or Ollama | each model's own licence | `lvw model pull` |

## Ideas, no code

These projects inspired features that were written from scratch for LvW. No code was copied.

| Project | Licence | Idea used in LvW |
|---|---|---|
| [opencode](https://github.com/anomalyco/opencode) | MIT | coding tool set, permission modes |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | MIT | coding tools on top of pi |
| [cloudflare/computer](https://github.com/cloudflare/computer) | MIT | one `exec` call with swappable backends (host or Docker) |
| [ego-lite](https://github.com/citrolabs/ego-lite) | MIT | one isolated browser "Space" per agent, compact page snapshots with refs |
| [browser-use](https://github.com/browser-use/browser-use) | MIT | acting on element refs instead of pixels |
| [Tencent BrowserSkill](https://github.com/Tencent/BrowserSkill) | MIT | attaching to your own browser over CDP |
| [ai-memory](https://github.com/akitaonrails/ai-memory) | MIT | Markdown memory with a full-text index |
| [hermes-agent](https://github.com/NousResearch/hermes-agent) | MIT | session handoff notes, agent-proposed skills, chat channels |
| [openclaw](https://github.com/openclaw/openclaw) | MIT | talking to the agent from a messenger (the Telegram bot) |
| [deer-flow](https://github.com/bytedance/deer-flow) | MIT | subagents with their own context, research mode |
| [paperclip](https://github.com/paperclipai/paperclip) | MIT | task board, approvals, budgets, routines |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | "everything is a plugin" |
| [open-design](https://github.com/nexu-io/open-design) | Apache-2.0 | sandboxed preview of HTML/SVG the agent makes |
| [harness2](https://github.com/google-research/harness2) | Apache-2.0 | propose → probe → compose, used by `lvw improve` |
| [odysseus](https://github.com/odysseus-dev/odysseus) | **AGPL-3.0** | side-by-side model compare, the RAM fit check. Ideas only; no AGPL code is included |

## Trademarks

Hugging Face, GitHub, GitLab, Telegram, Ollama and Chromium are trademarks of their owners. LvW-harness is not affiliated with or endorsed by any of them.
