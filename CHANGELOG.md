# Changelog

## 0.1.0 (unreleased)

First version.

### Models

- `lvw model search|info|pull|ls|rm|du|gc|run|stop|use` for Hugging Face, GitHub and GitLab releases, direct URLs and Ollama, with resumable downloads, sha256 checks, disk-space checks and RAM estimates.
- `lvw runtime install|update|rm` downloads the prebuilt `llama-server`.
- Default models: K2-Horizon 4x0.9B MoE heretic for chat, LFM3-VL 2B heretic for pictures, Whisper large-v3-turbo q4_1 on whisper.cpp, Yue2-3B on audio.cpp, and Idol on idol.cpp. A second llama-server answers turns with a picture when the chat model can't see.
- GGUF pulls bring the repo's vision projector along.

### Agent

- Built on the pi SDK, with file, shell, web, browser, scrape, memory, skill, task and subagent tools; `ask`, `auto` and `readonly` permissions; an optional Docker sandbox; token and turn budgets.
- `lvw chat` (terminal UI), `lvw run` and `lvw research`.
- Code, Plan, Ask, Debug, Architect and Research modes, with a model per mode.
- Checkpoints in a shadow git repo, with `lvw undo`.
- A test and lint loop, a repo map, YAML recipes (`lvw recipe`), an optional critic pass, prompt-injection checks on web, browser and MCP output, and a `fan_out` tool for CSV batches.
- Long chats compact themselves near the context limit. Large tool outputs go to a file with a preview. A `todo` tool keeps a checklist. Provider errors retry with backoff, and models without tool support run without tools.
- Skills in the `SKILL.md` format, installable from any git host with `lvw skill add`, which also imports a plugin's agents as named subagents. 18 are bundled, including impeccable, five from repository-harness and three from wshobson/agents. `lvw skill browse` lists plugins.
- Markdown memory with full-text search, plugins, MCP servers and routines.
- `lvw repo init` adds an `AGENTS.md` and a repo map.

### Media

- `lvw media`, `lvw make` and `lvw transcribe` make images and video (stable-diffusion.cpp), speech and transcripts (Ollama audio models), 3D models from a picture or a prompt (TripoSR) and music (ACE-Step 1.5). A hosted OpenAI-compatible or Replicate fallback covers kinds that aren't set up locally.
- The agent gets a media tool for each kind that is set up.
- Models that see or hear get pictures and audio directly; other models get a transcript of the audio.

### Web UI

- `lvw serve`: chat with a mode picker, approval cards, attachments, voice-note recording and a checkpoints panel, plus Create (live previews, gallery, 3D viewer), Models, Recipes, Tasks, Memory, Skills, Compare and Settings pages.
- The same UI runs in the browser at gitguy268.github.io/LvW-harness/webui. GGUF models from Hugging Face, GitHub and GitLab download into browser storage with resume and SHA-256 checks and run in wllama on WebGPU. Hosted models use keys from Settings. There's a just-bash shell over a browser workspace or a real folder, and Whisper speech to text in WebAssembly.
- `lvw serve --allow-web` lets the browser version drive your own harness with a web token.

### Server and other

- Single-file binaries, including Intel Macs and Windows (Windows has never been run), a Docker image and compose file, and `install.sh` with a systemd unit.
- `lvw doctor` checks disk, memory, runtimes, the browser, tokens and the media engines.
- Experimental: `lvw improve` (prompt profiles) and `lvw telegram`, which takes photos and voice notes and sends back what the agent makes.
