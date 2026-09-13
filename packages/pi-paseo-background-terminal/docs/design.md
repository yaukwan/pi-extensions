# pi-paseo-background-terminal design

How this package turns Paseo terminals into a background-terminal tool set: the model, the tool surface, the side-channel protocol, and what is still to build.

This is a fresh design, not a port of `pi-herdr-background-terminal`. Herdr's pane API forced compromises (start/done markers printed into the terminal, completion detection by screen-scraping parsed marker lines, a 24 h watcher per task, pane/tab release bookkeeping). Paseo's terminal surface plus a local side channel removes all of them.

## Concept model

Three nouns, following the background-terminal literature (Claude Code, Codex `exec_command`/`write_stdin`, omp brush):

| Noun | Here | Owner |
| --- | --- | --- |
| **Session** | One Paseo terminal = one persistent shell in a daemon-owned PTY | Paseo daemon |
| **Task** | One command submission = one record with its own side channel | This package |
| **Process** | The command itself, a child of the session shell | The session shell |

- A session survives Pi restarts and is visible/take-over-able in the Paseo app (its terminal belongs to the caller agent's workspace).
- A session is serial: submissions into the same session queue naturally (the shell runs them in order).
- A task's completion, exit code, and output are **out-of-band files**; nothing is printed into the terminal for bookkeeping. The screen stays exactly what a human would have typed and seen.
- State is **derived on read** from files plus terminal presence. No watcher threads, no timers, no session-start recovery pass, no resource-release bookkeeping.

```
Pi session (inside a Paseo agent)
  └── pi-paseo-background-terminal
        ├── MCP: create_terminal / send_terminal_keys / capture_terminal / list_terminals / kill_terminal
        └── local FS: ~/.pi/pi-paseo-background-terminal/<project-hash>/tasks/<task_id>/{meta.json,run.sh,log,status}

Paseo terminal (session)
  └── sh run.sh  ← the only line ever typed; runs the command, writes log + status
```

## Verified mechanics (live, daemon 0.8.0)

| Fact | Evidence |
| --- | --- |
| `create_terminal {cwd, name}` attaches to the caller agent's workspace; visible in the Paseo app | probe: listed under the workspace after creation |
| `send_terminal_keys {literal:true}` + `Enter` submits a line; `C-c` interrupts the foreground group | probes 2026-09-13 |
| Submitting `sh run.sh log status` with a `trap … INT TERM HUP` wrapper: status file appears exactly at completion; C-c yields `130`; the session shell's trap state stays clean afterwards (`rc_check=0` on the next command) | trap probe |
| The exact P0 wrapper template (trap + `( cmd ) > log 2>&1` + `printf $?`) live-verified: `status=1`, `log=hello` for `echo hello; false` | template probe |
| The daemon rejects `accept: text/event-stream` alone (`Not Acceptable`); the client must send `accept: application/json, text/event-stream` — already what `mcp-client.ts` does | probe failure path |
| Log file contains exact command output only — no prompt, no echo, no markers | side-channel probe (`line-one`, `line-two`) |
| The terminal screen shows only the short submit line; output redirected to the file never pollutes the screen | probe capture |
| `kill_terminal` removes the terminal; `list_terminals {all:true}` lists every terminal on the host | probes |
| `capture_terminal {scrollback:true}` returns the VT-rendered screen (~1000-line scrollback), not a byte log | probes |
| MCP terminal catalog has no wait/subscribe/notify primitive and no per-command exit code; `notifyOnFinish` exists only for agents | tools/list + source |
| WS `create_terminal` supports `command/args`, but a command-terminal is removed the moment its process exits (output lost, exit code not delivered); `terminal_stream_exit` carries no exit code | source: `terminal-session-controller.ts`, `TerminalStreamExitSchema` |
| `@getpaseo/client` 0.8.0: 22 MB dep tree, persistent WS, version-coupled; public surface is request/response parity with MCP — push streams only in the internal export | SDK probe + reference |

## Design rules

1. **Nothing printed for bookkeeping.** Completion and exit codes travel through `status` files; output through `log` files (log mode) or the PTY screen (screen mode). No `__BG_DONE__`-style markers, no screen parsing for state.
2. **The terminal receives one short line per task**: `sh <run.sh>`. Exact quoting lives in the file (no shell-escaping of a 64 KB command through the PTY input path); the file is the audit record of what ran.
3. **State is derived, not maintained.** `running` ⇔ no status file; `exited` ⇔ status file; `orphaned` ⇔ terminal gone while running. `background_list` needs no daemon call for terminal-state tasks.
4. **Codex env hygiene in log mode**: the wrapper exports `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat GH_PAGER=cat COLORTERM=` (Codex `UNIFIED_EXEC_ENV`) so redirected output is machine-readable without post-hoc ANSI stripping. Screen mode leaves the environment untouched (colors, TUI, TTY detection all work).
5. **Traps live in the wrapper's child process.** `sh run.sh` keeps SIGINT/TERM/HUP handling self-contained; the session shell is untouched (verified).
6. **Ownership is the local record.** The daemon never checks who owns a terminal id, so tools only ever address task ids that exist in this project's state; the terminal id is never a public handle.
7. **Same-host assumption.** The side channel is local FS next to a local daemon. Remote daemons (`ssh://`) are out of scope until P2.

## Wrapper protocol

`run.sh` is generated per task (POSIX `sh`); the command itself lives in `cmd.sh` and is sourced inside a subshell, so no user bytes are ever embedded in the wrapper — no quoting hazards, and a stray `)` is a contained parse error that still records a status:

```sh
#!/bin/sh
status='/abs/t-x/status'
export NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat GH_PAGER=cat COLORTERM=
trap 'printf %s 129 > "$status"; trap ":" INT TERM; kill -TERM 0; exit 129' HUP
trap 'printf %s 130 > "$status"; trap ":" HUP TERM; kill -TERM 0; exit 130' INT
trap 'printf %s 143 > "$status"; trap ":" HUP INT; kill -TERM 0; exit 143' TERM
( . '/abs/t-x/cmd.sh' ) <&0 > '/abs/t-x/log' 2>&1 &
child=$!
wait "$child"
printf '%s' "$?" > "$status"
```

- `& wait` is the POSIX trap-safe wait idiom: a trapped signal interrupts the wait immediately, so Ctrl-C is recorded in milliseconds instead of deferring the trap until the child exits (verified: wrapper killed with no PTY and no group signal still lands `130` in <500 ms).
- `<&0` keeps the PTY as the command's stdin. POSIX assigns `/dev/null` to an asynchronous list in a non-interactive shell, and without the explicit dup every `background_write` byte would sit in the PTY input queue until the wrapper exits — then run in the session shell (live-verified injection marker). With `<&0` the foreground process reads what is typed.
- The traps record the status first, demote their sibling signals to no-ops, then TERM the whole process group: the daemon's `C-c` reaches only the wrapper process, and killing just the direct child orphans grandchildren (live-verified: `sleep` survived with `ppid=1` while the task reported `exited`). The no-op siblings keep the group TERM from killing the wrapper before it records its own code; children keep the default dispositions they forked with. `kill -TERM 0` is safe because the interactive session shell runs `sh run.sh` as its own foreground process group; the `share_shell` variant (sourced into the session shell, no wrapper process) will need `set -m` + `kill -TERM -$child`.
- Screen mode: drop the redirection and the env exports, keep `<&0`; the command keeps the PTY as stdin/stdout/stderr.
- `share_shell: true` (P1): submit `. <run.sh>` instead — `cd`/`export` persist in the session (omp-style state carry-over). The sourced-trap-on-interrupt path is designed but not yet live-verified; the default `sh` path is.
- Status grammar: a decimal exit code (`129`/`130`/`143` for HUP/INT/TERM via trap), `terminated` (a stop where the trap lost the race), or `error` (submit failed).
- Known race: during the first milliseconds of wrapper startup the traps are not yet installed, so an immediately delivered signal can kill the wrapper with the default action. The service closes this: `background_stop` writes `terminated` when no status appears within its confirmation window — the command is dead either way, and the record never lies about running.
- Screen-mode output is read with `capture_terminal` and bounded to the last N lines; log-mode output is the file (unbounded history, survives daemon restart).

## Tool surface

Names match `pi-herdr-background-terminal` so prompts/skills transfer; the two packages are mutually exclusive installs (same pattern as the herdr/paseo subagent pair).

| Tool | Daemon calls | Notes |
| --- | --- | --- |
| `background_exec` | `create_terminal` (new session), `send_terminal_keys` ×2 | `{command, cwd?, label?, session?, output?: "log" \| "screen", wait_ms?}`. `session` reuses a task's terminal (commands queue). `wait_ms` blocks on the local status file (codex `yield_time` semantics). Returns `task_id` only. |
| `background_list` | none (or one `list_terminals` for running tasks) | Derived states, keyset cursor, works with the daemon down. |
| `background_read` | `capture_terminal` (screen mode only) | `{task_id, wait_ms?, output_lines?, range?: "new" \| "all"}`. Log mode = byte-cursor tail of the log file ("new" = since last read, Claude `BashOutput` semantics; a burst larger than the read window drops the head and lands the cursor on the tail). |
| `background_write` | `send_terminal_keys` | `{task_id, input, submit?}` → PTY input of the foreground process. |
| `background_stop` | `send_terminal_keys "C-c"` / `kill_terminal` | `interrupt` = C-c (trap writes `130`; no status inside the confirm window → `terminated`); `terminate` = kill PTY (HUP trap may record `129`, otherwise the stop writes `terminated`). |

Human control: `/bg [list|read|write|interrupt|terminate|clean] [task_id] [input]`. Watch or take over a task live in the Paseo app by opening its terminal.

Caps: ≤16 active sessions per project, command ≤64 KB, `wait_ms` ≤300 s, `output_lines` ≤2000.

## State layout

```
~/.pi/pi-paseo-background-terminal/<project-hash>/tasks/<task_id>/
  meta.json   # identity: task_id, terminal_id, label, command, cwd, output mode, created_at, read_offset
  run.sh      # the generated wrapper (audit + regeneration)
  log         # exact stdout+stderr, log mode only
  status      # exit code / "terminated" once finished
```

Sessions are derived by grouping `meta.json` by `terminal_id`; there is no sessions file. Task ids are opaque (`t-<hex8>`).

Deleted with `/bg clean --confirm`: terminal-state task directories (and a `kill_terminal` best-effort for sessions whose last task is gone).

## What this deletes relative to the Herdr design

| Herdr mechanism | Here |
| --- | --- |
| `wrapCommand` start/done markers + `parseTaskOutput` screen parsing | status file |
| 24 h watcher loop, retry backoff, per-task AbortController, `shutdown()` | nothing — `wait_ms` polls a local file |
| `session_start` recovery pass | nothing — state is derived |
| pane/tab release + `resources_released_at` | nothing — the terminal is either alive or the task is orphaned |
| extension-written canonical output files + `saveCapture` | the wrapper writes the log; the extension only reads |
| 6-state task machine | 3 states (`running`, `exited`, `orphaned`) |

Roughly: herdr `index.ts` 734 lines → est. ~350 here; `state.ts` 271 → folded into a ~150-line `runner.ts`.

## File plan

```
packages/pi-paseo-background-terminal/
  index.ts                 # tools, /bg
  mcp-client.ts            # copied from pi-paseo-subagent (publish independence)
  paseo-terminal-client.ts # create/send/capture/kill/list + "not found" normalization
  runner.ts                # run.sh template, submit line, status/log/meta I/O, state derivation
  protocol.ts              # param types + asserts
  index.test.ts            # unit
  service.integration.ts   # fake-daemon HTTP integration (node:http, no daemon needed)
  live.probe.ts            # real-daemon verification (not published)
  README.md, LICENSE, docs/design.md
```

## Verification

Implementation suites (all passing, 2026-09-13):

- Unit (`node --test index.test.ts`, 26 tests): wrapper template content and screen/log variants, real-spawn exit code and exact log bytes, quoting/command substitution verbatim through `cmd.sh`, contained `)` breakout, trap-recorded 130 (group INT and wrapper-only INT, <500 ms), status grammar, byte-cursor reads with window overflow, meta I/O with malformed-record skip, cwd confinement, service flows (exec, session reuse and dead-session refusal, 16-session cap with reclaimed slots, submit-failure cleanup, list state matrix with a down daemon, keyset pagination, write refusal paths, interrupt including the startup-race `terminated` fallback, terminate, cleanup including orphans), parameter bounds, and the five-tool registration.
- Fake-daemon HTTP integration (`service.integration.ts`): real JSON-RPC over the MCP SSE envelope with real `sh run.sh` spawns — 8 scenarios including orphan detection and terminal release.
- Live against daemon 0.8.0 (`live.probe.ts`, run inside a Paseo agent): log mode with real exit code, session reuse on one terminal, screen mode read back through `capture_terminal`, interrupt (the startup-race fallback fired on the real PTY, proving its need), orphan detection, terminate with terminal release, cleanup.
- Real `pi -ne -e` session smoke: `background_exec(wait_ms)` → `exited exit=0`, `background_read` → exact bytes.
- Loading both the Herdr and Paseo background packages at once fails loudly on the shared `background_*` names (verified) — install one backend per Pi setup.

Earlier research probes (2026-09-13, daemon 0.8.0) established the transport facts recorded above. Still unverified: daemon-restart orphaning on a live daemon (the fake covers the code path) and the `share_shell` variant.

## Phases

**P0.** Everything above with `output: log|screen`, `session` reuse, derived state, `/bg`, tests. **Done.**

**P1.** `share_shell: true` (sourced wrapper, verified interrupt path); completion `ui.notify` on observed transitions; task queue introspection (`background_list` showing per-session FIFO order); daemon-restart orphan rehearsal on a live daemon.

**P2.** Remote daemons (side channel breaks; needs an all-MCP variant — screen capture + terminal-scoped status via a typed sentinel); push completion via the internal WS stream if polling ever measurably hurts.

## Appendix: why not Codex's architecture verbatim

Codex owns the PTY (`portable-pty` + `waitpid`), so completion is a child-reap event and output is its own 1 MiB `HeadTailBuffer`. Here the daemon owns the PTY, and its only completion-relevant surfaces are terminal presence and the rendered screen. The side-channel files restore exactly what owning the PTY would have given (exit code, exact bytes, unbounded history) while keeping the two things Codex cannot offer: daemon-side survival across agent restarts, and a terminal a human can open and take over mid-run.
