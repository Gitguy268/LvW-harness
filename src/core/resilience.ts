/** Provider failures worth another try. After OpenHarness: retries with exponential backoff. */
export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = Number(process.env.LVW_RETRY_BASE_MS ?? 1000);

const TRANSIENT = /\b(429|500|502|503|504|529)\b|rate.?limit|overloaded|timed? ?out|timeout|econnreset|econnrefused|socket hang up|fetch failed|connection (error|closed|reset)|temporarily unavailable/i;

export const isTransientError = (message: string) => TRANSIENT.test(message);

/** Ollama refuses a request with tools when the model's template has none. */
export const isNoToolsError = (message: string) => /does not support tools/i.test(message);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
