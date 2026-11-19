/**
 * Level 2 - the peer's filesystem, seen from here.
 *
 * Unidirectional by policy, not by mechanism: the tool surface exists only for
 * hosts whose config sets `fs.enabled`. A peer that must not see this host's
 * files simply has no fs entry pointing back, and the reverse direction stays
 * available through level 1 (`bridge_shell` -> `cat`), which is the documented
 * trade-off and not a sandbox.
 *
 * Transport is level 1: every operation is one ssh call, so there is no mount,
 * no daemon, and no cache to go stale. Bytes move base64-encoded over stdin and
 * stdout, which keeps binary content and quoting out of the picture.
 */
import { posix } from "node:path";
import type { BridgeConfig, HostConfig } from "./config.ts";
import { run, shq, type RunResult } from "./ssh.ts";

export class FsError extends Error {
  constructor(message: string, readonly result?: RunResult) {
    super(message);
    this.name = "FsError";
  }
}

export type EntryType = "file" | "directory" | "symlink" | "fifo" | "socket" | "device" | "unknown";

export interface Entry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  mtimeMs: number;
}

export interface StatResult {
  path: string;
  type: EntryType;
  size: number;
  mtimeMs: number;
  mode: string;
  owner: string;
  group: string;
}

const TYPE_MAP: Record<string, EntryType> = {
  d: "directory",
  f: "file",
  l: "symlink",
  p: "fifo",
  s: "socket",
  b: "device",
  c: "device",
};

/** Resolve a caller path against the host's fs root and refuse escapes. */
export function resolveRemotePath(host: HostConfig, p: string): string {
  const root = host.fs?.root;
  if (!p) throw new FsError("path is required");
  const candidate = posix.isAbsolute(p)
    ? posix.normalize(p)
    : posix.normalize(posix.join(root ?? "/", p));
  if (root) {
    const base = posix.normalize(root).replace(/\/+$/, "");
    if (candidate !== base && !candidate.startsWith(`${base}/`)) {
      throw new FsError(`path escapes the configured fs root (${base}): ${candidate}`);
    }
  }
  return candidate;
}

function requireFs(host: HostConfig): void {
  if (!host.fs?.enabled) throw new FsError("filesystem access is not enabled for this host");
  if (!host.ssh) throw new FsError("filesystem access needs an ssh block");
}

export async function readFile(
  cfg: BridgeConfig,
  host: HostConfig,
  p: string,
  opts: { encoding?: "utf8" | "base64"; maxBytes?: number } = {},
): Promise<{ path: string; content: string; bytes: number; encoding: "utf8" | "base64" }> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  const encoding = opts.encoding ?? "utf8";
  // A real tab, not \t: stat(1) and head(1) do not share find's escape handling.
  const command = opts.maxBytes
    ? `head -c ${Math.max(1, Math.floor(opts.maxBytes))} -- ${shq(target)} | base64`
    : `base64 < ${shq(target)}`;
  const res = await run(cfg, host, command, { raw: true });
  const b64 = res.stdout.replace(/\s+/g, "");
  const buf = Buffer.from(b64, "base64");
  return {
    path: target,
    content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"),
    bytes: buf.byteLength,
    encoding,
  };
}

export async function writeFile(
  cfg: BridgeConfig,
  host: HostConfig,
  p: string,
  content: string,
  opts: { encoding?: "utf8" | "base64"; createDirs?: boolean } = {},
): Promise<{ path: string; bytes: number }> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  const buf = Buffer.from(content, opts.encoding === "base64" ? "base64" : "utf8");
  const b64 = buf.toString("base64");
  const dir = posix.dirname(target);
  const prefix = opts.createDirs ? `mkdir -p ${shq(dir)} && ` : "";
  await run(cfg, host, `${prefix}base64 -d > ${shq(target)}`, { raw: true, stdin: b64 });
  return { path: target, bytes: buf.byteLength };
}

export async function listDir(
  cfg: BridgeConfig,
  host: HostConfig,
  p: string,
): Promise<{ path: string; entries: Entry[] }> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  const res = await run(
    cfg,
    host,
    `find ${shq(target)} -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%s\\t%T@\\n'`,
    { raw: true },
  );
  const entries = res.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, kind, size, mtime] = line.split("\t");
      return {
        name,
        path: posix.join(target, name),
        type: TYPE_MAP[kind] ?? "unknown",
        size: Number(size) || 0,
        mtimeMs: Math.round((Number(mtime) || 0) * 1000),
      } satisfies Entry;
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
  return { path: target, entries };
}

export async function statPath(
  cfg: BridgeConfig,
  host: HostConfig,
  p: string,
): Promise<StatResult> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  const res = await run(
    cfg,
    host,
    `stat -c '%n\t%F\t%s\t%Y\t%a\t%U\t%G' -- ${shq(target)}`,
    { raw: true },
  );
  const [name, kind, size, mtime, mode, owner, group] = res.stdout.trim().split("\t");
  return {
    path: name,
    type: kind?.includes("directory") ? "directory" : kind?.includes("symbolic") ? "symlink" : "file",
    size: Number(size) || 0,
    mtimeMs: (Number(mtime) || 0) * 1000,
    mode,
    owner,
    group,
  };
}

export async function makeDir(cfg: BridgeConfig, host: HostConfig, p: string): Promise<string> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  await run(cfg, host, `mkdir -p -- ${shq(target)}`, { raw: true });
  return target;
}

export async function movePath(
  cfg: BridgeConfig,
  host: HostConfig,
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  requireFs(host);
  const src = resolveRemotePath(host, from);
  const dst = resolveRemotePath(host, to);
  await run(cfg, host, `mv -- ${shq(src)} ${shq(dst)}`, { raw: true });
  return { from: src, to: dst };
}

export async function deletePath(
  cfg: BridgeConfig,
  host: HostConfig,
  p: string,
  opts: { recursive?: boolean } = {},
): Promise<string> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  const root = host.fs?.root ? posix.normalize(host.fs.root) : null;
  if (root && target === root) throw new FsError(`refusing to delete the fs root: ${target}`);
  if (target === "/" || target === "") throw new FsError("refusing to delete /");
  const flags = opts.recursive ? "-rf" : "-f";
  await run(cfg, host, `rm ${flags} -- ${shq(target)}`, { raw: true });
  return target;
}

export async function exists(cfg: BridgeConfig, host: HostConfig, p: string): Promise<boolean> {
  requireFs(host);
  const target = resolveRemotePath(host, p);
  const res = await run(cfg, host, `test -e ${shq(target)} && echo yes || echo no`, { raw: true });
  return res.stdout.trim() === "yes";
}
