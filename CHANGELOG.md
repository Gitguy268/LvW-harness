# Changelog

## 0.1.0 (unreleased)

First version.

- **Web UI in the browser** at gitguy268.github.io/LvW-harness/webui: the same UI with the harness in the page. GGUF models from Hugging Face, GitHub and GitLab download into the browser's storage with resume and SHA-256 checks and run in wllama (WebGPU); hosted models with keys from Settings; a just-bash shell over a browser workspace or a real folder; Whisper speech to text in WebAssembly. `lvw serve --allow-web` lets it drive your own harness with a web token.
- **New default models:** K2-Horizon 4x0.9B MoE heretic for chat, LFM3-VL 2B heretic for pictures (a second llama-server answers turns with a picture when the chat model can't see), Whisper large-v3-turbo q4_1 on whisper.cpp, Yue2-3B on audio.cpp, and Idol on idol.cpp. GGUF pulls bring their vision projector along.
- **Agent:** Code, Plan, Ask, Debug, Architect and Research modes with a model per mode; checkpoints in a shadow git repo with `lvw undo`; a test and lint loop; a repo map; YAML recipes (`lvw recipe`); an optional critic pass; prompt-injection checks on web, browser and MCP output; a `fan_out` tool for CSV batches. The web UI has a mode picker, a checkpoints panel, and Recipes and Settings pages.

- Media: `lvw media`, `lvw make` and `lvw transcribe` make images and video (stable-diffusion.cpp), speech and transcripts (Ollama audio models), 3D models from a picture or a prompt (TripoSR) and music (ACE-Step 1.5). A hosted OpenAI-compatible or Replicate fallback is used for kinds that aren't set up locally.
- The agent gets media tools for every kind that is set up. The web UI has a Create page with live previews and a gallery, a 3D viewer, and chat attachments with voice-note recording. Models that see or hear get pictures and audio directly; other models get a transcript of the audio.
- `lvw telegram` takes photos and voice notes and sends back what the agent makes. `lvw doctor` reports the media engines.

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
