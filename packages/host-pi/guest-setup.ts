/** Trusted interactive Pi guest bindings. Never supplied by a model invocation. */
export const GUEST_SETUP = `
(() => {
const __spindleBridge = globalThis.__spindleHostCall;
delete globalThis.__spindleHostCall;
const __spindleAbortReason = (signal) => {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
};
let __spindleNextCallId = 1;
// A guest AbortSignal cannot cross the JSON boundary, so a call carrying one is
// tagged with an id instead: the host gives that call its own AbortController,
// and an abort on the guest side sends spindle.$cancel with the same id. The
// signal key is stripped here so it never reaches a tool's argument schema.
const __call = async (ref, args) => {
  const payload = args ?? {};
  const signal =
    payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload.signal : undefined;
  if (!signal || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    return __spindleBridge(ref, payload);
  }
  if (signal.aborted) throw __spindleAbortReason(signal);
  const rest = {};
  for (const key of Object.keys(payload)) if (key !== "signal") rest[key] = payload[key];
  const callId = __spindleNextCallId++;
  rest.__spindleCallId = callId;
  // The bridge promise always gets a handler: when the abort wins the race, the
  // call's own later rejection must not surface as an unhandled rejection.
  const settled = __spindleBridge(ref, rest).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => {
      void __call("spindle.$cancel", { callId });
      resolve({ ok: false, error: __spindleAbortReason(signal) });
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([settled, aborted]);
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
};
const __spindleProcessInfo = globalThis.__spindleProcess ?? { env: {}, platform: "unknown", arch: "unknown", cwd: "" };
const __spindleProviders = globalThis.__spindleProviders ?? [];
delete globalThis.__spindleProviders;
delete globalThis.__spindleProcess;
// Minimal process shim: the host injects an allowlisted env snapshot
// (HOME, USER, LOGNAME, SHELL, PATH, LANG, LC_*, TERM, TMPDIR, XDG_*), so no
// secret ever enters the sandbox. cwd() is the agent session's directory.
globalThis.process = Object.freeze({
  env: Object.freeze(__spindleProcessInfo.env ?? {}),
  platform: __spindleProcessInfo.platform,
  arch: __spindleProcessInfo.arch,
  cwd: () => __spindleProcessInfo.cwd,
});
const __piToolNames = ["read","bash","exec","edit","write","applyPatch","grep","find","ls"];
const __piStringFields = { bash: "command", read: "path", ls: "path", grep: "pattern", find: "pattern" };
// Per-tool key aliases. The runtime normalizes them to the canonical form
// before the host validates args; unit-converting aliases are handled separately
// in __normalizePiArgs. This lets a model that writes { query, regex, ... }
// or { file } instead of { pattern } / { path } still succeeds on the first
// call. Keep these in sync with the PiToolsApi overloads in guest-types.ts so
// the type-checker accepts the same spellings it coercion-handles at runtime.
const __piArgAliases = {
  bash: { cmd: "command", shell: "command", cmdline: "command", workdir: "cwd", workingDir: "cwd", workingDirectory: "cwd" },
  find: { query: "pattern", regex: "pattern", search: "pattern", max: "limit" },
  grep: {
    query: "pattern", regex: "pattern", search: "pattern",
    ic: "ignoreCase", caseInsensitive: "ignoreCase",
    globPattern: "glob",
    max: "limit", ctx: "context",
  },
  read: { file: "path", max: "limit", start: "offset" },
  ls: { dir: "path", file: "path", max: "limit" },
  edit: { file: "path", old: "oldText", new: "newText", replacement: "newText" },
  write: { file: "path", contents: "content", body: "content", text: "content" },
};
// Multi-arg positional order, used only when a call passes >= 2 args. The
// one-field tools (read/bash/ls) are intentionally absent: their bare-string
// form already covers the 1-arg case, and a 2-arg call should hit the
// type-checker's wrong-arity (2554) and be corrected to an options object
// rather than silently dropping the second argument.
const __piPositionalFields = {
  grep: ["pattern", "path", "limit"],
  find: ["pattern", "path", "limit"],
  write: ["path", "content"],
  edit: ["path", "oldText", "newText"],
};
const __positionalToArgs = (name, rest) => {
  const order = __piPositionalFields[name];
  if (!order) return rest.length > 0 ? rest[0] : {};
  const out = {};
  for (let i = 0; i < rest.length && i < order.length; i++) {
    const v = rest[i];
    if (v !== undefined) out[order[i]] = v;
  }
  return out;
};
const __normalizePiArgs = (name, args) => {
  const field = __piStringFields[name];
  if (typeof args === "string" && field) return { [field]: args };
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const aliases = __piArgAliases[name];
  let out = args;
  if ((name === "bash" || name === "exec") && "timeoutMs" in out) {
    out = Object.assign({}, args);
    if (!("timeout" in out)) {
      const timeoutMs = out.timeoutMs;
      out.timeout = typeof timeoutMs === "number" ? timeoutMs / 1000 : timeoutMs;
    }
    delete out.timeoutMs;
  }
  // settle is a guest-only directive (settles nonzero exits instead of
  // rejecting); strip it so it never reaches the host/bash schema.
  if ((name === "bash" || name === "exec") && "settle" in out) {
    if (out === args) out = Object.assign({}, args);
    delete out.settle;
  }
  if (aliases) {
    for (const alias in aliases) {
      const canonical = aliases[alias];
      if (alias in out) {
        if (out === args) out = Object.assign({}, args);
        if (!(canonical in out)) out[canonical] = out[alias];
        delete out[alias];
      }
    }
  }
  // The declared batch shape uses the same short keys as the single-edit form
  // ({ old, new }); pi core wants oldText/newText, and the alias table above
  // only rewrites top-level keys.
  if (name === "edit" && Array.isArray(out.edits)) {
    let touched = false;
    const edits = out.edits.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      if (!("old" in entry) && !("new" in entry) && !("replacement" in entry)) return entry;
      touched = true;
      const mapped = Object.assign({}, entry);
      if ("old" in mapped) {
        if (!("oldText" in mapped)) mapped.oldText = mapped.old;
        delete mapped.old;
      }
      if ("new" in mapped) {
        if (!("newText" in mapped)) mapped.newText = mapped.new;
        delete mapped.new;
      }
      if ("replacement" in mapped) {
        if (!("newText" in mapped)) mapped.newText = mapped.replacement;
        delete mapped.replacement;
      }
      return mapped;
    });
    if (touched) {
      if (out === args) out = Object.assign({}, args);
      out.edits = edits;
    }
  }
  if (name === "edit" && !Array.isArray(out.edits) && ("oldText" in out || "newText" in out)) {
    if (out === args) out = Object.assign({}, args);
    const edit = {};
    if ("oldText" in out) edit.oldText = out.oldText;
    if ("newText" in out) edit.newText = out.newText;
    out.edits = [edit];
    delete out.oldText;
    delete out.newText;
  }
  return out;
};
// The pi proxy accepts: a bare string (primary field), an options object, or
// a positional spread mapped by __piPositionalFields. 0/1 args preserve the
// legacy (args = {}) default so existing programs are unchanged.
globalThis.pi = new Proxy({}, {
  get(_target, property) {
    if (property === "then") return undefined;
    const name = String(property);
    return (...rest) => {
      let args;
      if (rest.length <= 1) {
        const first = rest.length === 1 ? rest[0] : undefined;
        args = first === undefined ? {} : first;
      } else {
        args = __positionalToArgs(name, rest);
      }
      // bash rejects on an ordinary nonzero exit; settle:true returns
      // {ok:false, exitCode, ...} instead (opt-in). Other failures still reject.
      const settle = name === "bash" &&
        typeof args === "object" && args !== null && args.settle === true;
      const call = __call("pi." + name, __normalizePiArgs(name, args));
      if (!settle) return call;
      return call.catch((error) => {
        const message = typeof error?.message === "string" ? error.message : String(error);
        const exit = error && error.__spindleBashExit;
        if (exit && Number.isSafeInteger(exit.exitCode) && exit.exitCode > 0 &&
            typeof exit.output === "string") {
          return {
            ok: false,
            output: exit.output,
            details: null,
            exitCode: exit.exitCode,
            error: message,
          };
        }
        // Fallback for a bash result that never reached the classifier (an
        // extension-owned override, for example).
        const match = /(?:^|\\n\\n)Command exited with code (\\d+)$/.exec(message);
        if (!match) throw error;
        return {
          ok: false,
          output: message.slice(0, match.index),
          details: null,
          exitCode: Number(match[1]),
          error: message,
        };
      });
    };
  },
});
const __piPayloads = (typeof globalThis["π"] === "object" && globalThis["π"] !== null) ? globalThis["π"] : {};
globalThis["π"] = new Proxy(__piPayloads, {
  get(target, property) {
    if (typeof property === "symbol") return undefined;
    const name = String(property);
    if (name === "then" || name === "toJSON" || name === "constructor") return undefined;
    if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
    if (__piToolNames.indexOf(name) >= 0) {
      throw new Error(
        "π." + name + " is the payloads accessor, not a tool. For the Pi core tool, call pi." + name + "(args)."
      );
    }
    const provided = Object.keys(target);
    throw new Error(
      "π." + name + " is not defined. π only exposes keys from the code_mode payloads argument" +
      (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)") +
      ". Pass payloads: { " + name + ": '...' } to use π." + name + "."
    );
  },
  ownKeys(target) { return Reflect.ownKeys(target); },
  getOwnPropertyDescriptor(target, prop) { return Reflect.getOwnPropertyDescriptor(target, prop); },
  has(target, prop) { return Object.prototype.hasOwnProperty.call(target, prop); }
});
// Stable providers share a lazy dispatch proxy; the guest declarations keep
// their known actions typed while the registry remains the runtime authority.
const __providerProxy = (provider) => new Proxy({}, {
  get(_target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    return (args = {}) => __call(provider + "." + String(property), args);
  },
});
for (const __provider of __spindleProviders) {
  if (typeof __provider !== "string" || !/^[a-z][a-z0-9_-]*$/.test(__provider)) continue;
  if (["pi", "mcp", "agents", "web"].indexOf(__provider) >= 0) continue;
  globalThis[__provider] = __providerProxy(__provider);
}
if (__spindleProviders.indexOf("web") >= 0) globalThis.web = __providerProxy("web");
// tools is discovery + generic calls only. The proxy keeps the six discovery
// methods and turns a core-tool name (read/bash/edit/...) into an actionable
// error pointing at pi.<name>, so a model that writes tools.read(...) learns
// the fix in one turn instead of looping on "tools.read is not a function".
const __toolsBase = {
  providers: () => __call("spindle.$providers", {}),
  catalog: (args = {}) => __call("spindle.$catalog", args),
  list: (args = {}) => __call("spindle.$list", args),
  search: (args) => __call("spindle.$search", args),
  describe: (args) => __call("spindle.$describe", args),
  call: (args) => __call("spindle.$call", args),
};
globalThis.tools = new Proxy(__toolsBase, {
  get(target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    const name = String(property);
    if (__piToolNames.indexOf(name) >= 0) {
      return () => {
        throw new Error(
          "tools." + name + " is not available on the discovery API. tools is discovery + generic calls only (providers/catalog/list/search/describe/call). For the Pi core tool, call pi." + name + "(args), e.g. pi." + name + "({ ... })."
        );
      };
    }
    return target[property];
  },
  set() { return true; },
  deleteProperty() { return true; },
});
globalThis.agents = Object.freeze({
  models: () => __call("agents.models", {}),
  list: () => __call("agents.list", {}),
  run: (args) => __call("agents.run", args),
  runAll: (args) => __call("agents.runAll", Array.isArray(args) ? { tasks: args } : args),
  start: (args) => __call("agents.start", Array.isArray(args) ? { tasks: args } : args),
  wait: (args) => __call("agents.wait", typeof args === "string" ? { runId: args } : args),
  status: () => __call("agents.status", {}),
  cancel: (args) =>
    __call("agents.cancel", typeof args === "string" ? { runId: args } : (args || {})),
});
// One way in: mcp.call({ server, tool, args }), or the positional form
// mcp.call(server, tool, args). Every route lands on the in-tree MCP client
// (mcp/client-hub.ts), which connects a server on first use.
//
// Discovery deliberately lives here rather than on tools.*: servers connect on
// demand, so a server's tool list is known only from the on-disk schema cache
// or after a connect, and folding it into the static action registry would mean
// connecting every configured server at startup.
globalThis.mcp = Object.freeze({
  call: (serverName, tool, args) =>
    __call(
      "mcp.call",
      serverName && typeof serverName === "object"
        ? serverName
        : { server: serverName, tool, args: args ?? {} },
    ),
  list: (args = {}) => __call("mcp.list", typeof args === "string" ? { server: args } : args),
  search: (args) => __call("mcp.search", typeof args === "string" ? { query: args } : args),
  describe: (args) => __call("mcp.describe", typeof args === "string" ? { tool: args } : args),
  connect: (args) => __call("mcp.connect", typeof args === "string" ? { server: args } : args),
});
// The session-scoped scratchpad. τ = 2π, and the joke is load-bearing: π is
// this program's read-only payloads, τ is the store that outlives it. Methods
// rather than property access on purpose — every one of these can fail (bad
// key, non-serializable value, budget), and a failable write must not look
// like an assignment. The held keys are echoed in every code_mode result,
// so a later program does not have to guess what is there.
globalThis["τ"] = Object.freeze({
  get: async (key) => {
    const read = await __call("spindle.$stateGet", { key });
    return read && read.found ? read.value : undefined;
  },
  set: (key, value) => __call("spindle.$stateSet", { key, value }),
  keys: () => __call("spindle.$stateKeys", {}),
  delete: (key) => __call("spindle.$stateDelete", { key }),
  clear: () => __call("spindle.$stateClear", {}),
});
const __runPool = async (thunks, options) => {
  if (!Array.isArray(thunks) || thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("mapLimit expects an array of functions or (items, mapper)");
  }
  if (thunks.length === 0) return [];
  const concurrencyOpt = typeof options === "number" ? { concurrency: options } : options ?? {};
  const requestedConcurrency = Number(concurrencyOpt.concurrency ?? thunks.length);
  if (!Number.isFinite(requestedConcurrency) || requestedConcurrency < 1) {
    throw new RangeError("mapLimit concurrency must be a positive finite number");
  }
  const concurrency = Math.max(1, Math.min(thunks.length || 1, Math.floor(requestedConcurrency)));
  const results = new Array(thunks.length);
  const signal = concurrencyOpt.signal;
  if (signal && signal.aborted) throw __spindleAbortReason(signal);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < thunks.length) {
      // Checked before each item rather than mid-flight: an aborted fan-out
      // stops launching new work, and the in-flight items cancel themselves if
      // they were handed the same signal.
      if (signal && signal.aborted) throw __spindleAbortReason(signal);
      const index = cursor++;
      results[index] = await thunks[index]();
    }
  }));
  return results;
};
// The one concurrency primitive Promise.all cannot express: Promise.all
// receives already-started promises, so it can never bound how many run at
// once. mapLimit takes thunks (or items + mapper) and starts them lazily
// behind a worker pool.
const __mapLimit = async (items, arg2, arg3) => {
  const mapper = typeof arg2 === "function" ? arg2 : undefined;
  const options = mapper ? arg3 : arg2;
  if (mapper && !Array.isArray(items)) {
    throw new TypeError("mapLimit expects an array as the first argument");
  }
  const thunks = mapper ? items.map((item, index) => () => mapper(item, index)) : items;
  return __runPool(thunks, options);
};
globalThis.mapLimit = __mapLimit;
globalThis.console = Object.freeze({ log: print, info: print, warn: print, error: print });
const __timerCallbacks = new Map();
let __nextTimerId = 1;
globalThis.setTimeout = (callback, ms = 0) => {
  const id = __nextTimerId++;
  __timerCallbacks.set(id, { callback, interval: false });
  __call("spindle.$timer", { ms }).then(() => {
    const entry = __timerCallbacks.get(id);
    if (!entry) return;
    __timerCallbacks.delete(id);
    try { entry.callback(); } catch { /* swallow timer callback errors */ }
  });
  return id;
};
globalThis.setInterval = (callback, ms = 0) => {
  const id = __nextTimerId++;
  __timerCallbacks.set(id, { callback, interval: true });
  const schedule = () => {
    __call("spindle.$timer", { ms }).then(() => {
      const entry = __timerCallbacks.get(id);
      if (!entry) return;
      try { entry.callback(); } catch { /* swallow timer callback errors */ }
      if (__timerCallbacks.has(id)) schedule();
    });
  };
  schedule();
  return id;
};
globalThis.clearTimeout = (id) => { __timerCallbacks.delete(id); };
globalThis.clearInterval = (id) => { __timerCallbacks.delete(id); };
})();
`;
