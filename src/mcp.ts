#!/usr/bin/env bun
/**
 * MCP stdio server.
 *
 * Dependency-free on purpose: MCP's stdio transport is newline-delimited
 * JSON-RPC 2.0, and hand-rolling it means there is no node_modules to install,
 * no SDK version to keep in step with the peer's, and no build step - the file
 * that runs is the file in the repo.
 *
 * stdout carries protocol frames and nothing else. Diagnostics go to stderr.
 */
import { loadConfig, ConfigError } from "./config.ts";
import { buildTools } from "./tools.ts";

const SERVER_INFO = { name: "agent-bridge", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

type JsonRpcId = string | number | null;

interface RpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function log(line: string): void {
  process.stderr.write(`[agent-bridge] ${line}\n`);
}

function textResult(value: unknown, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }], isError };
}

async function handle(msg: RpcMessage): Promise<void> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params?.protocolVersion as string | undefined) ?? DEFAULT_PROTOCOL;
      reply(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Three levels of access to a peer host. Level 1 bridge_shell runs a command there; " +
          "level 2 bridge_fs_* reads and writes its files; level 3 bridge_agent_* talks to its " +
          "OpenCode agent, which is a separate peer with its own authority, not a subagent. " +
          "Call bridge_hosts first.",
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "ping":
      reply(id, {});
      return;

    case "tools/list": {
      let cfg;
      try {
        cfg = loadConfig();
      } catch (err) {
        // Still answer, so the client sees a usable server and a clear error
        // per call rather than a dead connection.
        log(`config unavailable: ${(err as Error).message}`);
        reply(id, { tools: [] });
        return;
      }
      reply(id, {
        tools: buildTools(cfg).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
      return;
    }

    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      let cfg;
      try {
        cfg = loadConfig();
      } catch (err) {
        reply(id, textResult((err as Error).message, true));
        return;
      }
      const tool = buildTools(cfg).find((t) => t.name === name);
      if (!tool) {
        reply(id, textResult(`unknown tool: ${name}`, true));
        return;
      }
      try {
        reply(id, textResult(await tool.handler(args)));
      } catch (err) {
        const message = err instanceof ConfigError ? err.message : (err as Error).message;
        log(`${name} failed: ${message}`);
        reply(id, textResult(message, true));
      }
      return;
    }

    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;

    default:
      if (!isNotification) replyError(id, -32601, `method not found: ${msg.method ?? "(none)"}`);
  }
}

function main(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        log("dropped a frame that was not JSON");
        continue;
      }
      void handle(msg).catch((err) => log(`handler crashed: ${(err as Error).message}`));
    }
  });
  process.stdin.on("end", () => process.exit(0));
  log(`ready (config: ${process.env.AGENT_BRIDGE_CONFIG ?? "~/.agent-bridge/config.json"})`);
}

main();
