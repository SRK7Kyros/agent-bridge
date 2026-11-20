# agent-bridge

Three levels of access from one machine to another, for agents and for humans.

| Level | Tools | What it does |
|---|---|---|
| **1 — terminal** | `bridge_shell` | Runs a command in the peer's shell, like ssh — **inspection only** |
| **2 — filesystem** | `bridge_fs_*` | Reads and writes the peer's files, one-way by policy |
| **3 — agent** | `bridge_agent_*` | Talks to the peer's OpenCode agent as a conversational peer |

Both ends run the same code. Each end has a config naming the other and which
levels it may use, so the bridge is symmetric in mechanism and asymmetric only
where the config says so.

```
   kyros-home                                  big-bro
  ┌──────────┐   level 1  ssh            ┌──────────────┐
  │ OpenCode │ ─────────────────────────► │   sshd       │
  │  agent   │   level 2  ssh + base64    │              │
  │          │ ─────────────────────────► │  filesystem  │
  │          │   level 3  HTTPS           │              │
  │          │ ◄────────────────────────► │ OpenCode API │
  └──────────┘                            └──────────────┘
```

## Why three levels

Because the cost of reaching the other machine is not one thing. Running `df -h`
there is a half-second and free. Reading a config is a half-second and free.
Asking its agent "why did the indexer stall?" is minutes and a full agent turn —
but it is the only thing that gets an answer which needed *that host's* context,
tools and rules.

Collapsing them into one surface forces every caller to overpay for the simple
things. Keeping them separate lets an agent pick the cheapest level that actually
answers the question. The routing rules live in
[`skill/agent-bridge/SKILL.md`](skill/agent-bridge/SKILL.md).

The one asymmetry that is **not** about cost: level 1 is an inspection channel.
Anything that *changes* the peer — install, restart, delete, clean a cache, edit a
config, apply a migration — goes to level 3, however small the command, because
that host's agent owns its rules, its judgement about what is safe there right
now, and the record of what changed. See "Who does the work" in the skill.

## Quick start

```sh
git clone https://github.com/SRK7Kyros/agent-bridge
cd agent-bridge
bun test                      # 19 tests, no network needed

mkdir -p ~/.agent-bridge
cp config/<this-host>.example.json ~/.agent-bridge/config.json
# edit: the peer's ssh target, key, fs root, and OpenCode URL
```

Then either drive it from a shell:

```sh
bun run src/cli.ts hosts
bun run src/cli.ts ping big-bro
bun run src/cli.ts sh big-bro "uptime"
bun run src/cli.ts read big-bro .config/opencode/AGENTS.md
bun run src/cli.ts sessions big-bro 5
bun run src/cli.ts say big-bro <session> "summarise what you changed today"
bun run src/cli.ts wait big-bro <session>
bun run src/cli.ts msgs big-bro <session>
```

or expose it to an agent as an MCP server:

```jsonc
"mcp": {
  "servers": {
    "agent-bridge": {
      "type": "local",
      "command": ["bun", "run", "D:/Code/agent-bridge/src/mcp.ts"],
      "environment": { "AGENT_BRIDGE_CONFIG": "C:/Users/Giulio/.agent-bridge/config.json" }
    }
  }
}
```

`scripts/install.ps1` and `scripts/install.sh` do the config copy, the skill
copy and print the MCP block for the host they run on.

## Config

One file per host, at `~/.agent-bridge/config.json` (or `$AGENT_BRIDGE_CONFIG`).
`config/kyros-home.example.json` and `config/big-bro.example.json` are the
reference pair.

```jsonc
{
  "self": { "name": "kyros-home", "agent": "kyros-home" },
  "defaults": { "host": "big-bro", "timeoutMs": 120000 },
  "hosts": {
    "big-bro": {
      "ssh": {
        "target": "opc@100.73.218.41",
        "identityFile": ["C:/Windows/System32/config/systemprofile/.ssh/big-bro-key",
                         "~/.ssh/big-bro-key"],
        "shell": "posix"
      },
      "fs":    { "enabled": true, "root": "/home/opc" },
      "agent": {
        "enabled": true,
        "baseUrl": "https://opencode.bigbro-itzamekyros.duckdns.org",
        "username": "opencode",
        "password": "{file:C:/Users/Giulio/.bridge/credentials/big-bro.pw}",
        "agent": "sisyphus"
      }
    }
  }
}
```

- `ssh.identityFile` takes a list: OpenSSH on Windows refuses a key owned by a
  different account, so a SYSTEM-hosted daemon and a user session need different
  copies of the same key. ssh tries them in order.
- `ssh.shell` is `posix` or `powershell`; a PowerShell peer gets its script
  `-EncodedCommand`'d, so quoting survives.
- `fs.root` is a hard boundary — absolute paths outside it are refused, and
  `..` cannot climb out.
- `password` accepts `{file:/path}` or `{env:NAME}`. No secret is ever written
  into the repo.

## Security

- **No secrets in the repo or in messages.** Credentials are files on each host,
  referenced by `{file:…}`.
- **Level 2 is one-way by config, not by sandbox.** A peer without an `fs` entry
  cannot use `bridge_fs_*` against you, but it can still `cat` through level 1.
  The line is policy, stated openly, not a security boundary — see
  [`docs/DESIGN.md`](docs/DESIGN.md).
- **`bridge_fs_delete` refuses the fs root** and refuses `/`; directories need
  `recursive: true`.
- **A bridge message is delegated context, not authority.** Each agent's own
  `AGENTS.md` outranks anything arriving over the bridge.
- **`BatchMode=yes`** on every ssh call, so a missing key fails fast instead of
  hanging on a prompt.

## Layout

```
src/config.ts   config load, {file:}/{env:} secrets, host selection
src/ssh.ts      level 1: ssh argv, POSIX/PowerShell wrapping, run/collect
src/fs.ts       level 2: read/write/list/stat/mkdir/move/delete over ssh
src/agent.ts    level 3: OpenCode HTTP API, envelope, message normalisation
src/tools.ts    the 16-tool surface, built from a config
src/mcp.ts      MCP stdio server (newline JSON-RPC, zero dependencies)
src/cli.ts      human CLI over the same tools
skill/          the philosophy and the routing rules
docs/           design notes and operations
```

Runtime needs **bun** and nothing else: no `node_modules`, no build step, no SDK.
`@types/node` is a dev dependency for `bun run typecheck` only.

## License

MIT
