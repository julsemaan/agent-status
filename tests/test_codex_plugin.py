import importlib.util
import json
import os
import shutil
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

    def test_packaged_plugin_manifests_and_hooks(self):
        manifest = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text())
        marketplace_path = ROOT / ".agents" / "plugins" / "marketplace.json"
        marketplace = json.loads(marketplace_path.read_text())
        package = json.loads((ROOT / "package.json").read_text())
        pyproject = (ROOT / "pyproject.toml").read_text()

        self.assertEqual(manifest["name"], "agent-status")
        self.assertEqual(manifest["version"], package["version"])
        self.assertIn(f'version = "{manifest["version"]}"', pyproject)
        plugin = marketplace["plugins"][0]
        self.assertEqual(marketplace["name"], "agent-status")
        self.assertEqual(plugin["name"], manifest["name"])
        self.assertEqual((marketplace_path.parents[2] / plugin["source"]["path"]).resolve(), ROOT)
        self.assertEqual(plugin["policy"], {
            "installation": "AVAILABLE", "authentication": "ON_INSTALL",
        })

        hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        self.assertEqual(set(hooks["hooks"]), {
            "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
            "PostToolUse", "Stop", "SessionEnd",
        })
        for groups in hooks["hooks"].values():
            command = groups[0]["hooks"][0]["command"]
            self.assertEqual(command, 'python3 "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/codex-plugin/emitter.py" hook --host-pid "$PPID"')
            self.assertNotIn("git rev-parse", command)
        self.assertEqual(hooks["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"], 3)
        self.assertFalse((ROOT / ".codex" / "hooks.json").exists())

    def test_hook_executes_outside_git_with_spaced_plugin_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plugin_root = base / "plugin root with spaces"
            (plugin_root / "codex-plugin").mkdir(parents=True)
            shutil.copy2(ROOT / "codex-plugin" / "emitter.py", plugin_root / "codex-plugin")
            shutil.copy2(ROOT / "agent_status.py", plugin_root)
            plugin_data = base / "plugin data"
            cwd = base / "not a repository"
            cwd.mkdir()
            hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text())
            command = hooks["hooks"]["Stop"][0]["hooks"][0]["command"]
            event = self.event("Stop")
            result = subprocess.run(
                command, shell=True, cwd=cwd, input=json.dumps(event), text=True,
                capture_output=True, env={**os.environ, "PLUGIN_ROOT": str(plugin_root), "PLUGIN_DATA": str(plugin_data)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            queued = list(emitter.control_dir(plugin_data, "session/one").glob("events/*.json"))
            self.assertEqual(len(queued), 1)
            self.assertEqual(json.loads(queued[0].read_text())["hook_event_name"], "Stop")

    def test_tmux_environment_is_emitted_as_paired_metadata(self):
        self.assertEqual(
            emitter.parse_tmux_environment({
                "TMUX": "/tmp/tmux,socket/default,1234,7",
                "TMUX_PANE": "%12",
            }),
            {"tmux_socket": "/tmp/tmux,socket/default", "tmux_pane": "%12"},
        )
        with tempfile.TemporaryDirectory() as tmp:
            state = emitter.SessionState("codex-" + "a" * 32, 123, Path(tmp))
            state.apply(self.event("SessionStart", source="startup", _tmux={
                "tmux_socket": "/tmp/tmux-1000/default",
                "tmux_pane": "%3",
            }))
            self.assertEqual(state.payload()["x_meta"]["tmux_socket"], "/tmp/tmux-1000/default")
            self.assertEqual(state.payload()["x_meta"]["tmux_pane"], "%3")

    def test_hook_recovers_tmux_environment_from_codex_process(self):
        environ = {"TMUX": "/tmp/tmux-1000/default,1234,7", "TMUX_PANE": "%3"}
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(emitter, "process_environment", return_value=environ):
            self.assertEqual(emitter.detect_tmux_environment(456), {
                "tmux_socket": "/tmp/tmux-1000/default",
                "tmux_pane": "%3",
            })

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
            state.apply(self.event("Stop", turn_id="turn-1", last_assistant_message="Build complete."))
            self.assertNotIn("task", state.payload())
            self.assertEqual(agent_status.validate_payload(state.payload()), [])

    def test_question_tool_requires_input_until_tool_returns(self):
        for tool_name in ("request_user_input", "question", "mcp__ui__question"):
            with self.subTest(tool_name=tool_name), tempfile.TemporaryDirectory() as tmp:
                state = emitter.SessionState("codex-" + "a" * 32, 123, Path(tmp))
                state.apply(self.event("UserPromptSubmit", turn_id="turn-1", prompt="Build thing"))
                state.apply(self.event(
                    "PreToolUse",
                    turn_id="turn-1",
                    tool_name=tool_name,
                    tool_input={"questions": []},
                ))
                self.assertEqual(state.payload()["task"]["state"], "input-required")
                state.apply(self.event(
                    "PostToolUse",
                    turn_id="turn-1",
                    tool_name=tool_name,
                    tool_input={"questions": []},
                    tool_response={},
                ))
                self.assertEqual(state.payload()["task"]["state"], "working")

    def test_stop_with_assistant_question_requires_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = emitter.SessionState("codex-" + "a" * 32, 123, Path(tmp))
            state.apply(self.event("UserPromptSubmit", turn_id="turn-1", prompt="Build thing"))
            state.apply(self.event(
                "Stop",
                turn_id="turn-1",
                last_assistant_message="Which database should I use?",
            ))
            self.assertEqual(state.payload()["task"]["state"], "input-required")
            self.assertEqual(state.payload()["task"]["summary"], "Build thing")

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

    def test_crash_restart_reuses_snapshot_and_cleans_ownership(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, statuses = Path(tmp) / "data", Path(tmp) / "statuses"
            control = emitter.control_dir(data, "session/one")
            emitter.enqueue_event(control, self.event("SessionStart", source="startup"))
            cmd = [sys.executable, str(ROOT / "codex-plugin" / "emitter.py"), "sidecar",
                   "--host-pid", str(os.getpid()), "--control-dir", str(control),
                   "--status-dir", str(statuses), "--poll-interval", "0.02", "--heartbeat-interval", "0.05"]
            first = subprocess.Popen(cmd)
            second = None
            try:
                deadline = time.time() + 3
                while time.time() < deadline and not list(statuses.glob("codex-*.json")):
                    time.sleep(0.02)
                snapshots = list(statuses.glob("codex-*.json"))
                self.assertEqual(len(snapshots), 1)
                original = snapshots[0]
                first.kill()
                first.wait(timeout=3)

                emitter.enqueue_event(control, self.event("SessionStart", source="startup"))
                second = subprocess.Popen(cmd)
                deadline = time.time() + 3
                while time.time() < deadline and not original.exists():
                    time.sleep(0.02)
                time.sleep(0.1)
                self.assertEqual(list(statuses.glob("codex-*.json")), [original])
                emitter.enqueue_event(control, self.event("SessionEnd"))
                second.wait(timeout=3)
                self.assertFalse(original.exists())
                self.assertFalse((control / "ownership.json").exists())
            finally:
                for process in (first, second):
                    if process is not None and process.poll() is None:
                        process.terminate()
                        process.wait()

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
