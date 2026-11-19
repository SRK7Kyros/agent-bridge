/**
 * Level 1 - remote terminal.
 *
 * Everything goes through the system ssh client: no library, no daemon, no
 * agent on the far side. That is deliberate. ssh is already installed, already
 * authenticated, already audited, and works identically on Windows and Linux.
 */
import { spawn } from "node:child_process";
import { expandPath, resolveSecret, type BridgeConfig, type HostConfig, type ShellKind } from "./config.ts";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  signal?: NodeJS.Signals | null;
}

export interface RunOptions {
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  /** Force a shell dialect; defaults to the host's configured one. */
  shell?: ShellKind;
  /** Skip the cwd wrapper (used by fs, which quotes its own paths). */
  raw?: boolean;
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly result?: RunResult,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export function sshBinary(cfg: BridgeConfig): string {
  return cfg.defaults?.sshBinary ?? "ssh";
}

/** Build the argv for one ssh invocation. Exported for tests. */
export function sshArgs(host: HostConfig, command: string, timeoutSec: number): string[] {
  const ssh = host.ssh;
  if (!ssh) throw new SshError("host has no ssh block configured");
  const args: string[] = [];
  if (ssh.identityFile) {
    const keys = Array.isArray(ssh.identityFile) ? ssh.identityFile : [ssh.identityFile];
    for (const key of keys) args.push("-i", expandPath(resolveSecret(key)!));
  }
  if (ssh.port) args.push("-p", String(ssh.port));
  args.push(
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `ConnectTimeout=${ssh.connectTimeoutSec ?? 15}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-o", "LogLevel=ERROR",
  );
  if (ssh.extraArgs?.length) args.push(...ssh.extraArgs);
  args.push(ssh.target);
  args.push(command);
  void timeoutSec;
  return args;
}

/**
 * POSIX single-quote a value so the remote shell sees it literally.
 * `it's` becomes `'it'\''s'`.
 */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** PowerShell -EncodedCommand payload (base64 of UTF-16LE). */
function psEncoded(script: string): string {
  const buf = Buffer.from(script, "utf16le");
  return buf.toString("base64");
}

/** Wrap a user command for the target shell, honouring an optional cwd. */
export function wrapCommand(command: string, shell: ShellKind, cwd?: string): string {
  if (shell === "powershell") {
    const body = cwd ? `Set-Location -LiteralPath ${psQuote(cwd)}; ${command}` : command;
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncoded(body)}`;
  }
  return cwd ? `cd ${shq(cwd)} && ${command}` : command;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Spawn ssh and collect everything. Never throws on a non-zero exit. */
export function runRaw(
  cfg: BridgeConfig,
  host: HostConfig,
  command: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? cfg.defaults?.timeoutMs ?? 120_000;
  const args = sshArgs(host, command, Math.ceil(timeoutMs / 1000));
  const bin = sshBinary(cfg);

  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started, signal });
    };

    const timer = setTimeout(() => {
      stderr += `\n[agent-bridge] killed after ${timeoutMs} ms`;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (err) => {
      stderr += `\n[agent-bridge] spawn failed: ${err.message}`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/** Run a command on a peer and throw when it fails. */
export async function run(
  cfg: BridgeConfig,
  host: HostConfig,
  command: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const shell = opts.shell ?? host.ssh?.shell ?? "posix";
  const wrapped = opts.raw ? command : wrapCommand(command, shell, opts.cwd);
  const result = await runRaw(cfg, host, wrapped, opts);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().slice(0, 800);
    throw new SshError(
      `remote command failed on ${host.ssh?.target ?? "?"} (exit ${result.code}): ${detail}`,
      result,
    );
  }
  return result;
}

/** Convenience: run and return trimmed stdout, throwing on failure. */
export async function runText(
  cfg: BridgeConfig,
  host: HostConfig,
  command: string,
  opts: RunOptions = {},
): Promise<string> {
  return (await run(cfg, host, command, opts)).stdout.trim();
}
