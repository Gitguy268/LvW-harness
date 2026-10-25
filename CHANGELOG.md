# Changelog

## 0.1.0 (unreleased)

First version.

- Model manager: `lvw model search|info|pull|ls|rm|du|gc|run|stop|use` for Hugging Face, GitHub and GitLab releases, direct URLs and Ollama. Resumable downloads, sha256 checks, disk-space checks, RAM fit estimates.
- llama.cpp runtime: `lvw runtime install|update|rm` downloads the prebuilt `llama-server`.
- Agent on the pi SDK: file, shell, web, browser, scrape, memory, skill, task and subagent tools; `ask`, `auto` and `readonly` permissions; optional Docker sandbox; token and turn budgets.
- `lvw chat` (terminal UI), `lvw run`, `lvw research`, `lvw serve` (web UI with chat, approvals, models, tasks, memory, skills, routines and model compare).
- Skills (9 bundled, `lvw skill add` from any git host), Markdown memory with full-text search, plugins, MCP servers, routines.
- VPS: single-file binaries, Docker image and compose file, `install.sh` with a systemd unit.
- Experimental: `lvw improve` (prompt profiles) and `lvw telegram`.
