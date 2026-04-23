# Workflow System — Design Scaffolding

> **Status:** Draft / scaffolding for discussion. Names, scopes, and boundaries are intentionally loose so we can refine them together.

## 1. Purpose & Goals

A multi-deliverable system for **authoring, sharing, and executing multi-step workflows**, built around a portable serialized format and a small set of cooperating components:

- A **workflow engine library** that loads serialized workflows and runs them, with no UI, no I/O, and no built-in trigger system of its own.
- A **CLI** (`workflow`) that runs serialized workflows headlessly.
- A **visual editor** — Svelte + Svelte Flow, hostable as a Tauri desktop app, a VS Code webview, or an embedded Custom Element — for visually composing, inspecting, and iterating on workflows.
- A **pluggable step-type model**: every executable behavior (LLM call, shell command, HTTP request, script, future TypeAgent action, anything else) is contributed by a separate plugin package against a stable `StepHandler` interface; the engine itself ships only `core.*` control-flow nodes.
- An **optional TypeAgent `AppAgent`** (`workflowEditorAgent`) that exposes the editor's capabilities through fine-grained sub-schemas, so the editor can be driven by natural language from a TypeAgent shell's `chat-ui` + dispatcher — without the editor owning any LLM logic itself.

The system is designed so that none of these components requires the others. The engine runs without the editor; the editor runs without TypeAgent; the CLI runs without either.

### Primary goals

- **Serializable workflows as the unit of everything.** A `.workflow.json` file is the only thing that crosses boundaries between the editor, engine, CLI, plugins, and any future integration.
- **Standalone, embeddable engine library.** The engine library knows nothing about UIs, triggers, schedulers, servers, or transports; any external system can `import { runWorkflow }` and execute a workflow.
- **Visual authoring.** Drag/connect nodes drawn from a pluggable catalog of step types; round-trip cleanly to/from the serialized form.
- **Headless execution via CLI** for scripting, CI, and reproducible runs — and to validate the engine-as-library boundary from day one.
- **First-class extensibility** for step types, host capabilities, and validation hooks.
- **Optional NL authoring via TypeAgent**, delivered by exposing the editor as an `AppAgent` rather than by building NL handling inside the editor.
- **Multi-tab / multi-session editing** so subflow workflows (workflows referenced by other workflows) can be opened and edited side-by-side.
- **Support iteration**: edit → run → inspect → edit, whether driven by mouse, keyboard, CLI, or chat.

### Non-goals (initial)

- Coupling execution to the TypeAgent dispatcher. (TypeAgent integration is opt-in along two independent axes — see §3.2 and §3.4.)
- General-purpose programming (arbitrary expressions, free-form scripting) beyond a small control-flow set and binding language.
- Multi-user real-time collaboration; accounts; permissions; tenancy.
- A central registry / marketplace / publish UX for workflows or plugins.
- A persistent daemon for scheduled or event-driven triggers (those are external systems that consume the engine library).
- Replacing existing TypeAgent surfaces.

---

## 2. Open Questions (please refine)

1. **Host surface** — _Resolved (2026-04-22):_ The editor must be hostable in **three surfaces** from a single codebase:

   - **Standalone desktop app** (Tauri shell wrapping the editor)
   - **Web app** (dev-only; served from a host that exposes the workflow service)
   - **Embedded panel** in other apps (VS Code webview, TypeAgent shell, future hosts)

   See [§3.1 Host-Surface Strategy](#31-host-surface-strategy) for the architectural implications.

2. **Workflow == Activity?** _Resolved (2026-04-22):_ Workflows are a **separate, first-class artifact**, intentionally kept distinct from TypeAgent _activities_. Any later interop with activities is out of scope for this design.
3. **Execution model** — _Resolved (2026-04-22):_ Execution lives in a **standalone workflow engine** independent of the TypeAgent dispatcher. The engine walks the graph and invokes **pluggable step handlers**; each step type (LLM call, script, command, HTTP, etc.) is contributed by a plugin. TypeAgent dispatcher integration is treated as a **possible future plugin**, not a built-in dependency. See [§3.2 Execution Model & Extensibility](#32-execution-model--extensibility).
4. **Trigger model** — _Resolved (2026-04-22):_ **Manual trigger only**, invoked from the editor UI in v1. Scheduled / event-driven / chat-driven triggers are **out of scope**. The workflow engine is published as a **serializable-in, execute-out library** so any external system (cron job, webhook receiver, chat integration, another app) can read a `.workflow.json` and run it later without the editor being involved. See [§3.3 Engine-as-Library](#33-engine-as-library).
5. **Sharing** — _Resolved (2026-04-22):_ The **`.workflow.json` file is the unit of sharing**. Plugin requirements are declared in the document and lockfile-able; secrets and environment-specific values are **never embedded**. Distribution is just "send the file" — no central registry, no in-editor publish/install UX, no multi-user accounts in v1. See [§6.1 Sharing & Portability](#61-sharing--portability).
6. **LLM assist** — _Resolved (2026-04-23):_ NL authoring is provided by **exposing the editor as a TypeAgent `AppAgent`** with fine-grained sub-schemas. The conversational UI is the **existing `chat-ui` package + dispatcher**, embedded as a peer surface; the editor itself ships **no LLM client and no NL UI**. Multi-tab support is required because workflows can contain subflow nodes the user will want to open side-by-side. See [§3.4 NL Authoring via TypeAgent Agent](#34-nl-authoring-via-typeagent-agent).

---

## 3. Proposed Architecture (high level)

```
┌────────────────────────────────────────────────────────────┐
│                      Editor Frontend                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ Canvas   │  │ Palette  │  │ Inspector│  │ Run Panel  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬─────┘  │
│       └─────────────┴─────────────┴───────────────┘        │
│                  Workflow Model (in-memory)                 │
└──────────────────────────┬─────────────────────────────────┘
                           │  RPC (transport-neutral)
┌──────────────────────────┴─────────────────────────────────┐
│                    Workflow Service                         │
│  - Step-type registry (from plugins)                        │
│  - Validation (against each step type's param schema)       │
│  - Persistence (load/save)                                  │
│  - Workflow engine (graph walker + step dispatch)           │
└──────────────────────────┬─────────────────────────────────┘
                           │  StepHandler interface
        ┌──────────────────┼──────────────────────┬────────────────┐
        ▼                  ▼                      ▼                ▼
   ┌─────────┐        ┌─────────┐            ┌─────────┐     ┌──────────────┐
   │  LLM    │        │ Script  │            │  HTTP   │ ... │  TypeAgent   │
   │ plugin  │        │ plugin  │            │ plugin  │     │  dispatcher  │
   │         │        │         │            │         │     │  (optional,  │
   │         │        │         │            │         │     │   future)    │
   └─────────┘        └─────────┘            └─────────┘     └──────────────┘
```

### 3.1 Host-Surface Strategy

The editor ships as a **portable, host-agnostic core** plus thin **host adapters**. Nothing in the core may depend on Electron, the browser DOM specifics of one host, the VS Code API, or Node-only modules.

```
┌──────────────────────────────────────────────────────────────┐
│                     Host Adapters (thin)                     │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────────┐  │
│  │  Desktop   │   │  Web (dev) │   │  VS Code Webview     │  │
│  │  (Tauri)   │   │ (static +  │   │  (extension host +   │  │
│  │            │   │  service)  │   │   webview bridge)    │  │
│  └─────┬──────┘   └─────┬──────┘   └──────────┬───────────┘  │
└────────┼────────────────┼─────────────────────┼──────────────┘
         │                │                     │
         ▼                ▼                     ▼
┌──────────────────────────────────────────────────────────────┐
│              Editor Core (framework-agnostic)                 │
│  - UI components (Svelte, no host-specific imports)           │
│  - Workflow model + in-memory store                           │
│  - Command/keybinding registry                                │
│  - Transport-agnostic service client (interface only)         │
└──────────────────────────────┬───────────────────────────────┘
                               │  ServiceClient interface
                               ▼
┌──────────────────────────────────────────────────────────────┐
│             Transport Implementations (per host)              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ WebSocket    │  │ HTTP/SSE     │  │ postMessage bridge │  │
│  │ (desktop/web)│  │ (web)        │  │ (VS Code webview)  │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

#### Layering rules

1. **Core package (`workflowEditor`)** is pure TypeScript + Svelte. No `electron`, no `vscode`, no `fs`, no `process`. Renders into any DOM root.
2. **Service access** goes through a `WorkflowServiceClient` interface. The core never opens a socket itself.
3. **Host adapters** are tiny packages that:
   - Mount the core into the host's DOM/webview.
   - Provide a concrete `WorkflowServiceClient` (WebSocket, postMessage, in-process).
   - Provide host capabilities (file pickers, clipboard, notifications, theme) via a `HostBridge` interface.
4. **Workflow service** is independent of the host and reachable over any transport. In some hosts it is co-located (desktop in-process), in others it is remote (web).

#### Host-specific concerns

The Web column below describes the **dev-only** target; rows that imply production hosting (auth, per-user server storage) are what a shipped web target _would_ need and are recorded here only so the architecture remains compatible with a later promotion.

| Concern          | Desktop (Tauri)                   | Web (dev-only)                                   | VS Code Webview                     |
| ---------------- | --------------------------------- | ------------------------------------------------ | ----------------------------------- |
| Service location | In-process or local child process | Local dev server                                 | Extension host process              |
| Transport        | WebSocket / IPC                   | WebSocket / HTTP+SSE                             | `postMessage` bridge to extension   |
| File I/O         | Native dialogs                    | Browser download / File System Access API        | `vscode.workspace.fs` via extension |
| Auth             | OS keychain                       | (n/a for dev; Cookie / OAuth if promoted)        | VS Code secret storage              |
| Theme            | Custom + OS theme                 | App theme                                        | Inherit VS Code theme tokens        |
| Persistence root | `~/.workflows/`                   | Local dev server (would be per-user if promoted) | Workspace folder or global storage  |
| Process model    | Renderer + main                   | Single page                                      | Webview + extension host            |

#### Suggested package shape

Directories are camelCase; `package.json` `name` fields are kebab-case (see §5).

```
packages/
  workflowEditor/              # Core UI + model (Svelte 5 + Svelte Flow, host-agnostic)
  workflowEditorElement/       # Custom Element wrapper (<workflow-editor>)
  workflowEditorHostDesktop/   # Tauri shell
  workflowEditorHostWeb/       # Dev web entrypoint + Vite dev server
  workflowEditorHostVscode/    # VS Code extension + webview bundle
  workflowService/             # Backend service (host-agnostic)
  workflowServiceClientWs/     # WebSocket client impl
  workflowServiceClientVscode/ # postMessage client impl
```

#### Constraints this imposes on the rest of the design

- The **service RPC contract** must be transport-neutral (request/response + event stream), so it can ride on WebSocket, HTTP+SSE, or `postMessage`.
- The **workflow model** must serialize to plain JSON with no host-specific references.
- **Build output** for the core must be consumable both as an ES module bundle (web/VS Code) and via a desktop bundler.
- **Capabilities** (file open/save, "reveal in explorer", notifications) are accessed only through `HostBridge`, never directly.

#### Repository UI baseline (verified 2026-04-22)

The existing TypeAgent UI surfaces (`packages/shell` renderer, `chat-ui`, `cacheExplorer`, etc.) are written in **vanilla TypeScript + DOM**. There is **no React, Svelte, Vue, Preact, Lit, or Angular dependency anywhere in the monorepo** (verified by grepping every `packages/*/package.json` and `examples/*/package.json`).

Implications:

- Adopting any UI framework for the workflow editor introduces a **new stack** to the monorepo. "Repo consistency" is therefore **not** a tie-breaker between framework options.
- The framework choice should be re-evaluated on its own merits (canvas library maturity, form ecosystem, bundle size, embedding story, contributor pool) — see Decision Log entry on UI framework.
- Whatever is chosen should be **isolated to the editor packages** so it does not bleed into other UIs unless those teams opt in.

#### Embedding modes

The editor supports three embedding modes. Every supported host uses one of them. The host-agnostic core, `HostBridge`, and `WorkflowServiceClient` interfaces are designed so all three modes work without changing the core.

| Mode                           | What the host does                                                                                                                                          | Boundary                        | Communication                              | Style/theme isolation              | When to use                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **1. Native component import** | Imports the editor as a **Svelte component** (or, in mode 2, as a custom element) and mounts it in its own DOM tree.                                        | Same JS realm, same DOM root    | Direct prop binding + Svelte events        | Shared with host; explicit theming | Host is itself a Svelte app, **or** uses the Custom Element wrapper (mode 2).                             |
| **2. Custom Element**          | Loads a bundled `<workflow-editor>` script and uses it as an HTML tag. **First-class for Svelte** via `<svelte:options customElement="workflow-editor" />`. | Same document, isolated runtime | DOM attributes/properties + `CustomEvent`s | Shadow DOM (optional)              | Embedding into a non-Svelte web host (incl. the existing vanilla-TS TypeAgent UIs) or a third-party page. |
| **3. Iframe / webview**        | Loads the editor's web bundle inside an `<iframe>` or native webview and proxies events.                                                                    | Separate document/realm         | `postMessage` over a typed protocol        | Total isolation                    | VS Code webview, Tauri WebviewWindow, any cross-origin / sandboxed embed.                                 |

**Mapping to known hosts:**

| Host                        | Embedding mode               | Notes                                                                                                                                      |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Tauri desktop shell         | (3) Native webview           | Tauri loads the same web bundle as the dev web target; IPC bridges `HostBridge` to native APIs.                                            |
| VS Code extension           | (3) Webview + `postMessage`  | Extension host owns the workflow service or proxies to it; webview gets a `postMessage` transport.                                         |
| Dev web target              | (3) Browser tab (degenerate) | The "host" is the browser itself; no embedding wrapper needed.                                                                             |
| TypeAgent shell / `chat-ui` | (2) Custom Element           | Existing TypeAgent UIs are vanilla TS — they consume the editor as a `<workflow-editor>` Custom Element rather than as a Svelte component. |
| Future third-party host     | (2) Custom Element           | Same wrapper, no Svelte runtime requirements on the host.                                                                                  |

**Implementation rules to keep all three modes viable:**

1. The core's **public interface** (props, events, methods) is defined as a plain TypeScript contract — no Svelte-only types in the surface area. The Svelte component is one implementation of that contract; the Custom Element wrapper exposes the same contract.
2. **All host-only capabilities** are accessed through `HostBridge`; the core never assumes a `window`-level API exists.
3. **All service calls** go through `WorkflowServiceClient`; the core never instantiates a transport.
4. **Workflow documents and events** are plain JSON, so they cross any boundary (function call, `CustomEvent` detail, `postMessage` payload) unchanged.
5. The Custom Element wrapper (mode 2) and the iframe entrypoint (mode 3) are **separate thin packages** that depend on the core and provide their own transport + bridge implementations. The Custom Element wrapper is **in scope for the initial release** (it is how existing TypeAgent UIs embed the editor).

### 3.2 Execution Model & Extensibility

The workflow engine is a **standalone runtime** that walks the workflow graph, follows decision points, manages variables and bindings, and dispatches each step to a registered **step handler**. The engine itself knows nothing about LLMs, scripts, HTTP, or TypeAgent — every executable behavior is contributed by a plugin against a stable interface.

#### Step handler contract

Every step type declares:

- A **type id** (e.g., `llm.chat`, `script.node`, `cmd.shell`, `http.request`, `typeagent.action`).
- A **JSON Schema for its parameters** (consumed by the Inspector to render the form, and by the Validator to type-check bindings).
- A **JSON Schema for its outputs** (consumed by the `BindingPicker` so downstream nodes can reference fields).
- An **`execute(params, ctx)` function** returning a `StepResult` (`{ status: "ok" | "error" | "cancelled", outputs?, error?, logs? }`).
- Optional **palette metadata** (icon, category, label, description) for the editor's Node Palette.

```ts
// shape only — names will be refined
interface StepHandler<P = unknown, O = unknown> {
  type: string; // e.g., "llm.chat"
  paramsSchema: JSONSchema;
  outputsSchema: JSONSchema;
  paletteMetadata?: PaletteMetadata;
  execute(params: P, ctx: StepContext): Promise<StepResult<O>>;
}

interface StepContext {
  signal: AbortSignal;
  log(level: "info" | "warn" | "error", message: string, data?: unknown): void;
  emitProgress(data: unknown): void;
  variables: ReadonlyMap<string, unknown>;
  // capability bridges (filesystem, secrets, http) provided by the host
  capabilities: HostCapabilities;
}
```

#### Initial built-in step types (proposal)

| Type id                        | Description                                                | Notes                                  |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------- |
| `core.start`                   | Workflow entry point; emits initial inputs.                | Built-in control.                      |
| `core.end`                     | Workflow termination; collects outputs.                    | Built-in control.                      |
| `core.branch`                  | Evaluates a predicate; routes to one outgoing edge.        | Built-in control.                      |
| `core.parallel` / `core.merge` | Fan-out / join.                                            | Built-in control.                      |
| `core.loop`                    | Bounded iteration over a collection.                       | Built-in control.                      |
| `core.subflow`                 | Invokes another saved workflow.                            | Built-in control.                      |
| `core.note`                    | Authoring-only annotation; no-op at runtime.               | Built-in.                              |
| `llm.chat`                     | Single LLM completion / chat call.                         | First example of a real action plugin. |
| `cmd.shell`                    | Run a shell command; capture stdout/stderr/exit.           | First example of a real action plugin. |
| `script.node`                  | Run a Node.js script with declared inputs/outputs.         | First example of a real action plugin. |
| `http.request`                 | HTTP request with URL, headers, body; structured response. | First example of a real action plugin. |

`core.*` step types are owned by the engine. Everything else is a separate plugin package.

#### Reserved (not built-in) — TypeAgent dispatcher integration

A future `typeagent.action` step type would let a node represent a typed TypeAgent action and execute it through the dispatcher. **It is not part of the initial scope.** The contract above is sufficient to add it later without engine changes; the dispatcher integration would only need to:

- Register a step type whose `paramsSchema` is the action's schema (sourced via `actionSchema`).
- Implement `execute` by routing the action through `dispatcher` (or directly through `agentSdk`).

NL-driven authoring (translating natural language into typed nodes) is _not_ a concern of this step-type plugin. That responsibility lives in `workflowEditorAgent` (see §3.4), which drives the editor's existing command system rather than bypassing it.

This is recorded explicitly so the extension surface is designed with this case in mind, even though no code is written for it yet.

#### Extension points (designed up front, even if unused at v1)

| Extension point         | Purpose                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Step handler**        | Adds a new executable step type (the primary extension point).                                                 |
| **Palette contributor** | Surfaces step types in the Node Palette under a category, with icon / docs.                                    |
| **Capability provider** | Supplies host capabilities (filesystem, secrets, network, telemetry) injected into `StepContext.capabilities`. |
| **Validator hook**      | Optional cross-node validation (e.g., "this LLM step requires an API key capability").                         |
| **Run observer**        | Subscribes to engine events for logging, tracing, telemetry, custom UI panels.                                 |

#### Plugin loading & isolation

- Plugins are **separate npm packages** that export a registration function.
- The Workflow Service loads plugins at startup from a configured list (initially: a static list; later: dynamic discovery / user-installable).
- Plugins run **in the service process** (no sandbox in v1). Untrusted plugins are out of scope; this is treated like loading any other Node module.
- Plugin packages **must not depend on the editor frontend** \u2014 they contribute schemas + handlers, not UI.

#### What this buys us

- The editor can ship and execute real workflows without any TypeAgent dependency.
- TypeAgent integration is opt-in along two independent axes: a `workflowPluginTypeagent` step type (a workflow node that _runs_ a TypeAgent action) and a `workflowEditorAgent` package (an `AppAgent` that _edits_ the workflow via NL through `chat-ui`/dispatcher — see §3.4).
- New step types (Slack, Git, AWS, anything) follow the same path \u2014 add a plugin, register it, done.

### 3.3 Engine-as-Library

The workflow engine is published as a **reusable library** (`workflowEngine`) whose inputs are a serialized workflow document and a set of registered step handlers, and whose outputs are a run result plus a progress event stream. **It knows nothing about UIs, triggers, schedulers, servers, or transports.**

```ts
// Library surface (shape only — names TBD)
import {
  runWorkflow,
  loadWorkflow,
  registerStepHandlers,
} from "workflowEngine";

const workflow = loadWorkflow(jsonString); // parse + validate shape
registerStepHandlers([llmHandler, shellHandler]); // per-process registry
const run = runWorkflow(workflow, {
  inputs: {
    /* initial inputs */
  },
  signal: abortController.signal,
  onEvent: (evt) => {
    /* progress / logs / node transitions */
  },
});
const result = await run.completion; // { status, outputs, errors, nodeResults }
```

#### Rules

1. **Serializable round-trip is the contract.** A workflow document is the _only_ thing that crosses boundaries. `workflowModel` owns the schema; `loadWorkflow` / `saveWorkflow` are the only ways to cross the boundary. Any consumer with the JSON + registered handlers can execute a workflow; no editor instance required.
2. **Engine has no I/O of its own.** No filesystem reads, no network, no clocks beyond what a step handler requests through `StepContext.capabilities`. This is what makes it embeddable in a CLI, a server, a cron job, a chat bot, or a test.
3. **Manual trigger is the only supported trigger in v1.** The editor calls `runWorkflow` directly when the user clicks "Run." There is no trigger subsystem, no scheduler, no webhook listener, no FS watcher.
4. **External systems own their own trigger logic.** A cron job / webhook receiver / chat integration that wants to fire a workflow imports `workflowEngine`, loads the JSON, and calls `runWorkflow`. How _they_ get invoked is entirely their concern. The workflow editor project does not ship any of them.
5. **The workflow document may carry a `triggers` metadata field** for _recording_ external trigger intent (so another system can read the doc and know how it's meant to be invoked), but the engine itself ignores it at v1.

#### What this explicitly defers

- Scheduler (cron) integration.
- HTTP webhook listeners.
- Filesystem watchers.
- Chat / NL-invoked triggers (including any TypeAgent dispatcher integration for invocation).
- A persistent daemon / service process dedicated to firing triggers.

Each is achievable later **without engine changes** \u2014 any future trigger host simply becomes another `runWorkflow` caller.

#### First-class library consumers in v1

| Consumer            | Status       | Role                                                                                                                                                                           |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor (\u00a73.1)  | **In scope** | Calls `runWorkflow` directly when the user clicks "Run"; renders the event stream live.                                                                                        |
| **CLI** (\u00a74.7) | **In scope** | Headless runner: `workflow run <file>` invokes `runWorkflow`, streams events to stdout, exits with the run's status code. Validates the engine-as-library boundary on day one. |

#### Example future integrations (out of scope for this project)

| Integration       | How it would use the library                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| A cron daemon     | Its own cron scheduler calls `runWorkflow` on the configured workflow at the configured time.                  |
| A webhook server  | Its own HTTP listener calls `runWorkflow` on request; webhook-specific payload parsing lives in that server.   |
| A TypeAgent agent | A TypeAgent agent's `executeAction` implementation calls `runWorkflow`; workflow ID is the action's parameter. |

---

### 3.4 NL Authoring via TypeAgent Agent

Natural-language authoring is delivered by **exposing the editor as a TypeAgent `AppAgent`** — not by building NL handling inside the editor. The dispatcher (running in a TypeAgent shell that hosts the existing `chat-ui` pane) translates user input into typed actions on the workflow-editor agent, which then mutates the open workflow document. This composes cleanly with the dispatcher's planning, multi-turn, and multi-agent capabilities; the editor gets all of that for free without owning any LLM logic.

```
  User
   │  (natural language)
   ▼
 ┌────────────────┐    ┌──────────────┐                    ┌──────────────────────┐
 │  chat-ui pane  │───▶│  Dispatcher  │───typed actions───▶│ workflowEditorAgent  │
 │  (TypeAgent)   │    │  (TypeAgent) │  (workflow.session,│   (this project)     │
 └────────────────┘    └──────────────┘   workflow.edit,   └──────────┬───────────┘
                                          etc.)                      │
                                                                      ▼
                                                          ┌──────────────────────┐
                                                          │    Editor surface    │
                                                          │  (Svelte; multi-tab) │
                                                          └──────────┬───────────┘
                                                                     ▼
                                                          Open workflow document(s)
```

#### Architectural rules

1. **The editor owns no LLM logic.** It does not import an LLM client, does not render an "Assist" button, does not own a prompt box. The conversational surface is the existing `chat-ui` package, hosted alongside the editor by whatever shell is in use.
2. **The editor exposes its capabilities as an `AppAgent`.** A separate package, `workflowEditorAgent`, implements the `AppAgent` interface and its actions are typed editing/query/run operations on the currently focused workflow.
3. **Editor remains standalone.** The agent is opt-in. If no TypeAgent shell is present, the editor is a pure visual tool with no chat surface. This preserves the engine-as-library / host-agnostic decisions.
4. **Agent never bypasses the editor's model invariants.** The agent calls into the editor's existing in-memory model + command system (the same code paths the UI uses), so undo/redo, validation, and live updates work uniformly whether a change came from the mouse or from chat.

#### Sub-schema groupings

The `workflowEditorAgent` exposes its actions through **multiple TypeAgent sub-schemas**, grouped by responsibility. Each sub-schema can be enabled/disabled independently and translated independently by the dispatcher.

| Sub-schema         | Purpose                                                                           | Example actions                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `workflow.session` | Manage editor sessions (tabs / windows / focus).                                  | `openWorkflow`, `closeWorkflow`, `listOpenWorkflows`, `focusWorkflow`, `splitView`, `newWorkflow`                         |
| `workflow.query`   | Read-only inspection of the focused workflow.                                     | `describeWorkflow`, `findNode`, `getNode`, `listNodes`, `getEdges`, `getValidationErrors`, `getRunResult`, `summarizeRun` |
| `workflow.edit`    | Fine-grained mutations of the focused workflow.                                   | `addNode`, `deleteNode`, `setNodeParam`, `setNodeLabel`, `connectNodes`, `disconnectEdge`, `moveNode`, `setVariable`      |
| `workflow.subflow` | Multi-workflow composition (subflow nodes + tabs).                                | `createSubflowFromSelection`, `openSubflowOfNode`, `inlineSubflow`, `linkSubflow`                                         |
| `workflow.run`     | Execute and control runs of the focused workflow.                                 | `runWorkflow`, `cancelRun`, `runFromNode`, `runUpToNode`, `dryRun`                                                        |
| `workflow.palette` | Discover available step types (lets the dispatcher reason about what's possible). | `listStepTypes`, `getStepTypeSchema`, `searchStepTypes`                                                                   |

Fine-grained actions are the default; the dispatcher can plan multi-step changes by chaining them, and the editor's existing command system makes each one a discrete undoable operation. A coarse `applyPatch` action is intentionally _not_ offered — it would force the LLM to produce a complete structurally-correct diff in one shot and bypass the dispatcher's planning value.

#### Multi-session support (tabs)

Multiple workflows can be open at once. The agent uses an explicit session model so the dispatcher can address each one:

- Each open workflow has a stable **session id** and a user-friendly name (the workflow's `name` plus a disambiguator if duplicates).
- Exactly one session is **focused** at a time; mutating actions default to operating on the focused session.
- Any action can take an optional `session?: string` parameter to target a specific session by id or name.
- `workflow.session.focusWorkflow` and `workflow.session.splitView` let the dispatcher (or the user) change focus.
- Subflow nodes (`core.subflow`) carry a reference to another workflow file; `workflow.subflow.openSubflowOfNode` opens it as a new session, enabling "jump into the subflow" navigation either by click or by NL.

#### Why this is the right shape

- **Symmetric with TypeAgent.** The editor is just another agent in the ecosystem; it composes with planning, multi-agent calls, and the cache.
- **No duplicated NL infrastructure.** The dispatcher already does NL → typed-action mapping; the editor does not need to.
- **Future-proof.** Improvements to the dispatcher (better planning, clarification, RAG over the user's history) automatically benefit the editor.
- **Clean separation of concerns.** The `workflowEditorAgent` translates typed actions into editor commands; the dispatcher owns the conversation; the editor owns the document and its UI. Nothing is owned twice.
- **Standalone path preserved.** Without TypeAgent, the editor still works — just without chat.

#### Out of scope for v1

- Any LLM client or prompt template inside the editor or `workflowEditorAgent`.
- A registry of "assistants" inside the editor (the previous proposal, now superseded — see Decision Log).
- Inline ghost-text suggestions in the canvas.
- Voice input (handled by the host shell if at all).
- Continuous "explain this workflow" generation (a future TypeAgent agent can add this; not part of `workflowEditorAgent`).

#### Package shape

```
packages/
  workflowEditorAgent/    # AppAgent for the editor: schemas + handlers; depends on editor's command system
```

This package depends on the editor packages (it needs to call into the open editor instance) and on `@typeagent/agent-sdk`. It is **not** a dependency of the editor itself — the editor must build and run without it.

---

## 4. Proposed Components

### 4.1 Frontend (UI)

| Component                    | Responsibility                                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Canvas**                   | Renders nodes/edges; handles pan/zoom, selection, drag, connect, multi-select, undo/redo. Built on **Svelte Flow (`@xyflow/svelte`)**.                                                                                                                   |
| **Node Palette**             | Browsable, searchable list of available action nodes grouped by agent. Drag-to-canvas.                                                                                                                                                                   |
| **Inspector Panel**          | Edits the selected node's parameters using an in-house schema-driven Svelte renderer (see §4.6). Every primitive field is wrapped by a `BindingOrLiteral` widget so any input can be a literal or a reference to an upstream output / workflow variable. |
| **Run Panel**                | Triggers execution, shows live status, per-node logs, results, and elapsed time.                                                                                                                                                                         |
| **Toolbar**                  | New / Open / Save / Run / Stop / Undo / Redo / Validate / Export.                                                                                                                                                                                        |
| **Mini-map & Outline**       | Navigation aids for large graphs.                                                                                                                                                                                                                        |
| **Variable / Context Panel** | View and seed workflow-scoped variables and inputs.                                                                                                                                                                                                      |
| **Diff View** _(stretch)_    | Compare two workflow versions.                                                                                                                                                                                                                           |

### 4.2 Workflow Model (shared types)

| Type           | Purpose                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Workflow`     | Top-level document: id, name, version, nodes, edges, variables, triggers, metadata, plugin requirements.                                                                                                                                                                                                                                                                       |
| `WorkflowNode` | `{ id, stepType, params, position, label }`. `stepType` is a registered step-handler type id (e.g., `llm.chat`, `core.branch`). No agent/action coupling.                                                                                                                                                                                                                      |
| `WorkflowEdge` | `{ id, from: NodeRef, to: NodeRef, condition? }`. `NodeRef` includes a port for typed outputs.                                                                                                                                                                                                                                                                                 |
| `Binding`      | How a node's parameter is filled: literal, reference to upstream output, workflow variable, or expression.                                                                                                                                                                                                                                                                     |
| `Trigger`      | _Out of scope for v1._ Only a built-in **manual** trigger exists (run from the editor UI, CLI, or programmatic library call). The workflow schema reserves a `triggers` field for future external trigger records, but the engine does not consume it.                                                                                                                         |
| `PluginRef`    | `{ packageName, versionRange }` — the workflow declares which plugins must be loaded for it to validate and execute, by package name and **semver range**. The Service refuses to run a workflow whose required plugins are not registered, with an error that names what's missing. Exact versions used at design/test time may be pinned in `*.workflow.lock.json` (see §6). |

### 4.3 Backend / Service

| Component              | Responsibility                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plugin Loader**      | Loads configured plugin packages and calls each one's registration function; populates the step-type registry, palette contributions, capability providers, etc.                              |
| **Step-Type Registry** | Authoritative list of available step types and their `paramsSchema` / `outputsSchema`. Exposed to the editor for the Palette and Inspector.                                                   |
| **Validator**          | Type-checks each node's `params` against its step type's `paramsSchema`; checks bindings against upstream `outputsSchema`s; reports errors per node/edge.                                     |
| **Persistence Store**  | Save/load `.workflow.json` files under `~/.workflows/` (or repo-tracked). Path is configurable per host.                                                                                      |
| **Workflow Engine**    | Walks the graph, resolves bindings, calls the registered `StepHandler.execute` for each node, captures `StepResult`s, manages variables, evaluates control-flow nodes, emits progress events. |
| **Run History**        | Stores past runs with inputs, outputs, timings, errors for replay/inspection.                                                                                                                 |
| **RPC Surface**        | Transport-neutral protocol: `listStepTypes`, `getStepSchema`, `validate`, `save`, `load`, `run`, `cancel`, `subscribeRun`. No TypeAgent-specific methods at v1.                               |

### 4.4 Execution Semantics (initial proposal)

- **`core.start`** node receives initial inputs (from trigger or user).
- **Step nodes** of any registered type execute via their `StepHandler.execute(params, ctx)`, returning a `StepResult` whose `outputs` are made available to downstream nodes.
- **`core.branch`** evaluates a predicate over upstream outputs/variables; routes to one outgoing edge.
- **`core.parallel` / `core.merge`** fan-out and join.
- **`core.loop`** iterates over a collection output (bounded; max iterations configurable).
- **`core.subflow`** invokes another saved workflow as a single step; the engine instantiates a child run and surfaces its progress as the subflow node's progress.
- **Errors** surface on the node; configurable policy: stop, continue, retry(N), branch-to-error-port.
- **Cancellation** is cooperative — each step receives an `AbortSignal` via `StepContext`.

### 4.5 Integration Points

The core engine, service, and editor have **no required dependency on TypeAgent**. The table below lists where TypeAgent (or any other ecosystem) could plug in via the extension mechanism.

| Surface                                                    | Provided by              | Notes                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON Schema validation (`ajv`)                             | core dependency          | Used by Validator and the Inspector.                                                                                                                                                                          |
| Built-in step types (`core.*`)                             | `workflowEngine`         | Control-flow only.                                                                                                                                                                                            |
| Common step types (`llm.*`, `cmd.*`, `http.*`, `script.*`) | separate plugin packages | Each is its own package; users opt in.                                                                                                                                                                        |
| **TypeAgent dispatcher integration**                       | _future_ plugin package  | Would contribute a `typeagent.action` step type so a workflow node can _run_ a TypeAgent action. NL authoring is handled separately by `workflowEditorAgent` (§3.4), not by this plugin. **Not built in v1.** |
| Capabilities (fs, secrets, http)                           | host adapter or plugin   | Injected via `StepContext.capabilities`; differs per host (Tauri / VS Code / web).                                                                                                                            |

### 4.6 Inspector Architecture

The Inspector renders a form for the selected node's `params`, generated from the action's JSON Schema (sourced via `actionSchema`). It is built **in-house** rather than using a third-party schema-form library — see Decision Log for rationale. The decisive factor is that **every editable field must support bindings** (literal vs. reference to upstream output, workflow variable, or expression), and any off-the-shelf library would require us to override every primitive widget anyway.

#### File layout

```
packages/workflowEditor/src/inspector/
  Inspector.svelte                  # Top-level: shows form for selected node
  fields/
    FieldRenderer.svelte            # Dispatches by JSON Schema type
    StringField.svelte
    NumberField.svelte
    BooleanField.svelte
    EnumField.svelte                # string/number with `enum`
    ObjectField.svelte              # nested objects
    ArrayField.svelte               # add/remove items
    UnknownField.svelte             # fallback for unsupported schemas
  binding/
    BindingOrLiteral.svelte         # wraps any field; toggles literal vs. binding
    BindingPicker.svelte            # tree of upstream node outputs + variables
  validation/
    validate.ts                     # ajv wrapper; errors keyed by JSON Pointer
  types.ts                          # FieldValue, Binding, ValidationError
```

#### Contract

- `FieldRenderer` receives `{ schema, path, value, errors }` and emits change events.
- Every primitive field is wrapped by `BindingOrLiteral`, which renders either the type-specific literal editor or a `BindingPicker`.
- Validation runs `ajv` against the action's full param schema; errors are mapped to JSON Pointer paths and surfaced inline next to the offending field.
- The Inspector emits the node's full `params` object (literals + bindings) back to the workflow model on change; it does not own the document.

#### Explicit non-goals for v1

- `oneOf` / `anyOf` discrimination beyond simple enum-tagged unions.
- `$ref` resolution beyond what `actionSchema` already inlines.
- Conditional schemas (`if` / `then` / `else`).
- Schema-driven UI hints (`ui:widget`-style overrides).

Added only when a real action schema demands them.

### 4.7 CLI

A headless command-line tool, `workflow`, that runs serialized workflows without the editor. It is the **engine library's first non-editor consumer** and exists primarily to validate the engine-as-library boundary (§3.3) from day one. It is also genuinely useful for scripting, CI, and reproducible runs.

#### Commands (v1)

| Command                             | Purpose                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow run <file> [--input k=v]` | Loads the workflow JSON, registers configured plugins, runs it, streams events to stdout. Exits non-zero on failure.                                                |
| `workflow validate <file>`          | Loads + validates the workflow against registered step-type schemas; prints errors with JSON Pointer paths. No execution.                                           |
| `workflow inspect <file>`           | Prints the workflow's metadata: required plugins (and which are installed/missing), declared secrets, declared capabilities, declared inputs/outputs. No execution. |
| `workflow list-step-types`          | Prints the registered step types and their `paramsSchema` summaries. Useful for debugging plugin configuration.                                                     |
| `workflow version`                  | Prints engine and plugin versions.                                                                                                                                  |

#### Output

- Default: human-readable progress (one line per node transition + concise log lines).
- `--json`: NDJSON event stream (one event per line) for piping into other tools.
- Final summary written to stderr; final outputs written to stdout when `--emit-outputs` is set.

#### Configuration

- A small config file (`workflow.config.json` or `~/.config/workflow/config.json`) lists the **plugin packages to load** and any plugin-specific settings.
- `--plugin <pkg>` flag adds plugins ad-hoc.
- Secrets and capability bindings are sourced from environment variables and a configurable secret backend (initially: env vars only).

#### Constraints

- The CLI **must not** import the editor packages, transports, or service. Its only dependencies are `workflowModel`, `workflowEngine`, and the user-configured plugin packages.
- Run records (`~/.workflows/runs/...`) follow the same format the editor uses, so a CLI run can be inspected later in the editor's run history view.
- Cancellation: `SIGINT` triggers cooperative cancel via the engine's `AbortSignal`.

---

## 5. Proposed Package Layout (strawman)

Because the project is independent of TypeAgent, packages may live in this monorepo (with `workflow-` prefix) or move to a separate repo later. Names are placeholders.

```
packages/
  workflowModel/                 # Shared types, JSON schemas, serialization (no runtime deps on engine)
  workflowEngine/                # Standalone engine + StepHandler interface + core.* step types
  workflowService/               # Plugin loader, registry, validator, persistence, RPC surface
  workflowCli/                   # `workflow` command (headless runner; engine library's first consumer)
  workflowEditor/                # Frontend (Svelte 5 + Svelte Flow + in-house Inspector)
  workflowEditorElement/         # Custom Element wrapper (<workflow-editor>)
  workflowEditorHostDesktop/     # Tauri shell
  workflowEditorHostWeb/         # Dev web entrypoint + Vite dev server
  workflowEditorHostVscode/      # VS Code extension + webview bundle
  workflowServiceClientWs/       # WebSocket client transport
  workflowServiceClientVscode/   # postMessage client transport

  # Plugins (each a separate package; users opt in)
  workflowPluginLlm/             # llm.chat, llm.completion
  workflowPluginShell/           # cmd.shell
  workflowPluginHttp/            # http.request
  workflowPluginScript/          # script.node

  # Optional TypeAgent integration (opt-in; editor must build/run without it)
  workflowEditorAgent/           # AppAgent exposing the editor: workflow.session, workflow.query,
                                 # workflow.edit, workflow.subflow, workflow.run, workflow.palette sub-schemas (see §3.4)

  # Future, not in v1
  # workflowPluginTypeagent/     # typeagent.action step type (NL authoring lives in workflowEditorAgent, §3.4)
```

Directories are **camelCase**; the `name` field in each `package.json` is **kebab-case** (e.g., the directory `workflowEditorElement/` holds a package named `workflow-editor-element`).

**Rule:** `workflowEngine` and `workflowService` must not depend on any plugin package. Plugins depend on `workflowModel` (and possibly `workflowEngine` for types) only.

---

## 6. File Formats

- **`*.workflow.json`** — Canonical persisted form. Stable, diff-friendly, schema-versioned. **This is the library's only input format** — see §3.3.
- **`*.workflow.lock.json`** _(optional)_ — Pins the plugin package versions required to execute the workflow.
- **Run records** — `~/.workflows/runs/<workflow-id>/<timestamp>.json` (path is host-configurable).

### 6.1 Sharing & Portability

A workflow is shared by sending its `.workflow.json` file. The document is self-describing for **understanding and validation**, but executing it on a fresh machine still requires four environmental things to line up. The design separates what belongs in the document from what belongs in the environment.

#### What's required to run a shared workflow

| Requirement                | Where it lives                                                      | Whose problem                                               |
| -------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Compatible engine          | `workflowEngine` package version                                    | Recipient installs it; engine has a stability policy.       |
| Required step-type plugins | Declared in the workflow as `PluginRef[]`                           | Recipient installs them; service/CLI fails fast if missing. |
| Capability bindings        | Provided by host adapter or CLI config (`StepContext.capabilities`) | Recipient configures for their environment.                 |
| Secrets                    | Resolved at runtime from env vars / secret backend                  | Recipient supplies; never present in the document.          |

#### What MUST be in the document

- Nodes, edges, bindings, control flow.
- Required step types and their plugin packages with **semver ranges**.
- Declared **inputs** and **outputs** of the workflow.
- Declared **named secrets** the workflow expects (by name only, e.g., `openai_api_key`), so a recipient knows what to provide.
- Declared **capabilities** the workflow needs (e.g., `shell`, `network`, `filesystem`), so a recipient knows what the workflow will do.

#### What MUST NOT be in the document

- Secret values (API keys, tokens, passwords).
- Machine-specific absolute paths as literals (use bindings + capabilities).
- Environment-specific URLs as literals where bindings would do (use workflow variables).
- User identity / personally-identifying information beyond authorship metadata.

#### Distribution channels (no opinion)

The project takes no position on _how_ files move. All of these work because the file is just JSON:

- Copy/paste, email attachment.
- Git-tracked alongside other code.
- Stored in a shared drive.
- Future: a registry / marketplace / hub (see "Out of scope" below).

#### Per-user vs. repo-tracked storage

The default storage location is `~/.workflows/` (per-user). Nothing prevents a user from keeping `.workflow.json` files in a git-tracked project folder; the editor treats any path the host can read/write equivalently. There is no "workspace" concept in v1.

#### Reproducibility: the lock file

`*.workflow.lock.json` (sibling of the workflow file) records the exact plugin versions, engine version, and resolved capability identifiers used when the workflow was last successfully validated. It is **optional** and **intended for repo-tracked workflows** where reproducibility matters.

#### Out of scope for v1

- Central registry / marketplace / hub.
- In-editor publish / install / search UX.
- Multi-user accounts, ACLs, comments, per-workflow permissions.
- Cross-tenant sharing or any tenancy concept.
- One-click import of remote workflows by URL.
- Workflow signing / provenance / supply-chain attestations.

Each is achievable later **without changing the document format**, provided the rules above are kept.

---

## 7. Milestones (rough)

1. **M0 — Spec & types.** Lock workflow JSON schema; define RPC contract; define engine library surface.
2. **M1 — Read-only viewer.** Render a hand-written workflow JSON on a canvas.
3. **M2 — Authoring.** Palette, drag/drop, **in-house Inspector renderer + `BindingOrLiteral` + `BindingPicker`**, save/load.
4. **M3 — Execution.** Standalone engine runs linear flows end-to-end; live progress; **`workflow` CLI runs the same workflows headlessly**; at least one real step plugin (proposal: `cmd.shell` or `http.request`) plus the `core.*` controls.
5. **M4 — Control flow.** Branch, parallel, loop, **subflow + multi-tab editing of subflows**.
6. **M5 — Polish.** Undo/redo, validation surfaces, run history (shared with CLI run records), export.
7. **M6 — Stretch.** `workflowEditorAgent` (§3.4) so the editor can be NL-driven from a TypeAgent shell's `chat-ui`. _(External trigger systems — cron, webhooks, chat invocation — are deliberately out of scope: they are separate projects that consume the engine library per §3.3.)_

---

## 8. Risks & Considerations

- **Schema evolution** — Step-type schemas change; workflows must validate or migrate. The optional `*.workflow.lock.json` captures required plugin versions.
- **Binding language** — Need a small, safe expression syntax; avoid full eval.
- **Determinism** — LLM-backed steps are non-deterministic; document and surface this.
- **Security** — Workflows can chain side-effecting steps (filesystem, shell, HTTP); consider a confirmation/dry-run mode. Plugins run in-process with no sandbox in v1.
- **Performance** — Large graphs and long histories need virtualization.
- **Cancellation** — Engine must support cooperative cancel + cleanup via `AbortSignal`.
- **Engine-as-library surface stability** — Because external consumers will depend on `runWorkflow` / `loadWorkflow`, the library's public API needs an explicit stability policy from the start (semver, deprecation windows). Breaking changes there affect everyone embedding the engine.
- **Supply-chain risk of running shared workflows** — Loading a `.workflow.json` from an untrusted source is, by itself, harmless. But running it executes the declared plugins' code with the recipient's capabilities and secrets. v1 has no plugin sandbox, no signing, and no provenance check. Treat shared workflows like shared scripts: review before running, especially on side-effecting capabilities (shell, http, filesystem). Document this clearly; consider a CLI `--dry-run` / confirmation flow as a later mitigation.
- **NL-driven edits via `workflowEditorAgent`** — When the editor is being driven by an LLM through the dispatcher, the workflow's contents are sent to that LLM. This is the agent host's policy decision (which model, which provider, what's logged), not the editor's. The editor must surface that an external session is connected and provide a clear way to disconnect it.

---

## 9. Decision Log

### Resolved

| Date       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-04-22 | Editor must support **three host surfaces** (Tauri desktop, dev web, VS Code webview) from a single core.                                                                                                                                                                                                                                                                                                                                 | Avoids forking the codebase per host; forces clean separation of UI core, host adapters, and transport.                                                                                                                                                                                                                                                             |
| 2026-04-22 | Desktop shell will be **Tauri** (not Electron).                                                                                                                                                                                                                                                                                                                                                                                           | Smaller footprint, native webview, better fit for an embeddable editor; Electron remains in `packages/shell` for the existing chat shell, independent of this project.                                                                                                                                                                                              |
| 2026-04-22 | Web target is **dev-only** (not a first-class shipped surface).                                                                                                                                                                                                                                                                                                                                                                           | Avoids taking on hosting, auth, multi-tenancy, and security review now. Architectural seams (`HostBridge`, transport-neutral `WorkflowServiceClient`) preserve the option to promote it later without rewriting the core.                                                                                                                                           |
| 2026-04-22 | Three **embedding modes** are supported: native component import, Custom Element, iframe/webview.                                                                                                                                                                                                                                                                                                                                         | Each known host maps to one mode; design rules in §3.1 keep all three viable. The public interface must not preclude any of the three.                                                                                                                                                                                                                              |
| 2026-04-22 | UI framework will be **Svelte 5** with **Svelte Flow (`@xyflow/svelte`)** for the canvas.                                                                                                                                                                                                                                                                                                                                                 | Smallest bundle for Tauri cold start; first-class Custom Element output lets the existing vanilla-TS TypeAgent UIs embed the editor with no Svelte runtime requirement on the host; Svelte stores simplify the in-memory workflow model. Trade-off accepted: thinner form-from-schema ecosystem than React; the Inspector form generator is an explicit build item. |
| 2026-04-22 | The **Custom Element wrapper** is in scope for the initial release (not deferred).                                                                                                                                                                                                                                                                                                                                                        | It is the embedding mechanism for the existing TypeAgent vanilla-TS UIs and for any future non-Svelte host; deferring it would force a redesign later.                                                                                                                                                                                                              |     | 2026-04-22 | Inspector form rendering is **built in-house** (not `@sjsf`, `jsonforms`, or `sveltekit-superforms`).     | Every editable field must wrap a `BindingOrLiteral` widget for literal-vs-binding selection; any off-the-shelf lib would require overriding every primitive widget, defeating the convenience. TypeAgent action schemas are tame plain-data shapes; v1 explicitly excludes `oneOf`/`anyOf`, `$ref`, and conditional schemas. See §4.6. |
| 2026-04-22 | Workflows are a **separate, first-class artifact**, kept distinct from TypeAgent _activities_.                                                                                                                                                                                                                                                                                                                                            | Avoid coupling the editor's data model and lifecycle to the activities subsystem; revisit interop only if a concrete need arises.                                                                                                                                                                                                                                   |     | 2026-04-22 | Execution is a **standalone workflow engine** with **pluggable `StepHandler`s**; no TypeAgent dependency. | The engine walks the graph and dispatches to registered handlers (LLM, shell, HTTP, script, future TypeAgent). Decouples the editor from TypeAgent's release cadence and lets the engine be useful in non-TypeAgent contexts. See §3.2.                                                                                                |
| 2026-04-22 | TypeAgent dispatcher integration is **deferred** to a future plugin package (tentatively `workflowPluginTypeagent`).                                                                                                                                                                                                                                                                                                                      | Not required for v1. The `StepHandler` extension surface is designed up front so this can be added without engine changes. NL authoring is a separate concern, delivered by `workflowEditorAgent` (§3.4).                                                                                                                                                           |
| 2026-04-22 | Engine is shipped as a **library** (`workflowEngine`) consuming serialized workflow JSON; **manual trigger only** in v1 (via editor UI or library call).                                                                                                                                                                                                                                                                                  | Keeps the scope tight while preserving all future integrations. External triggers (cron, webhook, FS watcher, chat, TypeAgent invocation) are not built in this project; they are _separate_ future systems that import the library and call `runWorkflow`. Engine has no I/O of its own and no dedicated daemon. See §3.3.                                         |     | 2026-04-22 | A **CLI** (`workflow`) is a first-class v1 deliverable.                                                   | Headless runner that imports the engine library directly. Validates the engine-as-library boundary from day one (no UI bias creeps into the engine), and is genuinely useful for scripting/CI. See \u00a74.7.                                                                                                                          |
| 2026-04-22 | Sharing = the `.workflow.json` file is the unit of sharing; plugin deps are declared (semver) and lockable; secrets/env-specific values are never embedded; no registry / publish-UX / multi-user features in v1.                                                                                                                                                                                                                         | Keeps the document portable and safe to share. Distribution channels (git, email, drive) are user choice; the project is opinion-free. Future registry/marketplace remains possible without changing the document format. See §6.1.                                                                                                                                 |
| 2026-04-23 | NL authoring is delivered by exposing the editor as a TypeAgent **`AppAgent`** (`workflowEditorAgent`) with fine-grained sub-schemas (`workflow.session`, `workflow.query`, `workflow.edit`, `workflow.subflow`, `workflow.run`, `workflow.palette`). The conversational UI is the existing `chat-ui` + dispatcher; the editor itself owns no LLM client. **Multi-tab / multi-session editing is required** to support subflow workflows. | Symmetric with the rest of TypeAgent; reuses dispatcher's planning, multi-turn, multi-agent capabilities; no duplicated NL infrastructure; editor remains standalone when no TypeAgent shell is present. See §3.4.                                                                                                                                                  |
| 2026-04-23 | The previously proposed in-editor `AuthoringAssistant` extension point is **superseded** and removed.                                                                                                                                                                                                                                                                                                                                     | Building NL handling inside the editor would re-implement what the dispatcher already does, force a one-shot `WorkflowPatch` contract, and bypass dispatcher planning. The agent-based design is strictly more capable.                                                                                                                                             |

### Open

_All initial open questions resolved. Next-tier items live in the Risks section above and in the milestone notes._

```

```
