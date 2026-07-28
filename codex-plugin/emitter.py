#!/usr/bin/env python3
"""Codex hook receiver and single-writer status sidecar."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
if str(PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(PLUGIN_ROOT))

from agent_status import (  # noqa: E402
    SCHEMA_VERSION,
    atomic_write_json,
    default_status_dir,
    now_utc,
    validate_payload,
)

POLL_INTERVAL = 0.1
HEARTBEAT_INTERVAL = 20.0


def session_key(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def control_dir(plugin_data: Path, session_id: str) -> Path:
    return plugin_data.expanduser() / "sessions" / session_key(session_id)


def enqueue_event(control: Path, event: dict[str, Any]) -> Path:
    events = control / "events"
    path = events / f"{time.time_ns():020d}-{uuid.uuid4().hex}.json"
    atomic_write_json(path, event)
    return path


def normalize_summary(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    summary = " ".join(value.split())
    return summary[:120] or None


def is_subagent(event: dict[str, Any]) -> bool:
    return "agent_id" in event or "agent_transcript_path" in event


def detect_host(env: dict[str, str] | os._Environ[str]) -> str:
    return "claude-code" if env.get("CLAUDE_PLUGIN_ROOT") or env.get("CLAUDE_PLUGIN_DATA") else "codex"


def plugin_data_dir(env: dict[str, str] | os._Environ[str], host: str) -> Path:
    variable = "CLAUDE_PLUGIN_DATA" if host == "claude-code" else "PLUGIN_DATA"
    fallback = Path(env["CLAUDE_PLUGIN_ROOT"]) if host == "claude-code" and env.get("CLAUDE_PLUGIN_ROOT") else PLUGIN_ROOT
    return Path(env.get(variable, str(fallback / (".claude-data" if host == "claude-code" else ".codex-data"))))


def assistant_message_requires_input(value: Any) -> bool:
    return isinstance(value, str) and bool(re.search(r"\?(?:[\"'’”*_`\])}]+)?\s*$", value))


def is_question_tool(value: Any) -> bool:
    return isinstance(value, str) and (
        value in {"request_user_input", "AskUserQuestion", "ExitPlanMode"}
        or value.split("__")[-1] == "question"
    )


def has_background_work(event: dict[str, Any]) -> bool:
    return any(event.get(key) for key in ("active_background_tasks", "background_tasks"))


def parse_tmux_environment(env: dict[str, str] | os._Environ[str]) -> dict[str, str] | None:
    match = re.fullmatch(r"(.+),(\d+),(\d+)", env.get("TMUX", ""))
    pane = env.get("TMUX_PANE", "")
    if not match or not re.fullmatch(r"%\d+", pane):
        return None
    return {"tmux_socket": match.group(1), "tmux_pane": pane}


def process_environment(pid: int) -> dict[str, str]:
    try:
        proc_environ = Path(f"/proc/{pid}/environ")
        raw = proc_environ.read_bytes() if proc_environ.exists() else subprocess.check_output(
            ["ps", "eww", "-p", str(pid), "-o", "command="], stderr=subprocess.DEVNULL
        )
        return dict(item.split("=", 1) for item in raw.decode(errors="replace").replace("\x00", " ").split()
                    if "=" in item)
    except (OSError, subprocess.SubprocessError):
        return {}


def detect_tmux_environment(host_pid: int) -> dict[str, str] | None:
    return parse_tmux_environment(os.environ) or parse_tmux_environment(process_environment(host_pid))


class SessionState:
    def __init__(self, agent_id: str, host_pid: int, plugin_data: Path, host: str = "codex"):
        self.agent_id = agent_id
        self.agent_name = host
        self.host_pid = host_pid
        self.plugin_data = plugin_data
        self.resume_without_goal = False
        self.session_id: str | None = None
        self.workspace: str | None = None
        self.goal: dict[str, str] | None = None
        self.task: dict[str, str] | None = None
        self.model: str | None = None
        self.permission_mode: str | None = None
        self.tmux: dict[str, str] | None = None
        self.updated_at = now_utc()
        self.last_activity_at: str | None = None
        self.started = False
        self.shutdown = False

    def _goal_path(self) -> Path | None:
        if not self.session_id:
            return None
        return self.plugin_data / "goals" / f"{session_key(self.session_id)}.json"

    def _load_goal(self) -> None:
        path = self._goal_path()
        if not path or not path.exists():
            self.goal = None
            return
        try:
            goal = json.loads(path.read_text(encoding="utf-8"))
            self.goal = goal if not validate_payload({
                "schema_version": SCHEMA_VERSION,
                "agent_id": self.agent_id,
                "agent_name": self.agent_name,
                "runtime": {"lifecycle": "running", "updated_at": now_utc()},
                "goal": goal,
            }) else None
        except (OSError, json.JSONDecodeError):
            self.goal = None

    def _save_goal(self) -> None:
        path = self._goal_path()
        if path and self.goal:
            atomic_write_json(path, self.goal)

    def apply(self, event: Any) -> bool:
        if not isinstance(event, dict) or is_subagent(event):
            return False
        name = event.get("hook_event_name")
        session_id = event.get("session_id")
        if not isinstance(name, str) or not isinstance(session_id, str) or not session_id:
            return False
        if self.session_id and session_id != self.session_id:
            return False
        self.session_id = session_id
        cwd = event.get("cwd")
        if isinstance(cwd, str) and cwd:
            self.workspace = str(Path(cwd).expanduser().resolve())
        if isinstance(event.get("model"), str):
            self.model = event["model"]
        if isinstance(event.get("permission_mode"), str):
            self.permission_mode = event["permission_mode"]
        tmux = event.get("_tmux")
        if isinstance(tmux, dict):
            self.tmux = parse_tmux_environment({
                "TMUX": f'{tmux.get("tmux_socket", "")},0,0',
                "TMUX_PANE": tmux.get("tmux_pane", ""),
            })

        if name == "SessionStart":
            source = event.get("source")
            if source == "clear":
                path = self._goal_path()
                if path:
                    path.unlink(missing_ok=True)
                self.goal = None
                self.task = None
                self.resume_without_goal = False
            elif source in {"resume", "compact"}:
                if self.goal is None:
                    self._load_goal()
                self.resume_without_goal = source == "resume" and self.goal is None
            elif not self.started:
                self.task = None
                self.resume_without_goal = False
            self.started = True
        elif name == "UserPromptSubmit":
            summary = normalize_summary(event.get("prompt"))
            self._set_task(event, "working", summary)
            self.last_activity_at = now_utc()
            if summary and self.goal is None and not self.resume_without_goal:
                self.goal = {"summary": summary, "updated_at": now_utc(), "source": "initial-prompt"}
                self._save_goal()
        elif name in {"PreToolUse", "PostToolUse"}:
            state = "input-required" if name == "PreToolUse" and is_question_tool(event.get("tool_name")) else "working"
            self._set_task(event, state, None)
            self.last_activity_at = now_utc()
        elif name == "PermissionRequest":
            self._set_task(event, "input-required", None)
            self.last_activity_at = now_utc()
        elif name == "Stop":
            self.last_activity_at = now_utc()
            if assistant_message_requires_input(event.get("last_assistant_message")):
                self._set_task(event, "input-required", None)
            elif has_background_work(event):
                self._set_task(event, "submitted", None)
            else:
                self.task = None
        elif name == "SessionEnd":
            self.shutdown = True
        else:
            return False

        self.updated_at = now_utc()
        return True

    def _set_task(self, event: dict[str, Any], state: str, summary: str | None) -> None:
        previous = self.task or {}
        task: dict[str, str] = {"state": state, "status_timestamp": now_utc()}
        turn_id = event.get("turn_id") or event.get("prompt_id")
        if isinstance(turn_id, str):
            task["id"] = turn_id
        if self.session_id:
            task["context_id"] = self.session_id
        selected_summary = summary or previous.get("summary")
        if selected_summary:
            task["summary"] = selected_summary
        self.task = task

    def heartbeat(self) -> None:
        self.updated_at = now_utc()

    def payload(self) -> dict[str, Any]:
        runtime: dict[str, Any] = {
            "lifecycle": "running",
            "updated_at": self.updated_at,
            "pid": self.host_pid,
        }
        if self.workspace:
            runtime["workspace"] = self.workspace
        if self.last_activity_at:
            runtime["last_activity_at"] = self.last_activity_at
        payload: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "agent_id": self.agent_id,
            "agent_name": self.agent_name,
            "runtime": runtime,
        }
        if self.goal:
            payload["goal"] = dict(self.goal)
        if self.task:
            payload["task"] = dict(self.task)
        host_meta = {}
        if self.session_id:
            host_meta["session_id"] = self.session_id
        if self.model:
            host_meta["model"] = self.model
        if self.permission_mode:
            host_meta["permission_mode"] = self.permission_mode
        if host_meta or self.tmux:
            meta_key = "claude_code" if self.agent_name == "claude-code" else "codex"
            payload["x_meta"] = {meta_key: host_meta, **(self.tmux or {})}
        return payload


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


def drain_events(control: Path, state: SessionState) -> bool:
    changed = False
    for path in sorted((control / "events").glob("*.json")):
        try:
            event = json.loads(path.read_text(encoding="utf-8"))
            changed = state.apply(event) or changed
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
        finally:
            path.unlink(missing_ok=True)
    return changed


def run_sidecar(control: Path, output_dir: Path, host_pid: int, *, host: str = "codex",
                poll_interval: float = POLL_INTERVAL,
                heartbeat_interval: float = HEARTBEAT_INTERVAL) -> int:
    control.mkdir(parents=True, exist_ok=True)
    lock_path = control / "sidecar.lock"
    lock = lock_path.open("a+")
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        ownership_path = control / "ownership.json"
        try:
            ownership = json.loads(ownership_path.read_text(encoding="utf-8"))
            agent_id = ownership["agent_id"]
            prefix = "claude-code" if host == "claude-code" else "codex"
            if not isinstance(agent_id, str) or not re.fullmatch(rf"{prefix}-[0-9a-f]{{32}}", agent_id):
                raise ValueError
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            prefix = "claude-code" if host == "claude-code" else "codex"
            agent_id = f"{prefix}-{uuid.uuid4().hex}"
            atomic_write_json(ownership_path, {"agent_id": agent_id})
        snapshot = output_dir / f"{agent_id}.json"
        state = SessionState(agent_id, host_pid, control.parents[1], host)
        last_heartbeat = time.monotonic()
        while True:
            changed = drain_events(control, state)
            alive = process_alive(host_pid)
            if state.shutdown or not alive:
                drain_events(control, state)
                snapshot.unlink(missing_ok=True)
                ownership_path.unlink(missing_ok=True)
                break
            now = time.monotonic()
            if now - last_heartbeat >= heartbeat_interval:
                state.heartbeat()
                changed = True
                last_heartbeat = now
            if changed and state.started:
                payload = state.payload()
                if not validate_payload(payload):
                    atomic_write_json(snapshot, payload)
            time.sleep(poll_interval)
        for path in (control / "events").glob("*"):
            path.unlink(missing_ok=True)
        return 0
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def cmd_hook(args: argparse.Namespace) -> int:
    try:
        event = json.load(sys.stdin)
        session_id = event.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return 0
        host = detect_host(os.environ)
        plugin_data = plugin_data_dir(os.environ, host)
        tmux = detect_tmux_environment(args.host_pid)
        if tmux:
            event["_tmux"] = tmux
        control = control_dir(plugin_data, session_id)
        enqueue_event(control, event)
        if event.get("hook_event_name") == "SessionStart":
            subprocess.Popen(
                [sys.executable, str(Path(__file__).resolve()), "sidecar", "--host", host,
                 "--host-pid", str(args.host_pid), "--control-dir", str(control),
                 "--status-dir", str(default_status_dir())],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True, close_fds=True,
            )
        if event.get("hook_event_name") == "Stop":
            print("{}")
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        pass
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    hook = commands.add_parser("hook")
    hook.add_argument("--host-pid", required=True, type=int)
    hook.set_defaults(func=cmd_hook)
    sidecar = commands.add_parser("sidecar")
    sidecar.add_argument("--host", choices=("codex", "claude-code"), default="codex")
    sidecar.add_argument("--host-pid", required=True, type=int)
    sidecar.add_argument("--control-dir", required=True, type=Path)
    sidecar.add_argument("--status-dir", required=True, type=Path)
    sidecar.add_argument("--poll-interval", type=float, default=POLL_INTERVAL)
    sidecar.add_argument("--heartbeat-interval", type=float, default=HEARTBEAT_INTERVAL)
    sidecar.set_defaults(func=lambda args: run_sidecar(
        args.control_dir, args.status_dir, args.host_pid, host=args.host,
        poll_interval=args.poll_interval, heartbeat_interval=args.heartbeat_interval,
    ))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
