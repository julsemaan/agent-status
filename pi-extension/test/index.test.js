import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import agentStatusPiExtension, {
  SCHEMA_VERSION,
  buildBaseRecord,
  buildStatusPath,
  buildTempPath,
  createSessionAgentId,
  getSessionKey,
  getStatusDir,
  nowUtc,
  parseTmuxEnvironment,
  sanitizeAgentId,
  summarizePrompt,
  updateRuntime,
  withGoal,
  withTask,
  writeStatusFile,
} from "../index.js";

test("parseTmuxEnvironment extracts socket paths containing commas", () => {
  assert.deepEqual(
    parseTmuxEnvironment({ TMUX: "/tmp/tmux,socket/default,1234,7", TMUX_PANE: "%12" }),
    { tmux_socket: "/tmp/tmux,socket/default", tmux_pane: "%12" },
  );
});

test("parseTmuxEnvironment omits invalid or incomplete pairs", () => {
  for (const env of [
    {},
    { TMUX: "/tmp/default,1234,7" },
    { TMUX_PANE: "%1" },
    { TMUX: "/tmp/default,pid,7", TMUX_PANE: "%1" },
    { TMUX: "/tmp/default,1234,index", TMUX_PANE: "%1" },
    { TMUX: "/tmp/default,1234,7", TMUX_PANE: "1" },
    { TMUX: ",1234,7", TMUX_PANE: "%1" },
  ]) assert.equal(parseTmuxEnvironment(env), undefined);
});

test("getStatusDir follows standard", () => {
  assert.equal(getStatusDir({ AGENT_STATUS_DIR: "/tmp/custom" }, "/home/me"), "/tmp/custom");
  assert.equal(getStatusDir({ XDG_STATE_HOME: "/state" }, "/home/me"), "/state/agent-status");
  assert.equal(getStatusDir({}, "/home/me"), "/home/me/.local/state/agent-status");
});

test("buildBaseRecord creates minimal valid record", () => {
  const record = buildBaseRecord({ agentId: "pi-123", workspace: "/work", pid: 12, now: "2026-06-20T16:45:00Z" });
  assert.deepEqual(record, {
    schema_version: SCHEMA_VERSION,
    agent_id: "pi-123",
    agent_name: "pi",
    runtime: {
      lifecycle: "running",
      updated_at: "2026-06-20T16:45:00Z",
      pid: 12,
      workspace: path.resolve("/work"),
    },
  });
});

test("task and goal add and clear works", () => {
  const base = buildBaseRecord({ agentId: "pi-1", now: "2026-06-20T16:45:00Z" });
  const withSessionGoal = withGoal(base, { summary: "ship docs", updated_at: "2026-06-20T16:45:01Z", source: "initial-prompt" });
  assert.equal(withSessionGoal.goal.summary, "ship docs");

  const withWorkingTask = withTask(withSessionGoal, { state: "working", summary: "edit docs", status_timestamp: "2026-06-20T16:45:02Z" });
  assert.equal(withWorkingTask.task.state, "working");

  const clearedTask = withTask(withWorkingTask, undefined);
  assert.equal("task" in clearedTask, false);

  const clearedGoal = withGoal(clearedTask, undefined);
  assert.equal("goal" in clearedGoal, false);
});

test("runtime update bumps fields", () => {
  const base = buildBaseRecord({ agentId: "pi-1", now: "2026-06-20T16:45:00Z" });
  const updated = updateRuntime(base, { lifecycle: "stopped", last_activity_at: "2026-06-20T16:45:02Z" }, "2026-06-20T16:45:03Z");
  assert.equal(updated.runtime.lifecycle, "stopped");
  assert.equal(updated.runtime.last_activity_at, "2026-06-20T16:45:02Z");
  assert.equal(updated.runtime.updated_at, "2026-06-20T16:45:03Z");
});

test("session agent ids are unique even in one pid context", () => {
  const ids = new Set(Array.from({ length: 8 }, () => createSessionAgentId()));
  assert.equal(ids.size, 8);
  for (const id of ids) assert.match(id, /^pi-[0-9a-f-]+$/);
});

test("distinct agent ids map to distinct status paths", () => {
  const first = createSessionAgentId();
  const second = createSessionAgentId();
  assert.notEqual(first, second);
  assert.notEqual(
    buildStatusPath(first, { AGENT_STATUS_DIR: "/tmp/x" }, "/home/me"),
    buildStatusPath(second, { AGENT_STATUS_DIR: "/tmp/x" }, "/home/me"),
  );
});

test("writeStatusFile writes parseable json atomically", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-pi-"));
  const filePath = path.join(tmp, "pi-1.json");
  const record = withGoal(buildBaseRecord({ agentId: "pi-1", now: nowUtc() }), {
    summary: "keep intent",
    updated_at: nowUtc(),
    source: "initial-prompt",
  });
  writeStatusFile(filePath, record);
  writeStatusFile(filePath, updateRuntime(record, { last_activity_at: nowUtc() }));
  const loaded = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(loaded.agent_id, "pi-1");
  assert.equal(loaded.goal.summary, "keep intent");
  assert.equal(typeof loaded.runtime.updated_at, "string");
});

test("temp path uses random suffix, not pid suffix", () => {
  const filePath = "/tmp/pi-1.json";
  const first = buildTempPath(filePath);
  const second = buildTempPath(filePath);
  assert.match(first, /^\/tmp\/\.pi-1\.json\.[0-9a-f-]+\.tmp$/);
  assert.notEqual(first, second);
  assert.equal(first.includes(`.${process.pid}.`), false);
});

test("helpers sanitize id and summarize prompt", () => {
  assert.equal(sanitizeAgentId("pi / 123"), "pi-123");
  assert.equal(sanitizeAgentId(""), "pi");
  assert.equal(buildStatusPath("pi / 123", { AGENT_STATUS_DIR: "/tmp/x" }, "/home/me"), "/tmp/x/pi-123.json");
  assert.equal(summarizePrompt("  hello\nworld  "), "hello world");
  assert.match(summarizePrompt("x".repeat(200)), /^x+…$/);
});

test("getSessionKey prefers session file", () => {
  assert.equal(
    getSessionKey({ cwd: "/work/tree", sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } }),
    "session-file:/tmp/session.jsonl",
  );
  assert.equal(getSessionKey({ cwd: "/work/tree" }), `pid:${process.pid}:cwd:${path.resolve("/work/tree")}`);
});

test("extension session_start writes uuid-based status file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-ext-"));
  const previous = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  try {
    agentStatusPiExtension(pi);
    await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/work/tree" });

    const files = fs.readdirSync(tmp);
    assert.equal(files.length, 1);
    assert.match(files[0], /^pi-[0-9a-f-]+\.json$/);
    assert.notEqual(files[0], `pi-${process.pid}.json`);

    const record = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), "utf8"));
    assert.match(record.agent_id, /^pi-[0-9a-f-]+$/);
    assert.equal(record.runtime.workspace, path.resolve("/work/tree"));
    assert.equal("goal" in record, false);
    assert.equal("task" in record, false);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = previous;
  }
});

test("extension ignores duplicate load on same pi instance", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-ext-"));
  const previous = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
    },
  };

  try {
    agentStatusPiExtension(pi);
    agentStatusPiExtension(pi);

    for (const list of handlers.values()) assert.equal(list.length, 1);

    await handlers.get("session_start")?.[0]?.({ reason: "startup" }, { cwd: "/work/tree" });
    await handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, {});

    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = previous;
  }
});

test("extension ignores duplicate session across separate pi wrappers", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-ext-"));
  const previous = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const handlersA = new Map();
  const handlersB = new Map();
  const piA = { on(event, handler) { handlersA.set(event, handler); } };
  const piB = { on(event, handler) { handlersB.set(event, handler); } };
  const ctx = {
    cwd: "/work/tree",
    sessionManager: { getSessionFile: () => "/tmp/shared-session.jsonl" },
  };

  try {
    agentStatusPiExtension(piA);
    agentStatusPiExtension(piB);

    await handlersA.get("session_start")?.({ reason: "startup" }, ctx);
    await handlersB.get("session_start")?.({ reason: "startup" }, ctx);

    const filesAfterStart = fs.readdirSync(tmp);
    assert.equal(filesAfterStart.length, 1);

    await handlersA.get("session_shutdown")?.({ reason: "quit" }, ctx);
    await handlersB.get("session_shutdown")?.({ reason: "quit" }, ctx);

    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = previous;
  }
});

test("extension session_start switches session ownership and clears goal and task", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-ext-"));
  const previous = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const handlers = new Map();
  const listeners = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    events: {
      on(event, handler) {
        const list = listeners.get(event) || [];
        list.push(handler);
        listeners.set(event, list);
      },
      emit(event, data) {
        for (const handler of listeners.get(event) || []) handler(data);
      },
    },
  };

  try {
    agentStatusPiExtension(pi);

    const firstCtx = {
      cwd: "/work/first",
      sessionManager: { getSessionFile: () => "/tmp/first-session.jsonl" },
    };
    const secondCtx = {
      cwd: "/work/second",
      sessionManager: { getSessionFile: () => "/tmp/second-session.jsonl" },
    };

    await handlers.get("session_start")?.({ reason: "startup" }, firstCtx);
    await handlers.get("before_agent_start")?.({ prompt: "First session goal" }, firstCtx);
    await handlers.get("agent_end")?.({}, firstCtx);

    let files = fs.readdirSync(tmp);
    assert.equal(files.length, 1);
    let record = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), "utf8"));
    assert.equal(record.goal.summary, "First session goal");
    assert.equal("task" in record, false);

    await handlers.get("session_start")?.({ reason: "switch" }, secondCtx);

    files = fs.readdirSync(tmp);
    assert.equal(files.length, 1);
    record = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), "utf8"));
    assert.equal(record.runtime.workspace, path.resolve("/work/second"));
    assert.equal("goal" in record, false);
    assert.equal("task" in record, false);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, secondCtx);
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = previous;
  }
});

test("extension agent_end clears task but keeps goal", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-ext-"));
  const previous = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const handlers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
  };

  try {
    agentStatusPiExtension(pi);
    const ctx = {
      cwd: "/work/tree",
      sessionManager: { getSessionFile: () => "/tmp/session.jsonl" },
    };

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("before_agent_start")?.({ prompt: "Persist session intent" }, ctx);
    await handlers.get("agent_end")?.({}, ctx);

    const files = fs.readdirSync(tmp);
    const record = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), "utf8"));
    assert.equal(record.goal.summary, "Persist session intent");
    assert.equal("task" in record, false);

    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = previous;
  }
});
