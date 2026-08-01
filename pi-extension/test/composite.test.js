import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import agentStatusPiExtension from "../index.js";

function createMockPi() {
  const lifecycleHandlers = new Map();
  const eventListeners = new Map();

  const pi = {
    on(event, handler) {
      lifecycleHandlers.set(event, handler);
    },
    events: {
      on(event, handler) {
        const list = eventListeners.get(event) || [];
        list.push(handler);
        eventListeners.set(event, list);
      },
      emit(event, data) {
        const list = eventListeners.get(event) || [];
        for (const handler of [...list]) handler(data);
      },
    },
  };

  return { pi, lifecycleHandlers };
}

function readStatusFile(dir) {
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function testCtx(name, extra = {}) {
  return {
    cwd: `/tmp/${name}`,
    sessionManager: { getSessionFile: () => `/tmp/${name}.jsonl` },
    ...extra,
  };
}

async function flushAsync() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("composite: first prompt sets goal and active task", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("first-prompt");

    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Refactor scheduler tests" }, ctx);

    const record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Refactor scheduler tests");
    assert.equal(record.goal.source, "initial-prompt");
    assert.equal(record.task.state, "working");
    assert.equal(record.task.summary, "Refactor scheduler tests");
    assert.equal(record.task.context_id, "/tmp/first-prompt.jsonl");
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: second prompt updates task but keeps goal", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("second-prompt");

    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "First prompt becomes goal" }, ctx);
    await lifecycleHandlers.get("agent_end")?.({}, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Second prompt becomes task" }, ctx);

    const record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "First prompt becomes goal");
    assert.equal(record.task.summary, "Second prompt becomes task");
    assert.equal(record.task.state, "working");
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: agent_end clears task and keeps goal", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("agent-end");

    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Keep goal only" }, ctx);
    await lifecycleHandlers.get("agent_end")?.({}, ctx);

    const record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Keep goal only");
    assert.equal("task" in record, false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: idle heartbeat keeps goal without task", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("idle-heartbeat");

    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Persist goal through idle" }, ctx);
    await lifecycleHandlers.get("agent_end")?.({}, ctx);
    await lifecycleHandlers.get("tool_execution_start")?.({}, ctx);
    await lifecycleHandlers.get("tool_execution_end")?.({}, ctx);

    const record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Persist goal through idle");
    assert.equal("task" in record, false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: bridge submitted still works for real queued work", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("bridge-submitted");
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);

    pi.events.emit("agent-status:profile", {
      task: { state: "submitted", summary: "2 open todos pending" },
      x_meta: {
        pi: {
          mode: "build",
          ponytail: "full",
          todo: { open: 2, done: 1, current: "Fix bug" },
          goal: { active: false, status: "idle", text: "" },
          subagent: { active: false },
        },
      },
    });

    const record = readStatusFile(tmp);
    assert.equal(record.task.state, "submitted");
    assert.equal(record.task.summary, "2 open todos pending");
    assert.equal(record.x_meta.pi.todo.open, 2);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: valid tmux environment overrides bridge keys and preserves bridge metadata", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const previous = {
    statusDir: process.env.AGENT_STATUS_DIR,
    tmux: process.env.TMUX,
    pane: process.env.TMUX_PANE,
  };
  process.env.AGENT_STATUS_DIR = tmp;
  process.env.TMUX = "/tmp/tmux,socket/default,1234,7";
  process.env.TMUX_PANE = "%9";

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, testCtx("tmux-valid"));
    pi.events.emit("agent-status:profile", {
      x_meta: {
        pi: { mode: "build" },
        tmux_socket: "/bridge/socket",
        tmux_pane: "%1",
      },
    });

    const record = readStatusFile(tmp);
    assert.deepEqual(record.x_meta.pi, { mode: "build" });
    assert.equal(record.x_meta.tmux_socket, "/tmp/tmux,socket/default");
    assert.equal(record.x_meta.tmux_pane, "%9");
  } finally {
    restoreEnv("AGENT_STATUS_DIR", previous.statusDir);
    restoreEnv("TMUX", previous.tmux);
    restoreEnv("TMUX_PANE", previous.pane);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: invalid tmux environment strips bridge tmux keys", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const previous = { statusDir: process.env.AGENT_STATUS_DIR, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
  process.env.AGENT_STATUS_DIR = tmp;
  process.env.TMUX = "/tmp/default,1234,7";
  delete process.env.TMUX_PANE;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, testCtx("tmux-invalid"));
    pi.events.emit("agent-status:profile", {
      x_meta: { pi: { mode: "build" }, tmux_socket: "/bridge/socket", tmux_pane: "%1" },
    });

    const record = readStatusFile(tmp);
    assert.deepEqual(record.x_meta, { pi: { mode: "build" } });
  } finally {
    restoreEnv("AGENT_STATUS_DIR", previous.statusDir);
    restoreEnv("TMUX", previous.tmux);
    restoreEnv("TMUX_PANE", previous.pane);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: outside tmux emits no tmux metadata", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const previous = { statusDir: process.env.AGENT_STATUS_DIR, tmux: process.env.TMUX, pane: process.env.TMUX_PANE };
  process.env.AGENT_STATUS_DIR = tmp;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, testCtx("outside-tmux"));

    const record = readStatusFile(tmp);
    assert.equal("x_meta" in record, false);
  } finally {
    restoreEnv("AGENT_STATUS_DIR", previous.statusDir);
    restoreEnv("TMUX", previous.tmux);
    restoreEnv("TMUX_PANE", previous.pane);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: stale async older prompt cannot overwrite newer task", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  const first = deferred();
  const second = deferred();
  const summaries = [first, second];
  let callIndex = 0;

  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("stale-task-summary", {
      agentStatusSummarize: async () => summaries[callIndex++].promise,
    });

    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "First prompt" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Second prompt" }, ctx);

    second.resolve("Second better summary");
    await flushAsync();

    let record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "First prompt");
    assert.equal(record.task.summary, "Second better summary");

    first.resolve("First stale summary");
    await flushAsync();

    record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "First stale summary");
    assert.equal(record.task.summary, "Second better summary");
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: bridge task overrides prompt task", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("bridge-override");
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Do thing" }, ctx);

    pi.events.emit("agent-status:profile", {
      task: { state: "input-required", summary: "Waiting for user input" },
      x_meta: {
        pi: {
          mode: "build",
          ponytail: "full",
          todo: { open: 0, done: 0 },
          goal: { active: false, status: "idle", text: "" },
          subagent: { active: false },
        },
      },
    });

    const record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Do thing");
    assert.equal(record.task.state, "input-required");
    assert.equal(record.task.summary, "Waiting for user input");
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: question blocked survives agent_end via bridge", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("question-blocked");
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);

    pi.events.emit("agent-status:profile", {
      task: { state: "input-required", summary: "Waiting for user input" },
      x_meta: {
        pi: {
          mode: "build",
          ponytail: "full",
          todo: { open: 0, done: 0 },
          goal: { active: false, status: "idle", text: "" },
          subagent: { active: false },
        },
      },
    });

    await lifecycleHandlers.get("agent_end")?.({}, ctx);

    const record = readStatusFile(tmp);
    assert.equal(record.task.state, "input-required");
    assert.equal(record.x_meta.pi.mode, "build");
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: session_start resets goal and task", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const firstCtx = testCtx("first-session");
    const secondCtx = testCtx("second-session");

    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, firstCtx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Old session goal" }, firstCtx);
    await lifecycleHandlers.get("agent_end")?.({}, firstCtx);

    let record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Old session goal");
    assert.equal("task" in record, false);

    await lifecycleHandlers.get("session_start")?.({ reason: "switch" }, secondCtx);

    record = readStatusFile(tmp);
    assert.equal("goal" in record, false);
    assert.equal("task" in record, false);
    assert.equal(record.runtime.workspace, path.resolve("/tmp/second-session"));
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: shutdown removes file even with goal and bridge data", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const { pi, lifecycleHandlers } = createMockPi();
  try {
    agentStatusPiExtension(pi);
    const ctx = testCtx("shutdown");
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Goal before shutdown" }, ctx);
    await lifecycleHandlers.get("agent_end")?.({}, ctx);

    pi.events.emit("agent-status:profile", {
      task: { state: "submitted", summary: "pending" },
      x_meta: {
        pi: { mode: "build", ponytail: "full", todo: { open: 1, done: 0 }, goal: { active: false, status: "idle", text: "" }, subagent: { active: false } },
      },
    });

    await lifecycleHandlers.get("session_shutdown")?.({ reason: "quit" }, {});
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("composite: resume restores goal from custom entries", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-comp-"));
  const prev = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = tmp;

  const customEntries = [];
  const { pi, lifecycleHandlers } = createMockPi();
  pi.appendEntry = (customType, data) => {
    customEntries.push({ type: "custom", customType, data });
  };

  try {
    agentStatusPiExtension(pi);
    const ctx = {
      ...testCtx("resume-goal"),
      sessionManager: {
        getSessionFile: () => "/tmp/resume-goal.jsonl",
        getEntries: () => customEntries,
      },
    };

    // First session: start, set goal via prompt
    await lifecycleHandlers.get("session_start")?.({ reason: "startup" }, ctx);
    await lifecycleHandlers.get("before_agent_start")?.({ prompt: "Refactor auth module" }, ctx);

    let record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Refactor auth module");
    assert.equal(record.goal.source, "initial-prompt");
    assert.equal(customEntries.length, 1);
    assert.equal(customEntries[0].customType, "agent-status.goal");

    // Shutdown (simulates quit, status file deleted)
    await lifecycleHandlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    assert.deepEqual(fs.readdirSync(tmp), []);

    // Resume: should restore goal from custom entries
    await lifecycleHandlers.get("session_start")?.({ reason: "resume", previousSessionFile: "/tmp/resume-goal.jsonl" }, ctx);

    record = readStatusFile(tmp);
    assert.equal(record.goal.summary, "Refactor auth module");
    assert.equal(record.goal.source, "initial-prompt");
    assert.equal("task" in record, false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_STATUS_DIR;
    else process.env.AGENT_STATUS_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
