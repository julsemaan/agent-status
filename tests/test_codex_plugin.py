import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import agent_status

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("codex_emitter", ROOT / "codex-plugin" / "emitter.py")
emitter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(emitter)


class CodexPluginTests(unittest.TestCase):
    def event(self, name, **fields):
        return {
            "hook_event_name": name,
            "session_id": "session/one",
            "cwd": ".",
            "model": "gpt-5",
            "permission_mode": "default",
            **fields,
        }

    def test_project_hooks_parse(self):
        project_hooks = json.loads((ROOT / ".codex" / "hooks.json").read_text())
        self.assertEqual(set(project_hooks["hooks"]), {
            "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
            "PostToolUse", "Stop", "SessionEnd",
        })
        for groups in project_hooks["hooks"].values():
            command = groups[0]["hooks"][0]["command"]
            self.assertIn('PLUGIN_ROOT="$(git rev-parse --show-toplevel)"', command)
            self.assertIn('PLUGIN_DATA="${XDG_STATE_HOME:-$HOME/.local/state}/agent-status/codex-plugin"', command)
            self.assertIn('python3 "$PLUGIN_ROOT/codex-plugin/emitter.py" hook --host-pid "$PPID"', command)
        self.assertEqual(project_hooks["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3)

    def test_queue_writes_are_atomic_and_unique(self):
        with tempfile.TemporaryDirectory() as tmp:
            control = emitter.control_dir(Path(tmp), "session/one")
            paths = [emitter.enqueue_event(control, self.event("Stop")) for _ in range(20)]
            self.assertEqual(len(set(paths)), 20)
            self.assertTrue(all(json.loads(path.read_text())["hook_event_name"] == "Stop" for path in paths))
            self.assertFalse(list(control.rglob("*.tmp")))

    def test_reducer_full_transition_and_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = emitter.SessionState("codex-" + "a" * 32, 123, Path(tmp))
            start = self.event("SessionStart", source="startup")
            self.assertTrue(state.apply(start))
            self.assertNotIn("task", state.payload())
            prompt = self.event("UserPromptSubmit", turn_id="turn-1", prompt="  Build   thing  " + "x" * 200)
            state.apply(prompt)
            record = state.payload()
            self.assertEqual(record["task"]["state"], "working")
            self.assertEqual(record["task"]["id"], "turn-1")
            self.assertEqual(record["task"]["context_id"], "session/one")
            self.assertLessEqual(len(record["task"]["summary"]), 120)
            self.assertEqual(record["goal"]["summary"], record["task"]["summary"])
            activity = record["runtime"]["last_activity_at"]
            state.apply(self.event("PermissionRequest", turn_id="turn-1"))
            self.assertEqual(state.payload()["task"]["state"], "input-required")
            state.apply(self.event("PostToolUse", turn_id="turn-1"))
            self.assertEqual(state.payload()["task"]["state"], "working")
            self.assertGreaterEqual(state.payload()["runtime"]["last_activity_at"], activity)
            state.apply(self.event("Stop", turn_id="turn-1"))
            self.assertNotIn("task", state.payload())
            self.assertEqual(agent_status.validate_payload(state.payload()), [])

    def test_goal_resume_clear_and_compact(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            first = emitter.SessionState("codex-" + "a" * 32, 1, data)
            first.apply(self.event("SessionStart", source="startup"))
            first.apply(self.event("UserPromptSubmit", prompt="Original goal", turn_id="1"))
            resumed = emitter.SessionState("codex-" + "b" * 32, 1, data)
            resumed.apply(self.event("SessionStart", source="resume"))
            self.assertEqual(resumed.payload()["goal"]["summary"], "Original goal")
            resumed.apply(self.event("SessionStart", source="compact"))
            self.assertIn("goal", resumed.payload())
            resumed.apply(self.event("SessionStart", source="clear"))
            self.assertNotIn("goal", resumed.payload())
            self.assertNotIn("task", resumed.payload())

            missing = emitter.SessionState("codex-" + "c" * 32, 1, data)
            missing.apply(self.event("SessionStart", session_id="missing", source="resume"))
            missing.apply(self.event("UserPromptSubmit", session_id="missing", prompt="Later prompt", turn_id="2"))
            self.assertNotIn("goal", missing.payload())

    def test_subagent_and_malformed_events_do_not_change_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = emitter.SessionState("codex-" + "a" * 32, 1, Path(tmp))
            state.apply(self.event("SessionStart", source="startup"))
            before = state.payload()
            self.assertFalse(state.apply({"broken": object()}))
            self.assertFalse(state.apply(self.event("UserPromptSubmit", agent_id="sub", prompt="overwrite")))
            self.assertEqual(state.payload(), before)

    def test_heartbeat_only_changes_updated_at(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = emitter.SessionState("codex-" + "a" * 32, 1, Path(tmp))
            state.apply(self.event("PreToolUse", turn_id="1"))
            activity = state.payload()["runtime"]["last_activity_at"]
            with mock.patch.object(emitter, "now_utc", return_value="2999-01-01T00:00:00Z"):
                state.heartbeat()
            self.assertEqual(state.payload()["runtime"]["updated_at"], "2999-01-01T00:00:00Z")
            self.assertEqual(state.payload()["runtime"]["last_activity_at"], activity)

    def test_duplicate_ownership_and_shutdown_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, statuses = Path(tmp) / "data", Path(tmp) / "statuses"
            control = emitter.control_dir(data, "session/one")
            emitter.enqueue_event(control, self.event("SessionStart", source="startup"))
            cmd = [sys.executable, str(ROOT / "codex-plugin" / "emitter.py"), "sidecar",
                   "--host-pid", str(os.getpid()), "--control-dir", str(control),
                   "--status-dir", str(statuses), "--poll-interval", "0.02", "--heartbeat-interval", "0.05"]
            first = subprocess.Popen(cmd)
            try:
                deadline = time.time() + 3
                while time.time() < deadline and not list(statuses.glob("codex-*.json")):
                    time.sleep(0.02)
                second = subprocess.run(cmd, timeout=2)
                self.assertEqual(second.returncode, 0)
                self.assertEqual(len(list(statuses.glob("codex-*.json"))), 1)
                emitter.enqueue_event(control, self.event("SessionEnd"))
                first.wait(timeout=3)
                self.assertFalse(list(statuses.glob("*.json")))
                self.assertFalse(list(control.glob("events/*.json")))
                self.assertFalse(list(control.rglob("*.tmp")))
            finally:
                if first.poll() is None:
                    first.terminate()
                    first.wait()

    def test_dead_host_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, statuses = Path(tmp) / "data", Path(tmp) / "statuses"
            control = emitter.control_dir(data, "session/one")
            emitter.enqueue_event(control, self.event("SessionStart", source="startup"))
            dead_pid = 99999999
            emitter.run_sidecar(control, statuses, dead_pid, poll_interval=0.01, heartbeat_interval=0.02)
            self.assertFalse(list(statuses.glob("*.json")))
            self.assertFalse(list(control.glob("events/*.json")))


if __name__ == "__main__":
    unittest.main()
