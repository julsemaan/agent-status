import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeSimple } from "@earendil-works/pi-ai";

export const SCHEMA_VERSION = "agent-status/v1alpha1";
export const HEARTBEAT_INTERVAL_MS = 20_000;
const EXTENSION_LOADED = Symbol.for("agent-status.pi-extension.loaded");
const ACTIVE_SESSIONS = Symbol.for("agent-status.pi-extension.active-sessions");

export function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function getStatusDir(env = process.env, homeDir = os.homedir()) {
  if (env.AGENT_STATUS_DIR) return path.resolve(expandHome(env.AGENT_STATUS_DIR, homeDir));
  if (env.XDG_STATE_HOME) return path.resolve(expandHome(env.XDG_STATE_HOME, homeDir), "agent-status");
  return path.resolve(homeDir, ".local", "state", "agent-status");
}

export function sanitizeAgentId(value) {
  const text = String(value || "").trim();
  return text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "pi";
}

export function createSessionAgentId(prefix = "pi") {
  return sanitizeAgentId(`${prefix}-${crypto.randomUUID()}`);
}

export function summarizePrompt(prompt, maxLength = 120) {
  const text = String(prompt || "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function parseTmuxEnvironment(env = process.env) {
  const match = String(env.TMUX || "").match(/^(.+),(\d+),(\d+)$/);
  if (!match || !/^%\d+$/.test(String(env.TMUX_PANE || ""))) return undefined;
  return { tmux_socket: match[1], tmux_pane: env.TMUX_PANE };
}

export function buildStatusPath(agentId, env = process.env, homeDir = os.homedir()) {
  return path.join(getStatusDir(env, homeDir), `${sanitizeAgentId(agentId)}.json`);
}

export function buildBaseRecord({ agentId, workspace, pid = process.pid, lifecycle = "running", now = nowUtc() }) {
  const runtime = {
    lifecycle,
    updated_at: now,
    pid,
  };

  if (workspace) runtime.workspace = path.resolve(workspace);

  return {
    schema_version: SCHEMA_VERSION,
    agent_id: sanitizeAgentId(agentId),
    agent_name: "pi",
    runtime,
  };
}

export function withTask(record, task) {
  const next = structuredClone(record);
  if (!task) {
    delete next.task;
    return next;
  }
  next.task = task;
  return next;
}

export function withGoal(record, goal) {
  const next = structuredClone(record);
  if (!goal) {
    delete next.goal;
    return next;
  }
  next.goal = goal;
  return next;
}

export function updateRuntime(record, patch = {}, now = nowUtc()) {
  const next = structuredClone(record);
  next.runtime = {
    ...next.runtime,
    ...patch,
    updated_at: patch.updated_at || now,
  };
  return next;
}

export function buildTempPath(filePath) {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
}

export function writeStatusFile(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const data = `${JSON.stringify(record, null, 2)}\n`;
  const tempPath = buildTempPath(filePath);
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
}

export function getSessionKey(ctx = {}) {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) return `session-file:${String(sessionFile)}`;

  const cwd = ctx.cwd ? path.resolve(ctx.cwd) : process.cwd();
  return `pid:${process.pid}:cwd:${cwd}`;
}

function getActiveSessions() {
  if (!globalThis[ACTIVE_SESSIONS]) globalThis[ACTIVE_SESSIONS] = new Map();
  return globalThis[ACTIVE_SESSIONS];
}

function expandHome(value, homeDir) {
  if (!value.startsWith("~")) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return value;
}

async function llmSummarize(prompt, ctx) {
  if (!prompt || !ctx.model) return undefined;
  try {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
    if (!auth?.ok || !auth.apiKey) return undefined;

    const response = await completeSimple(
      ctx.model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: `One-line summary of the user's request:\n\n${prompt}` }],
          timestamp: Date.now(),
        }],
      },
      { apiKey: auth.apiKey, headers: auth.headers },
    );

    const text = response.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    return text || undefined;
  } catch (err) {
    console.error("[agent-status] llmSummarize failed:", err);
    ctx.ui?.notify("[agent-status] LLM summarization failed, using fallback", "warning");
    return undefined;
  }
}

export default function agentStatusPiExtension(pi) {
  if (process.env.PI_SUBAGENT === "1") return;
  if (pi[EXTENSION_LOADED]) return;
  pi[EXTENSION_LOADED] = true;

  const ownerId = crypto.randomUUID();
  const agentId = createSessionAgentId();
  const statusPath = buildStatusPath(agentId);
  let heartbeat = undefined;
  let activeSessionKey = undefined;
  let enabled = false;
  let current = buildBaseRecord({ agentId });

  // -- Composable task sources --
  let coreTask = undefined; // active prompt-derived task only
  let goal = undefined; // first-prompt durable session intent
  let bridgeData = undefined; // from agent-status:profile event
  let promptSequence = 0;
  let activeTaskSequence = undefined;
  let goalSequence = undefined;
  let sessionSequence = 0;

  const flush = () => {
    if (!enabled) return;
    // ponytail: compose final record from sources inline, no extra abstraction
    let record = current;

    record = withGoal(record, goal);
    record = withTask(record, bridgeData?.task || coreTask || undefined);

    const xMeta = { ...bridgeData?.x_meta };
    delete xMeta.tmux_socket;
    delete xMeta.tmux_pane;
    Object.assign(xMeta, parseTmuxEnvironment());
    if (Object.keys(xMeta).length) record.x_meta = xMeta;
    else delete record.x_meta;

    writeStatusFile(statusPath, record);
  };
  const touch = (patch = {}) => {
    if (!enabled) return;
    current = updateRuntime(current, patch);
    flush();
  };
  const setCoreTask = (task, sequence = activeTaskSequence) => {
    if (!enabled) return;
    coreTask = task;
    activeTaskSequence = task ? sequence : undefined;
    current = updateRuntime(current, { last_activity_at: nowUtc() });
    flush();
  };
  const setGoal = (nextGoal, sequence = goalSequence) => {
    if (!enabled) return;
    goal = nextGoal;
    goalSequence = nextGoal ? sequence : undefined;
    current = updateRuntime(current, { last_activity_at: nowUtc() });
    flush();
  };
  const startHeartbeat = () => {
    if (!enabled || heartbeat) return;
    heartbeat = setInterval(() => {
      current = updateRuntime(current);
      flush();
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
  };
  const stopHeartbeat = () => {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const releaseSession = () => {
    if (!activeSessionKey) return;
    const activeSessions = getActiveSessions();
    if (activeSessions.get(activeSessionKey) === ownerId) activeSessions.delete(activeSessionKey);
    activeSessionKey = undefined;
    enabled = false;
  };

  pi.on("session_start", async (_event, ctx) => {
    const sessionKey = getSessionKey(ctx);
    const activeSessions = getActiveSessions();
    if (activeSessionKey && activeSessionKey !== sessionKey) releaseSession();
    if (activeSessions.has(sessionKey)) return;

    activeSessions.set(sessionKey, ownerId);
    activeSessionKey = sessionKey;
    enabled = true;
    sessionSequence += 1;
    coreTask = undefined;
    goal = undefined;
    bridgeData = undefined;
    promptSequence = 0;
    activeTaskSequence = undefined;
    goalSequence = undefined;

    // ponytail: restore goal from session entries (on resume/fork/startup with existing session)
    // no-op on fresh sessions (getEntries returns [])
    const entries = ctx.sessionManager?.getEntries?.() || [];
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "agent-status.goal" && entry.data) {
        goal = entry.data;
      }
    }

    current = buildBaseRecord({
      agentId,
      workspace: ctx.cwd,
      lifecycle: "running",
    });
    flush();
    startHeartbeat();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt;
    const fallbackSummary = summarizePrompt(prompt);
    const sequence = ++promptSequence;
    const currentSessionSequence = sessionSequence;
    const summarize = ctx.agentStatusSummarize || llmSummarize;
    const contextId = ctx.sessionManager?.getSessionFile?.() ? String(ctx.sessionManager.getSessionFile()) : undefined;

    const summaryPromise = Promise.resolve(summarize(prompt, ctx)).catch(() => undefined);

    if (!goal) {
      const baseGoal = {
        summary: fallbackSummary,
        updated_at: nowUtc(),
        source: "initial-prompt",
      };
      setGoal(baseGoal, sequence);
      try { pi.appendEntry?.("agent-status.goal", baseGoal); } catch {}

      summaryPromise.then(llmSummary => {
        if (!llmSummary || llmSummary === fallbackSummary) return;
        if (!enabled || sessionSequence !== currentSessionSequence || goalSequence !== sequence) return;
        const refinedGoal = {
          summary: llmSummary,
          updated_at: nowUtc(),
          source: "initial-prompt",
        };
        setGoal(refinedGoal, sequence);
        try { pi.appendEntry?.("agent-status.goal", refinedGoal); } catch {}
      });
    }

    const task = {
      state: "working",
      summary: fallbackSummary,
      status_timestamp: nowUtc(),
      ...(contextId ? { context_id: contextId } : {}),
    };
    setCoreTask(task, sequence);

    summaryPromise.then(llmSummary => {
      if (!llmSummary || llmSummary === fallbackSummary) return;
      if (!enabled || sessionSequence !== currentSessionSequence || activeTaskSequence !== sequence || !coreTask) return;
      setCoreTask({ ...task, summary: llmSummary, status_timestamp: nowUtc() }, sequence);
    });
  });

  pi.on("tool_execution_start", async () => {
    touch({ last_activity_at: nowUtc() });
  });

  pi.on("tool_execution_end", async () => {
    touch({ last_activity_at: nowUtc() });
  });

  pi.on("agent_end", async () => {
    if (!enabled) return;
    setCoreTask(undefined);
    current = updateRuntime(current);
    flush();
  });

  pi.on("session_shutdown", async () => {
    if (!enabled) return;
    stopHeartbeat();
    coreTask = undefined;
    goal = undefined;
    bridgeData = undefined;
    activeTaskSequence = undefined;
    goalSequence = undefined;
    fs.rmSync(statusPath, { force: true });
    releaseSession();
  });

  // -- Bridge composition event --
  // external profile-side bridge may emit this with structured
  // task priority (input-required > working > submitted) and x_meta.pi.
  if (pi.events) {
    pi.events.on("agent-status:profile", (data) => {
      if (!enabled) return;
      bridgeData = data;
      flush();
    });
  }
}
