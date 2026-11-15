<div align="center">

# LvW-harness

**A local-first AI agent with a one-command model manager for Hugging Face, GitHub and GitLab.**

[Web UI in your browser](https://gitguy268.github.io/LvW-harness/webui/) · [Install](#install) · [Default models](#default-models) · [Models](#models) · [Media](#media) · [Agent](#agent) · [Web UI](#web-ui) · [VPS](#vps) · [Commands](#all-commands) · [Credits](NOTICE.md)

![License: MIT](https://img.shields.io/badge/license-MIT-2f6f62)
![Runtime: Bun 1.4](https://img.shields.io/badge/runtime-Bun%201.4-2f6f62)
![Built on the pi SDK](https://img.shields.io/badge/built%20on-pi%20SDK-2f6f62)
![Runs on macOS and Linux](https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux-2f6f62)

<img src="docs/images/models.webp" alt="The Models page of the LvW web UI: disk meter, a source field, and a table of downloaded models with Run and Remove buttons" width="900">

</div>

LvW runs an agent on your own computer or server. It reads and edits files, runs commands, browses the web, remembers things between sessions and follows skills. It also makes pictures, short videos, speech, music and 3D models, and it understands pictures and voice notes you send it. Models run locally through [llama.cpp](https://github.com/ggml-org/llama.cpp) or [Ollama](https://ollama.com), so nothing has to leave your machine. Cloud models work too if you add a key.

The model manager is the main feature. One command downloads a model from Hugging Face, a GitHub or GitLab release, any URL or Ollama, and one command removes it again with every file it brought.

```sh
lvw model pull hf:Lucasgitguy-co/K2-Horizon-4x0.9B-MoE-heretic-GGUF:Q5_K_M   # 2.2 GB
lvw chat
lvw model rm K2-Horizon-4x0.9B-MoE-heretic-Q5_K_M                              # frees the 2.2 GB
```

**No install needed to try it:** [the web UI runs in your browser](https://gitguy268.github.io/LvW-harness/webui/). It downloads GGUF models into the browser's own storage and runs them there (WebGPU when your browser has it), with the same chat, modes, approvals, checkpoints, recipes and model manager. It can also drive your own LvW-harness, see [the web UI in your browser](#in-your-browser).

<!-- live-links -->
**Project page:** [gitguy268.github.io/LvW-harness](https://gitguy268.github.io/LvW-harness/) · [lvw-harness.vercel.app](https://lvw-harness.vercel.app)
<!-- /live-links -->

## Install with Homebrew

```sh
brew trust gitguy268/tap
brew install gitguy268/tap/lvw-harness
```

Then run `lvw setup` once, and `lvw` (or `lvw serve` for the web UI).

<!-- run-steps:start -->
## Run it locally, step by step

1. **Install [Bun](https://bun.sh) 1.4** or newer (macOS on Apple silicon, or Linux).

2. **Get the code:**

   ```sh
   git clone https://github.com/Gitguy268/LvW-harness.git
   cd LvW-harness
   ```

3. **Install it:**

   ```sh
   bun install
   bun link
   ```

4. **Set it up.** This downloads llama-server (about 30 MB) and offers a starter model:

   ```sh
   lvw setup
   lvw doctor
   ```

5. **Start it** with `lvw`, or double-click `start.command` on a Mac for the web UI at <http://localhost:7878/>.
<!-- run-steps:end -->

## Install

You need [Bun](https://bun.sh) 1.4 or newer on macOS (Apple silicon) or Linux.

```sh
git clone https://github.com/Gitguy268/LvW-harness.git
cd LvW-harness
bun install
bun link            # puts `lvw` on your PATH
lvw setup           # downloads llama-server (~30 MB), installs the bundled skills, offers a starter model
lvw doctor          # checks disk, memory, runtimes, browser and tokens
```

On a Mac you can also double-click **`start.command`**. It installs what's missing, starts the web UI and opens it in your browser.

To build a single binary that doesn't need Bun: `bun run build` (this machine) or `bun run build:all` (macOS arm64, Linux x64 and Linux arm64, in `dist/`).

## Default models

`lvw setup` offers the chat and vision models; `lvw media install transcribe|music|3d` sets up the rest. The web UI suggests the same models on its Models page.

| Role | Model | Licence | Runs on | In the browser |
|---|---|---|---|---|
| Chat | [K2-Horizon 4x0.9B MoE heretic](https://huggingface.co/Lucasgitguy-co/K2-Horizon-4x0.9B-MoE-heretic-GGUF), Q5_K_M (2.2 GB) | Apache-2.0 | llama.cpp | yes, Q4_K_M (1.87 GB): the browser loads at most 2 GB per file |
| Pictures | [LFM3-VL 2B heretic](https://huggingface.co/Lucasgitguy-co/lfm3-vl-2b-heretic-gguf), Q4_K_M + F16 projector (1.5 GB) | LFM Open License v1.0 | llama.cpp, a second server on port 7885 | yes |
| Speech to text | [Whisper large-v3-turbo q4_1](https://huggingface.co/oxide-lab/whisper-large-v3-turbo-GGUF/blob/main/whisper.cpp/whisper-large-v3-turbo-q4_1.gguf) (0.52 GB) | MIT | whisper.cpp `whisper-server` | yes, on the CPU (slow: about ten times the audio length) |
| Music | [Yue2-3B](https://huggingface.co/audio-cpp/Yue2-3B-GGUF) Q4_0 + F16 VAE (2.9 GB) | CC-BY-NC-4.0, non-commercial | [audio.cpp](https://github.com/0xShug0/audio.cpp) v0.9.5 | no; through a connected LvW-harness |
| Picture to 3D | [Idol](https://huggingface.co/TimeLordRaps/Idol-GGUF) Q8_0 (1 GB, plus 3.7 GB of gated encoders) | Apache-2.0; the encoders have their own gated terms | [idol.cpp](https://github.com/TimeLordRaps/idol.cpp) v0.1.1 | no; through a connected LvW-harness |

<details>
<summary><b>Notes on these models</b></summary>

- **Whisper:** oxide-lab's repo has two kinds of `.gguf`. The files in its root are in [Candle](https://github.com/huggingface/candle)'s GGUF layout, which whisper.cpp can't read. LvW uses the q4_1 file from its `whisper.cpp/` folder, the same model and quantization in whisper.cpp's own format (the `.gguf` name notwithstanding).
- **K2-Horizon** makes tool calls and writes its reasoning first. With 0.9B active parameters it is quick, but long chains of tool calls go better with a bigger model.
- **LFM3-VL** answers a turn that carries a picture when the chat model can't see (`visionModel` in the config, or Settings in the web UI). Pulling a GGUF repo now brings its `mmproj` projector along automatically.
- **Context:** local models now start with a 16k-token context (`llama.ctx`), and the vision model always gets at least 16k. The agent's prompt and tools take about 3k tokens, a picture about 1.4k more, and pi-ai keeps 4k back as a safety margin, so 8k left reasoning models almost no room to answer. Lower `llama.ctx` on a machine short of memory.
- **Yue2** sings lyrics: give lyrics, or the prompt becomes one verse. The style prompt goes to `style=`. Weights are for non-commercial use only.
- **Idol** reconstructs a Gaussian point cloud from one picture; LvW turns its mesh into a GLB for the 3D viewer. Its native decoders are x86-64 only, so on Apple silicon they run through Rosetta 2 (macOS 15 or later), on the CPU. It needs Hugging Face access to [DINOv3](https://huggingface.co/facebook/dinov3-vith16plus-pretrain-lvd1689m) and the [FLUX.2-dev](https://huggingface.co/black-forest-labs/FLUX.2-dev) autoencoder: accept their terms (read them first; they are not Apache-2.0), then `lvw login hf`. `lvw doctor` checks that access. TripoSR stays available without it.

</details>

## Models

<img src="docs/images/demo-pull-remove.webp" alt="Animated demo: typing a Hugging Face source, choosing the Q2_K file, downloading it with a progress bar, then removing it" width="760">

| Source | Example | What it downloads |
|---|---|---|
| Hugging Face | `hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M` | one quant (plus the vision projector if the repo has one); leave out `:Q4_K_M` to choose from a list, add `--all` for the whole repo |
| GitHub release | `gh:owner/repo@v1.2:*.gguf` | release assets matching the glob (newest release without `@tag`) |
| GitLab release | `gl:group/project@v1.2:*.gguf` | the same for gitlab.com, or your own GitLab with `LVW_GITLAB_URL` |
| Any URL | `https://example.com/model.gguf` | that file |
| Ollama | `ollama:qwen3:4b` | passed through to your running Ollama |

- **Resumes** interrupted downloads and **checks sha256** where the host publishes it (Hugging Face LFS files, GitHub release assets).
- **Checks free disk first** and refuses a download that would leave less than 2 GB (`lvw config set minFreeGB 5` to change it).
- **Estimates RAM** for each GGUF and marks it *fits*, *tight* or *too big* for this machine.
- `lvw model rm` deletes the files and the registry entry and prints the space freed. `lvw model gc` cleans up unfinished downloads.
- GGUF models run through llama.cpp (`lvw model run <name>`). Other formats (safetensors, ONNX…) can be downloaded and removed but not run by LvW.

Gated or private models need a read token: `lvw login hf|gh|gl`, or `HF_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`. Tokens are stored in `~/.lvw/credentials.json` with mode 600 and are never logged.

## Media

LvW makes images, video, speech, music and 3D models, and transcribes audio, on your own machine. Each kind has a small default model you add with one command. A hosted API is used only for a kind you haven't set up locally, and only when you have added a key for it.

```sh
lvw media install image            # stable-diffusion.cpp plus Z-Image-Turbo (6 GB)
lvw make image "a red lighthouse on a cliff at sunset, oil painting"
lvw make 3d "a small toy robot"    # draws the robot first, then builds a GLB mesh
lvw make speech "Dinner is ready." --voice female-american-english
lvw transcribe meeting.wav
lvw media ls                       # what is set up, with sizes and licences
```

| Kind | Local engine | Default model | Licence |
|---|---|---|---|
| Image (text to image, picture editing) | [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) `sd-server` | Z-Image-Turbo Q3_K (6 GB). SD 1.5 (1.6 GB) is a smaller option | Apache-2.0 |
| Video (text to video, picture to video) | the same `sd-server` | Wan 2.1 T2V 1.3B (6 GB) | Apache-2.0 |
| Speech and transcription | [Ollama](https://ollama.com) 0.40.13 or later | `lfm3-audio` (1.7 GB, 18 languages). `phonon` is a tiny English voice for Apple silicon | LFM Open 1.0 |
| Pictures and voice notes in chat | Ollama or llama.cpp | any model that sees or hears, such as `lfm3-omni` | the model's own |
| 3D (picture to 3D, text to 3D) | [TripoSR](https://github.com/VAST-AI-Research/TripoSR) in a uv-made Python env | TripoSR (1.7 GB) | MIT |
| Music and sound | [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) in a uv-made Python env | ACE-Step 1.5 2B turbo (about 9 GB) | MIT |

- **In chat**, the agent gets `generate_image`, `generate_video`, `speak`, `transcribe`, `generate_music` and `generate_3d` tools for every kind that is set up. The results show up inline in the web UI and arrive as files in Telegram.
- **Pictures and voice notes** can be attached, pasted, dropped or recorded in the web chat, and sent to the Telegram bot. A model that hears gets the audio itself. For any other model, the audio is transcribed first, so the voice note still reaches it as text.
- **Create page** in the web UI: pick a kind, write a prompt or add a file, watch the steps and a live preview, and keep everything in a gallery. 3D models open in a viewer you can turn.
- Results are saved in `~/.lvw/media/<date>/`, each with a `.json` beside it holding the prompt, model, seed and settings.

<details>
<summary><b>Hosted fallbacks</b></summary>

Set these only if you want a kind to work without a local engine. Keys come from `lvw login openai|replicate` or `OPENAI_API_KEY` / `REPLICATE_API_TOKEN`.

```sh
lvw login openai
lvw config set media.api.openai '{"image":"gpt-image-1","speech":"tts-1","voice":"alloy","transcribe":"whisper-1"}'
lvw config set media.api.openai.baseUrl https://your-openai-compatible-server/v1   # optional
lvw login replicate
lvw config set media.api.replicate '{"video":"owner/video-model","music":"owner/music-model","3d":"owner/3d-model"}'
```

Replicate models take different inputs; LvW sends `prompt`, `image` and `duration`. `lvw make image "…" --model api` forces the fallback. The OpenAI-compatible fallback has unit tests against a fake server; the Replicate path has none. Neither has been run with real keys.
</details>

<details>
<summary><b>Models, engines and where they run</b></summary>

`lvw media install <kind>` sets up the engine and the default model for a kind; `lvw media pull <id>` gets another catalog model; `lvw media use <kind> <id>` changes the default; `lvw media rm <id>` removes it. Add your own sd.cpp models in `~/.lvw/media-catalog.json`, which uses the same format as [src/media/catalog.json](src/media/catalog.json).

| | macOS arm64 | macOS x64 | Linux x64 | Linux arm64 | Windows x64 |
|---|---|---|---|---|---|
| Image and video | local | local | local (CPU or Vulkan) | hosted API, or build `sd-server` yourself and set `media.sdServer` | local (CPU, Vulkan or CUDA) |
| Speech and transcription | local | local | local | local | local |
| 3D and music | local (Apple GPU) | hosted API (no PyTorch wheels) | local | local | local |

Pick a GPU build of `sd-server` with `lvw media install sd --variant vulkan` (Linux) or `--variant cuda12` (Windows). Ports: `sd-server` 7880, 3D 7881, music 7882, `whisper-server` 7883, idol.cpp 7884.

The default engines for transcription, music and 3D install their programs on first use: `whisper-server` from Homebrew on a Mac (a pinned source build elsewhere, which needs git and cmake), audio.cpp's release build (macOS, Linux x64), and idol.cpp's release package with its Python packages (macOS through Rosetta 2, Linux x64; needs uv).
</details>

## Agent

```sh
lvw chat                         # terminal chat; asks before it changes anything
lvw run "add a --verbose flag to cli.ts and run the tests"
lvw research "how do llama.cpp quant types compare?"
```

| | |
|---|---|
| **Tools** | read, write, edit, grep, glob, bash; web search and fetch; a Playwright browser with its own isolated profile per chat; memory; skills; task board; subagents; MCP servers; plugins |
| **Permissions** | `ask` (default) asks before writes, commands that change things, and clicking or typing on websites. `--auto` stops asking, except for commands that look dangerous and writes outside the working folder. `--readonly` blocks all changes. `--sandbox docker` runs commands in a container without network |
| **Memory** | Markdown notes in `~/.lvw/memory` (everywhere) and `.lvw/memory` (this project), with full-text search. `AGENTS.md` or `CLAUDE.md` in the folder are read as project rules |
| **Skills** | the `SKILL.md` format. 18 skills are bundled: design work with `impeccable`, repository onboarding, code review, debugging, TDD, security audit and more. `lvw skill browse` lists the 90-odd plugins of [wshobson/agents](https://github.com/wshobson/agents), and adding one brings its skills and subagents; `lvw skill add gh:owner/repo` installs others. Only names and descriptions go into the prompt, and the full text loads when needed |
| **Budgets** | 40 turns and 400k tokens per run by default (`budgets` in the config, `--max-turns`) |

<details>
<summary><b>Modes, checkpoints, the test loop, recipes and the critic</b></summary>

```sh
lvw chat --mode plan                 # look around and write a plan; changes nothing
lvw run --mode debug "the upload test fails on Linux"
lvw undo                             # put back what the last turn changed
lvw recipe new release-notes && lvw recipe run release-notes -p since=v0.1.0
```

| | |
|---|---|
| **Modes** | Code (default), Plan and Ask (read-only, whatever approval setting is on), Debug (reproduce first, then fix), Architect (a planner model writes the plan, an editor model carries it out) and Research. Pin a model per mode in the config (`modes.plan.model`, `modes.architect.model` / `.editor`) or on the web UI's Settings page. In chat: `/mode plan`, `/architect` |
| **Checkpoints** | Before the agent first changes anything in a turn, LvW snapshots the folder into a shadow git repo under `~/.lvw/checkpoints`; your own `.git` is never touched. `lvw undo`, `lvw checkpoints [--diff id]`, `/undo` and `/restore <id>` in chat, or the ↩ button in the web UI. A restore saves the current state first, so it can be undone too. Folders over 500 MB or 20,000 files, and files over 20 MB, are skipped |
| **Test and lint loop** | After a turn that changed files, LvW runs the project's test and lint commands (found from package.json, go.mod, Cargo.toml, pyproject or a Makefile, or set with `checks.test` / `checks.lint`) and hands failures back to the agent for up to `checks.maxRounds` rounds. Running them asks first unless approvals are on auto. `/test` runs them now |
| **Repo map** | A list of the folder's source files and their main functions and classes, most-referenced first. It goes into the prompt when the model's context window is 12k tokens or more, and the `repo_map` tool gives it on demand |
| **Recipes** | YAML files with a prompt, mode, model, skills, `{{parameters}}` and sub-recipes, in `~/.lvw/recipes` or `.lvw/recipes`. Share them as files; the web UI imports and downloads them |
| **Critic** | `lvw config set critic.enabled true`: a second model call reviews the result and the diff, and on FAIL the agent gets one more round with the notes |
| **Injection check** | Text from web pages, the browser tools and MCP servers is passed to the model as untrusted data, and flagged with a warning when it looks like it is trying to give instructions |
| **Fan-out** | The `fan_out` tool runs one helper agent per row of a CSV, a few at a time, and returns the CSV with their answers |

</details>

<details>
<summary><b>Tasks, routines and approvals</b></summary>

```sh
lvw task add "Write release notes for 0.1.0" --budget 50000
lvw task run 1                     # the agent works on it; the result goes on the task
lvw routine add news "0 8 * * 1-5" "Summarise the AI news"   # runs while `lvw serve` is running
lvw task ls                        # also lists approvals waiting for you
lvw task approve 1
```

When the agent needs a decision (publishing, spending, deleting data) it calls `request_approval`, the task is marked *blocked*, and it waits for you on the Tasks page or `lvw task approve|reject`.

</details>

<details>
<summary><b>MCP servers, plugins and the scrape tool</b></summary>

```sh
lvw mcp add files -- npx -y @modelcontextprotocol/server-filesystem ~/notes
lvw mcp add remote --url https://example.com/mcp
lvw mcp ls                         # starts each server and lists its tools
lvw tool install scrapling         # adds web_scrape for pages plain fetching can't read (uses uv)
```

A plugin is a folder in `~/.lvw/plugins/<name>/` with a `plugin.json` (`{"name": "...", "description": "..."}`) and an `index.ts` that exports `tools(ctx)` returning extra tools. A `skills/` folder inside the plugin adds skills. `lvw plugin ls` shows what loaded.

</details>

<details>
<summary><b>Using a cloud model or your own browser</b></summary>

`--model` takes a downloaded model's name, `ollama:<name>`, or `<provider>:<model-id>` for any provider pi-ai supports, with its usual API key in the environment (for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). `lvw model use <name>` sets the default.

To let the browser tools use your logged-in browser, start it with `--remote-debugging-port=9222` and run `lvw config set browser.cdpUrl http://127.0.0.1:9222`. The agent then opens its own tabs in that browser.

</details>

## Web UI

```sh
lvw serve                          # http://127.0.0.1:7878
```

The web UI has pages for Chat (with a mode picker, approval cards, attachments, voice notes, checkpoints and a preview of HTML or SVG the agent writes), Create (images, video, speech, music and 3D), Models, Recipes, Tasks, Memory, Skills, Compare (one prompt sent to several models side by side) and Settings. It loads nothing from the internet and works offline.

<table>
<tr>
<td><img src="docs/images/tasks.webp" alt="Tasks page with an approval waiting, a board of tasks and a routine"></td>
<td><img src="docs/images/skills.webp" alt="Skills page listing bundled skills"></td>
</tr>
</table>

### In your browser

[gitguy268.github.io/LvW-harness/webui](https://gitguy268.github.io/LvW-harness/webui/) is the same UI with the harness running in the page itself:

- **Models:** download GGUF files from Hugging Face, GitHub repo files and GitLab with the same resolvers as `lvw model pull`, resumable and checked against their SHA-256, into the browser's private storage (OPFS). The Models page shows how much room the browser gives the site.
- **Running them:** [wllama](https://github.com/ngxson/wllama) (llama.cpp in WebAssembly, WebGPU when available). The model sits behind the same OpenAI-compatible path LvW uses for `llama-server`, so tool calls, reasoning, compaction and retries behave the same. Hosted models (OpenAI, Anthropic, Google, OpenRouter and more) work with a key in Settings, kept in that browser only.
- **Files and shell:** the agent works in a folder in the browser's storage, or in a real folder you open (Chrome, Edge and Arc; Brave has the File System Access API behind brave://flags). The shell is [just-bash](https://github.com/vercel-labs/just-bash), a bash emulation: ls, cat, grep, sed, awk, find, jq, curl and friends work, but there is no node, python, git or npm. The test loop runs only commands you set in Settings.
- **Everything else** from the desktop version: modes, approvals, checkpoints, recipes, critic, injection check, fan-out, memory, skills (bundled, or installed from GitHub), tasks and routines (while the tab is open), Compare, and speech to text with Whisper.

Connect it to your own harness for a real shell, Yue2, Idol, and image or video generation:

```sh
lvw serve --allow-web    # prints a link that carries its web token (kept in ~/.lvw/config.json)
```

The page then talks to `http://127.0.0.1:7878`. Only the origins in `server.allowOrigins` (the GitHub Pages site by default) may connect, and only with the web token, even on your own machine. Tested in Chromium. Safari blocks pages on https from reaching `http://127.0.0.1`, and recent Chrome versions ask once for permission to reach your local network.

Browsers stop some downloads: GitHub release files and gitlab.com `/-/` links send no CORS headers, so the page can't fetch them. Set a CORS proxy you trust in Settings, or connect your LvW-harness.

## VPS

The server only listens on `127.0.0.1` unless you tell it otherwise. Any other address needs a login token: set `LVW_TOKEN`, or LvW generates one and prints it.

**Docker** (the image includes llama-server and headless Chromium):

```sh
echo "LVW_TOKEN=$(openssl rand -base64 24)" > .env
docker compose up -d               # web UI on 127.0.0.1:7878; models in the lvw-data volume, the agent's files in lvw-work
docker compose exec lvw lvw model pull hf:unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M
```

Keep the port local and put HTTPS in front of it (see "HTTPS with Caddy" below). The login cookie is marked `Secure` here, so logging in over plain `http://<server-ip>:7878` won't stick, and it would send your token unencrypted. Only set `LVW_BIND=0.0.0.0` in `.env` when an HTTPS proxy on another machine needs to reach the port. Build without the browser with `docker compose build --build-arg WITH_BROWSER=0`.

**Bare Linux server** (x64 or arm64, with systemd):

```sh
bun run build:all                                  # on your machine
scp dist/lvw-linux-x64 install.sh deploy/lvw.service you@server:
ssh you@server 'mkdir -p deploy && mv lvw.service deploy/ && sudo LVW_BINARY=./lvw-linux-x64 sh install.sh'
```

The server needs glibc 2.38 or newer (Ubuntu 24.04, Debian 13 or later) to run current llama.cpp builds. `install.sh` creates an `lvw` user, data in `/var/lib/lvw`, a token in `/etc/lvw.env`, installs llama-server and starts the `lvw` service on `127.0.0.1:7878`. Once releases are published it can download the binary itself (`curl -fsSL …/install.sh | sudo sh`).

<details>
<summary><b>HTTPS with Caddy</b></summary>

```
lvw.example.com {
    reverse_proxy 127.0.0.1:7878
}
```

Caddy gets the certificate itself. Open `https://lvw.example.com` and log in with the token.

</details>

## Experimental

- **`lvw telegram`** runs a Telegram bot, so you can talk to LvW from your phone. Create a bot with @BotFather, run `lvw login telegram`, then message the bot: it replies with the command that allows your chat. Approvals show up as Yes / Always / No buttons. Photos and voice notes work too, and the pictures, sounds and clips the agent makes come back as files. The bot polls Telegram, so it needs no public address.
- **`lvw improve "<task>" --name p`** runs the same task with four prompt strategies (baseline, plan-first, verify, lean), each in a scratch copy of the folder, has the model grade every result, and saves the winner as a profile you use with `lvw run --profile p`. The grades are only as good as the model giving them.

## All commands

```text
Models
  lvw model search|info|pull|ls|rm|du|gc|run|stop|use   download, run and remove models
  lvw runtime [install|update|rm]                         llama.cpp runtime
  lvw login|logout hf|gh|gl|telegram|openai|replicate   tokens for gated models, the Telegram bot and media APIs

Media
  lvw media ls|install|pull|rm|use|out|stop              image, video, speech, 3D and music engines
  lvw make image|video|speech|music|3d "<prompt>"         make something (--image file for edits, picture to video, picture to 3D)
  lvw transcribe <audio-file>                           speech to text

Agent
  lvw chat [--model m] [--auto|--readonly] [--sandbox docker]   terminal chat
  lvw run "<task>" [--yes] [--json]                     one task, no questions
  lvw research "<question>"                             deep research report
  lvw serve [--host h] [--port p]                       web UI and API (default 127.0.0.1:7878)
  lvw telegram                                          talk to LvW from Telegram
  lvw improve "<task>" [--name p]                       experimental: tune a prompt profile (--profile p)

Extras
  lvw repo init                      add AGENTS.md and a repo map, keeping what exists
  lvw skill ls|add|browse|rm|show|approve   lvw memory ls|search|add|rm
  lvw task ls|add|show|run|done      lvw task approve|reject <id>
  lvw routine ls|add|rm|on|off
  lvw mcp ls|add|rm                  lvw tool install|rm scrapling
  lvw plugin ls

Setup
  lvw setup [--yes]   lvw doctor   lvw config [get|set|path]   lvw version
```

Data lives in `~/.lvw` (set `LVW_HOME` to move it). Ports: web UI 7878, llama-server 7879, sd-server 7880, 3D 7881, music 7882, whisper-server 7883, idol.cpp 7884, vision llama-server 7885.

## Limits

- Small local models (around 4B) handle short tasks well but get unreliable over long chains of tool calls. Hard coding work goes better with a bigger model or a cloud key.
- Only GGUF models run locally through llama.cpp. Other formats are stored, not run.
- Image and video generation is slow without a GPU: a 512×512 SD 1.5 picture takes about 4 minutes on a Mac's CPU. The stable-diffusion.cpp build LvW pins renders SD 1.x models blank on Apple GPUs, so SD 1.5 runs on the CPU there. Z-Image-Turbo, the default, works on Apple GPUs: about 3 minutes for a first 512×512 picture, model loading included.
- Tested for real on a Mac (Apple silicon): Z-Image-Turbo and SD 1.5 images, speech, transcription, voice notes in chat, picture to 3D and text to 3D. Never run for real: Wan video, ACE-Step music, Linux and Windows, and the hosted fallbacks with real keys. Video only has a unit test of its request; music and Replicate have no tests.
- New in this version, tested for real on a Mac (Apple silicon): Whisper large-v3-turbo through Homebrew's `whisper-server`; the LFM3-VL vision slot answering a picture beside a text-only chat model; `lvw serve --allow-web` with the web UI connecting. In the browser (Playwright's Chromium with WebGPU): cross-origin isolation on a plain static server, every page, downloads with SHA-256 checks, SmolLM2 chat, K2-Horizon Q4_K_M with a `write_file` call, a checkpoint and undo, the just-bash shell, recipes, and connect mode; earlier spikes also ran LFM3-VL describing a picture and Whisper transcribing in the browser. Never run: Yue2 on audio.cpp and Idol on idol.cpp (no access to Idol's gated encoders), the browser's vision and Whisper steps inside the full app (the run was stopped by low memory on the test machine), hosted models with real keys in the browser, Firefox and Safari.
- 3D works on one object on a plain background. Landscapes and busy scenes give an error.
- Transcription without ffmpeg reads WAV files only.
- `--sandbox docker` covers shell commands only. File tools still work directly in the folder you started in.
- The web UI in the browser can load at most 2 GB per model file and keeps up to two models in memory (chat and vision). Its shell is an emulation, and Whisper there runs on the CPU only.

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

MIT © Lucas Van De Weerd. Bundled skills keep their own MIT licences, and models you download keep theirs. LvW reuses ideas from many projects, each credited in [NOTICE.md](NOTICE.md). It isn't affiliated with Hugging Face, GitHub, GitLab, Telegram or Ollama.
