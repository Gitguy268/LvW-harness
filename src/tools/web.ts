import { Type } from "@earendil-works/pi-ai";
import { decodeEntities, htmlToMarkdown } from "./html.ts";
import { defineTool, type ToolContext } from "./tool.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 lvw-harness";

export async function fetchReadable(url: string, maxChars = 20_000, signal?: AbortSignal) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" }, signal, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const out = type.includes("html") ? htmlToMarkdown(text, res.url) : { title: "", markdown: text };
  const md = out.markdown.length > maxChars ? out.markdown.slice(0, maxChars) + `\n\n… [${out.markdown.length - maxChars} more characters]` : out.markdown;
  return { url: res.url, title: out.title, markdown: md };
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** SearXNG when configured (fully self-hosted), otherwise DuckDuckGo's HTML endpoint. */
export async function webSearch(query: string, searxngUrl?: string, signal?: AbortSignal): Promise<SearchResult[]> {
  if (searxngUrl) {
    const res = await fetch(`${searxngUrl.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(query)}`, { signal });
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
    const data = (await res.json()) as { results: { title: string; url: string; content?: string }[] };
    return data.results.slice(0, 10).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "user-agent": UA }, signal });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  for (let m; (m = re.exec(html)) && results.length < 10; ) {
    let url = decodeEntities(m[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url)?.[1];
    if (uddg) url = decodeURIComponent(uddg);
    if (url.startsWith("//")) url = "https:" + url;
    if (url.includes("duckduckgo.com/y.js")) continue; // ads
    const strip = (s = "") => decodeEntities(s.replace(/<[^>]+>/g, "")).trim();
    results.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  return results;
}

export function webTools(ctx: ToolContext) {
  return [
    defineTool({
      name: "web_fetch",
      label: "Fetch",
      description: "Fetch a web page and return it as Markdown (title, text, links).",
      risk: "read",
      parameters: Type.Object({ url: Type.String(), max_chars: Type.Optional(Type.Number()) }),
      async execute({ url, max_chars }, signal) {
        const r = await fetchReadable(url, max_chars ?? 20_000, signal);
        return `# ${r.title || r.url}\n${r.url}\n\n${r.markdown}`;
      },
    }),
    defineTool({
      name: "web_search",
      label: "Search the web",
      description: "Search the web. Returns titles, URLs and snippets; use web_fetch to read a result.",
      risk: "read",
      parameters: Type.Object({ query: Type.String() }),
      async execute({ query }, signal) {
        const results = await webSearch(query, ctx.config.searxngUrl, signal);
        if (!results.length) return "No results.";
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
      },
    }),
  ];
}
