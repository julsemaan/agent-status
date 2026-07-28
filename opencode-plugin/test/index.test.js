import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AgentStatusPlugin, {
  HEARTBEAT_INTERVAL_MS,
  buildStatusPath,
  buildTempPath,
  createAgentId,
  getStatusDir,
  parseTmuxEnvironment,
  sanitizeAgentId,
  writeStatusFile,
} from "../index.js";

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "agent-status-opencode-")); }
function readOnly(dir) {
  const files = fs.readdirSync(dir).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
}
async function harness({ messages = [], directory = "/work/tree" } = {}) {
  const dir = tempDir();
  const old = process.env.AGENT_STATUS_DIR;
  process.env.AGENT_STATUS_DIR = dir;
  const plugin = await AgentStatusPlugin.server({
    directory,
    project: { id: "project-1" },
    client: { session: { messages: async () => ({ data: messages }) } },
  });
  return {
    dir,
    hooks: plugin,
    async event(type, properties) { await plugin.event({ event: { type, properties } }); },
    restore() {
      if (old === undefined) delete process.env.AGENT_STATUS_DIR;
      else process.env.AGENT_STATUS_DIR = old;
    },
  };
}

test("directory resolution, ID sanitization, and unique random names", () => {
  assert.equal(getStatusDir({ AGENT_STATUS_DIR: "~/custom" }, "/home/me"), "/home/me/custom");
  assert.equal(getStatusDir({ XDG_STATE_HOME: "/state" }, "/home/me"), "/state/agent-status");
  assert.equal(getStatusDir({}, "/home/me"), "/home/me/.local/state/agent-status");
  assert.equal(sanitizeAgentId("open code / one"), "open-code-one");
  assert.equal(buildStatusPath("x / y", { AGENT_STATUS_DIR: "/tmp/s" }), "/tmp/s/x-y.json");
  const ids = new Set(Array.from({ length: 10 }, () => createAgentId()));
  assert.equal(ids.size, 10);
  for (const id of ids) assert.match(id, /^opencode-[0-9a-f-]+$/);
  assert.notEqual(buildTempPath("/tmp/a.json"), buildTempPath("/tmp/a.json"));
});

test("atomic writes stay parseable and leave no temp files", () => {
  const dir = tempDir();
  const file = path.join(dir, "agent.json");
  for (let i = 0; i < 5; i++) writeStatusFile(file, { value: i });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { value: 4 });
  assert.deepEqual(fs.readdirSync(dir), ["agent.json"]);
});

test("tmux metadata requires valid socket and pane pair", () => {
  assert.deepEqual(parseTmuxEnvironment({ TMUX: "/tmp/a,b,12,3", TMUX_PANE: "%4" }), { tmux_socket: "/tmp/a,b", tmux_pane: "%4" });
  assert.equal(parseTmuxEnvironment({ TMUX: "/tmp/a,12,3", TMUX_PANE: "4" }), undefined);
  assert.equal(parseTmuxEnvironment({ TMUX: "/tmp/a,no,3", TMUX_PANE: "%4" }), undefined);
});

test("session lifecycle keeps first goal and clears task on idle", async () => {
  const h = await harness();
  try {
    await h.event("session.created", { info: { id: "s1" } });
    let record = readOnly(h.dir);
    assert.equal(record.schema_version, "agent-status/v1alpha1");
    assert.match(record.agent_id, /^opencode-[0-9a-f-]+$/);
    assert.equal(record.agent_name, "opencode");
    assert.equal(record.runtime.lifecycle, "running");
    assert.match(record.runtime.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.equal(record.runtime.workspace, path.resolve("/work/tree"));
    assert.equal(record.runtime.pid, process.pid);
    assert.equal("task" in record, false);

    await h.hooks["chat.message"]({ sessionID: "s1" }, { message: { role: "user" }, parts: [{ type: "text", text: "Build first thing" }] });
    record = readOnly(h.dir);
    assert.equal(record.task.state, "working");
    assert.equal(record.task.context_id, "s1");
    assert.equal(record.goal.summary, "Build first thing");

    await h.hooks["chat.message"]({ sessionID: "s1" }, { message: { role: "user" }, parts: [{ type: "text", text: "Then second thing" }] });
    await h.event("session.idle", { sessionID: "s1" });
    record = readOnly(h.dir);
    assert.equal(record.goal.summary, "Build first thing");
    assert.equal("task" in record, false);
    assert.equal(record.x_meta.opencode.session_id, "s1");
  } finally { await h.hooks.dispose(); h.restore(); }
});

test("question and permission block then resume working", async () => {
  const h = await harness();
  try {
    await h.event("session.created", { info: { id: "s1" } });
    await h.hooks["chat.message"]({ sessionID: "s1" }, { message: { role: "user" }, parts: [{ type: "text", text: "Do work" }] });
    await h.hooks["tool.execute.before"]({ sessionID: "s1", tool: "question" }, {});
    assert.equal(readOnly(h.dir).task.state, "input-required");
    await h.hooks["tool.execute.after"]({ sessionID: "s1", tool: "question" }, {});
    assert.equal(readOnly(h.dir).task.state, "working");
    await h.event("question.asked", { sessionID: "s1", questions: [{ question: "Choose?" }] });
    await h.event("session.idle", { sessionID: "s1" });
    assert.equal(readOnly(h.dir).task.state, "input-required");
    await h.event("question.replied", { sessionID: "s1" });
    assert.equal(readOnly(h.dir).task.state, "working");
    await h.event("permission.asked", { sessionID: "s1", permission: "bash" });
    assert.equal(readOnly(h.dir).task.state, "input-required");
    await h.event("permission.replied", { sessionID: "s1" });
    assert.equal(readOnly(h.dir).task.state, "working");
  } finally { await h.hooks.dispose(); h.restore(); }
});

test("pending todos become submitted only while idle", async () => {
  const h = await harness();
  try {
    await h.event("session.created", { info: { id: "s1" } });
    await h.event("todo.updated", { sessionID: "s1", todos: [{ content: "Finish tests", status: "pending" }] });
    assert.equal(readOnly(h.dir).task.state, "submitted");
    await h.hooks["chat.message"]({ sessionID: "s1" }, { message: { role: "user" }, parts: [{ type: "text", text: "Work now" }] });
    assert.equal(readOnly(h.dir).task.state, "working");
    await h.event("session.idle", { sessionID: "s1" });
    assert.equal(readOnly(h.dir).task.state, "submitted");
    await h.event("todo.updated", { sessionID: "s1", todos: [{ content: "Done", status: "completed" }] });
    assert.equal("task" in readOnly(h.dir), false);
  } finally { await h.hooks.dispose(); h.restore(); }
});

test("session error is transient failed state", async () => {
  const h = await harness();
  try {
    await h.event("session.created", { info: { id: "s1" } });
    await h.event("session.error", { sessionID: "s1", error: { message: "boom" } });
    assert.equal(readOnly(h.dir).task.state, "failed");
    await h.event("session.idle", { sessionID: "s1" });
    assert.equal("task" in readOnly(h.dir), false);
  } finally { await h.hooks.dispose(); h.restore(); }
});

test("restores goal from resumed session messages", async () => {
  const h = await harness({ messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "Original goal" }] }] });
  try {
    await h.event("session.created", { info: { id: "resume" } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readOnly(h.dir).goal.summary, "Original goal");
  } finally { await h.hooks.dispose(); h.restore(); }
});

test("sessions stay isolated; child and duplicate owners are excluded", async () => {
  const h1 = await harness();
  const h2 = await harness();
  try {
    await h1.event("session.created", { info: { id: "parent" } });
    await h1.event("session.created", { info: { id: "child", parentID: "parent" } });
    await h2.event("session.created", { info: { id: "parent" } });
    assert.equal(fs.readdirSync(h1.dir).filter(x => x.endsWith(".json")).length, 1);
    assert.equal(fs.readdirSync(h2.dir).filter(x => x.endsWith(".json")).length, 0);
    await h1.event("session.created", { info: { id: "other" } });
    assert.equal(fs.readdirSync(h1.dir).filter(x => x.endsWith(".json")).length, 2);
    await h1.event("session.deleted", { info: { id: "parent" } });
    assert.equal(fs.readdirSync(h1.dir).filter(x => x.endsWith(".json")).length, 1);
  } finally { await h1.hooks.dispose(); await h2.hooks.dispose(); h1.restore(); h2.restore(); }
});

test("tool activity, status, trailing questions, and cleanup", async () => {
  const h = await harness();
  try {
    await h.event("session.created", { info: { id: "s1" } });
    await h.hooks["tool.execute.before"]({ sessionID: "s1", tool: "bash" }, {});
    assert.equal(readOnly(h.dir).task.state, "working");
    await h.event("message.part.updated", { part: { sessionID: "s1", type: "text", text: "Need anything else?" } });
    await h.event("session.idle", { sessionID: "s1" });
    assert.equal(readOnly(h.dir).task.state, "input-required");
    await h.event("session.status", { sessionID: "s1", status: { type: "busy" } });
    assert.equal(readOnly(h.dir).task.state, "working");
    await h.hooks.dispose();
    assert.deepEqual(fs.readdirSync(h.dir), []);
  } finally { await h.hooks.dispose(); h.restore(); }
  assert.equal(HEARTBEAT_INTERVAL_MS, 20_000);
});
