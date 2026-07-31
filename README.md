# agent-status

`agent-status` is a generic local agent status standard with a small reference CLI. Core file format and validation logic stay lean. Display commands `list` and `watch` require `rich`; non-display commands like `emit`, `get`, `validate`, and `prune` work without it.

## Why a local status layer exists

Remote protocols answer remote questions. Local operators still need fast answers to a different set of questions: which agents are running here, what are they doing, and is the latest snapshot stale?

Why this needs its own standard:
- A2A is designed for remote discovery and task interaction, not workstation-local runtime visibility.
- Local operators need data that A2A does not model directly, such as process lifecycle, PID, workspace, and heartbeat freshness.
- One file per agent instance enables simple tooling: shell scripts, CLIs, watchers, and validators can all read the same shape.
- Shared writer and reader rules prevent ad hoc status files from drifting on filenames, fields, stale semantics, and shutdown behavior.
- `${XDG_STATE_HOME:-~/.local/state}` is a good fit for persistent user state that is local to a machine.

## Relation to A2A

This project is an A2A-compatible local status layer. It complements A2A rather than replacing it. It does not replace Agent Card discovery, Task APIs, or full A2A service behavior.

A2A answers, "How do agents talk to each other?" This repository answers, "What is running on this machine right now?"

See:
- `docs/agent-status-v1alpha1.md`
- `docs/a2a-compat.md`

## Install

Python 3.10+.

From PyPI:

```bash
pip install agent-status
```

### Pi extension install

Install from git:

```bash
pi install git:github.com/you/astatus
```

### OpenCode plugin install

OpenCode can load this dependency-free plugin from a local checkout. Add checkout's absolute path to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/you/src/astatus"]
}
```

Start OpenCode, then verify snapshots from another terminal:

```bash
agent-status watch
```

OpenCode runtime appears idle as soon as plugin loads, before any prompt or session exists. Session metadata attaches later to same entry; prompts/tools set `working`, question-tool and permission events set `input-required`, open todos while idle set `submitted`, and session errors transiently set `failed`. First prompt remains durable goal across resume. Session deletion keeps process snapshot; plugin disposal removes it. Child/subagent sessions are currently excluded.

### Codex CLI integration

Requires Python 3.10+, Linux or macOS, and a Codex CLI release with plugin support. Verify support with:

```bash
codex plugin --help
```

Install the status CLI and plugin marketplace:

```bash
pip install agent-status
codex plugin marketplace add julsemaan/astatus
codex plugin add agent-status@astatus
```

Start Codex in any repository, open `/hooks`, and trust the agent-status hooks. Then watch from another terminal:

```bash
agent-status watch
```

First prompt starts a detached sidecar. Sidecar emits 20-second heartbeats until `SessionEnd` or Codex process death. Integration adds no model tools or MCP server.

Upgrade or remove the plugin:

```bash
codex plugin marketplace upgrade astatus
codex plugin remove agent-status@astatus
codex plugin marketplace remove astatus
```

### Claude Code integration

Requires Python 3.10+ and Claude Code on Linux or macOS. Install marketplace plugin:

```bash
pip install agent-status
claude plugin marketplace add julsemaan/astatus
claude plugin install agent-status@astatus
```

Plugin adds hooks only: no model tools or MCP server. Hooks map prompts and ordinary tools to `working`, `AskUserQuestion`, `ExitPlanMode`, permission dialogs, and trailing assistant questions to `input-required`, active background work at turn end to `submitted`, and ordinary turn completion to task removal (reader-derived idle). Sidecar emits 20-second heartbeats and removes snapshot on session exit.

## Development

See [`docs/development.md`](docs/development.md) for local setup, Pi extension loading, tests, and builds.

## Quick start

Emit one snapshot:

```bash
RUN_ID="pi-$(python3 - <<'PY'
import uuid
print(uuid.uuid4().hex)
PY
)"

python3 -m agent_status emit \
  --agent-id "$RUN_ID" \
  --agent-name pi \
  --lifecycle running \
  --workspace "$PWD" \
  --pid $$ \
  --task-id task-123 \
  --task-state working \
  --task-summary "refactor scheduler tests" \
  --task-status-timestamp 2026-06-20T16:44:55Z
```

`agent_id` must be unique per running agent instance. Do not derive it from PID alone: sandboxed sessions can share same PID and collide. `runtime.pid` is descriptive metadata only.

List snapshots:

```bash
python3 -m agent_status list
```

Get one snapshot:

```bash
python3 -m agent_status get "$RUN_ID"
```

Watch snapshots:

```bash
python3 -m agent_status watch --interval 2
```

Prune old stale or stopped snapshots:

```bash
python3 -m agent_status prune --prune-after 86400
```

Validate a file:

```bash
python3 -m agent_status validate examples/sample-status.json
```

## Protocol summary

Default status directory:

```text
${AGENT_STATUS_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-status}
```

One running agent instance maps to one file:

```text
<agent_id>.json
```

Core required fields:
- `schema_version`
- `agent_id`
- `agent_name`
- `runtime.lifecycle`
- `runtime.updated_at`

Task state uses A2A-style values. `idle`, `stale`, and `missing` are derived by readers and are never written directly.

## JSON example

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
  "task": {
    "id": "task-123",
    "context_id": "ctx-456",
    "state": "working",
    "summary": "refactor scheduler tests",
    "status_timestamp": "2026-06-20T16:44:55Z"
  }
}
```

## CLI examples

After installation, you can also use the entry point directly:

```bash
agent-status emit --agent-id "pi-$(python3 - <<'PY'
import uuid
print(uuid.uuid4().hex)
PY
)" --agent-name pi --lifecycle running
agent-status list
agent-status get <agent-id>
agent-status watch
agent-status prune --prune-after 86400
agent-status validate examples/sample-status.json
```

## Writer rules

- Write the whole file atomically.
- `agent_id` must be unique per running instance. PID-only IDs like `pi-12345` are unsafe under PID namespaces or sandboxes.
- Use an absolute workspace path when it is known.
- Update on lifecycle changes, task changes, summary changes, and heartbeats.
- Send a heartbeat every 15 to 30 seconds.
- On clean exit, either remove the file or persist `runtime.lifecycle=stopped`.
- If you use temp files for atomic writes, temp names need random or OS-guaranteed uniqueness. Do not rely on PID suffixes.

## Stale semantics

The default `stale_after` value is 60 seconds.

A reader marks a record as stale when:

```text
now - runtime.updated_at > stale_after
```

If `runtime.lifecycle=running` and there is no `task`, a reader may render the agent as `idle`.

A stale file is not definitive proof that the writer is gone permanently. The agent may be crashed, suspended, disconnected, or simply slow. Readers should mark records as stale rather than deleting them silently. Cleanup is a separate operator policy.

The reference CLI provides explicit cleanup:

```bash
agent-status prune --prune-after 86400
```

The default prune policy removes snapshots older than 24 hours if they are already stale, along with older snapshots whose `runtime.lifecycle` is `stopped`.

## Validation

Run tests:

```bash
python3 -m unittest
```

Validate examples:

```bash
python3 -m agent_status validate examples/sample-status.json
python3 -m agent_status validate examples/a2a-linked-status.json
```

## Roadmap

Possible future additions:
- HTTP exporter
- registry bridge
- richer TUI or shell integrations

Out of scope for now:
- registry server
- full A2A server
- orchestration layer
- history store
