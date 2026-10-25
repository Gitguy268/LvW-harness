// LvW web UI. Plain ES module, no build step and no network dependencies.

const $ = (sel, root = document) => root.querySelector(sel);

/** Build DOM safely: strings become text nodes, never HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only for our own escaped Markdown output
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Small Markdown renderer for chat replies. Escapes first, then adds formatting. */
function markdown(src) {
  const blocks = [];
  let text = esc(src).replace(/```(\w*)\n([\s\S]*?)(```|$)/g, (_, lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  text = text
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  const out = [];
  let list = null;
  for (const line of text.split("\n")) {
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      if (!list) out.push((list = []));
      list.push(`<li>${li[1]}</li>`);
      continue;
    }
    list = null;
    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) out.push(`<h${hd[1].length + 2}>${hd[2]}</h${hd[1].length + 2}>`);
    else if (line.trim()) out.push(`<p>${line}</p>`);
  }
  return out
    .map((x) => (Array.isArray(x) ? `<ul>${x.join("")}</ul>` : x))
    .join("")
    .replace(/<p>\u0000(\d+)\u0000<\/p>|\u0000(\d+)\u0000/g, (_, a, b) => blocks[Number(a ?? b)]);
}

function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 1 : 0)} ${u[i]}`;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers ?? {}) }, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  if (res.status === 401) {
    showLogin();
    throw new Error("Log in first.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const fail = (err) => toast(err.message ?? String(err));

// ---- live connection --------------------------------------------------------

const state = { status: null, models: [], jobs: new Map(), sessionId: null, approvals: new Map(), busy: new Set() };
const listeners = new Set();
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "job") state.jobs.set(m.job.id, m.job);
    if (m.type === "approval") state.approvals.set(m.id, m);
    if (m.type === "approval_done") state.approvals.delete(m.id);
    if (m.type === "session") m.state === "busy" ? state.busy.add(m.sessionId) : state.busy.delete(m.sessionId);
    for (const fn of listeners) fn(m);
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
const send = (m) => ws?.readyState === 1 ? ws.send(JSON.stringify(m)) : toast("Not connected yet, try again.");

async function refreshStatus() {
  try {
    state.status = await api("/api/status");
    const s = state.status;
    $("#status-line").replaceChildren(
      h("div", {}, s.running ? `▶ ${s.running.modelName}` : "No model loaded"),
      h("div", {}, `default: ${s.model ?? "none"}`),
      h("div", {}, `${bytes(s.free)} free`),
      h("div", {}, `v${s.version}`),
    );
  } catch {}
}

function showLogin() {
  const input = h("input", { type: "password", placeholder: "Login token", autocomplete: "current-password", class: "grow" });
  const go = async () => {
    try {
      await api("/api/login", { method: "POST", body: { token: input.value.trim() } });
      location.reload();
    } catch (e) {
      fail(e);
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  $("#page").replaceChildren(
    h("div", { class: "page" }, h("h1", {}, "Log in"), h("p", { class: "sub" }, "This LvW server needs its login token. It was printed when the server started, and is in ~/.lvw/config.json."), h("div", { class: "row card" }, input, h("button", { class: "primary", onclick: go }, "Log in"))),
  );
}

// ---- pages -----------------------------------------------------------------

const pages = { chat: chatPage, models: modelsPage, tasks: tasksPage, memory: memoryPage, skills: skillsPage, compare: comparePage };
let cleanup = () => {};

function route() {
  const name = (location.hash.slice(1).split("/")[0] || "chat");
  for (const a of document.querySelectorAll(".sidebar a")) a.classList.toggle("active", a.dataset.page === name);
  cleanup();
  cleanup = () => {};
  const page = pages[name] ?? chatPage;
  page($("#page")).catch(fail);
}

function onLive(fn) {
  listeners.add(fn);
  const prev = cleanup;
  cleanup = () => {
    prev();
    listeners.delete(fn);
  };
}

function fitPill(fit) {
  if (!fit) return "";
  return h("span", { class: `pill ${fit === "fits" ? "fits" : fit === "tight" ? "tight" : "big"}` }, fit);
}

// Chat ------------------------------------------------------------------------

async function chatPage(root) {
  const [sessions, models] = await Promise.all([api("/api/sessions"), api("/api/models")]);
  await refreshStatus();
  const sessionId = location.hash.split("/")[1] || null;
  state.sessionId = sessionId;

  const transcript = h("div", { class: "transcript", "aria-live": "polite" });
  const input = h("textarea", { placeholder: "Ask LvW to do something…  (Enter sends, Shift+Enter new line)", rows: 2, "aria-label": "Message" });
  const runnable = models.filter((m) => m.runnable);
  const modelSel = h("select", { "aria-label": "Model" }, h("option", { value: "" }, `default (${state.status?.model ?? "none"})`), runnable.map((m) => h("option", { value: m.name }, m.name)));
  const permSel = h("select", { "aria-label": "Permissions" }, ["ask", "auto", "readonly"].map((p) => h("option", { value: p, selected: p === (state.status?.permissions ?? "ask") }, p)));
  const research = h("input", { type: "checkbox", id: "research" });
  const cwd = h("input", { type: "text", value: state.status?.cwd ?? "", class: "grow mono", "aria-label": "Working folder", title: "Working folder" });
  const sendBtn = h("button", { class: "primary" }, "Send");
  const stopBtn = h("button", { hidden: true }, "Stop");
  const previewPane = h("aside", { class: "preview", hidden: true });
  const chat = h("div", { class: "chat" });

  const list = h(
    "div",
    { class: "sessions" },
    h("button", { class: "new", onclick: () => (location.hash = "chat") }, "+ New chat"),
    sessions.map((s) => h("a", { href: `#chat/${s.id}`, class: s.id === sessionId ? "active" : "", title: s.cwd }, s.title || "chat")),
  );

  async function refreshSessions() {
    const fresh = await api("/api/sessions").catch(() => null);
    if (!fresh) return;
    list.replaceChildren(list.firstChild, ...fresh.map((s) => h("a", { href: `#chat/${s.id}`, class: s.id === state.sessionId ? "active" : "", title: s.cwd }, s.title || "chat")));
  }

  let current = null;
  let currentText = "";
  const toolEls = new Map();
  const scroll = () => (transcript.scrollTop = transcript.scrollHeight);
  const addUser = (text) => transcript.append(h("div", { class: "msg user" }, text));
  const addTool = (id, name, args) => {
    const pre = h("pre", {}, JSON.stringify(args, null, 2));
    const el = h("details", { class: "tool" }, h("summary", {}, h("span", { class: "state" }), h("strong", {}, name), h("span", { class: "muted mono" }, summarize(args))), pre);
    toolEls.set(id, { el, pre, name, args });
    transcript.append(el);
    return el;
  };
  const finishTool = (id, result, isError) => {
    const t = toolEls.get(id);
    if (!t) return;
    t.el.classList.add(isError ? "err" : "ok");
    const text = (result?.content ?? []).map((b) => b.text ?? `[${b.type}]`).join("\n");
    t.pre.textContent = `${JSON.stringify(t.args, null, 2)}\n\n${text}`;
    const path = t.args?.path;
    if (!isError && typeof path === "string" && /\.(html?|svg|png|jpe?g|gif)$/i.test(path)) {
      t.el.querySelector("summary").append(h("button", { class: "small", onclick: (e) => (e.preventDefault(), showPreview(path)) }, "Preview"));
    }
  };
  const summarize = (args) => {
    const v = args?.command ?? args?.path ?? args?.url ?? args?.query ?? args?.name ?? args?.task ?? "";
    return String(v).slice(0, 90);
  };
  function showPreview(path) {
    const src = `/api/preview?path=${encodeURIComponent(path)}&cwd=${encodeURIComponent(cwd.value)}`;
    previewPane.hidden = false;
    chat.classList.add("with-preview");
    previewPane.replaceChildren(h("div", { class: "row" }, h("strong", { class: "grow mono" }, path), h("a", { href: src, target: "_blank", rel: "noopener" }, "Open"), h("button", { class: "small", onclick: () => ((previewPane.hidden = true), chat.classList.remove("with-preview")) }, "Close")), h("iframe", { src, sandbox: "allow-scripts", title: `Preview of ${path}` }));
  }
  const addApproval = (a) => {
    if (a.sessionId !== state.sessionId || transcript.querySelector(`[data-approval="${a.id}"]`)) return;
    const answer = (ans) => send({ type: "approve", id: a.id, answer: ans });
    transcript.append(
      h("div", { class: "approval", "data-approval": a.id }, h("strong", {}, `Allow ${a.tool}?`), h("span", { class: "mono" }, a.summary), h("div", { class: "row" }, h("button", { class: "primary", onclick: () => answer("yes") }, "Allow"), h("button", { onclick: () => answer("always") }, `Always allow ${a.tool}`), h("button", { class: "danger", onclick: () => answer("no") }, "Deny"))),
    );
    scroll();
  };

  // Rebuild a saved conversation.
  if (sessionId) {
    const messages = await api(`/api/sessions/${sessionId}`);
    const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
    for (const m of messages) {
      if (m.role === "user") addUser(typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join(""));
      if (m.role === "assistant") {
        for (const b of m.content ?? []) {
          if (b.type === "text" && b.text.trim()) transcript.append(h("div", { class: "msg assistant", html: markdown(b.text) }));
          if (b.type === "toolCall") {
            addTool(b.id, b.name, b.arguments);
            const r = results.get(b.id);
            if (r) finishTool(b.id, r, r.isError);
          }
        }
        if (m.errorMessage) transcript.append(h("div", { class: "msg error" }, m.errorMessage));
      }
    }
  } else transcript.append(h("div", { class: "empty" }, "Start a conversation. LvW can read and edit files in the working folder, run commands, search the web and remember things."));
  for (const a of state.approvals.values()) addApproval(a);

  const setBusy = (busy) => {
    sendBtn.disabled = busy;
    stopBtn.hidden = !busy;
  };
  setBusy(sessionId ? state.busy.has(sessionId) : false);

  onLive((m) => {
    if (m.type === "approval") return addApproval(m);
    if (m.type === "approval_done") return transcript.querySelector(`[data-approval="${m.id}"]`)?.remove();
    if (m.type === "error" && (!m.sessionId || m.sessionId === state.sessionId)) {
      transcript.append(h("div", { class: "msg error" }, m.error));
      setBusy(false);
      return scroll();
    }
    if (m.sessionId !== state.sessionId) return;
    if (m.type === "session") {
      setBusy(m.state === "busy");
      if (m.error) transcript.append(h("div", { class: "msg error" }, m.error));
      if (m.state === "idle" && m.label) transcript.append(h("div", { class: "msg muted" }, `stopped: ${m.label}`));
      if (m.state === "idle") refreshSessions();
    }
    if (m.type !== "agent") return;
    const ev = m.event;
    if (ev.type === "message_start" && ev.message.role === "assistant") {
      current = null;
      currentText = "";
    }
    if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
      currentText += ev.assistantMessageEvent.delta;
      if (!current) transcript.append((current = h("div", { class: "msg assistant" })));
      current.innerHTML = markdown(currentText);
    }
    if (ev.type === "message_end" && ev.message.role === "assistant" && ev.message.errorMessage && ev.message.stopReason !== "aborted") transcript.append(h("div", { class: "msg error" }, ev.message.errorMessage));
    if (ev.type === "tool_execution_start") addTool(ev.toolCallId, ev.toolName, ev.args);
    if (ev.type === "tool_execution_end") finishTool(ev.toolCallId, ev.result, ev.isError);
    scroll();
  });

  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    if (!state.sessionId) {
      state.sessionId = crypto.randomUUID();
      history.replaceState(null, "", `#chat/${state.sessionId}`);
      transcript.replaceChildren();
    }
    addUser(text);
    input.value = "";
    setBusy(true);
    send({ type: "chat", sessionId: state.sessionId, text, model: modelSel.value, permissions: permSel.value, cwd: cwd.value, mode: research.checked ? "research" : "default" });
    scroll();
  };
  sendBtn.onclick = submit;
  stopBtn.onclick = () => send({ type: "abort", sessionId: state.sessionId });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });

  chat.append(
    list,
    h("section", { class: "convo" }, transcript, h("div", { class: "composer" }, input, h("div", { class: "row" }, modelSel, permSel, h("label", { class: "row", for: "research" }, research, "research"), cwd, stopBtn, sendBtn))),
    previewPane,
  );
  root.replaceChildren(chat);
  scroll();
  input.focus();
}

// Models ----------------------------------------------------------------------

async function modelsPage(root) {
  const page = h("div", { class: "page" });
  root.replaceChildren(page);
  const disk = h("div", { class: "card" });
  const jobs = h("div");
  const table = h("div", { class: "card" });
  const spec = h("input", { type: "text", class: "grow mono", placeholder: "hf:unsloth/Qwen3-4B-Instruct-2507-GGUF   gh:owner/repo   gl:group/project   https://…/model.gguf   ollama:llama3.2", "aria-label": "Model source" });
  const inspectBox = h("div");
  const searchInput = h("input", { type: "text", class: "grow", placeholder: "Search Hugging Face, e.g. qwen3 4b gguf", "aria-label": "Search Hugging Face" });
  const results = h("div");

  page.append(
    h("h1", {}, "Models"),
    h("p", { class: "sub" }, "Download, run and remove models from Hugging Face, GitHub, GitLab, any URL or Ollama."),
    disk,
    h("h2", {}, "Add a model"),
    h("div", { class: "card" }, h("div", { class: "row" }, spec, h("button", { class: "primary", onclick: () => inspect(spec.value) }, "Choose files…")), inspectBox, h("div", { class: "row", style: "margin-top:14px" }, searchInput, h("button", { onclick: () => search() }, "Search")), results),
    jobs,
    h("h2", {}, "Downloaded"),
    table,
  );
  spec.addEventListener("keydown", (e) => e.key === "Enter" && inspect(spec.value));
  searchInput.addEventListener("keydown", (e) => e.key === "Enter" && search());

  async function search() {
    if (!searchInput.value.trim()) return;
    results.replaceChildren(h("p", { class: "muted" }, "Searching…"));
    try {
      const rows = await api(`/api/models/search?q=${encodeURIComponent(searchInput.value)}`);
      results.replaceChildren(
        rows.length
          ? h("table", {}, h("tbody", {}, rows.map((r) => h("tr", {}, h("td", { class: "mono" }, r.id), h("td", { class: "muted" }, `${r.downloads.toLocaleString()} downloads`), h("td", {}, r.gguf ? h("span", { class: "pill fits" }, "gguf") : "", " ", r.gated ? h("span", { class: "pill tight" }, "gated") : ""), h("td", {}, h("button", { class: "small", onclick: () => ((spec.value = `hf:${r.id}`), inspect(spec.value)) }, "Choose files…"))))))
          : h("p", { class: "muted" }, "No results."),
      );
    } catch (e) {
      results.replaceChildren();
      fail(e);
    }
  }

  async function inspect(value) {
    const s = value.trim();
    if (!s) return;
    if (s.startsWith("ollama:")) return pull(s);
    inspectBox.replaceChildren(h("p", { class: "muted" }, "Looking at the source…"));
    try {
      const r = await api(`/api/models/inspect?spec=${encodeURIComponent(s)}`);
      const gguf = r.choices.some((c) => /\.gguf$/i.test(c.path));
      const name = "pick";
      const rows = r.choices.map((c) =>
        h("label", { class: "choice" }, h("input", { type: gguf ? "radio" : "checkbox", name, value: c.pattern, checked: r.selected.some((p) => p === c.path || p.replace(/-\d{5}-of-\d{5}/, "") === c.path) || !gguf }), h("span", { class: "grow mono" }, c.pattern), h("span", { class: "muted" }, c.size ? bytes(c.size) : "?"), c.parts > 1 ? h("span", { class: "pill" }, `${c.parts} parts`) : "", fitPill(c.fit)),
      );
      inspectBox.replaceChildren(
        h("p", { class: "muted" }, r.note ?? `${r.choices.length} ${gguf ? "quantizations" : "files"} in ${r.dir}`),
        h("div", { class: "choices" }, rows),
        h("div", { class: "row" }, h("button", { class: "primary", onclick: () => {
          const picked = [...inspectBox.querySelectorAll("input:checked")].map((i) => i.value);
          if (!picked.length) return toast("Pick at least one.");
          if (gguf) pull(s, picked[0]);
          else if (picked.length === r.choices.length) pull(s, undefined, true);
          else for (const p of picked) pull(s, p);
        } }, "Download"), h("button", { onclick: () => inspectBox.replaceChildren() }, "Cancel")),
      );
    } catch (e) {
      inspectBox.replaceChildren();
      fail(e);
    }
  }

  async function pull(s, pattern, all) {
    try {
      const job = await api("/api/models/pull", { method: "POST", body: { spec: s, pattern, all } });
      state.jobs.set(job.id, job);
      inspectBox.replaceChildren();
      renderJobs();
      toast("Download started");
    } catch (e) {
      fail(e);
    }
  }

  function renderJobs() {
    const list = [...state.jobs.values()].filter((j) => j.status === "running" || Date.now() - (j.seen ?? Date.now()) < 60_000).reverse();
    jobs.replaceChildren(
      list.length ? h("h2", {}, "Downloads") : "",
      ...list.map((j) =>
        h(
          "div",
          { class: "card", style: "margin-bottom:8px" },
          h("div", { class: "row" }, h("strong", { class: "grow mono" }, j.model?.name ?? j.spec), h("span", { class: "muted" }, j.status === "running" ? `${bytes(j.done)} / ${bytes(j.total)}` : j.status), j.status === "running" ? h("button", { class: "small", onclick: () => api(`/api/jobs/${j.id}/cancel`, { method: "POST" }).catch(fail) }, "Stop") : ""),
          h("div", { class: "bar", style: "margin-top:8px" }, h("span", { style: `width:${j.total ? Math.min(100, (j.done / j.total) * 100) : j.status === "done" ? 100 : 2}%` })),
          j.note ? h("div", { class: "muted", style: "font-size:13px;margin-top:6px" }, j.note) : "",
          j.error ? h("div", { style: "color:var(--bad);font-size:13px;margin-top:6px" }, j.status === "cancelled" ? "Stopped. Download again to resume." : j.error) : "",
        ),
      ),
    );
  }

  async function renderModels() {
    await refreshStatus();
    const [models, du] = await Promise.all([api("/api/models"), api("/api/disk")]);
    const free = du.free;
    const total = du.used + free;
    disk.replaceChildren(
      h("div", { class: "row" }, h("strong", { class: "grow" }, "Disk"), h("span", { class: "muted" }, `models ${bytes(du.used)} · ${bytes(free)} free`), h("button", { class: "small", onclick: gc }, "Clean up")),
      h("div", { class: "meter", style: "margin-top:10px", role: "img", "aria-label": `Models use ${bytes(du.used)}, ${bytes(free)} free` }, h("span", { style: `width:${Math.max(1, (du.used / total) * 100)}%;background:var(--accent)` }), h("span", { style: `width:${100 - (du.used / total) * 100}%` })),
    );
    const running = state.status?.running?.modelId;
    const def = state.status?.model;
    table.replaceChildren(
      models.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["Name", "Format", "Size", "RAM", ""].map((t) => h("th", {}, t)))),
            h(
              "tbody",
              {},
              models.map((m) =>
                h(
                  "tr",
                  {},
                  h("td", {}, h("div", { class: "row" }, h("strong", { class: "mono" }, m.name), running === m.id ? h("span", { class: "pill on" }, "running") : "", def === m.name ? h("span", { class: "pill fits" }, "default") : ""), h("div", { class: "muted mono", style: "font-size:12px" }, m.spec)),
                  h("td", {}, m.format),
                  h("td", {}, bytes(m.size)),
                  h("td", {}, m.missing ? h("span", { class: "pill big" }, "files missing") : m.runnable ? fitPill(m.fit) : h("span", { class: "pill" }, "not runnable")),
                  h(
                    "td",
                    { style: "text-align:right" },
                    h("div", { class: "row", style: "justify-content:flex-end" },
                      m.runnable && m.source !== "ollama" ? (running === m.id ? h("button", { class: "small", onclick: () => act(api("/api/models/stop", { method: "POST" }), "Stopped") }, "Stop") : h("button", { class: "small", onclick: () => act(api(`/api/models/${encodeURIComponent(m.name)}/run`, { method: "POST" }), `${m.name} is running`, "Loading…") }, "Run")) : "",
                      m.runnable && def !== m.name ? h("button", { class: "small", onclick: () => act(api(`/api/models/${encodeURIComponent(m.name)}/default`, { method: "POST" }), "Default model set") }, "Make default") : "",
                      h("button", { class: "small danger", onclick: () => confirm(`Remove ${m.name} and delete its files (${bytes(m.size)})?`) && act(api(`/api/models/${encodeURIComponent(m.name)}`, { method: "DELETE" }).then((r) => toast(`Freed ${bytes(r.freed)}`)), null) }, "Remove"),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("div", { class: "empty" }, "No models yet. Add one above."),
    );
  }
  async function act(p, done, pending) {
    if (pending) toast(pending);
    try {
      await p;
      if (done) toast(done);
    } catch (e) {
      fail(e);
    }
    renderModels();
  }
  async function gc() {
    const rep = await api("/api/gc");
    const n = rep.partials.length + rep.orphans.length + rep.missing.length;
    if (!n) return toast("Nothing to clean.");
    const size = [...rep.partials, ...rep.orphans].reduce((a, f) => a + f.size, 0);
    if (confirm(`Delete ${n} unfinished or stray item(s), ${bytes(size)}?`)) act(api("/api/gc", { method: "POST" }), "Cleaned up");
  }

  for (const j of await api("/api/jobs")) state.jobs.set(j.id, j);
  renderJobs();
  await renderModels();
  onLive((m) => {
    if (m.type !== "job") return;
    if (m.job.status !== "running") {
      m.job.seen = Date.now();
      renderModels();
      if (m.job.status === "done") toast(`${m.job.model?.name} is ready`);
    }
    renderJobs();
  });
}

// Tasks -----------------------------------------------------------------------

async function tasksPage(root) {
  const page = h("div", { class: "page" });
  root.replaceChildren(page);
  const title = h("input", { type: "text", class: "grow", placeholder: "New task, e.g. Add a dark mode to the docs site", "aria-label": "Task title" });
  const desc = h("textarea", { rows: 2, placeholder: "Details (optional)", "aria-label": "Task details" });
  const board = h("div", { class: "board" });
  const approvals = h("div");
  const routines = h("div", { class: "card" });
  page.append(
    h("h1", {}, "Tasks"),
    h("p", { class: "sub" }, "A board for longer work. Run a task and LvW works on it in its own chat; routines create tasks on a schedule."),
    h("div", { class: "card" }, h("div", { class: "row" }, title, h("button", { class: "primary", onclick: add }, "Add")), h("div", { style: "margin-top:8px" }, desc)),
    approvals,
    h("h2", {}, "Board"),
    board,
    h("h2", {}, "Routines"),
    routines,
  );
  async function add() {
    if (!title.value.trim()) return;
    await api("/api/tasks", { method: "POST", body: { title: title.value, description: desc.value } }).catch(fail);
    title.value = desc.value = "";
    render();
  }
  async function render() {
    const { tasks, approvals: pending } = await api("/api/tasks");
    approvals.replaceChildren(
      pending.length ? h("h2", {}, "Waiting for you") : "",
      ...pending.map((a) => h("div", { class: "approval" }, h("strong", {}, `#${a.id}${a.task_id ? ` · task ${a.task_id}` : ""}`), h("span", { class: "mono" }, a.question), h("div", { class: "row" }, h("button", { class: "primary", onclick: () => decide(a.id, true) }, "Approve"), h("button", { class: "danger", onclick: () => decide(a.id, false) }, "Reject")))),
    );
    const cols = ["todo", "doing", "blocked", "review", "done"];
    board.replaceChildren(
      ...cols.map((c) =>
        h(
          "div",
          { class: "col" },
          h("h3", {}, `${c} · ${tasks.filter((t) => t.status === c).length}`),
          tasks
            .filter((t) => t.status === c)
            .map((t) =>
              h(
                "div",
                { class: "task" },
                h("div", {}, h("span", { class: "muted" }, `#${t.id} `), t.title),
                t.result ? h("details", {}, h("summary", { class: "muted" }, "result"), h("div", { html: markdown(t.result) })) : "",
                h("div", { class: "row" },
                  c === "todo" || c === "blocked" ? h("button", { class: "small primary", onclick: () => api(`/api/tasks/${t.id}/run`, { method: "POST", body: {} }).then(() => toast("Running…"), fail) }, "Run") : "",
                  c !== "done" ? h("button", { class: "small", onclick: () => setStatus(t.id, "done") }, "Done") : h("button", { class: "small", onclick: () => setStatus(t.id, "todo") }, "Reopen"),
                ),
              ),
            ),
        ),
      ),
    );
  }
  const setStatus = (id, status) => api(`/api/tasks/${id}`, { method: "PATCH", body: { status } }).then(render, fail);
  const decide = (id, approved) => api(`/api/approvals/${id}`, { method: "POST", body: { approved } }).then(render, fail);

  const rName = h("input", { type: "text", placeholder: "Name", "aria-label": "Routine name" });
  const rCron = h("input", { type: "text", class: "mono", placeholder: "0 9 * * 1-5", "aria-label": "Cron schedule", size: 12 });
  const rPrompt = h("input", { type: "text", class: "grow", placeholder: "What to do, e.g. Summarise new issues in this repo", "aria-label": "Routine prompt" });
  async function renderRoutines() {
    const list = await api("/api/routines");
    routines.replaceChildren(
      list.length ? h("table", {}, h("tbody", {}, list.map((r) => h("tr", {}, h("td", {}, h("strong", {}, r.name)), h("td", { class: "mono" }, r.cron), h("td", { class: "muted" }, r.prompt), h("td", { class: "muted" }, r.last_run ? new Date(r.last_run).toLocaleString() : "never"), h("td", {}, h("button", { class: "small danger", onclick: () => api(`/api/routines/${r.id}`, { method: "DELETE" }).then(renderRoutines, fail) }, "Delete")))))) : h("p", { class: "muted" }, "No routines. Cron format: minute hour day month weekday."),
      h("div", { class: "row", style: "margin-top:10px" }, rName, rCron, rPrompt, h("button", { onclick: () => api("/api/routines", { method: "POST", body: { name: rName.value, cron: rCron.value, prompt: rPrompt.value } }).then(() => { rName.value = rCron.value = rPrompt.value = ""; renderRoutines(); }, fail) }, "Add routine")),
    );
  }
  await Promise.all([render(), renderRoutines()]);
  onLive((m) => m.type === "tasks" && render());
}

// Memory ----------------------------------------------------------------------

async function memoryPage(root) {
  const page = h("div", { class: "page" });
  root.replaceChildren(page);
  const list = h("div", { class: "card" });
  const name = h("input", { type: "text", placeholder: "Name, e.g. profile", "aria-label": "Note name" });
  const scope = h("select", { "aria-label": "Scope" }, h("option", { value: "global" }, "global"), h("option", { value: "project" }, "project"));
  const body = h("textarea", { rows: 8, class: "mono", placeholder: "Markdown. A global note called profile is shown to every session.", "aria-label": "Note text" });
  page.append(
    h("h1", {}, "Memory"),
    h("p", { class: "sub" }, "Plain Markdown files in ~/.lvw/memory (global) and .lvw/memory in each project. The agent searches them and writes handoffs here."),
    list,
    h("h2", {}, "Edit or add a note"),
    h("div", { class: "card" }, h("div", { class: "row" }, name, scope, h("button", { class: "primary", onclick: save }, "Save")), h("div", { style: "margin-top:8px" }, body)),
  );
  async function save() {
    if (!name.value.trim()) return toast("Give the note a name.");
    await api("/api/memory", { method: "PUT", body: { name: name.value, content: body.value, scope: scope.value } }).then(() => toast("Saved"), fail);
    render();
  }
  async function render() {
    const notes = await api("/api/memory");
    list.replaceChildren(
      notes.length
        ? h("table", {}, h("tbody", {}, notes.map((n) => h("tr", {}, h("td", {}, h("strong", {}, n.title)), h("td", { class: "muted mono" }, `${n.scope}/${n.name}`), h("td", { style: "text-align:right" }, h("button", { class: "small", onclick: () => ((name.value = n.name), (scope.value = n.scope), (body.value = n.body), body.focus()) }, "Edit"), " ", h("button", { class: "small danger", onclick: () => confirm(`Delete ${n.name}?`) && api(`/api/memory/${encodeURIComponent(n.name)}`, { method: "DELETE" }).then(render, fail) }, "Delete"))))))
        : h("div", { class: "empty" }, "Nothing remembered yet."),
    );
  }
  await render();
}

// Skills ----------------------------------------------------------------------

async function skillsPage(root) {
  const page = h("div", { class: "page" });
  root.replaceChildren(page);
  const list = h("div", { class: "card" });
  const spec = h("input", { type: "text", class: "grow mono", placeholder: "gh:owner/repo or gh:owner/repo/path/to/skills", "aria-label": "Skill source" });
  page.append(
    h("h1", {}, "Skills"),
    h("p", { class: "sub" }, "Instructions the agent loads when a task fits. Only their names and descriptions take up context until then."),
    h("div", { class: "card" }, h("div", { class: "row" }, spec, h("button", { class: "primary", onclick: add }, "Install"))),
    h("h2", {}, "Installed"),
    list,
  );
  async function add() {
    if (!spec.value.trim()) return;
    toast("Installing…");
    try {
      const r = await api("/api/skills", { method: "POST", body: { spec: spec.value.trim() } });
      toast(`Installed ${r.installed.map((i) => i.name).join(", ")} · licence: ${r.installed[0]?.licence}`);
      spec.value = "";
    } catch (e) {
      fail(e);
    }
    render();
  }
  async function render() {
    const skills = await api("/api/skills");
    list.replaceChildren(
      skills.length
        ? h("table", {}, h("tbody", {}, skills.map((s) => h("tr", {}, h("td", {}, h("strong", { class: "mono" }, s.name), s.scope !== "user" ? h("span", { class: `pill ${s.scope === "draft" ? "tight" : ""}`, style: "margin-left:6px" }, s.scope) : ""), h("td", { class: "muted" }, s.description.slice(0, 220)), h("td", { style: "text-align:right;white-space:nowrap" }, s.scope === "draft" ? h("button", { class: "small primary", onclick: () => api(`/api/skills/${encodeURIComponent(s.name)}/approve`, { method: "POST" }).then(render, fail) }, "Approve") : "", " ", h("button", { class: "small danger", onclick: () => confirm(`Remove ${s.name}?`) && api(`/api/skills/${encodeURIComponent(s.name)}`, { method: "DELETE" }).then(render, fail) }, "Remove"))))))
        : h("div", { class: "empty" }, "No skills installed. Run lvw setup to add the bundled ones."),
    );
  }
  await render();
}

// Compare ---------------------------------------------------------------------

async function comparePage(root) {
  const models = (await api("/api/models")).filter((m) => m.runnable);
  const page = h("div", { class: "page" });
  root.replaceChildren(page);
  const prompt = h("textarea", { rows: 3, placeholder: "One prompt, answered by each model you tick.", "aria-label": "Prompt" });
  const picks = models.map((m) => h("label", { class: "choice" }, h("input", { type: "checkbox", value: m.name }), h("span", { class: "mono grow" }, m.name), fitPill(m.fit)));
  const extra = h("input", { type: "text", class: "grow mono", placeholder: "Also: provider:model, e.g. anthropic:claude-sonnet-5-5", "aria-label": "Extra model" });
  const out = h("div", { class: "compare" });
  const run = async () => {
    const chosen = [...page.querySelectorAll(".choice input:checked")].map((i) => i.value).concat(extra.value.trim() ? [extra.value.trim()] : []);
    if (!prompt.value.trim() || chosen.length < 1) return toast("Write a prompt and pick at least one model.");
    out.replaceChildren(h("p", { class: "muted" }, "Running one model after another…"));
    try {
      const results = await api("/api/compare", { method: "POST", body: { prompt: prompt.value, models: chosen } });
      out.replaceChildren(...results.map((r) => h("div", { class: "card" }, h("div", { class: "row" }, h("strong", { class: "mono grow" }, r.model), h("span", { class: "muted" }, `${(r.ms / 1000).toFixed(1)} s${r.tokens ? ` · ${r.tokens} tokens` : ""}`)), r.error ? h("p", { style: "color:var(--bad)" }, r.error) : h("div", { class: "msg", html: markdown(r.text) }))));
    } catch (e) {
      out.replaceChildren();
      fail(e);
    }
  };
  page.append(h("h1", {}, "Compare"), h("p", { class: "sub" }, "The same prompt to several models, side by side, without tools."), h("div", { class: "card" }, prompt, h("div", { class: "choices" }, picks), h("div", { class: "row" }, extra, h("button", { class: "primary", onclick: run }, "Compare"))), h("h2", {}, "Answers"), out);
}

// ---- start -----------------------------------------------------------------

window.addEventListener("hashchange", route);
connect();
refreshStatus().then(route);
