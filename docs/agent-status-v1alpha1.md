# agent-status/v1alpha1

## Motivation

`agent-status/v1alpha1` exists because local agent operations need one cheap, shared way to answer questions that remote protocols do not answer well: which agents are running here, what they are doing, which workspace they are attached to, and whether their latest signal is stale.

Why standardize this instead of letting each tool invent its own file:
- A2A focuses on remote discovery and task interaction, not local process visibility.
- Local operators and scripts need runtime metadata such as lifecycle, PID, workspace, heartbeat time, and the current task summary.
- A shared file contract lets emitters, readers, watchers, and validators interoperate without bespoke adapters.
- Reader-derived states such as `idle`, `stale`, and `missing` should have consistent meanings.
- A forward-compatible schema is cheaper than maintaining many slightly different local JSON files.

The storage choice follows normal host conventions: `${XDG_STATE_HOME:-~/.local/state}` is intended for persistent user-specific state, which makes it a better fit for live status snapshots than config directories or shared data directories.

## Scope

`agent-status/v1alpha1` defines a local snapshot file for live agent runtime, optional durable session goal, and optional current task state. Its goal is cheap local discovery, inspection, and lightweight tooling.

This standard covers:
- file location
- filename rules
- JSON payload shape
- runtime lifecycle semantics
- task status semantics
- writer and reader behavior
- stale handling
- forward compatibility

## Non-goals

Out of scope:
- tmux orchestration or navigation
- registry server
- full A2A server
- orchestration layer
- task history store
- cross-host synchronization

## File location rules

Default status directory:

```text
${AGENT_STATUS_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-status}
```

Reason: status files represent live runtime state, not shared application data. They should survive process restarts long enough to remain useful to local tooling, but they are not durable records or portable user data.

Writers MAY allow an override. Readers SHOULD default to the same directory.

## Filename rules

Each running agent instance maps to one file.

Filename:

```text
<agent_id>.json
```

`agent_id` SHOULD be filename-safe within local filesystem conventions.

This model supports multiple simultaneous sessions of the same agent family by using distinct `agent_id` values.

`agent_id` MUST be unique per running instance. PID-only schemes like `pi-12345` are not safe under PID namespaces, containers, or sandboxes where different sessions can report same PID. `runtime.pid` is descriptive metadata, not uniqueness key.

## Full JSON example

```json
{
  "schema_version": "agent-status/v1alpha1",
  "agent_id": "pi-7d5d6ca5e54c44cfb9e8d5acfd3c71a1",
  "agent_name": "pi",
  "runtime": {
    "lifecycle": "running",
    "updated_at": "2026-06-20T16:45:00Z",
    "last_activity_at": "2026-06-20T16:44:52Z",
    "pid": 12345,
    "workspace": "/home/julien/src/project"
  },
  "goal": {
    "summary": "refactor scheduler tests",
    "updated_at": "2026-06-20T16:44:50Z",
    "source": "initial-prompt"
  },
  "task": {
    "id": "task-123",
    "context_id": "ctx-456",
    "state": "working",
    "summary": "update flaky scheduler assertions",
    "status_timestamp": "2026-06-20T16:44:55Z"
  },
  "a2a": {
    "agent_card_url": "http://127.0.0.1:8711/.well-known/agent-card.json",
    "service_url": "http://127.0.0.1:8711/a2a"
  },
  "x_meta": {
    "branch": "main",
    "tmux_socket": "/tmp/tmux-1000/default",
    "tmux_pane": "%3"
  }
}
```

## Required and optional fields

Required top-level fields:
- `schema_version`
- `agent_id`
- `agent_name`
- `runtime`

Required runtime fields:
- `runtime.lifecycle`
- `runtime.updated_at`

Optional fields:
- `runtime.last_activity_at`
- `runtime.pid`
- `runtime.workspace`
- `goal`
- `task`
- `a2a`
- `x_meta`

### Field notes

- `schema_version`: exact string `agent-status/v1alpha1`
- `agent_id`: unique local identifier for one running agent instance
- `agent_name`: human-recognizable agent or program name
- `runtime.updated_at`: timestamp of the latest heartbeat or state update
- `runtime.last_activity_at`: time of the last meaningful work activity, if known
- `runtime.workspace`: absolute path preferred
- `goal`: durable session-level intent snapshot, usually seeded from first prompt
- `task`: current turn or currently queued unit of work
- `x_meta`: extension object for additive local metadata
- `x_meta.tmux_socket`: optional tmux server socket path
- `x_meta.tmux_pane`: optional tmux pane identifier matching `^%\d+$`

The tmux fields MUST be emitted as a pair or omitted together. They identify the local pane but do not define navigation, orchestration, or process correlation behavior.

## Runtime lifecycle model

`runtime.lifecycle` represents process or session health, not work progress.

Allowed values:
- `running`
- `stopped`
- `unknown`

Semantics:
- `running`: the agent session is believed to be active
- `stopped`: the agent stopped cleanly or a final snapshot was persisted after exit
- `unknown`: the writer cannot determine runtime state confidently

## Goal model

If `goal` exists, it captures durable session intent that may outlive active turns.

Required goal fields:
- `goal.summary`
- `goal.updated_at`
- `goal.source`

Rules:
- `goal` is session-level purpose, not turn-level progress
- `goal.source="initial-prompt"` means writer seeded goal from first prompt in session
- `goal` MAY persist while agent is otherwise idle
- retained session purpose MUST NOT be encoded by keeping `task.state="submitted"`

## Task model

If `task` exists, `task.state` uses A2A-style values:
- `submitted`
- `working`
- `input-required`
- `auth-required`
- `completed`
- `canceled`
- `rejected`
- `failed`
- `unknown`

Rules:
- `idle` is not a valid `task.state`
- a reader MAY derive `idle` from `runtime.lifecycle=running` plus a missing `task`
- `task` represents current turn work or real queued work only
- retained session purpose belongs in `goal`, not `task.state="submitted"`
- `task.id` and `task.context_id` align with A2A task concepts when available
- `task.status_timestamp` records the timestamp of the current task state

## Writer rules

Reference writer behavior:
1. Write the whole file atomically using a temporary file and rename.
2. Call `fsync` before rename when practical.
3. Create the status directory if it does not exist.
4. Use an absolute workspace path when populating `runtime.workspace`.
5. Use `agent_id` value unique per running instance. Do not reuse PID as identity.
6. First prompt in session SHOULD seed `goal`; later prompts SHOULD update `task` without replacing `goal`.
7. Update the file on lifecycle changes, goal changes, task changes, summary changes, and heartbeat intervals.
8. Send a heartbeat every 15 to 30 seconds.
9. On clean exit, a writer MAY remove the file or MAY persist a final snapshot with `runtime.lifecycle=stopped`.
10. Temporary filenames used for atomic writes SHOULD use random or OS-guaranteed uniqueness, not PID suffixes.
11. Writers SHOULD emit UTC timestamps with a `Z` suffix.

## Reader rules

Reference reader behavior:
1. Scan the status directory for `*.json`.
2. Ignore invalid JSON files and surface a warning.
3. Validate core required fields before use.
4. Parse timestamps as ISO 8601 / RFC3339-style timestamps.
5. Use a default stale threshold of 60 seconds.
6. Mark a record stale when `now - runtime.updated_at > stale_after`.
7. If `runtime.lifecycle=running` and there is no `task`, derive `idle`.
8. Unknown future fields MUST be ignored by read-only tools.
9. Tools that rewrite existing payloads SHOULD preserve unknown fields.
10. Reference readers that validate `task.state` against this enum MUST ignore invalid records with a warning instead of crashing.
11. Readers MUST support both shutdown patterns: removed file and persisted `stopped` snapshot.
12. Readers SHOULD NOT silently delete stale snapshots during normal reads. Retention cleanup is a separate policy.

## Stale semantics

`stale` is derived by readers, not written by writers.

A reader MAY derive:
- `idle`
- `stale`
- `missing`

These values MUST NOT be written into `task.state` or `runtime.lifecycle` to represent derived read-side conditions.

`missing` usually means an expected file is absent. The exact policy is left to the reader.

Stale entry handling rule:
- A stale snapshot remains readable evidence; it is not automatically treated as garbage.
- Readers mark a snapshot as stale before any cleanup is considered.
- Cleanup, if desired, should be an explicit prune policy based on retention age.
- The reference default retention policy prunes snapshots older than 24 hours when they are already stale, along with older `stopped` snapshots.

Reason: automatic deletion in the read path can race with slow or suspended agents and removes useful debugging signal.

## Forward compatibility

Compatibility posture:
- unknown fields allowed
- additive optional fields allowed
- `x_meta` reserved for extensions
- readers ignore fields they do not understand

Versioning rule:
- breaking contract changes require a new schema version string
- additive optional fields within `v1alpha1` are allowed

## Local-only posture

This file format is a local snapshot layer. It can complement remote task or discovery protocols, but it does not define transport, multi-agent coordination, or remote execution semantics.

That split is deliberate: remote protocols should stay focused on interoperability, while this file stays focused on low-cost workstation-local observability.
