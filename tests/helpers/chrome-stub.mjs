/** Minimal in-memory chrome.storage stub for unit testing shared/*.js modules
 * outside a browser. Mirrors the subset of the chrome.storage API this codebase
 * actually uses (get by string/array/object-with-defaults, set, remove). */
function makeArea() {
  let store = {};
  return {
    async get(keys) {
      if (keys == null) return { ...store };
      if (typeof keys === 'string') return { [keys]: store[keys] };
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      const out = {};
      for (const k of Object.keys(keys)) out[k] = store[k] !== undefined ? store[k] : keys[k];
      return out;
    },
    async set(obj) {
      Object.assign(store, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
    },
    _dump() {
      return store;
    },
    _reset() {
      store = {};
    },
  };
}

/** Installs a fresh globalThis.chrome stub and returns its storage areas so a
 * test can inspect/reset them directly. Call in beforeEach for isolation. */
export function installChromeStub() {
  const local = makeArea();
  const sync = makeArea();
  globalThis.chrome = {
    storage: { local, sync },
    tabs: { query: async () => [], sendMessage: async () => undefined },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => undefined },
    scripting: { executeScript: async () => [] },
  };
  return { local, sync };
}
