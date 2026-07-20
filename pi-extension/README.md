# pi-extension

Pi extension package for `agent-status/v1alpha1`.

Structure follows `ponytail` pattern:
- repo root `package.json` exports pi resources
- `pi-extension/index.js` holds extension entrypoint
- `pi-extension/package.json` holds dev-local test script

## Install

From repo root:

```bash
pi install /path/to/astatus
# or
pi install git:github.com/you/astatus
```

Do not install `./pi-extension` path itself. That directory is dev-local test harness, not package root.
After install in running pi session, run `/reload` or restart pi.

Pi loads `./pi-extension/index.js` via root `package.json` `pi.extensions` manifest.

Current extension supports durable `goal` persistence plus optional bridge override via `agent-status:profile`. Bridge producer not shipped in this repo.

When pi starts inside tmux, the extension automatically emits paired `x_meta.tmux_socket` and `x_meta.tmux_pane` values from `TMUX` and `TMUX_PANE`. Missing or malformed values omit both fields. After installing or upgrading the extension, run `/reload` or restart pi so the new emitter code loads.
