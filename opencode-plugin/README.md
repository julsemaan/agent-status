# agent-status OpenCode plugin

Dependency-free OpenCode plugin that writes local [agent-status](https://github.com/julsemaan/astatus) snapshots.

## Install

Add package name to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["agent-status"]
}
```

Start OpenCode. Plugin reports working, input-required, submitted, failed, and idle states under `${AGENT_STATUS_DIR:-${XDG_STATE_HOME:-~/.local/state}/agent-status}`.

Install Python CLI separately to inspect snapshots:

```bash
pip install agent-status
agent-status watch
```

## License

Apache-2.0
