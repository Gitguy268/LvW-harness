# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/Gitguy268/LvW-harness/security/advisories/new) instead. You'll get an answer within a week.

## What LvW protects

- The web server listens on `127.0.0.1` only by default. Binding to any other address requires a login token (`LVW_TOKEN`, or one LvW generates and stores in `config.json`).
- Without a token, the server rejects requests whose `Host` or `Origin` isn't local, so a web page can't drive your agent.
- Tokens for Hugging Face, GitHub, GitLab and Telegram live in `~/.lvw/credentials.json` (mode 600) or in environment variables, and are never logged.
- The agent asks before writing files, running commands that change things, or clicking and typing on websites (`ask` mode). Reading files, searching and fetching web pages don't ask. Commands matching a list of dangerous patterns always ask, even in `auto` mode. `--sandbox docker` runs shell commands in a container, with no network by default (`sandboxNetwork`).

## What it doesn't

The agent runs with your user's rights. `auto` mode and the Telegram bot's "Always" button let it act without asking, so only use them in folders and accounts you are willing to risk. Web pages the agent reads can contain instructions aimed at it (prompt injection), and fetching a URL can leak whatever the agent puts in it, so be careful pointing it at untrusted pages while it can see private files. Downloaded models and skills come from third parties: `lvw skill add` prints each skill's licence and `lvw skill show` its text, but LvW doesn't audit them. Read a skill before you use it.
