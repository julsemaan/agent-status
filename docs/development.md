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

The Pi package is exported by the repository root `package.json`. The published package is `agent-status-pi`:

```bash
pi install npm:agent-status-pi
```

For local development, install the repository root rather than `./pi-extension` so Pi loads the same manifest used by Git installs.

Pi persists installed packages in `~/.pi/agent/settings.json` and loads them again on startup. Before developing the extension locally, remove this entry from the `packages` array:

```json
"https://github.com/julsemaan/agent-status@main"
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

Before restarting Pi, verify `~/.pi/agent/settings.json` contains the local checkout in `packages` and no `https://github.com/julsemaan/agent-status@main` entry. If `.pi/settings.json` exists in the repository, remove the same GitHub source there too because project settings can also install packages on startup.

For a one-shot extension test without installing it:

```bash
pi -e ./pi-extension/index.js
```

## Develop OpenCode plugin

Load repository package by absolute local path in project or global OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/you/src/agent-status"]
}
```

Run `opencode` in a test workspace and `agent-status watch` in another terminal. Smoke-test session creation, prompt work, question/permission blocking, idle goal retention, resume goal restoration, and snapshot cleanup on exit.

Validate npm packages from repository root with `make check-packages`. Each package must contain only `index.js`, `package.json`, `README.md`, and `LICENSE`.

## Develop Codex CLI integration

Codex CLI with plugin support on Linux/macOS installs the repository as a local marketplace plugin:

```bash
codex plugin marketplace add .
codex plugin add agent-status@agent-status
```

After changing the plugin, bump its version and refresh the installed cache:

```bash
codex plugin marketplace upgrade agent-status
codex plugin remove agent-status@agent-status
codex plugin add agent-status@agent-status
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
npm ci
python -m pip install build twine
make check
claude plugin validate .
```

`make check` verifies that all version files agree, runs the Python and Node tests, checks npm package contents, and builds the Python distributions.

## Build Python packages

Build a wheel and source distribution:

```bash
python -m pip install build
python -m build
```

Smoke-test the wheel in a fresh environment:

```bash
python -m venv /tmp/agent-status-smoke
. /tmp/agent-status-smoke/bin/activate
pip install dist/*.whl
agent-status --help
```

## Release

PyPI, npm, and GitHub Releases share one version. `tools/version.py` lists every file that holds it. Published versions are immutable, so recover from a broken release with a new patch version.

1. Dispatch the **Prepare release** workflow from the Actions tab, or run:

   ```bash
   gh workflow run prepare-release.yml            # next patch
   gh workflow run prepare-release.yml -f version=X.Y.Z
   ```

   It bumps every version file, pushes `release/vX.Y.Z`, and opens a pull request.
2. Review and merge the pull request. Merging triggers `publish.yml`, which runs `make check`, publishes to PyPI, `agent-status-opencode`, and `agent-status-pi`, then creates the `vX.Y.Z` tag and GitHub Release on the merge commit.

GitHub does not run CI on pull requests opened by the workflow token. `publish.yml` runs the full check before publishing anything.

To bump locally, run `make bump-version` or `make bump-version VERSION=X.Y.Z`.

Verify the release:

- Release workflow is green.
- PyPI version is available.
- npm package versions and metadata are correct: `npm view agent-status-opencode version dist-tags repository` and `npm view agent-status-pi version dist-tags repository`.
- Pi package loads: `pi -e npm:agent-status-pi`.
- GitHub Release is published.
- Wheel and source distribution are attached.
- A fresh virtual environment can install the released wheel.

Repository setup:

- Enable "Allow GitHub Actions to create and approve pull requests" under Settings > Actions > General.
- Any `v*` tag ruleset must let GitHub Actions create tags while still blocking tag updates and deletion.
- The `pypi` and `npm` environments must not restrict deployments to tags or `main`, since release runs use the pull request ref.
- PyPI and npm Trusted Publishers point at workflow `publish.yml` with environments `pypi` and `npm`. They need no changes.
- npm package publishing access requires 2FA and disallows tokens.
- Do not store PyPI or npm credentials in repository secrets.

Recovery rules:

- If the build job fails before anything publishes, rerun the workflow when the cause was temporary. Otherwise fix it on `main` and prepare the next patch.
- After PyPI or npm publication, never move or reuse the tag or version.
- For a broken published release, deprecate/yank it when necessary, then issue a patch release.
- If one registry publishes and another job fails, keep published artifacts immutable, fix the failure, and release a patch if rerunning cannot safely complete the missing publication.
- If GitHub Release publication fails after registry publication, rerun the failed job or repair release assets manually.
