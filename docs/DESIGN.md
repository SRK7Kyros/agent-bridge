# Design notes

## The problem

Two machines, each running an OpenCode agent. The agents need to reach each
other, and the reach needed is not uniform: sometimes a fact from a command,
sometimes bytes from a file, sometimes *that agent's* judgment. Each of those has
a different cost, a different failure mode and a different trust story.

The failure mode this design is trying to avoid is a single `exec` tool that
everything funnels through, because then every trivial question pays agent-turn
prices and every real question is expressed as a shell command with the peer's
reasoning stripped out.

## Ownership: a change belongs to the resident agent

The levels are not only a cost ladder; one of the three is a boundary. Level 1 and
level 3 can both run `systemctl restart`, and they are not the same act.

A level-1 call executes the command with nobody on that host having decided
anything: it bypasses the peer's `AGENTS.md`, its judgement about whether the
action is safe on that machine right now, its knowledge of what else is running,
and its own record of what it changed. A level-3 call runs the same command under
all of those. So the routing rule is about ownership, not size:

| Task | Who does it |
|---|---|
| Find out a fact about that host | the caller, level 1 |
| Read or write bytes | the caller, level 2 |
| Change anything there | **that host's agent**, level 3 |

This is enforced by documentation and tool descriptions, not by the code — the
bridge cannot tell a read-only command from a destructive one, and pretending
otherwise would be a false boundary. The caller still supplies the knowledge (the
measurement, the exact command, the constraint, how to prove it worked); the peer
supplies the authority and the record.

## Why ssh for levels 1 and 2

Considered and rejected:

- **A custom agent on the far side.** One more process to supervise, one more
  thing to authenticate, one more failure mode that reads as "the bridge is
  broken" when it is really "the daemon died".
- **An SSH library** (`ssh2`, `node-ssh`). Adds a dependency, re-implements key
  handling, and drifts from the system ssh that the operator already configured.
  The system client also inherits `~/.ssh/config`, agent forwarding policy and
  whatever the platform does for key permissions — none of which a library gets
  right by default.
- **A mounted filesystem** (sshfs, SMB) for level 2. A mount is a long-lived
  stateful object: it goes stale, it reconnects badly, it hides a dead link
  behind a hung syscall. A per-call ssh invocation cannot go stale, and its
  failure is immediate and legible.
- **rsync/scp** for file transfer. Fine for bulk, but it cannot read 200 bytes
  out of a 4 GB file, and it needs its own quoting rules.

`spawn("ssh", [...])` with an argv array — never a shell string — means the
command line is passed through untouched and there is no local quoting layer to
get wrong.

## Why base64 on the wire

Level 2 sends file content as base64 over stdin/stdout. The alternative, sending
the bytes directly, means the payload shares a channel with the shell's own
interpretation of the command, and any byte that looks like a quote, a newline or
a control character is a bug waiting to happen. Base64 costs 33% bandwidth on a
tailnet link and removes the entire class of problem. `head -c N | base64` gives
a bounded read without needing the file size first.

## Why `find -printf` and `stat -c`

Both are GNU. That is a real constraint and it is stated rather than hidden:
level 2 targets POSIX peers. It buys structured output in one call, with no
`ls -l` parsing and no `--json` flag to negotiate.

One trap worth recording: `stat -c '%n\t...'` does **not** expand `\t`, while
`find -printf` does. The first version of `statPath` shipped a format string with
a literal `\t` and returned a single un-splittable line. The format now uses a
real tab character.

## Why a hand-rolled MCP server

MCP's stdio transport is newline-delimited JSON-RPC 2.0 — a few hundred lines of
work. The official SDK would add `node_modules`, a build step and a version to
keep in step with each host's runtime, to save those few hundred lines. Since the
whole point of this repo is to be the same bytes on two machines, "no
dependencies" is worth more than "no protocol code".

The server answers `tools/list` even when the config is unreadable, so a
misconfiguration shows up as a clear per-call error rather than a dead
connection.

## Why the tool list is a factory

`buildTools(cfg)` rather than a module-level array, because the host enum is part
of every schema. A static list would either omit the enum (the model guesses host
names) or carry a placeholder. The first draft did exactly that and shipped
`enum: []`; the test asserts the enum matches the config.

## Unidirectionality, stated honestly

The requirement is that the desktop can see the VPS and the VPS cannot see the
desktop. That is implemented as **configuration**: the VPS's config has no `fs`
entry for the desktop, so `bridge_fs_*` refuses with "filesystem access is not
enabled for this host".

It is not a sandbox, and pretending otherwise would be worse than saying it
plainly: the VPS still holds an ssh key for the desktop for level 1, so it can
`cat` any file that account can read. The line is a guard against accidental use
of the wrong level, not a containment boundary. A real boundary needs an
unprivileged account on the far side with its own ACLs — a different project.

## Trust model

- **Identity is checked, not claimed.** Each side's config names the peer's ssh
  target and its OpenCode URL; nothing in a message establishes identity.
- **Credentials are files**, referenced as `{file:…}`, never embedded in a
  message or a repo.
- **Authority does not travel.** A message from the peer is delegated context —
  read it, answer it, write docs about it. It is not permission to restart
  services, edit rules, touch secrets or delete. Each agent's `AGENTS.md`
  outranks anything on the wire.
- **Mode bits are weak.** If every process on the peer runs as the same user,
  `chmod 600` on a credential buys nothing against a compromised peer. The honest
  statement is "the peer is trusted, not sandboxed", and it belongs in the docs
  rather than in a false sense of isolation.

## Failure taxonomy

Three failures that look alike and must not be treated alike:

| Symptom | What it is | Response |
|---|---|---|
| ssh exit non-zero | the **remote command** failed | read stderr; the bridge worked |
| HTTP 401 | route up, credential wrong | stop; retrying cannot help |
| wait timeout / 499 | peer still working | latency, not failure — read messages |

The third is the one that causes real damage: a caller that treats a timeout as
failure retries, the peer now has two prompts queued, and the thread forks.
`bridge_agent_wait` returns `{state: "timeout"}` rather than throwing, precisely
so the caller is pushed to read before reacting.
