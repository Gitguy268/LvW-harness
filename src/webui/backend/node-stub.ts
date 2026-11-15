// Stand-ins for the few Node modules just-bash's browser bundle still imports (gzip commands,
// its python/js workers). Those features don't run in a browser; the rest of the shell does.
const unavailable = (what: string) => () => {
  throw new Error(`${what} isn't available in the browser version of the shell.`);
};

export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
export const gzipSync = unavailable("gzip");
export const gunzipSync = unavailable("gunzip");
export const createRequire = () => unavailable("require()");
export const parentPort = null;
export const workerData = undefined;
export const isMainThread = true;
export class Worker {
  constructor() {
    throw new Error("Worker threads aren't available in the browser version of the shell.");
  }
}
export const readFileSync = unavailable("Reading host files");
export const existsSync = () => false;
export const open = unavailable("Opening host files");

/** Enough of AsyncLocalStorage for one shell running one command at a time. */
export class AsyncLocalStorage<T> {
  private store: T | undefined;
  getStore() {
    return this.store;
  }
  enterWith(store: T) {
    this.store = store;
  }
  disable() {
    this.store = undefined;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const prev = this.store;
    this.store = store;
    try {
      const r = fn(...args);
      if (r && typeof (r as { finally?: unknown }).finally === "function") return (r as unknown as Promise<unknown>).finally(() => (this.store = prev)) as R;
      this.store = prev;
      return r;
    } catch (err) {
      this.store = prev;
      throw err;
    }
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    return this.run(undefined as T, fn, ...args);
  }
}

export default { constants, gzipSync, gunzipSync, createRequire, parentPort, workerData, isMainThread, Worker, readFileSync, existsSync, open, AsyncLocalStorage };
