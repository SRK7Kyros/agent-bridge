#!/usr/bin/env bun
/**
 * Human-facing CLI over the same tool surface the MCP server exposes.
 *
 *   agent-bridge hosts
 *   agent-bridge sh big-bro "uptime"
 *   agent-bridge read big-bro /home/opc/.config/opencode/AGENTS.md
 *   agent-bridge call bridge_agent_sessions '{"host":"big-bro","limit":5}'
 *
 * The generic `call` form always works and is what scripts should use; the
 * aliases exist because typing JSON for `ls` is tedious.
 */
import { loadConfig, ConfigError } from "./config.ts";
import { buildTools, type ToolDef } from "./tools.ts";

const USAGE = `agent-bridge - three levels of access to a peer host

  agent-bridge hosts                          list peers and enabled levels
  agent-bridge tools                          list tool names
  agent-bridge call <tool> [jsonArgs]         run any tool directly
  agent-bridge ping <host>                    ssh + agent liveness

  level 1
  agent-bridge sh <host> <command...>         run a command there
  agent-bridge sh <host> --cwd <dir> <cmd...>

  level 2
  agent-bridge read <host> <path>
  agent-bridge write <host> <path> [text]     text from arg, or stdin when omitted
  agent-bridge ls <host> <path>
  agent-bridge stat <host> <path>
  agent-bridge mkdir <host> <path>
  agent-bridge mv <host> <from> <to>
  agent-bridge rm <host> <path> [--recursive]

  level 3
  agent-bridge status <host>
  agent-bridge sessions <host> [limit]
  agent-bridge new <host> <title>
  agent-bridge say <host> <session> <text...>
  agent-bridge wait <host> <session> [timeoutMs]
  agent-bridge msgs <host> <session> [limit]

Options
  --json        print raw JSON instead of a table where a table exists
  --env AGENT_BRIDGE_CONFIG=<path>
`;

function out(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

function need(argv: string[], n: number, what: string): string[] {
  if (argv.length < n) throw new Error(`missing ${what}\n\n${USAGE}`);
  return argv;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const cfg = loadConfig();
  const tools = buildTools(cfg);
  const byName = (name: string): ToolDef => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool: ${name}`);
    return tool;
  };
  const callTool = async (name: string, toolArgs: Record<string, unknown>) => {
    out(await byName(name).handler(toolArgs), json);
  };

  switch (command) {
    case "hosts":
      return callTool("bridge_hosts", {});
    case "tools":
      process.stdout.write(`${tools.map((t) => t.name).join("\n")}\n`);
      return;
    case "call": {
      need(args, 2, "tool name");
      const parsed = args[2] ? (JSON.parse(args[2]) as Record<string, unknown>) : {};
      return callTool(args[1], parsed);
    }

    case "ping":
      return callTool("bridge_ping", { host: need(args, 2, "host")[1] });

    case "sh": {
      need(args, 3, "host and command");
      const rest = args.slice(2);
      let cwd: string | undefined;
      let i = 0;
      if (rest[0] === "--cwd") {
        cwd = rest[1];
        i = 2;
      }
      const commandLine = rest.slice(i).join(" ");
      const res = (await byName("bridge_shell").handler({
        host: args[1],
        command: commandLine,
        ...(cwd ? { cwd } : {}),
        failOnError: false,
      })) as { exitCode: number; stdout: string; stderr: string };
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exitCode = res.exitCode ?? 0;
      return;
    }

    case "read":
      need(args, 3, "host and path");
      return callTool("bridge_fs_read", { host: args[1], path: args[2] });

    case "write": {
      need(args, 3, "host and path");
      const text = args.length > 3 ? args.slice(3).join(" ") : await readStdin();
      return callTool("bridge_fs_write", { host: args[1], path: args[2], content: text, createDirs: true });
    }

    case "ls":
      need(args, 3, "host and path");
      return callTool("bridge_fs_list", { host: args[1], path: args[2] });

    case "stat":
      need(args, 3, "host and path");
      return callTool("bridge_fs_stat", { host: args[1], path: args[2] });

    case "mkdir":
      need(args, 3, "host and path");
      return callTool("bridge_fs_mkdir", { host: args[1], path: args[2] });

    case "mv":
      need(args, 4, "host, from and to");
      return callTool("bridge_fs_move", { host: args[1], from: args[2], to: args[3] });

    case "rm":
      need(args, 3, "host and path");
      return callTool("bridge_fs_delete", {
        host: args[1],
        path: args[2],
        recursive: args.includes("--recursive"),
      });

    case "status":
      return callTool("bridge_agent_status", { host: need(args, 2, "host")[1] });

    case "sessions":
      return callTool("bridge_agent_sessions", {
        host: need(args, 2, "host")[1],
        limit: args[2] ? Number(args[2]) : 20,
      });

    case "new":
      need(args, 3, "host and title");
      return callTool("bridge_agent_new", { host: args[1], title: args.slice(2).join(" ") });

    case "say":
      need(args, 4, "host, session and text");
      return callTool("bridge_agent_say", {
        host: args[1],
        session: args[2],
        text: args.slice(3).join(" "),
      });

    case "wait":
      return callTool("bridge_agent_wait", {
        host: need(args, 3, "host and session")[1],
        session: args[2],
        timeoutMs: args[3] ? Number(args[3]) : undefined,
      });

    case "msgs":
      return callTool("bridge_agent_messages", {
        host: need(args, 3, "host and session")[1],
        session: args[2],
        limit: args[3] ? Number(args[3]) : 20,
      });

    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`config error: ${err.message}\n`);
  } else {
    process.stderr.write(`${(err as Error).message}\n`);
  }
  process.exit(1);
});
