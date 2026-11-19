/**
 * The tool surface, defined once and consumed twice: the MCP server exposes it
 * to an agent, the CLI exposes it to a human or a shell script.
 *
 * Level 1 (shell) and level 2 (fs) run over ssh. Level 3 (agent) runs over the
 * peer's OpenCode HTTP API. A host can enable any subset; a disabled level
 * answers with a clear error instead of failing deep inside a transport.
 *
 * Built as a factory because the host enum is part of every schema: the tool
 * list must describe the peers this config actually has.
 */
import { pickHost, timeoutFor, type BridgeConfig, type HostConfig } from "./config.ts";
import { run, type RunResult } from "./ssh.ts";
import * as fs from "./fs.ts";
import * as agent from "./agent.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

function shape(res: RunResult) {
  return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr, ms: res.ms };
}

export function buildTools(cfg: BridgeConfig): ToolDef[] {
  const names = Object.keys(cfg.hosts);
  const fallback = cfg.defaults?.host ?? (names.length === 1 ? names[0] : undefined);
  const hostArg = {
    type: "string",
    description: `Peer host key. One of: ${names.join(", ")}.${fallback ? ` Default: ${fallback}.` : ""}`,
    enum: names,
    ...(fallback ? { default: fallback } : {}),
  };
  const hostOf = (args: Record<string, unknown>): [string, HostConfig] =>
    pickHost(cfg, typeof args.host === "string" ? args.host : undefined);
  const noArgs = { type: "object", properties: {}, additionalProperties: false } as const;

  return [
    // -------------------------------------------------------------- meta
    {
      name: "bridge_hosts",
      description:
        "List configured peers and which levels (shell / fs / agent) each exposes. Start here when you do not know what is reachable.",
      inputSchema: noArgs,
      async handler() {
        return {
          self: cfg.self,
          hosts: Object.entries(cfg.hosts).map(([name, h]) => ({
            name,
            label: h.label ?? null,
            sshTarget: h.ssh?.target ?? null,
            levels: {
              shell: Boolean(h.ssh),
              fs: Boolean(h.fs?.enabled),
              agent: Boolean(h.agent?.enabled),
            },
            fsRoot: h.fs?.enabled ? (h.fs.root ?? "/") : null,
            agentUrl: h.agent?.enabled ? h.agent.baseUrl : null,
          })),
        };
      },
    },
    {
      name: "bridge_ping",
      description:
        "Prove a peer is reachable: ssh round trip plus, when enabled, its OpenCode version.",
      inputSchema: { type: "object", properties: { host: hostArg }, additionalProperties: false },
      async handler(args) {
        const [name, h] = hostOf(args);
        const out: Record<string, unknown> = { host: name };
        if (h.ssh) {
          const res = await run(cfg, h, "echo ok; hostname; uname -s", { timeoutMs: 25_000 });
          out.ssh = { ok: res.code === 0, detail: res.stdout.trim().split("\n"), ms: res.ms };
        }
        if (h.agent?.enabled) {
          const started = Date.now();
          const i = await agent.info(h);
          out.agent = {
            ok: true,
            version: i.version,
            pid: i.pid,
            hostname: i.hostname,
            ms: Date.now() - started,
          };
        }
        return out;
      },
    },

    // ----------------------------------------------------------- level 1
    {
      name: "bridge_shell",
      description:
        "LEVEL 1 — run a command in the peer's shell; returns stdout, stderr, exit code. Use for anything a local shell call could do: inspect, build, tail logs, run its CLI tools.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          command: str("Command line, executed by the peer's own shell (posix sh or powershell)."),
          cwd: str("Working directory for the command."),
          stdin: str("Text piped to the command's stdin."),
          timeoutMs: num("Kill after this many ms. Default 120000."),
          failOnError: bool("Throw when the exit code is non-zero. Default true."),
        },
        required: ["command"],
        additionalProperties: false,
      },
      async handler(args) {
        const [name, h] = hostOf(args);
        if (!h.ssh) throw new Error(`host "${name}" has no ssh block`);
        const res = await run(cfg, h, String(args.command), {
          cwd: typeof args.cwd === "string" ? args.cwd : undefined,
          stdin: typeof args.stdin === "string" ? args.stdin : undefined,
          timeoutMs: timeoutFor(cfg, args.timeoutMs as number | undefined),
        });
        if (args.failOnError !== false && res.code !== 0) {
          throw new Error(`exit ${res.code} on ${name}: ${(res.stderr || res.stdout).trim().slice(0, 1200)}`);
        }
        return shape(res);
      },
    },

    // ----------------------------------------------------------- level 2
    {
      name: "bridge_fs_read",
      description:
        "LEVEL 2 — read a file from the peer. Relative paths resolve against the host's fs root. Survives binary content and never mangles quoting.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          path: str("Path on the peer."),
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8." },
          maxBytes: num("Read at most this many bytes from the start."),
        },
        required: ["path"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return fs.readFile(cfg, h, String(args.path), {
          encoding: args.encoding === "base64" ? "base64" : "utf8",
          maxBytes: typeof args.maxBytes === "number" ? args.maxBytes : undefined,
        });
      },
    },
    {
      name: "bridge_fs_write",
      description:
        "LEVEL 2 — write a file on the peer, replacing it. Set createDirs to mkdir -p the parent first.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          path: str("Path on the peer."),
          content: str("File contents. Base64 when encoding is base64."),
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8." },
          createDirs: bool("Create the parent directory first. Default false."),
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return fs.writeFile(cfg, h, String(args.path), String(args.content), {
          encoding: args.encoding === "base64" ? "base64" : "utf8",
          createDirs: args.createDirs === true,
        });
      },
    },
    {
      name: "bridge_fs_list",
      description: "LEVEL 2 — list one directory on the peer: name, type, size, mtime.",
      inputSchema: {
        type: "object",
        properties: { host: hostArg, path: str("Directory on the peer.") },
        required: ["path"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return fs.listDir(cfg, h, String(args.path));
      },
    },
    {
      name: "bridge_fs_stat",
      description: "LEVEL 2 — metadata for one path on the peer: type, size, mtime, mode, owner, group.",
      inputSchema: {
        type: "object",
        properties: { host: hostArg, path: str("Path on the peer.") },
        required: ["path"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return fs.statPath(cfg, h, String(args.path));
      },
    },
    {
      name: "bridge_fs_mkdir",
      description: "LEVEL 2 — create a directory (and parents) on the peer.",
      inputSchema: {
        type: "object",
        properties: { host: hostArg, path: str("Directory on the peer.") },
        required: ["path"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return { path: await fs.makeDir(cfg, h, String(args.path)) };
      },
    },
    {
      name: "bridge_fs_move",
      description: "LEVEL 2 — rename or move a path on the peer.",
      inputSchema: {
        type: "object",
        properties: { host: hostArg, from: str("Source path."), to: str("Destination path.") },
        required: ["from", "to"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return fs.movePath(cfg, h, String(args.from), String(args.to));
      },
    },
    {
      name: "bridge_fs_delete",
      description:
        "LEVEL 2 — delete a path on the peer. Directories need recursive=true; the fs root is refused. Irreversible: say what you are deleting.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          path: str("Path on the peer."),
          recursive: bool("Required for directories. Default false."),
        },
        required: ["path"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return { deleted: await fs.deletePath(cfg, h, String(args.path), { recursive: args.recursive === true }) };
      },
    },

    // ----------------------------------------------------------- level 3
    {
      name: "bridge_agent_status",
      description:
        "LEVEL 3 — the peer's OpenCode server: version, pid, hostname. Cheap liveness check before a conversation.",
      inputSchema: { type: "object", properties: { host: hostArg }, additionalProperties: false },
      async handler(args) {
        const [, h] = hostOf(args);
        return agent.info(h);
      },
    },
    {
      name: "bridge_agent_sessions",
      description: "LEVEL 3 — list the peer's OpenCode sessions, newest first by default.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          limit: num("Default 20."),
          order: { type: "string", enum: ["asc", "desc"], description: "Default desc." },
        },
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return agent.listSessions(h, {
          limit: typeof args.limit === "number" ? args.limit : undefined,
          order: args.order === "asc" ? "asc" : "desc",
        });
      },
    },
    {
      name: "bridge_agent_new",
      description:
        "LEVEL 3 — open a new session on the peer. Prefer a fresh session over reusing an unrelated one.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          title: str("Session title."),
          agent: str("Peer agent id. Defaults to the host's configured agent."),
          directory: str("Working directory on the peer. Defaults to the host's configured directory."),
        },
        required: ["title"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return agent.createSession(h, {
          title: String(args.title),
          agent: typeof args.agent === "string" ? args.agent : undefined,
          directory: typeof args.directory === "string" ? args.directory : undefined,
        });
      },
    },
    {
      name: "bridge_agent_say",
      description:
        "LEVEL 3 — send a prompt to a session on the peer. Returns at once; the peer's turn runs in the background, so follow with bridge_agent_wait.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          session: str("Session id on the peer."),
          text: str("Message text."),
          envelope: {
            type: "object",
            description:
              "Optional BRIDGE envelope {from,to,thread,msg}. Prepends the header line and stamps sent=<epoch_ms>.",
            properties: {
              from: str("Sender, e.g. kyros-home."),
              to: str("Recipient, e.g. sisyphus@big-bro."),
              thread: str("Thread name."),
              msg: num("Message number within the thread."),
            },
            required: ["from", "to", "thread", "msg"],
          },
        },
        required: ["session", "text"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return agent.say(h, String(args.session), String(args.text), args.envelope as agent.Envelope | undefined);
      },
    },
    {
      name: "bridge_agent_wait",
      description:
        "LEVEL 3 — block until the peer's session goes idle. A timeout is latency, not failure: read messages and retry.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          session: str("Session id on the peer."),
          timeoutMs: num("Default 900000 (15 min)."),
        },
        required: ["session"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return agent.waitForIdle(
          h,
          String(args.session),
          typeof args.timeoutMs === "number" ? args.timeoutMs : 900_000,
        );
      },
    },
    {
      name: "bridge_agent_messages",
      description: "LEVEL 3 — read messages from a session on the peer, text only.",
      inputSchema: {
        type: "object",
        properties: {
          host: hostArg,
          session: str("Session id on the peer."),
          limit: num("Default 20."),
          order: { type: "string", enum: ["asc", "desc"], description: "Default desc (newest first)." },
        },
        required: ["session"],
        additionalProperties: false,
      },
      async handler(args) {
        const [, h] = hostOf(args);
        return agent.messages(h, String(args.session), {
          limit: typeof args.limit === "number" ? args.limit : undefined,
          order: args.order === "asc" ? "asc" : "desc",
        });
      },
    },
  ];
}
