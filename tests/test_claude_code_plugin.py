import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import agent_status

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("claude_emitter", ROOT / "codex-plugin" / "emitter.py")
emitter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(emitter)


class ClaudeCodePluginTests(unittest.TestCase):
    def event(self, name, **fields):
        return {
            "hook_event_name": name,
            "session_id": "claude/session",
            "cwd": ".",
            "model": "claude-opus-4-6",
            "permission_mode": "default",
            **fields,
        }

    def state(self, data):
        return emitter.SessionState("claude-code-" + "a" * 32, 123, data, host="claude-code")

    def test_manifests_package_hooks_only_from_repository_root(self):
        manifest = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text())
        marketplace = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
        package = json.loads((ROOT / "package.json").read_text())
        codex = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text())

        self.assertEqual(manifest["name"], "agent-status")
        self.assertEqual(manifest["version"], package["version"])
        self.assertEqual(manifest["version"], codex["version"])
        self.assertEqual(marketplace["name"], "astatus")
        self.assertEqual(marketplace["plugins"][0]["source"], "./")
        self.assertNotIn("mcpServers", manifest)
        self.assertNotIn("commands", manifest)
        self.assertTrue((ROOT / "hooks" / "hooks.json").exists())

    def test_claude_environment_and_spaced_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            plugin_root = base / "plugin root with spaces"
            (plugin_root / "codex-plugin").mkdir(parents=True)
            shutil.copy2(ROOT / "codex-plugin" / "emitter.py", plugin_root / "codex-plugin")
            shutil.copy2(ROOT / "agent_status.py", plugin_root)
            plugin_data = base / "plugin data with spaces"
            hook = json.loads((ROOT / "hooks" / "hooks.json").read_text())["hooks"]["Stop"][0]["hooks"][0]
            result = subprocess.run(
                hook["command"], shell=True, input=json.dumps(self.event("Stop")), text=True,
                capture_output=True, env={**os.environ, "CLAUDE_PLUGIN_ROOT": str(plugin_root),
                                           "CLAUDE_PLUGIN_DATA": str(plugin_data)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            queued = list(emitter.control_dir(plugin_data, "claude/session").glob("events/*.json"))
            self.assertEqual(len(queued), 1)

    def test_payload_uses_claude_identity_metadata_and_prompt_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = self.state(Path(tmp))
            state.apply(self.event("SessionStart", source="startup"))
            state.apply(self.event("UserPromptSubmit", prompt_id="prompt-1", prompt="Build Claude support"))
            payload = state.payload()
            self.assertEqual(payload["agent_name"], "claude-code")
            self.assertEqual(payload["task"]["id"], "prompt-1")
            self.assertEqual(payload["x_meta"]["claude_code"]["session_id"], "claude/session")
            self.assertEqual(agent_status.validate_payload(payload), [])

    def test_claude_question_tools_stop_and_goal_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            state = self.state(data)
            state.apply(self.event("SessionStart", source="startup"))
            state.apply(self.event("UserPromptSubmit", prompt_id="p1", prompt="Original goal"))
            for tool in ("AskUserQuestion", "ExitPlanMode"):
                state.apply(self.event("PreToolUse", prompt_id="p1", tool_name=tool))
                self.assertEqual(state.payload()["task"]["state"], "input-required")
                state.apply(self.event("PostToolUse", prompt_id="p1", tool_name=tool))
                self.assertEqual(state.payload()["task"]["state"], "working")
            state.apply(self.event("Stop", prompt_id="p1", last_assistant_message="Done"))
            self.assertNotIn("task", state.payload())

            resumed = self.state(data)
            resumed.apply(self.event("SessionStart", source="resume"))
            self.assertEqual(resumed.payload()["goal"]["summary"], "Original goal")
            resumed.apply(self.event("SessionStart", source="compact"))
            self.assertIn("goal", resumed.payload())
            resumed.apply(self.event("SessionStart", source="clear"))
            self.assertNotIn("goal", resumed.payload())

    def test_stop_preserves_real_background_work_as_submitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = self.state(Path(tmp))
            state.apply(self.event("UserPromptSubmit", prompt_id="p1", prompt="Run background job"))
            state.apply(self.event("Stop", prompt_id="p1", last_assistant_message="Job continues.",
                                   active_background_tasks=["job-1"]))
            self.assertEqual(state.payload()["task"]["state"], "submitted")

    def test_subagent_events_are_ignored_but_main_agent_type_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = self.state(Path(tmp))
            self.assertTrue(state.apply(self.event("SessionStart", source="startup", agent_type="custom-main")))
            before = state.payload()
            self.assertFalse(state.apply(self.event("UserPromptSubmit", agent_id="sub-1", agent_type="Explore",
                                                    prompt="subagent work")))
            self.assertEqual(state.payload(), before)

    def test_claude_sidecar_identity_heartbeat_and_shutdown(self):
        with tempfile.TemporaryDirectory() as tmp:
            data, statuses = Path(tmp) / "data", Path(tmp) / "statuses"
            control = emitter.control_dir(data, "claude/session")
            emitter.enqueue_event(control, self.event("SessionStart", source="startup"))
            command = [
                os.sys.executable, str(ROOT / "codex-plugin" / "emitter.py"), "sidecar",
                "--host", "claude-code", "--host-pid", str(os.getpid()),
                "--control-dir", str(control), "--status-dir", str(statuses),
                "--poll-interval", "0.02", "--heartbeat-interval", "0.05",
            ]
            process = subprocess.Popen(command)
            try:
                deadline = time.time() + 3
                while time.time() < deadline and not list(statuses.glob("claude-code-*.json")):
                    time.sleep(0.02)
                snapshots = list(statuses.glob("claude-code-*.json"))
                self.assertEqual(len(snapshots), 1)
                first_update = json.loads(snapshots[0].read_text())["runtime"]["updated_at"]
                deadline = time.time() + 3
                while time.time() < deadline:
                    if json.loads(snapshots[0].read_text())["runtime"]["updated_at"] != first_update:
                        break
                    time.sleep(0.02)
                self.assertNotEqual(json.loads(snapshots[0].read_text())["runtime"]["updated_at"], first_update)
                emitter.enqueue_event(control, self.event("SessionEnd"))
                process.wait(timeout=3)
                self.assertFalse(snapshots[0].exists())
                self.assertFalse((control / "ownership.json").exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
