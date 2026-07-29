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

## Develop OpenCode plugin

Load repository package by absolute local path in project or global OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/you/src/astatus"]
}
```

Run `opencode` in a test workspace and `agent-status watch` in another terminal. Smoke-test session creation, prompt work, question/permission blocking, idle goal retention, resume goal restoration, and snapshot cleanup on exit. Run plugin tests directly with:

```bash
node --test opencode-plugin/test/*.test.js
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

## Develop Claude Code integration

Claude Code on Linux/macOS can validate and load repository directly:

```bash
claude plugin validate .
claude --plugin-dir .
```

After hook or manifest changes, run `/reload-plugins` in Claude Code. Shared emitter selects Claude paths from `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA`; Codex continues using `PLUGIN_ROOT` and `PLUGIN_DATA`.

Lifecycle mapping:

- `SessionStart`: running snapshot, no task; resume/compact restores goal, clear resets it.
- `UserPromptSubmit`: first prompt seeds durable goal; every prompt sets `working`.
- `PreToolUse`: `AskUserQuestion` and `ExitPlanMode` set `input-required`; other tools set `working`.
- `PermissionRequest`: sets `input-required`.
- `PostToolUse`: returns to `working`.
- `Stop`: trailing question sets `input-required`, active background work sets `submitted`, otherwise removes task.
- `SessionEnd`: stops heartbeat and removes snapshot.

## Run checks

```bash
python3 -m unittest
npm ci
npm test
claude plugin validate .
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

## Release

Releases use annotated `vMAJOR.MINOR.PATCH` tags. PyPI and GitHub Releases receive the same wheel and source distribution. PyPI already contains `0.1.10`, so the next release must be `v0.1.11` or newer.

Prepare and verify a version bump:

```bash
git switch main
git pull --ff-only

make bump-version BUMP=patch
python3 -m unittest
npm ci
npm test
python -m build
twine check dist/*
```

Commit the changed manifests on a branch and merge them through a pull request:

```bash
git add pyproject.toml package.json package-lock.json .codex-plugin/plugin.json
git commit -m "chore(release): bump version to X.Y.Z"
```

After the pull request merges, tag the merged commit and push the tag:

```bash
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

Verify the release:

- Release workflow is green.
- PyPI version is available.
- GitHub Release is published.
- Wheel and source distribution are attached.
- A fresh virtual environment can install the released wheel.

Repository setup required before the first release:

- Add a `v*` tag ruleset restricted to release maintainers; block tag updates and deletion.
- Confirm the `pypi` environment exists. Optionally require approval before publication.
- Configure the PyPI Trusted Publisher for repository `julsemaan/astatus`, workflow `.github/workflows/publish-pypi.yml`, and environment `pypi`.
- Do not store PyPI credentials in repository secrets.

Recovery rules:

- Before PyPI publication, fix the commit and recreate the tag only after deleting the unpublished bad tag.
- After PyPI publication, never move or reuse the tag or version.
- For a broken published release, yank the package when necessary, then issue a patch release.
- If GitHub Release publication fails after PyPI succeeds, rerun the failed job or repair the release assets manually.
