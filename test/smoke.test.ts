import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shq, wrapCommand, sshArgs } from "../src/ssh.ts";
import { resolveRemotePath } from "../src/fs.ts";
import { withEnvelope } from "../src/agent.ts";
import { loadConfig, pickHost, resolveSecret } from "../src/config.ts";
import type { HostConfig } from "../src/config.ts";

const host = (over: Partial<HostConfig> = {}): HostConfig => ({
  ssh: { target: "opc@example", shell: "posix" },
  fs: { enabled: true, root: "/home/opc" },
  ...over,
});

describe("shell quoting", () => {
  test("wraps plain values", () => {
    expect(shq("hello")).toBe("'hello'");
  });

  test("escapes an embedded single quote", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  test("leaves a semicolon inert", () => {
    expect(shq("a; rm -rf /")).toBe("'a; rm -rf /'");
  });
});

describe("remote path containment", () => {
  test("relative paths resolve under the root", () => {
    expect(resolveRemotePath(host(), "projects/x")).toBe("/home/opc/projects/x");
  });

  test("absolute paths inside the root are allowed", () => {
    expect(resolveRemotePath(host(), "/home/opc/a")).toBe("/home/opc/a");
  });

  test("absolute paths outside the root are refused", () => {
    expect(() => resolveRemotePath(host(), "/etc/passwd")).toThrow(/escapes the configured fs root/);
  });

  test("dot-dot cannot climb out", () => {
    expect(() => resolveRemotePath(host(), "../../etc/shadow")).toThrow(/escapes/);
  });

  test("the root itself is allowed", () => {
    expect(resolveRemotePath(host(), "/home/opc")).toBe("/home/opc");
  });
});

describe("command wrapping", () => {
  test("posix with cwd", () => {
    expect(wrapCommand("ls", "posix", "/tmp")).toBe("cd '/tmp' && ls");
  });

  test("powershell encodes the script", () => {
    const wrapped = wrapCommand("Get-Date", "powershell");
    expect(wrapped.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
    const payload = wrapped.split(" ").pop()!;
    expect(Buffer.from(payload, "base64").toString("utf16le")).toBe("Get-Date");
  });
});

describe("ssh argv", () => {
  test("accepts a list of identity files, in order", () => {
    const args = sshArgs(
      { ssh: { target: "opc@example", identityFile: ["/k1", "/k2"] } },
      "uptime",
      10,
    );
    const joined = args.join(" ");
    expect(joined).toContain("-i /k1");
    expect(joined.indexOf("/k1")).toBeLessThan(joined.indexOf("/k2"));
    expect(args.at(-1)).toBe("uptime");
    expect(args.at(-2)).toBe("opc@example");
  });

  test("always sets BatchMode so a prompt cannot hang the call", () => {
    const args = sshArgs({ ssh: { target: "opc@example" } }, "true", 10);
    expect(args.join(" ")).toContain("BatchMode=yes");
  });
});

describe("bridge envelope", () => {
  test("is omitted when not requested", () => {
    expect(withEnvelope("hi")).toBe("hi");
  });

  test("stamps a numeric sent and keeps the body", () => {
    const before = Date.now();
    const text = withEnvelope("hi", { from: "a@x", to: "b@y", thread: "t1", msg: 3 });
    const after = Date.now();
    const [header, , body] = text.split("\n");
    expect(header.startsWith("[BRIDGE v2] from=a@x to=b@y re=t1 msg=3 sent=")).toBe(true);
    const sent = Number(header.split("sent=")[1]);
    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(after);
    expect(body).toBe("hi");
  });
});

describe("config", () => {
  test("reads a file and picks the single host by default", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        self: { name: "test" },
        hosts: { peer: { ssh: { target: "opc@peer" }, fs: { enabled: true, root: "/srv" } } },
      }),
    );
    const cfg = loadConfig(path);
    expect(cfg.self.name).toBe("test");
    expect(pickHost(cfg)[0]).toBe("peer");
  });

  test("refuses fs without ssh", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ hosts: { p: { fs: { enabled: true } } } }));
    expect(() => loadConfig(path)).toThrow(/fs but has no ssh/);
  });

  test("resolves a {file:} secret and trims it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const secret = join(dir, "pw");
    writeFileSync(secret, "s3cret\n");
    expect(resolveSecret(`{file:${secret}}`)).toBe("s3cret");
  });

  test("leaves a plain value alone", () => {
    expect(resolveSecret("plain")).toBe("plain");
  });
});

describe("mcp server", () => {
  test("answers initialize, tools/list and an unknown tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-bridge-"));
    const cfgPath = join(dir, "config.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        self: { name: "test" },
        hosts: { peer: { ssh: { target: "opc@peer" }, fs: { enabled: true, root: "/srv" } } },
      }),
    );

    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "mcp.ts")], {
      env: { ...process.env, AGENT_BRIDGE_CONFIG: cfgPath },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    const frames = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } },
    ];
    proc.stdin.write(`${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
    proc.stdin.end();

    const raw = await new Response(proc.stdout).text();
    await proc.exited;

    const replies = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any);

    const init = replies.find((r) => r.id === 1);
    expect(init.result.serverInfo.name).toBe("agent-bridge");
    expect(init.result.protocolVersion).toBe("2025-06-18");

    const list = replies.find((r) => r.id === 2);
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain("bridge_shell");
    expect(names).toContain("bridge_fs_read");
    expect(names).toContain("bridge_agent_say");
    // the host enum must describe the real config, not a placeholder
    const shell = list.result.tools.find((t: any) => t.name === "bridge_shell");
    expect(shell.inputSchema.properties.host.enum).toEqual(["peer"]);
    expect(shell.inputSchema.properties.host.default).toBe("peer");

    const bad = replies.find((r) => r.id === 3);
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain("unknown tool");
  }, 30_000);
});
