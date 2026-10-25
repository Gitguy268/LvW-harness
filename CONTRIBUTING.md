# Contributing

Thanks for helping. Bug reports, fixes and new features are all welcome.

## Set up

You need [Bun](https://bun.sh) 1.4 or newer.

```sh
git clone https://github.com/Gitguy268/LvW-harness.git
cd LvW-harness
bun install
bun src/cli/main.ts doctor
```

Use a throwaway data folder while you work, so your real models and memory stay untouched:

```sh
export LVW_HOME=$(mktemp -d)
```

## Before you open a pull request

```sh
bun run typecheck
bun test
bun run build        # the single-file binary still compiles
```

- Keep changes small and focused, one topic per pull request.
- Add or update a test in `test/` for behaviour you change. Tests use pi's scripted `fauxProvider`, so they need no model.
- Update the README when a command or option changes, and add a line to `CHANGELOG.md`.
- Never commit tokens, `.env` files or downloaded models.
- New dependencies need a clear reason and an MIT-compatible licence. Credit borrowed ideas in `NOTICE.md`. Code from GPL/AGPL or unlicensed projects can't be accepted.

## Project layout

`src/cli` commands · `src/core` agent sessions and providers · `src/models` the model manager · `src/runtime` llama.cpp and Ollama · `src/tools` agent tools · `src/server` and `src/web` the web UI · `src/orchestra` tasks, routines, `improve` · `src/channels` Telegram · `skills/` bundled skills (run `bun scripts/bundle-skills.ts` after changing them).
