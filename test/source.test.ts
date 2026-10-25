import { describe, expect, test } from "bun:test";
import { listChoices, quantOf, selectFiles } from "../src/models/select.ts";
import { matchesPattern, parseSpec, specToString } from "../src/models/source.ts";

describe("parseSpec", () => {
  test("hf with quant and revision", () => {
    expect(parseSpec("hf:Qwen/Qwen3-4B-GGUF@v2:Q4_K_M")).toEqual({ kind: "hf", repo: "Qwen/Qwen3-4B-GGUF", revision: "v2", pattern: "Q4_K_M" });
  });
  test("bare owner/repo is Hugging Face", () => {
    expect(parseSpec("unsloth/gemma-3-1b-it-GGUF")).toMatchObject({ kind: "hf", repo: "unsloth/gemma-3-1b-it-GGUF", revision: "main" });
  });
  test("github and gitlab", () => {
    expect(parseSpec("gh:owner/repo@v1.0:*.gguf")).toEqual({ kind: "gh", repo: "owner/repo", tag: "v1.0", pattern: "*.gguf" });
    expect(parseSpec("gl:group/sub/project")).toMatchObject({ kind: "gl", project: "group/sub/project", host: "https://gitlab.com" });
  });
  test("site URLs", () => {
    expect(parseSpec("https://huggingface.co/owner/repo/resolve/main/model.Q8_0.gguf")).toEqual({ kind: "hf", repo: "owner/repo", revision: "main", pattern: "model.Q8_0.gguf" });
    expect(parseSpec("https://github.com/owner/repo/releases/tag/v2")).toEqual({ kind: "gh", repo: "owner/repo", tag: "v2" });
    expect(parseSpec("https://gitlab.com/group/project/-/tree/main")).toMatchObject({ kind: "gl", project: "group/project" });
    expect(parseSpec("https://example.com/x/model.gguf")).toEqual({ kind: "url", url: "https://example.com/x/model.gguf" });
  });
  test("ollama", () => {
    expect(parseSpec("ollama:llama3.2:1b")).toEqual({ kind: "ollama", name: "llama3.2:1b" });
  });
  test("bad specs", () => {
    expect(() => parseSpec("hf:justone")).toThrow();
    expect(() => parseSpec("ollama:")).toThrow();
  });
  test("round trip", () => {
    for (const s of ["hf:a/b:Q4_K_M", "gh:a/b@v1", "gl:a/b/c@t:*.bin", "ollama:x"]) expect(specToString(parseSpec(s))).toBe(s);
  });
});

describe("patterns and quants", () => {
  test("quant tokens match whole words", () => {
    expect(matchesPattern("Qwen3-4B-Q4_K_M.gguf", "Q4_K_M")).toBe(true);
    expect(matchesPattern("Qwen3-4B-Q4_K_M.gguf", "q4_k")).toBe(false);
    expect(matchesPattern("sub/model.Q8_0.gguf", "*.gguf")).toBe(true);
    expect(matchesPattern("onnx/model.onnx", "onnx/*")).toBe(true);
  });
  test("quantOf", () => {
    expect(quantOf("Qwen3-4B-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("model-IQ4_XS-00001-of-00002.gguf")).toBe("IQ4_XS");
    expect(quantOf("gemma-3-1b-it-BF16.gguf")).toBe("BF16");
  });
});

const f = (path: string, size = 10) => ({ path, url: `https://x/${path}`, size });

describe("selectFiles", () => {
  const repo = [f("README.md"), f(".gitattributes"), f("m-Q8_0.gguf", 80), f("m-Q4_K_M.gguf", 40), f("m-Q2_K.gguf", 20), f("mmproj-F16.gguf", 5)];
  test("defaults to Q4_K_M", () => {
    const s = selectFiles(repo, {});
    expect(s.files.map((x) => x.path)).toEqual(["m-Q4_K_M.gguf"]);
    expect(s.note).toContain("Q4_K_M");
  });
  test("pattern picks a quant", () => {
    expect(selectFiles(repo, { pattern: "Q8_0" }).files.map((x) => x.path)).toEqual(["m-Q8_0.gguf"]);
  });
  test("unknown quant lists the options", () => {
    expect(() => selectFiles(repo, { pattern: "Q3_K_L" })).toThrow(/Q8_0, Q4_K_M, Q2_K/);
  });
  test("shards come together", () => {
    const sharded = [f("big-Q4_K_M-00001-of-00002.gguf"), f("big-Q4_K_M-00002-of-00002.gguf"), f("big-Q8_0.gguf")];
    expect(selectFiles(sharded, { pattern: "Q4_K_M" }).files).toHaveLength(2);
    expect(listChoices(sharded).find((c) => c.pattern === "Q4_K_M")?.parts).toBe(2);
  });
  test("non-GGUF repo downloads everything but .gitattributes", () => {
    const st = [f("config.json"), f("model.safetensors"), f(".gitattributes")];
    expect(selectFiles(st, {}).files.map((x) => x.path)).toEqual(["config.json", "model.safetensors"]);
  });
  test("--all", () => {
    expect(selectFiles(repo, { all: true }).files).toHaveLength(5);
  });
});
