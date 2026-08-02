# agent-status Pi extension

Pi package for `agent-status/v1alpha1`.

## Install

Preferred npm package:

```bash
pi install npm:agent-status-pi
```

Git alternative:

```bash
pi install git:github.com/julsemaan/agent-status
```

For local development from a checkout, install the repository root:

```bash
pi install /path/to/agent-status
```

After install in a running pi session, run `/reload` or restart pi.

The extension supports durable `goal` persistence plus optional bridge override via `agent-status:profile`. Bridge producer is not shipped in this repo.

When pi starts inside tmux, the extension automatically emits paired `x_meta.tmux_socket` and `x_meta.tmux_pane` values from `TMUX` and `TMUX_PANE`. Missing or malformed values omit both fields. After installing or upgrading the extension, run `/reload` or restart pi so new emitter code loads.
