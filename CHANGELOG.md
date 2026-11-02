# Changelog

## 0.1.0 (unreleased)

First version.

- Long chats compact themselves near the context limit. Large tool outputs go to a file with a preview. A `todo` tool keeps a checklist. Provider errors retry with backoff. Models without tool support run without tools.
- 9 more skills: impeccable, five from repository-harness and three from wshobson/agents. `lvw skill browse` lists plugins, and `lvw skill add` also imports their agents as named subagents. `lvw repo init` adds an `AGENTS.md` and a repo map.
- Binaries for Intel Macs and Windows are built too. Windows has never been run.

- Model manager: `lvw model search|info|pull|ls|rm|du|gc|run|stop|use` for Hugging Face, GitHub and GitLab releases, direct URLs and Ollama. Resumable downloads, sha256 checks, disk-space checks, RAM fit estimates.
- llama.cpp runtime: `lvw runtime install|update|rm` downloads the prebuilt `llama-server`.
- Agent on the pi SDK: file, shell, web, browser, scrape, memory, skill, task and subagent tools; `ask`, `auto` and `readonly` permissions; optional Docker sandbox; token and turn budgets.
- `lvw chat` (terminal UI), `lvw run`, `lvw research`, `lvw serve` (web UI with chat, approvals, models, tasks, memory, skills, routines and model compare).
- Skills (9 bundled, `lvw skill add` from any git host), Markdown memory with full-text search, plugins, MCP servers, routines.
- VPS: single-file binaries, Docker image and compose file, `install.sh` with a systemd unit.
- Experimental: `lvw improve` (prompt profiles) and `lvw telegram`.
