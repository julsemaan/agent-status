## Verdict

Mostly compliant. Normal supported scope—Codex CLI, Linux/macOS, root sessions—matches requirements.

### Gaps

1. **Important edge case — duplicate snapshot after sidecar crash**
   - `codex-plugin/emitter.py:283-288` locks per session but generates new `agent_id` every sidecar start.
   - Old snapshot survives abnormal sidecar exit. Later `SessionStart` can create second file for same session.
   - Conflicts with §5.2: exactly one snapshot per session.
   - Normal reload/compact safe while original sidecar owns lock.

2. **Requirements contradiction — factory entry point**
   - §12.1 requires exported factory.
   - Codex uses command hooks via `.codex/hooks.json`; no extension factory exists.
   - Official Codex API confirms command-hook model: https://developers.openai.com/codex/hooks
   - Fix requirement wording, not implementation.

3. **Minor — incomplete `last_activity_at` tracking**
   - `PermissionRequest` and `Stop` change meaningful state without updating activity (`codex-plugin/emitter.py:189-196`).
   - §9.3 says activity should track meaningful agent work.

4. **Test coverage below §13.2 SHOULD list**
   Missing direct coverage for:
   - `AGENT_STATUS_DIR` / `XDG_STATE_HOME` resolution
   - malformed/incomplete tmux pairs
   - real snapshot heartbeat rewrite
   - concurrent status-file writes
   - abnormal sidecar restart deduplication

### Matches

- Schema fields and UTC timestamps
- Absolute workspace
- UUID agent IDs
- Atomic UUID/tempfile writes with `fsync` and rename
- 20-second heartbeat
- Session lock deduplication
- Prompt → `working`
- Question/permission → `input-required`
- Post-tool → `working`
- Stop → idle or trailing-question state
- Goal persistence across resume/compact; reset on clear
- SessionEnd/process death cleanup
- Supported Codex hook names and payload fields
- Windows/subagents deferred as documented

Validation passed:

```text
python3 -m unittest: 36 passed, 2 skipped
npm test: 31 passed
```

## Implementation plan

1. **Persist sidecar ownership**
   - Update `codex-plugin/emitter.py`.
   - Store session agent ID under control directory.
   - Reuse/replace prior snapshot after abnormal restart.
   - Remove ownership metadata during clean shutdown.

2. **Correct framework requirement**
   - Update `docs/extension-requirements.md`.
   - Allow either extension factory or host-native hook executable.

3. **Close test gaps**
   - Update `tests/test_codex_plugin.py`.
   - Add env resolution, malformed tmux, heartbeat rewrite, concurrent write, and crash-restart tests.

4. **Validate**
   - Run `python3 -m unittest` and `npm test`.
   - Manually verify one snapshot through prompt, question, answer, stop, compact, and SessionEnd.
