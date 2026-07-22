# Agent-Status Emitter Extension — Requirements

Requirements for building an agent framework extension that emits
`agent-status/v1alpha1` conformant snapshots. Framework-agnostic: applies to
pi, Codex, Claude Code, Aider, or any agent runtime that can host extensions.

Reference implementations: `pi-extension/index.js` (pi) and `codex-plugin/emitter.py` (Codex CLI).

Codex mapping: `SessionStart` creates idle snapshot; prompt and tool hooks set `working`; `PermissionRequest` sets `input-required`; `Stop` clears task; `SessionEnd` removes snapshot. Goal survives resume and compact but resets on clear.

Codex limits: first prompt may trigger lazy session start; plain assistant questions lack reliable waiting hook; permission state may last until `PostToolUse`; Windows and subagent snapshots are deferred.

## 1. Scope

This spec defines what an emitter extension MUST do to produce valid
`agent-status/v1alpha1` snapshots. It covers:

- Schema conformance for emitted JSON
- File lifecycle (create, update, heartbeat, shutdown)
- Session identity and deduplication
- Task state management
- Framework integration patterns (event hooks, tool registration)

Out of scope:

- Reader/consumer behavior (see `docs/agent-status-v1alpha1.md`)
- Cross-host synchronization
- Registry servers or A2A protocol compliance
- UI rendering of status data

## 2. Terminology

| Term | Meaning |
|------|---------|
| **emitter** | The extension code that writes status files |
| **host** | The agent runtime framework (pi, Codex, etc.) |
| **session** | A running conversation or task context within the host |
| **snapshot** | One JSON file conforming to `agent-status/v1alpha1` |
| **status directory** | The directory containing snapshot files |
| **bridge** | An optional secondary data source that overrides or augments the emitter's own state (e.g., profile-side metadata) |

## 3. Schema Conformance

### 3.1 Required Fields

Every emitted snapshot MUST include:

```
schema_version  = "agent-status/v1alpha1"
agent_id        = <string, unique per running instance>
agent_name      = <string, human-readable agent name>
runtime.lifecycle  = "running" | "stopped" | "unknown"
runtime.updated_at = <ISO 8601 UTC timestamp, Z suffix>
```

### 3.2 Optional Fields

The emitter SHOULD populate when available:

```
runtime.pid            = <integer, process ID, descriptive only>
runtime.workspace      = <string, absolute path>
runtime.last_activity_at = <ISO 8601 UTC, last meaningful work>
goal                   = <object, durable session intent>
task                   = <object, current task state>
x_meta                 = <object, extension-specific metadata>
```

### 3.3 Goal Object

If a goal exists:

```
goal.summary           = <string, concise session intent>
goal.updated_at        = <ISO 8601 UTC>
goal.source            = "initial-prompt"
```

Rules:
- `goal` captures session-level durable intent.
- `goal` MAY persist across idle turns.
- First prompt in session SHOULD seed `goal`.

### 3.4 Task Object

If a task exists:

```
task.state             = one of: submitted, working, input-required,
                         auth-required, completed, canceled, rejected,
                         failed, unknown
task.summary           = <string, ≤120 chars recommended>
task.status_timestamp  = <ISO 8601 UTC>
task.id                = <string, optional, aligns with A2A task id>
task.context_id        = <string, optional, session/context identifier>
```

Rules:
- `task.state` MUST NOT be `idle`. Idle is a reader-derived state.
- When no task is active, the `task` key SHOULD be absent (not null, not empty object).
- A reader derives `idle` from `runtime.lifecycle=running` + missing `task`.
- Retained session purpose MUST NOT be encoded by keeping `task.state = "submitted"` after `agent_end`.

### 3.5 Schema Version

`schema_version` MUST be the exact string `"agent-status/v1alpha1"`. This is
a const, not a semver range. Breaking changes require a new schema version
string.

## 4. File Lifecycle

### 4.1 File Location

Default status directory:

```
${AGENT_STATUS_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-status}
```

The emitter SHOULD respect this convention. The emitter MAY allow override
via environment variable (`AGENT_STATUS_DIR`).

### 4.2 Filename

```
<agent_id>.json
```

`agent_id` MUST be filename-safe. The emitter SHOULD sanitize by replacing
non-alphanumeric characters (except `._-`) with `-` and stripping leading/trailing `-`.

### 4.3 Atomic Writes

The emitter MUST write snapshots atomically:

1. Write to a temporary file in the same directory.
2. Temp filename MUST use random or OS-guaranteed uniqueness (UUID, `/dev/urandom`).
   MUST NOT use PID as uniqueness key.
3. `fsync` the temp file before rename.
4. Rename temp file to final path.

This prevents readers from seeing partial writes.

### 4.4 Directory Creation

The emitter MUST create the status directory if it does not exist, using
recursive creation (`mkdir -p` equivalent).

## 5. Session Identity

### 5.1 agent_id Uniqueness

`agent_id` MUST be unique per running agent instance. The emitter MUST NOT
derive `agent_id` from PID alone. PID-based IDs are unsafe under:

- PID namespaces (containers, sandboxes)
- Multiple sessions sharing a process
- Rapid restart reusing PIDs

Recommended scheme: `<agent-prefix>-<random-uuid-hex>` (e.g.,
`pi-7d5d6ca5e54c44cfb9e8d5acfd3c71a1`).

### 5.2 One Instance Per Session

Each session maps to exactly one snapshot file. The emitter MUST NOT write
multiple files for the same session.

### 5.3 Deduplication

If the host framework can invoke the extension factory multiple times for the
same session (e.g., reload, hot-reload), the emitter MUST deduplicate. Options:

- **Session key**: Use a stable session identifier (session file path, session
  ID) to detect duplicate startups.
- **Owner token**: Use a random token per factory invocation; only the first
  invocation per session key owns the file.

The reference implementation uses a global `Map<sessionKey, ownerToken>` to
prevent duplicate writes across reload or multiple extension instances.

## 6. Lifecycle Events

The emitter MUST hook into host framework lifecycle events. The following
table maps abstract events to required behavior. Host-specific names vary;
the semantics are universal.

### 6.1 Required Event Hooks

| Abstract Event | When It Fires | Emitter Action |
|---|---|---|
| `session_start` | Session begins (startup, new, resume, fork) | Ensure stable unique `agent_id` exists for this extension instance, create initial snapshot with `lifecycle=running`, start heartbeat |
| `before_agent_start` | User prompt submitted, before agent loop | Set task from prompt summary (cheap fallback) |
| `agent_end` | Agent loop finished for current prompt | Clear core task, update `updated_at` |
| `session_shutdown` | Session ending (quit, reload, new, fork) | Stop heartbeat, remove snapshot file OR persist `lifecycle=stopped` |
| `tool_execution_start` | Tool begins executing | Update `runtime.last_activity_at` |
| `tool_execution_end` | Tool finishes executing | Update `runtime.last_activity_at` |

### 6.2 Optional Event Hooks

| Abstract Event | Purpose |
|---|---|
| `turn_start` / `turn_end` | Fine-grained turn tracking |
| `message_start` / `message_end` | Message lifecycle |
| `model_select` | Track active model in `x_meta` |
| Custom bridge event | Override task state from external source |

### 6.3 Event Handler Contracts

- `session_start` handlers MUST be idempotent. Multiple calls for the same
  session MUST NOT create duplicate files or overwrite an existing owner's file.
- `session_shutdown` handlers MUST clean up: stop timers, release session
  ownership, remove the status file.
- `before_agent_start` handlers MUST seed `task` from prompt summary and SHOULD seed `goal` from first prompt in session.
- `agent_end` handlers MUST clear the core task (task derived from prompt).
  Bridge-derived tasks MAY survive `agent_end`.

## 7. State Catalog

All possible states an emitter may produce, with semantics and when each
applies.

### 7.1 Runtime Lifecycle States

`runtime.lifecycle` represents process/session health, not work progress.

| State | Meaning | When to Use
|-------|---------|-------------
| `running` | Agent session is active | Session started, process alive, heartbeat ticking
| `stopped` | Agent exited cleanly | Clean shutdown, final snapshot persisted
| `unknown` | Cannot determine runtime state | Agent is a subprocess, sandboxed, or health is opaque

The emitter SHOULD set `running` on session start and `stopped` on clean
shutdown. Use `unknown` only when the emitter genuinely cannot determine
process health (e.g., the agent runs in a container the emitter cannot
inspect).

### 7.2 Task States

`task.state` represents work progress within the current agent turn.

| State | Meaning | Reader Interpretation
|-------|---------|----------------------
| `submitted` | Work queued, not yet started | Agent has real pending work but is not actively processing
| `working` | Agent actively processing | LLM is generating, tools are executing, work is in flight
| `input-required` | Waiting for user input | Agent asked a question, needs confirmation, or is blocked on user action
| `auth-required` | Waiting for authentication | Agent needs OAuth, API key, credential, or permission grant
| `completed` | Task finished successfully | Agent finished requested work without error
| `canceled` | Task was canceled | User or system canceled before completion
| `rejected` | Task was rejected | Agent or system refused task (e.g. safety gate)
| `failed` | Task failed with error | Agent encountered unrecoverable error
| `unknown` | Cannot determine task state | State is unclear or in transition

Framework note: schema allows full enum above. Each host integration only emits subset it can verify reliably.
Reference pi extension in this repo currently verifies `working` directly, `submitted` and `input-required` via optional bridge data, derives idle by omitting `task`, and removes snapshot on shutdown. Direct in-tree support for `tool_call`, `completed`, `failed`, and `auth-required` is not present.

### 7.3 Derived States (Read-Side Only)

These are NEVER written by emitters. Readers derive them from the snapshot.

| State | Derivation | Meaning
|-------|-----------|--------
| `idle` | `runtime.lifecycle=running` + no `task` key | Agent is alive but not working on anything
| `stale` | `now - runtime.updated_at > stale_after` (default 60s) | Agent may be dead or suspended; last heartbeat is too old
| `missing` | Expected file not found in status directory | Agent was expected but has no snapshot

The emitter MUST NOT write `idle`, `stale`, or `missing` into `task.state`
or `runtime.lifecycle`. These are reader-computed values.

### 7.4 State Transition Diagram

```
                           session_start
                               │
                               ▼
              ┌──────────── running ────────────┐
              │                                  │
              │  before_agent_start              │
              │       │                          │
              │       ▼                          │
              │    working ──────┐               │
              │       │         │               │
              │       │    agent_end             │
              │       │         │               │
              │       ▼         ▼               │
              │   (no task) ◄────┘    session_shutdown
              │    = idle                      │
              │                                ▼
              │                           stopped
              └──────────────────────────────────

  Special states during working:

    working ──[question tool]──► input-required ──[user answers]──► working
    working ──[auth tool]──────► auth-required ──[auth granted]──► working
    working ──[error]──────────► failed
    working ──[user cancel]────► canceled
    working ──[safety gate]────► rejected
    working ──[done]───────────► completed ──► agent_end
```

### 7.5 State Accuracy Requirements

The emitter MUST reflect the agent's actual state, not a desired state.
Specifically:

- When the agent is waiting for user input, `task.state` MUST be
  `input-required`, not `working`.
- When the agent has finished processing and is idle, the `task` key MUST be
  absent (derived `idle`), not `completed` and not synthetic `submitted`.
  `completed` is transient and should be cleared at `agent_end`.
- When the agent is executing tools (file writes, shell commands, API calls),
  `task.state` MUST be `working`.
- The emitter MUST NOT hold `completed` or `failed` beyond the current agent
  turn. These are transient: they should be set during the turn and cleared
  at `agent_end`.

## 8. Harness Event Mapping

How to detect each state from common agent harness events. The emitter
author MUST map their target harness's events to these abstract states.

### 8.1 Mapping Table

| Desired State | Detection Signal | Host Event (pi) | Host Event (Codex) | Host Event (Claude Code)
|---|---|---|---|---
| `running` | Session begins | `session_start` | Session init | Session init
| `working` | Prompt submitted, agent loop starting | `before_agent_start` | User message received | User message received
| `working` | Tool executing | `tool_execution_start` | Tool call begin | Tool call begin
| `input-required` | Waiting for user input | optional bridge event such as `agent-status:profile` | Permission prompt shown | Permission prompt shown
| `auth-required` | Auth/OAuth flow triggered | host-specific integration needed | OAuth redirect | OAuth redirect
| `submitted` | Real pending work while idle | optional bridge event such as `agent-status:profile` | Queued task signal | Queued task signal
| (no task) | Agent idle, turn ended | `agent_end` | Idle state | Idle state
| `stopped` | Session shutting down | `session_shutdown` | Session teardown | Session teardown

### 8.2 Detecting `input-required`

This is the most important state to get right. A common failure mode is
reporting `working` when the agent is actually blocked on user input.

**Signals that indicate `input-required`:**

- The agent called a tool that prompts the user for a choice (question,
  confirm, select, input).
- The agent called a tool that is blocked on user approval (permission gate,
  destructive action confirmation).
- The host framework shows a permission dialog or approval prompt.
- The agent explicitly asked the user a question in its response.

**Detection strategies by harness type:**

| Harness Type | Strategy |
|---|---|
| **Extension-based** (pi) | Prefer host-supported state signal or bridge event over tool-name heuristics. Current in-repo pi extension uses bridge data instead of direct `tool_call` interception. |
| **Event-emitting** (Codex) | Listen for permission prompt or user approval events.
These are explicit signals the agent is waiting. |
| **Log-parsing** | Watch for output patterns indicating a prompt: `?`, `(y/n)`,
`Select:`, `Confirm:`. Less reliable; prefer event-based detection. |
| **Bridge/external** | A profile-side bridge can observe the agent's internal state
and emit `input-required` via a custom event (e.g., `agent-status:profile`).
This is the most reliable approach when the harness exposes rich state. |

**Timing:**

The emitter SHOULD set `input-required` as soon as the blocking tool call is
detected, not after a timeout. When the user responds and the tool call
resumes, the emitter SHOULD transition back to `working`.

**Reference implementation pattern (pi):**

The pi extension uses optional bridge event `agent-status:profile` from
profile-side integration code outside this repo. That bridge can set
`task.state = "input-required"` with summary like `"Waiting for user input"`.
This survives `agent_end` because agent is genuinely waiting — it has not
finished turn.

### 8.3 Detecting `working` vs `idle`

| Condition | State |
|---|---|
| Agent loop is active (generating, calling tools) | `working` — task present |
| Agent loop finished, no pending tool calls | No task — derived `idle` |
| Agent loop finished, but bridge says open todos remain | `submitted` — task present |
| Agent loop finished, no bridge-reported pending work | No task — derived `idle` |
| Heartbeat ticking, no task, no activity | No task — derived `idle` |

The emitter MUST NOT report `working` when the agent is idle. The most
common bug: setting `working` at `before_agent_start` and forgetting to
clear it at `agent_end`.

### 8.4 Detecting `submitted`

`submitted` means work is queued but not actively processing. Use cases:

- Agent has open todos (from bridge) but is currently idle.
- Agent received a follow-up message that is queued for next turn.
- Agent is waiting for a sub-agent or background task to complete.

Do not use `submitted` to preserve session intent after work finished. That belongs in `goal`.

The emitter SHOULD set `submitted` when:
- A bridge reports pending work items (open todo count > 0).
- Host exposes real queued-work signal.

### 8.5 Detecting `auth-required`

Signals:
- Agent initiated an OAuth flow.
- Agent requested an API key or credential.
- Host framework shows an authentication dialog.

If the harness does not distinguish auth from general input, the emitter
MAY use `input-required` as a fallback. Correct specificity is better but
not blocking.

### 8.6 Multi-Turn State Persistence

Some states must survive across agent turns within a session:

| State | Persists across turns? | Reason |
|---|---|---|
| `working` | No | Transient — set per prompt, cleared at `agent_end` |
| `input-required` | Yes | Agent may be waiting across turns (question blocked) |
| `submitted` | Yes | Real pending work persists |
| `completed` | No | Transient — cleared at `agent_end` |
| `failed` | No | Transient — cleared at `agent_end` |
| `goal` | Yes | Session intent may outlive active turns |

Reference pattern: separate `goal` (first-prompt durable intent), `coreTask`
(prompt-derived current turn, cleared at `agent_end`), and `bridgeData`
(external integration data, persists until replaced). Bridge task state may
survive `agent_end`; core task does not.

### 8.7 State Transition Rules

The emitter MUST follow these transition rules:

1. **`session_start` → `running`**: Always. No task.
2. **`before_agent_start` → `working`**: Set task from prompt summary.
3. **Tool call (question/confirm) → `input-required`**: Override task state.
4. **Tool result (user answered) → `working`**: Resume previous state.
5. **`agent_end` → no task**: Clear core task. Bridge task may survive.
6. **`session_shutdown` → `stopped` or removed**: Final state.

Illegal transitions (emitter MUST NOT produce):
- `completed` → `working` (completed is terminal for the turn)
- `idle` as a written state (idle is derived, not written)
- Any state → `stale` (stale is reader-computed)

## 9. Heartbeat

### 9.1 Interval

The emitter MUST send a heartbeat every 15–30 seconds. Recommended: 20
seconds.

A heartbeat updates `runtime.updated_at` to the current time and writes the
snapshot.

### 9.2 Timer Management

- The heartbeat timer SHOULD be started on `session_start` and stopped on
  `session_shutdown`.
- The timer SHOULD be detached (`unref()` in Node.js) so it does not prevent
  process exit.
- The emitter MUST NOT stack multiple heartbeat timers for the same session.

### 9.3 Last Activity

The emitter SHOULD track `runtime.last_activity_at` separately from
`runtime.updated_at`. `last_activity_at` reflects the last meaningful work
(tool execution, agent activity), while `updated_at` reflects the last
heartbeat.

## 10. Task State Management

### 10.1 Task Sources

The emitter may receive task state from multiple sources:

1. **Goal (first-prompt derived)**: Set from first prompt in session.
   Persists across idle turns until session reset.
2. **Core (prompt-derived)**: Set from current user's prompt text at
   `before_agent_start`. Cleared at `agent_end`.
3. **Bridge (external)**: Override from an external data source (profile
   sidecar, status bridge). May persist across agent turns.

### 10.2 Priority Rules

When both sources are present:

- Bridge task OVERRIDES core task (bridge has higher priority).
- When bridge task is absent, fall back to core task.
- When both are absent, `task` key is absent (idle state).
- `goal` is independent of task priority and persists until session reset.

### 10.3 LLM Summarization (Optional)

The emitter MAY use an LLM to generate a better task summary from the prompt.
If doing so:

- Use a cheap/fast model for summarization.
- Fall back to a truncation-based summary immediately; update with LLM result
  asynchronously.
- Use fallback summary immediately; refine asynchronously when available.
- Guard async updates so older prompt summaries cannot overwrite newer `task.summary`.
- `goal` refinement SHOULD apply only to first prompt in session.
- LLM summarization failure MUST NOT block or break the emitter.

### 10.4 x_meta

`x_meta` is an extension object for additive metadata. Emitters MAY combine bridge metadata with validated local environment metadata.

For tmux metadata:

- Read the socket path from `TMUX`, whose format is `<socket>,<server-pid>,<session-index>`. Parse the final two comma-delimited numeric fields so socket paths may contain commas.
- Read the pane identifier from `TMUX_PANE` and require it to match `^%\d+$`.
- Emit `x_meta.tmux_socket` and `x_meta.tmux_pane` only as a validated pair.
- Environment-derived tmux values override bridge values.
- If either environment value is missing or malformed, omit both tmux keys, including tmux keys supplied by the bridge. The local environment is authoritative because bridge data cannot safely correlate a pane without the socket.

Other bridge-provided `x_meta` keys MUST survive this merge. Remove `x_meta` when no metadata remains; do not emit an empty object.

## 11. Shutdown Behavior

The emitter MUST handle two shutdown patterns:

1. **Clean removal**: Delete the snapshot file. Preferred for ephemeral agents.
2. **Persisted stop**: Set `runtime.lifecycle=stopped` and write final snapshot.
   Preferred for agents where post-mortem inspection is useful.

The choice is implementation-defined. The reference implementation removes the
file on clean exit.

### 11.1 Shutdown Guarantees

- Heartbeat MUST be stopped before file removal.
- Session ownership MUST be released.
- The status file MUST NOT be left behind with `lifecycle=running` after the
  process exits.

## 12. Framework Integration

### 12.1 Extension Entry Point

The emitter MUST export a factory function that receives the host's extension
API. The factory may be synchronous or async.

```typescript
// Pi-style
export default function (pi: ExtensionAPI) { ... }

// Generic pseudocode
function createExtension(host: HostAPI) { ... }
```

### 12.2 Guard Against Double-Load

If the host can load the same extension module multiple times (hot reload,
multiple import paths), the emitter MUST guard against double-initialization.
Use a module-level symbol, boolean flag, or owner token.

### 12.3 Background Resources

The emitter MUST NOT start background resources (timers, sockets, file
watchers) from the factory function. Defer to `session_start` or the first
event that needs them. This prevents resource leaks when the host loads the
extension without starting a session.

### 12.4 Dependencies

- The emitter SHOULD use minimal dependencies. Node.js stdlib (`fs`, `path`,
  `crypto`, `os`) is sufficient for file I/O and ID generation.
- If the host provides AI utilities (for LLM summarization), the emitter MAY
  use them but MUST NOT require them (graceful fallback).
- The emitter MUST NOT add npm dependencies for what stdlib provides.

## 13. Validation

### 13.1 JSON Schema

Emitted snapshots MUST validate against `schema/agent-status-v1alpha1.schema.json`.

### 13.2 Test Requirements

The emitter SHOULD include tests covering:

1. **Status directory resolution**: Correct directory from env vars and defaults.
2. **Record construction**: `buildBaseRecord` produces valid minimal record.
3. **Agent ID uniqueness**: Generated IDs are unique across calls.
4. **File atomicity**: Writes produce parseable JSON; concurrent writes don't corrupt.
5. **Temp path uniqueness**: Temp files use random suffixes, not PID.
6. **Task lifecycle**: Task added, updated, cleared correctly.
7. **Runtime updates**: Fields patched correctly, `updated_at` bumped.
8. **Session deduplication**: Duplicate `session_start` events don't create extra files.
9. **Shutdown cleanup**: File removed, heartbeat stopped, ownership released.
10. **Bridge composition**: Bridge overrides core task; absent bridge falls back.
11. **Agent end behavior**: Core task cleared; bridge task survives.
12. **Tmux metadata**: Valid environment pair overrides bridge tmux keys; missing or malformed pair omits both keys while preserving unrelated bridge metadata.

### 13.3 Test Framework

Use the host's standard test runner. For Node.js: `node:test` +
`node:assert/strict` (no external test framework required).

## 14. Reference Implementation Notes

The canonical implementation is `pi-extension/index.js`. Key patterns:

| Pattern | Implementation |
|---|---|
| Atomic write | UUID temp file → fsync → rename |
| Session dedup | Global `Map<sessionKey, ownerToken>` via `Symbol.for()` |
| Double-load guard | `Symbol.for("agent-status.pi-extension.loaded")` on `pi` object |
| Task composition | `goal` (first prompt) + `coreTask` (current prompt) + `bridgeData` (external) → `flush()` merges |
| Heartbeat | `setInterval` at 20s, `.unref()`'d, cleared on shutdown |
| LLM summary | Background `llmSummarize()` with cached result, non-blocking fallback |
| Idempotent handlers | `enabled` flag gates all writes; `releaseSession()` cleans ownership |

## 15. Compliance Checklist

An emitter is conformant when:

- [ ] Emits valid `agent-status/v1alpha1` JSON
- [ ] `agent_id` unique per instance (not PID-based)
- [ ] Atomic writes with random temp filenames
- [ ] Heartbeat every 15–30 seconds
- [ ] File removed or marked stopped on clean shutdown
- [ ] Session deduplication across reload/double-load
- [ ] Task state follows priority rules (bridge > core > absent)
- [ ] Goal state persists across idle turns but resets on new session
- [ ] No background resources leaked on factory load
- [ ] `runtime.workspace` uses absolute path when known
- [ ] Timestamps are ISO 8601 UTC with `Z` suffix
