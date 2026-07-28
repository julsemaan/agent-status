import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = "agent-status/v1alpha1";
export const HEARTBEAT_INTERVAL_MS = 20_000;
const OWNERS = Symbol.for("agent-status.opencode-plugin.owners");

export function nowUtc() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }

function expandHome(value, homeDir) {
  if (value === "~") return homeDir;
  return value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value;
}

export function getStatusDir(env = process.env, homeDir = os.homedir()) {
  if (env.AGENT_STATUS_DIR) return path.resolve(expandHome(env.AGENT_STATUS_DIR, homeDir));
  if (env.XDG_STATE_HOME) return path.resolve(expandHome(env.XDG_STATE_HOME, homeDir), "agent-status");
  return path.resolve(homeDir, ".local", "state", "agent-status");
}

export function sanitizeAgentId(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "opencode";
}

export function createAgentId() { return `opencode-${crypto.randomUUID()}`; }
export function buildStatusPath(agentId, env = process.env, homeDir = os.homedir()) {
  return path.join(getStatusDir(env, homeDir), `${sanitizeAgentId(agentId)}.json`);
}
export function buildTempPath(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
}

export function writeStatusFile(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = buildTempPath(filePath);
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

export function parseTmuxEnvironment(env = process.env) {
  const match = String(env.TMUX || "").match(/^(.+),(\d+),(\d+)$/);
  if (!match || !/^%\d+$/.test(String(env.TMUX_PANE || ""))) return undefined;
  return { tmux_socket: match[1], tmux_pane: env.TMUX_PANE };
}

function summarize(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function textFromParts(parts = []) {
  return summarize(parts.filter(part => part?.type === "text").map(part => part.text).join(" "));
}
function sessionId(properties = {}) {
  return properties.sessionID || properties.info?.id || properties.part?.sessionID || properties.message?.sessionID;
}
function owners() {
  if (!globalThis[OWNERS]) globalThis[OWNERS] = new Map();
  return globalThis[OWNERS];
}

export async function AgentStatusPlugin({ client, directory, project } = {}) {
  const owner = crypto.randomUUID();
  const sessions = new Map();
  const statusDir = getStatusDir();

  const flush = state => {
    const time = nowUtc();
    const record = {
      schema_version: SCHEMA_VERSION,
      agent_id: state.agentId,
      agent_name: "opencode",
      runtime: {
        lifecycle: "running",
        updated_at: time,
        pid: process.pid,
        workspace: path.resolve(directory || process.cwd()),
        ...(state.lastActivity ? { last_activity_at: state.lastActivity } : {}),
      },
      x_meta: {
        opencode: {
          session_id: state.sessionID,
          ...(project?.id ? { project_id: project.id } : {}),
        },
        ...parseTmuxEnvironment(),
      },
    };
    if (state.goal) record.goal = state.goal;
    const summary = state.blocked || state.error || state.active || state.pending || state.trailingQuestion;
    const taskState = state.blocked || state.trailingQuestion ? "input-required"
      : state.error ? "failed"
      : state.active ? "working"
      : state.pending ? "submitted"
      : undefined;
    if (taskState) record.task = {
      state: taskState,
      ...(summary ? { summary } : {}),
      status_timestamp: time,
      context_id: state.sessionID,
    };
    writeStatusFile(state.file, record);
  };

  const touch = (state, active) => {
    if (!state) return;
    state.lastActivity = nowUtc();
    if (active) {
      state.active = state.active || active;
      state.error = undefined;
      state.trailingQuestion = undefined;
    }
    flush(state);
  };

  const restoreGoal = async state => {
    try {
      const response = await client?.session?.messages?.({ path: { id: state.sessionID } });
      if (state.goal || sessions.get(state.sessionID) !== state) return;
      const first = response?.data?.find(item => item?.info?.role === "user" && !item.info.synthetic);
      const summary = textFromParts(first?.parts);
      if (!summary || state.goal) return;
      state.goal = { summary, updated_at: nowUtc(), source: "initial-prompt" };
      flush(state);
    } catch {}
  };

  const start = properties => {
    const info = properties.info || properties;
    const id = info.id || properties.sessionID;
    if (!id || info.parentID || sessions.has(id) || owners().has(id)) return;
    owners().set(id, owner);
    const agentId = createAgentId();
    const state = { sessionID: id, agentId, file: path.join(statusDir, `${agentId}.json`) };
    sessions.set(id, state);
    flush(state);
    state.heartbeat = setInterval(() => flush(state), HEARTBEAT_INTERVAL_MS);
    state.heartbeat.unref?.();
    void restoreGoal(state);
    return state;
  };

  const remove = id => {
    const state = sessions.get(id);
    if (!state) return;
    clearInterval(state.heartbeat);
    fs.rmSync(state.file, { force: true });
    sessions.delete(id);
    if (owners().get(id) === owner) owners().delete(id);
  };

  const event = async ({ event }) => {
    const p = event.properties || {};
    const id = sessionId(p);
    if (event.type === "session.created") { start(p); return; }
    if (event.type === "session.deleted") { remove(id); return; }
    const state = sessions.get(id);
    if (!state) return;

    if (event.type === "session.status" && ["busy", "retry"].includes(p.status?.type)) touch(state, state.active || "Working");
    else if (event.type === "question.asked") { state.blocked = summarize(p.questions?.[0]?.question) || "Waiting for user input"; flush(state); }
    else if (event.type === "permission.asked") { state.blocked = "Waiting for permission"; flush(state); }
    else if (["question.replied", "question.rejected", "permission.replied"].includes(event.type)) { state.blocked = undefined; state.active ||= "Working"; touch(state); }
    else if (event.type === "todo.updated") {
      const open = p.todos?.find(todo => !["completed", "cancelled", "canceled"].includes(todo.status));
      state.pending = open ? summarize(open.content) || "Pending work" : undefined;
      flush(state);
    } else if (event.type === "session.error") {
      state.error = summarize(p.error?.message || p.error?.name || "Session failed");
      state.active = undefined;
      flush(state);
    } else if (event.type === "message.part.updated" && p.part?.type === "text") {
      state.assistantText = p.part.text || "";
    } else if (event.type === "message.updated" && p.info?.role === "assistant") {
      state.assistantText = p.info.text || state.assistantText;
    } else if (event.type === "session.idle") {
      state.active = undefined;
      state.error = undefined;
      state.trailingQuestion = state.blocked ? undefined : /\?\s*$/.test(state.assistantText || "") ? summarize(state.assistantText) : undefined;
      flush(state);
    }
  };

  const chatMessage = async (input, output) => {
    const state = sessions.get(input.sessionID) || start({ sessionID: input.sessionID });
    if (!state || output.message?.role !== "user" || output.message?.synthetic) return;
    const prompt = textFromParts(output.parts);
    if (!prompt) return;
    if (!state.goal) state.goal = { summary: prompt, updated_at: nowUtc(), source: "initial-prompt" };
    state.active = prompt;
    state.blocked = state.error = state.trailingQuestion = undefined;
    touch(state);
  };

  const toolBefore = async input => {
    const state = sessions.get(input.sessionID);
    if (!state) return;
    if (input.tool === "question") {
      state.blocked = "Waiting for user input";
      flush(state);
    } else touch(state, state.active || `Using ${input.tool}`);
  };
  const toolAfter = async input => {
    const state = sessions.get(input.sessionID);
    if (!state) return;
    if (input.tool === "question") state.blocked = undefined;
    touch(state, state.active || `Using ${input.tool}`);
  };
  const dispose = async () => { for (const id of [...sessions.keys()]) remove(id); };

  return { event, dispose, "chat.message": chatMessage, "tool.execute.before": toolBefore, "tool.execute.after": toolAfter };
}

export default { id: "agent-status", server: AgentStatusPlugin };
