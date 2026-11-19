/**
 * Configuration loading and secret resolution.
 *
 * A config file describes the peers this host may reach and, per peer, which of
 * the three bridge levels are enabled. Nothing here talks to the network - this
 * module only turns a file on disk into a validated object.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type ShellKind = "posix" | "powershell";

export interface SshConfig {
  /** Anything ssh accepts as a destination, e.g. "opc@100.73.218.41" or a Host alias. */
  target: string;
  /**
   * One key, or several tried in order. The list form exists because a key that
   * one identity may use is refused by another: OpenSSH on Windows rejects a
   * private key owned by a different account, so a daemon running as SYSTEM and
   * a user running as themselves need different copies of the same key.
   */
  identityFile?: string | string[];
  port?: number;
  shell?: ShellKind;
  extraArgs?: string[];
  connectTimeoutSec?: number;
}

export interface FsConfig {
  enabled: boolean;
  /** Prefix every path is resolved against. Absolute paths outside it are refused. */
  root?: string;
}

export interface AgentConfig {
  enabled: boolean;
  baseUrl: string;
  username?: string;
  password?: string;
  /** Default agent id used when creating sessions. */
  agent?: string;
  /** Default working directory used when creating sessions. */
  directory?: string;
}

export interface HostConfig {
  label?: string;
  ssh?: SshConfig;
  fs?: FsConfig;
  agent?: AgentConfig;
}

export interface BridgeConfig {
  self: { name: string; agent?: string };
  hosts: Record<string, HostConfig>;
  defaults?: {
    host?: string;
    timeoutMs?: number;
    sshBinary?: string;
  };
}

export class ConfigError extends Error {}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Expand a leading "~" or "%USERPROFILE%" style prefix. */
export function expandPath(p: string): string {
  if (!p) return p;
  let out = p;
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    out = join(homedir(), out.slice(1));
  }
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
    const v = process.env[name];
    return v === undefined ? whole : v;
  });
  return isAbsolute(out) ? out : resolve(process.cwd(), out);
}

/**
 * Resolve an indirect value. Supports:
 *   {file:/path/to/secret}   -> trimmed file contents
 *   {env:NAME}               -> environment variable
 * Anything else is returned verbatim.
 */
export function resolveSecret(value: string | undefined): string | undefined {
  if (!value) return value;
  const m = /^\{(file|env):([^}]+)\}$/.exec(value.trim());
  if (!m) return value;
  const [, kind, target] = m;
  if (kind === "env") {
    const v = process.env[target];
    if (v === undefined) throw new ConfigError(`environment variable ${target} is not set`);
    return v;
  }
  const path = expandPath(target);
  if (!existsSync(path)) throw new ConfigError(`secret file not found: ${path}`);
  return readFileSync(path, "utf8").trim();
}

export function configPath(): string {
  const explicit = process.env.AGENT_BRIDGE_CONFIG;
  if (explicit) return expandPath(explicit);
  return join(homedir(), ".agent-bridge", "config.json");
}

export function loadConfig(path = configPath()): BridgeConfig {
  if (!existsSync(path)) {
    throw new ConfigError(
      `no config at ${path}. Copy config/config.example.json there, or set AGENT_BRIDGE_CONFIG.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return validate(raw, path);
}

function validate(raw: unknown, path: string): BridgeConfig {
  if (!raw || typeof raw !== "object") throw new ConfigError(`config at ${path} must be an object`);
  const obj = raw as Record<string, unknown>;
  const self = (obj.self ?? {}) as Record<string, unknown>;
  const hosts = obj.hosts;
  if (!hosts || typeof hosts !== "object") {
    throw new ConfigError(`config at ${path} needs a "hosts" object`);
  }
  const entries = Object.entries(hosts as Record<string, unknown>);
  if (entries.length === 0) throw new ConfigError(`config at ${path} defines no hosts`);

  const validated: Record<string, HostConfig> = {};
  for (const [name, value] of entries) {
    if (!value || typeof value !== "object") throw new ConfigError(`host "${name}" must be an object`);
    const host = value as HostConfig;
    if (host.fs?.enabled && !host.ssh) {
      throw new ConfigError(`host "${name}" enables fs but has no ssh block`);
    }
    validated[name] = host;
  }

  return {
    self: {
      name: typeof self.name === "string" ? self.name : "unknown-host",
      agent: typeof self.agent === "string" ? self.agent : undefined,
    },
    hosts: validated,
    defaults: (obj.defaults ?? {}) as BridgeConfig["defaults"],
  };
}

/** Pick a host, falling back to the configured default when only one exists. */
export function pickHost(cfg: BridgeConfig, requested?: string): [string, HostConfig] {
  const name = requested ?? cfg.defaults?.host;
  if (name) {
    const host = cfg.hosts[name];
    if (!host) {
      throw new ConfigError(
        `unknown host "${name}". Configured: ${Object.keys(cfg.hosts).join(", ")}`,
      );
    }
    return [name, host];
  }
  const names = Object.keys(cfg.hosts);
  if (names.length === 1) return [names[0], cfg.hosts[names[0]]];
  throw new ConfigError(`host is required. Configured: ${names.join(", ")}`);
}

export function timeoutFor(cfg: BridgeConfig, override?: number): number {
  return override ?? cfg.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}
