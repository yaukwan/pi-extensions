# pi-paseo-background-terminal

A Pi extension that runs background tasks in persistent [Paseo](https://paseo.sh) terminal sessions and exposes them through background-task tools.

## Install

```bash
pi install npm:pi-paseo-background-terminal
```

Requires a Pi session running inside a Paseo agent (`PASEO_AGENT_ID` is set by the daemon) and a reachable daemon, local to the Pi process.

## How it works

- Each background session is a real Paseo terminal: a daemon-owned PTY that survives Pi restarts, visible and take-over-able in the Paseo app (Terminals of the agent's workspace).
- Each `background_exec` submits one line to the session's shell: `sh <run.sh>`. The wrapper sources your command from `cmd.sh` and records completion out-of-band — nothing is ever printed into the terminal for bookkeeping.
- Output stays on the terminal screen (`output: "screen"`, default: colors and TUI work; read returns rendered lines) or goes to a log file (`output: "log"`: exact bytes with `NO_COLOR`/`TERM=dumb` environment).
- Task state is derived on read: `running` (no status file), `exited` (status file with the exit code), `orphaned` (terminal gone). No watchers, no polling loops.
- Records live under `~/.pi/pi-paseo-background-terminal/<project-hash>/tasks/<task_id>/` (`meta.json`, `run.sh`, `cmd.sh`, `log`, `status`).

## Tools

| Tool | Purpose |
| --- | --- |
| `background_exec` | Run a POSIX shell command; returns an opaque `task_id`. `session=<task_id>` reuses a session's shell (commands queue). `wait_ms` reports completion and the exit code in the same call. |
| `background_list` | List tasks with derived state; works with the daemon down for finished tasks. |
| `background_read` | Log mode: new bytes since the last read (`range: "new"` default) or the bounded tail (`range: "all"`). Screen mode: captured terminal lines. |
| `background_write` | Send PTY keyboard input to a running task (`submit: false` skips the Enter press). |
| `background_stop` | `interrupt` sends Ctrl-C (exit code 130 via the wrapper's trap; falls back to `terminated` when the trap loses the startup race); `terminate` kills the session terminal. |

The `/bg` command provides the same controls:

```text
/bg list
/bg read <task_id>
/bg write <task_id> <input>
/bg interrupt <task_id>
/bg terminate <task_id>
/bg clean --confirm
```

To watch or take over a task interactively, open its terminal in the Paseo app.

## Limits

- At most 16 active sessions per project; commands up to 64 KB; `wait_ms` up to 300 s; reads bounded to 2000 lines / 50 KB per response (a log burst larger than the window drops the head and keeps the tail).
- Commands run under POSIX `sh`; use `bash -lc '...'` inside the command for shell-specific behavior.
- Interrupt is Ctrl-C, not a guaranteed kill — a program that ignores SIGINT keeps running; use `terminate`.
- Same-host daemon and Pi process (the side channel is the local filesystem). Remote daemons are not supported yet.

## Development

```bash
node --test --experimental-transform-types index.test.ts          # unit
node --experimental-transform-types service.integration.ts       # fake-daemon HTTP integration
node --experimental-transform-types live.probe.ts                # real daemon (inside a Paseo agent)
```

Design notes: [`docs/design.md`](docs/design.md).

## License

[MIT](LICENSE)
