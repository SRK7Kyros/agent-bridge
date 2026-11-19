/**
 * Level 3 - the peer's OpenCode agent, as a conversational peer.
 *
 * This is not a subagent call and not a shared session. It is two independent
 * servers, each with its own config, its own AGENTS.md and its own authority,
 * exchanging prompts over HTTP. What comes back is the peer's answer, not an
 * extension of the caller's context.
 *
 * Transport: the peer's `opencode serve` HTTP API, reached directly (public
 * hostname) or through a tailnet proxy, with HTTP basic auth.
 */
import { resolveSecret, type AgentConfig, type BridgeConfig, type HostConfig } from "./config.ts";

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AgentError";
  }
}

export interface AgentInfo {
  version: string;
  pid?: number;
  hostname?: string;
  urls?: string[];
}

export interface SessionSummary {
  id: string;
  title?: string;
  agent?: string;
  created?: number;
  updated?: number;
  busy?: number;
  idle?: number;
}

export interface Message {
  id: string;
  role: string;
  created?: number;
  text: string;
}

export interface Envelope {
  from: string;
  to: string;
  thread: string;
  msg: number;
}

function requireAgent(host: HostConfig): AgentConfig {
  const agent = host.agent;
  if (!agent?.enabled) throw new AgentError("agent access is not enabled for this host");
  if (!agent.baseUrl) throw new AgentError("agent.baseUrl is required");
  return agent;
}

function authHeader(agent: AgentConfig): Record<string, string> {
  const password = resolveSecret(agent.password);
  if (!password) return {};
  const user = agent.username ?? "opencode";
  const token = Buffer.from(`${user}:${password}`, "utf8").toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function call<T>(
  host: HostConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  const agent = requireAgent(host);
  const base = agent.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...authHeader(agent),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " — the route is up and the credential is wrong (rotated password or restarted server)"
          : res.status === 499
            ? " — the caller gave up while the peer was mid-turn; poll messages and retry"
            : "";
      throw new AgentError(
        `HTTP ${res.status} ${method} ${path}${hint}: ${text.slice(0, 400)}`,
        res.status,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  } catch (err) {
    if (err instanceof AgentError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new AgentError(`request to ${base}${path} timed out after ${timeoutMs} ms`);
    }
    throw new AgentError(`cannot reach ${base}${path}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function info(host: HostConfig): Promise<AgentInfo> {
  return call<AgentInfo>(host, "GET", "/api/info", undefined, 20_000);
}

export async function listSessions(
  host: HostConfig,
  opts: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<SessionSummary[]> {
  const limit = opts.limit ?? 20;
  const order = opts.order ?? "desc";
  const raw = await call<{ data?: any[] } | any[]>(
    host,
    "GET",
    `/api/session?limit=${limit}&order=${order}`,
  );
  const rows = Array.isArray(raw) ? raw : (raw?.data ?? []);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    agent: r.agent,
    created: r.time?.created,
    updated: r.time?.updated,
    busy: r.time?.busy,
    idle: r.time?.idle,
  }));
}

export async function createSession(
  host: HostConfig,
  opts: { title: string; agent?: string; directory?: string },
): Promise<SessionSummary> {
  const cfg = requireAgent(host);
  const body: Record<string, unknown> = {
    title: opts.title,
    agent: opts.agent ?? cfg.agent,
    location: { directory: opts.directory ?? cfg.directory },
  };
  const raw = await call<any>(host, "POST", "/api/session", body, 60_000);
  const row = raw?.data ?? raw;
  return {
    id: row.id,
    title: row.title,
    agent: row.agent,
    created: row.time?.created,
  };
}

/** Prepend the BRIDGE envelope line, stamping `sent` in this process. */
export function withEnvelope(text: string, env?: Envelope): string {
  if (!env) return text;
  const header = `[BRIDGE v2] from=${env.from} to=${env.to} re=${env.thread} msg=${env.msg} sent=${Date.now()}`;
  return `${header}\n\n${text}`;
}

export async function say(
  host: HostConfig,
  session: string,
  text: string,
  env?: Envelope,
): Promise<{ id?: string; created?: number }> {
  const body = { text: withEnvelope(text, env) };
  const raw = await call<any>(host, "POST", `/api/session/${session}/prompt`, body, 120_000);
  const row = raw?.data ?? raw ?? {};
  return { id: row.id, created: row.time?.created ?? row.created };
}

export async function waitForIdle(
  host: HostConfig,
  session: string,
  timeoutMs = 900_000,
): Promise<{ state: "idle" | "timeout" }> {
  try {
    await call(host, "POST", `/api/experimental/session/${session}/wait`, {}, timeoutMs);
    return { state: "idle" };
  } catch (err) {
    if (err instanceof AgentError && err.message.includes("timed out")) return { state: "timeout" };
    if (err instanceof AgentError && err.status === 499) return { state: "timeout" };
    throw err;
  }
}

function extractText(message: any): string {
  const parts = message?.content ?? message?.parts;
  if (Array.isArray(parts)) {
    const joined = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n");
    if (joined) return joined;
  }
  // User turns carry a top-level `text`; some versions nest it under `payload`.
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.payload?.text === "string") return message.payload.text;
  return "";
}

export async function messages(
  host: HostConfig,
  session: string,
  opts: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<Message[]> {
  const limit = opts.limit ?? 20;
  const order = opts.order ?? "desc";
  const raw = await call<any>(
    host,
    "GET",
    `/api/session/${session}/message?limit=${limit}&order=${order}`,
  );
  const rows = Array.isArray(raw) ? raw : (raw?.data ?? []);
  return rows.map((m: any) => ({
    id: m.id,
    role: m.type ?? m.role ?? m.info?.role ?? "unknown",
    created: m.time?.created ?? m.created,
    text: extractText(m),
  }));
}
