# NOTICE

LvW-harness is MIT licensed (see [LICENSE](LICENSE)). It builds on the work below. Licences were checked with the GitHub and npm APIs on 2026-10-25.

## Dependencies (npm)

| Package | Version | Licence | Used for |
|---|---|---|---|
| [@earendil-works/pi-ai, pi-agent-core, pi-tui, pi-mcp, pi-telemetry](https://github.com/earendil-works/pi) | 1.4.0 | MIT | model providers, the agent loop, the terminal UI, the MCP client |
| [playwright-core](https://github.com/microsoft/playwright) | 1.64.1 | Apache-2.0 | the browser tools |

Development dependencies used only to build the web UI that runs in the browser (`bun run build:webui`): [just-bash](https://github.com/vercel-labs/just-bash) 3.6.0 (Apache-2.0, with its own dependencies under MIT, ISC, BSD and Apache-2.0 licences), [@wllama/wllama](https://github.com/ngxson/wllama) 3.13.0 (MIT), [hash-wasm](https://github.com/Daninet/hash-wasm) 4.13.0 (MIT), [yaml](https://github.com/eemeli/yaml) 2.9.1 (ISC) and [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) 0.1.7 (MIT).

## Bundled skills

Copied into `skills/`, each folder with its original `LICENSE`. Unchanged except where noted.

| Skills | Source | Licence |
|---|---|---|
| ponytail, ponytail-audit, ponytail-review | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | MIT, © 2026 DietrichGebert |
| security-audit | [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) | MIT, © 2025-2026 Cloudflare, Inc. |
| diagnosing-bugs, grill-me, handoff, research, tdd | [mattpocock/skills](https://github.com/mattpocock/skills) | MIT, © 2026 Matt Pocock |
| onboard-repository, audit-onboarding-proposal, encode-invariant, improve-harness, engineering-wisdom | [hoangnb24/repository-harness](https://github.com/hoangnb24/repository-harness) | MIT. Their `agents/` metadata folders are left out |
| code-review-excellence, debugging-strategies, error-handling-patterns | [wshobson/agents](https://github.com/wshobson/agents) | MIT |
| impeccable | [pbakaus/impeccable](https://github.com/pbakaus/impeccable), version 4.8.0 | Apache-2.0, with its `LICENSE` and `NOTICE.md` alongside. **Changed:** `SKILL.md` uses `<skill-base-dir>` in place of the `.pi/skills/...` path, and the live-mode scripts and font index (about 1.7 MB) are left out, so `live` needs a full copy from `lvw skill add gh:pbakaus/impeccable/.pi/skills/impeccable` |

## Bundled in the web UI

| Software | Licence | Where |
|---|---|---|
| [wllama](https://github.com/ngxson/wllama) 3.13.0 (llama.cpp `7d7f028` in WebAssembly) | MIT | the static web UI, `vendor/wllama/`. **Changed:** the worker pool gets 4 extra threads, because llama.cpp's multimodal code starts its own threads and the pool otherwise hangs |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) v1.9.5 in WebAssembly | MIT | `src/webui/vendor/whisper/`, built by `scripts/build-whisper-wasm.sh` with LvW's own small binding (`scripts/whisper-wasm/lvw_whisper.cpp`) |
| [just-bash](https://github.com/vercel-labs/just-bash) 3.6.0 browser build | Apache-2.0 | the static web UI's shell; its gzip and worker features, which need Node, are replaced by stubs |
| [hash-wasm](https://github.com/Daninet/hash-wasm), [yaml](https://github.com/eemeli/yaml), [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | MIT, ISC, MIT | the static web UI: SHA-256 checks, recipe files, cross-origin isolation on GitHub Pages |
| [@google/model-viewer](https://github.com/google/model-viewer) 4.4.0 (UMD build, includes [three.js](https://github.com/mrdoob/three.js), MIT, and [fflate](https://github.com/101arrowz/fflate), MIT) | Apache-2.0 | `src/web/vendor/model-viewer.min.js`, licence text in `src/web/vendor/model-viewer.LICENSE`; loaded only when a 3D result is shown |

## Downloaded at run time (not part of this repository)

| Software | Licence | When |
|---|---|---|
| [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` | MIT | `lvw runtime install`, and baked into the Docker image |
| [Ollama](https://github.com/ollama/ollama) | MIT | optional; LvW talks to a running Ollama |
| Impeccable's detection engine | Apache-2.0 | when the `impeccable` skill first runs; its launcher checks the download against a checksum list |
| [wshobson/agents](https://github.com/wshobson/agents) plugins | MIT | `lvw skill add gh:wshobson/agents/plugins/<name>` |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | BSD-3-Clause | optional; `lvw tool install scrapling` installs it with `uv` |
| Chromium (Debian package) | BSD-3-Clause and others | the Docker image only |
| Liberation fonts (Debian `fonts-liberation`) | SIL Open Font License 1.1 | the Docker image only, for page rendering |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) `sd-server` (release `master-1058-7bcd4ce`) | MIT | `lvw media install image` or `video`; checked against the sha256 digest GitHub publishes |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR) source (commit `107cefd`) and weights `stabilityai/TripoSR` | MIT | `lvw media install 3d`. Run by LvW's own `src/media/sidecar/media3d.py`, which swaps its compiled `torchmcubes` for PyMCubes |
| [PyTorch](https://pytorch.org), [transformers](https://github.com/huggingface/transformers), [trimesh](https://github.com/mikedh/trimesh), [PyMCubes](https://github.com/pmneila/PyMCubes) | BSD-3-Clause, Apache-2.0, MIT, BSD-3-Clause | the 3D engine's venv |
| [rembg](https://github.com/danielgatis/rembg) and its U²-Net weights | MIT, Apache-2.0 | the 3D engine's venv, for background removal |
| [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) code (tag `v0.1.8`) and weights | MIT | `lvw media install music`, with its own `uv sync` |
| Media models (Z-Image-Turbo, Qwen3-4B text encoder, FLUX VAE via Comfy-Org, SD 1.5 GGUF, Wan 2.1 1.3B, UMT5-XXL GGUF, LFM3 Audio/Omni, Phonon) | Apache-2.0; SD 1.5: CreativeML OpenRAIL-M; LFM models: LFM Open License 1.0; Phonon voices: partly CC BY-NC 4.0 | `lvw media pull`; each licence is shown in `lvw media ls` |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `whisper-server` 1.9.5 | MIT | `lvw media install transcribe`: Homebrew's `whisper.cpp` on a Mac, else a pinned source build |
| [audio.cpp](https://github.com/0xShug0/audio.cpp) v0.9.5 release build | Apache-2.0 | `lvw media install music`; checked against the sha256 digest GitHub publishes |
| [idol.cpp](https://github.com/TimeLordRaps/idol.cpp) v0.1.1 release package, the pinned [idol-sdk](https://github.com/speridlabs/idol-sdk), PyTorch and their Python dependencies | Apache-2.0 (idol.cpp), the others their own | `lvw media install 3d`, with its own `setup.sh` in a uv-made venv |
| Default models: K2-Horizon 4x0.9B MoE heretic GGUF, LFM3-VL 2B heretic GGUF, Whisper large-v3-turbo (oxide-lab, whisper.cpp files), Yue2-3B GGUF (audio-cpp), Idol-GGUF; Idol's DINOv3 and FLUX.2-dev encoders | Apache-2.0; LFM Open License v1.0; MIT; **CC-BY-NC-4.0**; Apache-2.0; the encoders are gated, under their own terms | `lvw setup`, `lvw media install`, or the web UI's Models page |
| Models from Hugging Face, GitHub, GitLab or Ollama | each model's own licence | `lvw model pull` |

## Ideas, no code

These projects inspired features that were written from scratch for LvW. No code was copied.

| Project | Licence | Idea used in LvW |
|---|---|---|
| [opencode](https://github.com/anomalyco/opencode) | MIT | coding tool set, permission modes, plan and build modes |
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
| [OpenHarness](https://github.com/HKUDS/OpenHarness) | MIT | retry with backoff on provider errors, auto-compaction |
| [deepagents](https://github.com/langchain-ai/deepagents) | MIT | the `todo` planning tool, moving large tool outputs to files, summarizing long threads |
| [wshobson/agents](https://github.com/wshobson/agents) | MIT | named specialist subagents from Markdown files, the plugin catalogue format |
| [repository-harness](https://github.com/hoangnb24/repository-harness) | MIT | `lvw repo init`: a small `AGENTS.md` and a repo map, added without overwriting |
| [Cline](https://github.com/cline/cline) | Apache-2.0 | read-only planning separate from acting, and checkpoints of the workspace at every turn that you can roll back |
| [Aider](https://github.com/Aider-AI/aider) | Apache-2.0 | architect mode (one model plans, another edits), the repo map ranked by references, running tests and lint after edits and feeding failures back, `undo` |
| [Kilo Code](https://github.com/Kilo-Org/kilocode) | MIT | Code, Plan, Ask and Debug modes with a model pinned to each mode |
| [Goose](https://github.com/aaif-goose/goose) | Apache-2.0 | shareable YAML recipes with parameters and sub-recipes, prompt-injection checks on outside content |
| [OpenHands](https://github.com/OpenHands/openhands) | MIT | a critic pass that reviews the agent's result |
| [Codex CLI](https://github.com/openai/codex) | Apache-2.0 | fanning a CSV of tasks out to parallel subagents |
| [odysseus](https://github.com/odysseus-dev/odysseus) | **AGPL-3.0** | side-by-side model compare, the RAM fit check. Ideas only; no AGPL code is included |

## Trademarks

Hugging Face, GitHub, GitLab, Telegram, Ollama and Chromium are trademarks of their owners. LvW-harness is not affiliated with or endorsed by any of them.
