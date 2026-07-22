# Development guide

## Set up Python

Python 3.10 or newer is required.

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
```

Alternatively, use Devbox:

```bash
devbox shell
python -m pip install -e .
```

Devbox uses the same `.venv` path through `VENV_DIR=.venv`.

## Use the local Pi extension

The Pi package is exported by the repository root `package.json`. Do not install `./pi-extension` directly; that directory is the development test harness.

Pi persists installed packages in `~/.pi/agent/settings.json` and loads them again on startup. Before developing the extension locally, remove this entry from the `packages` array:

```json
"https://github.com/julsemaan/astatus@main"
```

Do not only delete the cached Git checkout: leaving the entry in `settings.json` causes Pi to load or install the GitHub version again after a restart. Keep the local checkout entry that `pi install .` adds.

From the repository root, run this shell command inside Pi:

```text
!! pi install .
```

Then reload Pi so the local extension starts:

```text
/reload
```

Before restarting Pi, verify `~/.pi/agent/settings.json` contains the local checkout in `packages` and no `https://github.com/julsemaan/astatus@main` entry. If `.pi/settings.json` exists in the repository, remove the same GitHub source there too because project settings can also install packages on startup.

For a one-shot extension test without installing it:

```bash
pi -e ./pi-extension/index.js
```

## Develop Codex CLI integration

Codex CLI with plugin support on Linux/macOS installs the repository as a local marketplace plugin:

```bash
codex plugin marketplace add .
codex plugin add agent-status@astatus
```

After changing the plugin, bump its version and refresh the installed cache:

```bash
codex plugin marketplace upgrade astatus
codex plugin remove agent-status@astatus
codex plugin add agent-status@astatus
```

Start a new Codex session, open `/hooks`, and trust the agent-status hooks. Hook definition changes require trust again. First prompt triggers `SessionStart` and a detached 20-second heartbeat sidecar.

Tests can pass short `--poll-interval` and `--heartbeat-interval` values to `emitter.py sidecar`; production defaults remain 0.1 and 20 seconds.

## Run checks

```bash
npm test
python3 -m unittest
```

## Build Python packages

Build a wheel and source distribution:

```bash
python -m pip install build
python -m build
```

Smoke-test the wheel in a fresh environment:

```bash
python -m venv /tmp/astatus-smoke
. /tmp/astatus-smoke/bin/activate
pip install dist/*.whl
agent-status --help
```
