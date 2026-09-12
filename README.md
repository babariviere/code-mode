# code-mode

code-mode is a small, host-independent TypeScript orchestration runtime. It lets a caller submit a typed code body that combines several explicitly registered tools in one invocation. The body is type-checked against the tools that are visible under the current policy, transpiled to ES2022, and run in a fresh QuickJS/WASM context.

It exists to make multi-step tool work explicit and composable without giving model-authored code ambient access to the host. A host chooses the capabilities it exposes, labels each tool's effects, and supplies the policy and limits. code-mode provides the execution boundary, generated declarations, discovery, cancellation, progress events, and bounded JSON results; the host remains responsible for implementing and securing its callbacks.

## Status and requirements

This is a public source repository whose npm workspace packages are private and are not published. It requires Node.js 24 or newer. The package manifests and root manifest are marked `private`, and `dist/` is generated and ignored. Consumers use a pinned Git revision or include the source as a workspace dependency.

## Architecture

An invocation follows this path:

1. A trusted host creates a `Registry` and registers its tools.
2. `CodeModeExecutor` combines host constraints with the invocation policy. Invocation policy can only narrow a host policy.
3. The registry filters visible tools and generates TypeScript declarations and namespace bindings for them.
4. The code body is type-checked and transpiled before it enters the runtime.
5. QuickJS runs the emitted program in a new context. Calls cross a JSON boundary to the host, which validates the input, applies policy, executes the callback, and validates the output.
6. The executor returns an `InvocationResult` containing the value or structured error, formatted output, logs, progress, state, call count, and duration.

The QuickJS context receives only JSON payloads (`π`), bounded mutable invocation state (`τ`), `print`, registered tool namespaces, a discovery helper (`tools.search`), and a deliberately minimal `process` description. It does not receive Node's filesystem, process, network, module, or extension APIs.

## Package layout

| Package | Purpose |
| --- | --- |
| `@babariviere/code-mode-core` (`packages/core`) | Contracts, registry, policy, type-checking, QuickJS execution, state, serialization, and result formatting. This is the host-independent core. |
| `@babariviere/code-mode-protocol` (`packages/protocol`) | Validated newline-delimited JSON contracts for case and workflow events. It is separate from code execution. |
| `@babariviere/code-mode-host-pi` (`packages/host-pi`) | Adapts already-selected Pi tool callbacks into the `pi.*` namespace. It does not load the Pi SDK or discover extensions. |
| `@babariviere/code-mode-host-agentos` (`packages/host-agentos`) | Adapts narrow AgentOS workspace, sandbox, evidence, and optional web callbacks with host-side bounds and path checks. |
| `@babariviere/code-mode-background-runtime` (`packages/background-runtime`) | Registers the single AgentOS Pi-facing `code_mode` tool and provides helpers for building an isolated Pi/ACP package environment. |

`docs/architecture.md` contains the short design note. `examples/` contains runnable source examples. `scripts/` emits package build artifacts and rewrites declaration imports. The root `package.json` owns the workspace and development dependencies; the package manifests expose built files from `dist/`.

## Core API

The core entry point re-exports the contracts and main helpers:

- `Registry` and `createRegistry()` register, discover, declare, and invoke tools.
- `CodeModeExecutor` executes an `InvocationOptions` value.
- `executeCodeMode()` is a convenience wrapper for an invocation that includes a registry.
- `codeMode()` is a convenience wrapper that creates a default empty registry when one is not supplied.
- `CodeModeTool`, `CodeModePolicy`, `InvocationOptions`, `InvocationLimits`, `InvocationResult`, `CodeModeError`, and related types describe the API.

A code body is wrapped in an async function, so it can use `await` and `return` directly. Payload values are available by key through `π`; keys and state values must be JSON-compatible. `τ` is persisted into the returned state for the invocation. `resultFormat` accepts `auto`, `json`, `yaml`, or `text`.

### Registering custom tools

Registration is explicit. A tool has a dotted ID, description, input JSON Schema, an effect classification, an optional output schema and capability list, and a synchronous or asynchronous `execute` callback:

```ts
import { CodeModeExecutor, createRegistry, type CodeModeTool } from "@babariviere/code-mode-core";

const reportsList = {
	id: "reports.list",
	description: "List the reports available to this session",
	inputSchema: {
		type: "object",
		properties: { limit: { type: "integer" } },
		required: ["limit"],
		additionalProperties: false,
	},
	effect: "none",
	capabilities: ["reports.read"],
	execute: async (input: { limit: number }) =>
		(await loadReports()).slice(0, input.limit),
} satisfies CodeModeTool<{ limit: number }>;

const registry = createRegistry([reportsList]);
const executor = new CodeModeExecutor({ registry });
const result = await executor.execute({
	code: "const reportData = await reports.list({ limit: π.limit }); τ.count = reportData.length; return reportData;",
	payloads: { limit: 10 },
});
```

The example above is illustrative and assumes that `loadReports()` is supplied by the host application. The runtime validates inputs against `inputSchema` before calling the callback and validates the result against `outputSchema` when one is provided. IDs must match the lowercase dotted ID format and `tools.search` is reserved. Duplicate IDs and declaration-name collisions are rejected.

### Namespaces and capabilities

The first segment of a tool ID is the code namespace. The remaining segments become a function name joined with underscores:

- `reports.list` is called as `reports.list(input)`.
- `git.diff.file` is called as `git.diff_file(input)`.
- `workspace.read` is called as `workspace.read(input)`.

A namespace is only a generated binding convention. It is not a permission. Permissions come from the tool ID, its exact capability strings, its effect, and the policy. Capability strings are lowercase dotted names such as `workspace.read` or `sandbox.exec`; they are validated on registration and matched exactly by `allowedCapabilities`. Tool allow/deny patterns may match an exact ID or use a trailing `.*` prefix.

The built-in `tools.search({ query?: string })` discovery operation returns summaries for policy-visible tools. It is reserved, does not require registration, and has its own discovery budget. Discovery does not reveal denied tools.

## Policy and security model

A host can pass an immutable policy to `CodeModeExecutor`:

```ts
const executor = new CodeModeExecutor({
	registry,
	policy: {
		allowedCapabilities: ["reports.read"],
		allowedEffects: ["none"],
		maxToolCalls: 8,
	},
});
```

During an invocation, `InvocationOptions.policy` can further restrict, but cannot expand, those host constraints. Policies filter discovery, generated declarations, and runtime dispatch. `deniedTools` always adds denials; `allowedTools`, `allowedCapabilities`, and `allowedEffects` are intersections when both host and invocation policies provide them. A host-side binding must enforce its own authorization as well; the runtime is not a substitute for a deployment boundary.

The default limits are deliberately finite: 30 seconds, 32 tool calls, 16 discovery calls, 256 KiB of source, 512 KiB of payloads and declarations, 128 KiB per tool input, 512 KiB per tool output, 100 KiB of formatted result, 20 KiB of logs, 64 MiB of QuickJS memory, and 64 KiB of state. Each limit has a host maximum; callers can lower limits but cannot exceed those maxima. Cancellation uses `AbortSignal`; host callbacks should honor the signal.

The runtime also enforces a 256 KiB QuickJS stack limit, bounded JSON serialization, cycle and non-JSON-value checks, bounded state keys, schema validation, deadlines, and disposal of the QuickJS context. A cancelled invocation does not wait for a non-cooperative host promise, so host callbacks must avoid side effects after cancellation where that matters.

These controls do not make arbitrary host callbacks safe by themselves. Do not register unrestricted filesystem, process, credential, or network functions. Give every tool the narrowest input and output schema, effect, capability, and host implementation possible.

## Pi integration

`createPiRegistry()` accepts two explicit callback lists, `coreTools` and `selectedTools`. Each Pi tool is adapted to `pi.<name>`, preserving its description, schema, optional effect, and capabilities. Nothing is discovered implicitly, and the package does not load the Pi SDK, ACP, or extension directory. `createPiCodeModeHost()` exposes a `code_mode`-compatible execute callback and forwards progress to the enclosing tool context.

The adapter is intentionally not a Pi extension loader. The surrounding Pi integration must select trusted callbacks and decide which policy to pass. For an AgentOS Pi extension, use `registerBackgroundRuntime()` instead of registering a collection of Pi tools directly.

## AgentOS integration

`createAgentOsRegistry(bindings, options)` exposes only callbacks supplied by the trusted AgentOS host:

- `workspace.read` and optional `workspace.write` operate under a virtual workspace root, `/workspace` by default. Absolute paths, traversal, symlink escapes, and oversized content are rejected.
- `sandbox.exec` runs an argv array through the host's disposable sandbox callback. Its working directory is confined to the workspace, argv and output are bounded, timeouts are capped, and environment variables are denied by default. Credential-like names are rejected even when listed in `allowedEnv`.
- Optional `evidence.create`, `web.search`, and `web.fetch` are registered only when their callbacks are supplied. Evidence is bounded and marked `workspace-write`; web callbacks are marked `none` but still require host/network authorization.

These are adapters, not an AgentOS SDK or sandbox implementation. The deployment supplies the virtual filesystem, disposable executor, evidence store, and approved web services.

`registerBackgroundRuntime(api)` registers exactly one Pi tool named `code_mode`; it adds no commands, widgets, or implicit extension discovery. Its model-facing schema accepts `code`, `payloads`, `limits`, and `invocationId`. A trusted `rolePolicy` is supplied by the host and is never accepted from model input. If a `codeModeBinding` is present, the host owns execution; otherwise the extension runs an executor over its local registry, which is empty unless the caller supplies a binding-based integration.

`generateAgentOsPiPackage()` emits a small private package manifest and `agentos-environment.json`. It pins the Pi and ACP integration dependencies to `0.80.6`, sets `PI_ACP_PI_COMMAND`, `PI_CODING_AGENT_DIR`, and `PI_ACP_EXTENSIONS`, and expects the image builder to copy the built runtime and provision the profile separately. It does not install Pi, ACP, or credentials.

## Build and use from Git

Clone the repository and build it locally; no npm publication is required:

```sh
git clone https://github.com/babariviere/code-mode.git
cd code-mode
npm ci
npm run build
npm test
npm run typecheck
npm run fmt:check
npm exec -- tsx examples/basic.ts
npm exec -- tsx examples/agentos.ts
```

`npm run build` type-checks and emits JavaScript, declarations, and source maps under `dist/`, then copies the package artifacts into each package's ignored `dist/` directory. The package `exports` point at those generated files, so build before importing a package through its workspace export. For development, the examples and tests import source files directly and can be run with `tsx` as above.

The package manifests are private and currently omit a publication/release contract. A separate application should consume a checked-out revision through its workspace or a reviewed local build, with the root development dependencies available; do not assume that copying one package directory alone provides the QuickJS runtime dependencies. Pin the Git revision in deployment automation and review generated artifacts before shipping them.

## Development commands

- `npm ci` installs the lockfile dependencies with Node 24.
- `npm run typecheck` runs strict TypeScript checking without emitting.
- `npm test` runs the Node test suite through `tsx`.
- `npm run build` emits and prepares package artifacts.
- `npm run fmt` applies Biome formatting to source, docs, examples, scripts, and JSON manifests.
- `npm run fmt:check` checks that formatting without writing.

CI runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run fmt:check` on Node 24.

## Current limitations

- This is a private, source-first workspace. There are no published npm packages, release artifacts, or stable compatibility guarantees.
- Tool callbacks are supplied by the host. code-mode does not implement a filesystem, process runner, network client, credential store, AgentOS server, or Pi extension discovery.
- QuickJS isolation is an execution boundary, not a complete operating-system sandbox. Host callbacks and their backing services must enforce authorization, confinement, credentials, quotas, and cancellation.
- Guest values and host bridge values must be JSON-compatible and bounded. Cycles, unsupported values, oversized payloads, outputs, logs, declarations, state, or results fail the invocation.
- TypeScript support is intentionally embedded and non-module-oriented: guest code is wrapped in one async function, checked with the ES2022 library declarations, and cannot import application modules or Node APIs.
- Tool schemas use a structural JSON Schema subset for generated declarations and runtime validation. Complex validator-specific schema semantics are not interpreted by the built-in validator.
- A tool's effect and capability labels are metadata used by policy; they do not grant or revoke authority unless the host policy and callback implementation enforce them.
- The AgentOS Pi helper assumes separately provisioned profiles and image-build integration. It does not perform ACP smoke tests, dependency installation, or sandbox provisioning.
