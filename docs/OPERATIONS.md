# Operations

## What must exist on each host

| Requirement | Level 1 | Level 2 | Level 3 |
|---|---|---|---|
| `ssh` client | yes | yes | no |
| reachable `sshd` on the peer | yes | yes | no |
| an authorised key | yes | yes | no |
| the peer's OpenCode HTTP API + credential | no | no | yes |
| `bun` | yes | yes | yes |

`bun` runs the tool itself; nothing else is installed.

## Install

Both hosts run the same repo. Clone it wherever that host keeps code.

**Windows (kyros-home)**

```powershell
git clone https://github.com/SRK7Kyros/agent-bridge D:\Code\agent-bridge
pwsh -File D:\Code\agent-bridge\scripts\install.ps1
```

**Linux (big-bro)**

```sh
git clone https://github.com/SRK7Kyros/agent-bridge ~/code/agent-bridge
bash ~/code/agent-bridge/scripts/install.sh
```

Each installer:

1. copies the matching `config/<host>.example.json` to `~/.agent-bridge/config.json`
   when none exists (never overwrites),
2. links `skill/agent-bridge` into the host's skills directory,
3. prints the MCP block to paste into `opencode.jsonc`.

Then edit `~/.agent-bridge/config.json` for that host. **Which half needs a restart
is not the obvious half** (measured 2026-11-19 on both hosts):

- the **MCP block needs no restart** — `mcp.servers` re-resolves per list/connect.
  Adding it made the 16 tools appear in a live session, and `bridge_ping` answered
  in-process; big-bro measured the same twice (2026-10-30, 2026-10-31).
- the **skill link does need one** — `skills` paths are a startup read, so
  `~/.opencode/skills/agent-bridge` stays invisible until the server is replaced.

## Keeping the two in sync

The repo is the unit of sync. Change it on one host, push, pull on the other:

```sh
git add -A && git commit -m "feat: ..." && git push
# other host
git pull
```

Config files are **not** in the repo (`config/config.json` is gitignored), because
they name paths and credentials that differ per host. Only the examples are
tracked.

After pulling, a change under `src/` is live only in an MCP process spawned after
it — the running child keeps the old code in memory. Replace that child (restart
the server, or toggle the entry's `disabled` twice to force a respawn) rather than
assuming a pull reached the live tools.

## Verifying an install

Run these in order; each one proves a different link.

```sh
bun test                                  # 19 tests, no network
bun run src/cli.ts hosts                  # config parses, levels visible
bun run src/cli.ts ping big-bro           # ssh + agent liveness
bun run src/cli.ts sh big-bro "uptime"    # level 1 — inspection only
bun run src/cli.ts ls big-bro "."         # level 2
bun run src/cli.ts sessions big-bro 3     # level 3 (read-only)
```

A level-3 write test, if you want the whole loop:

```sh
bun run src/cli.ts new big-bro "bridge smoke test"
bun run src/cli.ts say big-bro <session> "Reply with exactly: OK"
bun run src/cli.ts wait big-bro <session>
bun run src/cli.ts msgs big-bro <session> 3
```

## Troubleshooting

### `Permission denied (publickey)` — but the key is right

On Windows, OpenSSH **silently ignores a private key owned by another account**:

```
WARNING: UNPROTECTED PRIVATE KEY FILE!
Permissions for 'C:\Users\...\big-bro-key' are too open.
Load key "...": bad permissions
```

The file mode is not the issue — the **owner** is. A key owned by `Giulio` cannot
be used by a process running as `SYSTEM`, even with an ACL granting SYSTEM read.
Give each identity its own copy:

```powershell
# as SYSTEM (e.g. from the supervised daemon)
$dst = "C:\Windows\System32\config\systemprofile\.ssh\big-bro-key"
Copy-Item "$env:USERPROFILE\.ssh\big-bro-key" $dst -Force
icacls $dst /inheritance:r /grant:r "SYSTEM:(R)" /grant:r "*S-1-5-32-544:(F)"
```

and list both in `ssh.identityFile` — ssh tries them in order and uses the one
its own identity is allowed to read.

### `HTTP 401` on level 3

The route is up and the credential is wrong. Either the password rotated or the
peer's server restarted with a different one. Re-read the password file on the
peer; do not retry.

### `wait` returns `{ "state": "timeout" }`

Not a failure. The peer was still working when the wait expired. Read
`bridge_agent_messages`; if the answer is not there yet, wait again. Never resend
the prompt on a timeout — that queues a second turn and forks the thread.

### `path escapes the configured fs root`

`fs.root` is a hard boundary. Either use a path inside it or change the root in
the config. This is a guard, not a bug.

### `find: unknown predicate` or `stat: invalid option`

The peer is not GNU. Level 2 assumes GNU coreutils (`find -printf`, `stat -c`).
On a BSD/macOS peer those calls need different flags.

### The MCP tools do not appear

Check `GET /api/mcp` on the **running** server, not the file — and do not assume
the entry needs a restart. `mcp.servers` re-resolves per list/connect (measured
2026-11-19 on both hosts), so a correct block appears in a live session. If the
tools are still missing, the cause is the block itself (bad path, `disabled:
true`, a server that failed to spawn) — `/api/mcp` reports the failure and the
stderr of the spawn, and the log line is the answer, not a restart.

The **skill** is the opposite: `skills` paths are a startup read, so the symlink
only becomes visible after the server process is replaced.

## Adding a third host

Add an entry to `hosts` in every config that should reach it, then run
`bridge_ping`. Nothing else changes: the tool schemas are generated from the
config, so the new host appears in every `host` enum automatically.
