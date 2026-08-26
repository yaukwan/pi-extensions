# pi-herdr-subagent

A Pi extension that runs delegated Pi agents in persistent Herdr panes through `pi-herdr-background-terminal`.

## Install

Install as a Pi package. It uses `pi-herdr-background-terminal` as an implementation dependency and registers only the `subagent_*` tools:

```bash
pi install npm:pi-herdr-subagent
```

To try it without installing:

```bash
pi -e npm:pi-herdr-subagent
```

`pi-herdr-background-terminal` may be installed separately. Its `background_*` tools and this package's `subagent_*` tools are designed to coexist; `pi-herdr-subagent` imports its service but does not load its extension entry point.

The Herdr daemon must be running. The current project must be trusted.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_run` | Start an asynchronous delegated Pi process and return an opaque `subagent_id`. |
| `subagent_list` | List subagents created in the current Pi session. |
| `subagent_read` | Read bounded output, optionally waiting for completion. |
| `subagent_wait` | Wait for one or more subagents to reach a terminal state (`all` or `any`) and return bounded output. |
| `subagent_stop` | Interrupt or terminate a subagent. |

Human control is also available through:

```text
/subagent list
/subagent read <subagent_id>
/subagent interrupt <subagent_id>
/subagent terminate <subagent_id>
```

Example request shape:

```json
{
  "prompt": "Inspect the authentication flow and report the highest-risk defects.",
  "role": "reviewer",
  "model_preset": "balanced",
  "name": "auth-review"
}
```

`model_preset` is optional. Omit it to inherit the parent Pi model. The configured presets are `fast`, `balanced`, and `strong`; each maps to a `provider/model` and may define a default thinking level. An explicit `thinking` argument overrides the preset. Presets are read from the `pi-herdr-subagent` field in global or trusted project `settings.json` files:

```json
{
  "pi-herdr-subagent": {
    "presets": {
      "fast": { "model": "provider/fast", "thinking": "low" },
      "balanced": { "model": "provider/balanced", "thinking": "medium" },
      "strong": { "model": "provider/strong", "thinking": "high" }
    }
  }
}
```

`subagent_read` is pull-based and bounded: it waits for output when requested, returns the latest tail, and reports `output_truncated` when the captured output exceeds its limits. `subagent_wait` accepts `subagent_ids`, waits for all tasks by default, or returns when any task reaches a terminal state with `mode: "any"`. Its `wait_ms` is one shared timeout for the whole operation, defaulting to five minutes; a timeout only ends the wait and does not stop running subagents. The result includes every requested subagent's current state and bounded output, including tasks that are still running in `any` mode. Subagent discovery is scoped to the current Pi session; Herdr processes may continue running after the session ends but are not listed by a later session.

## Design

The v1 contract follows the useful common ground between Claude Code and Codex:

- Each invocation has an independent Pi context window and a focused delegated prompt.
- Roles control the child agent's native Pi tool allowlist: `scout` is read-only, `reviewer` can run checks, and `worker` can edit files.
- The parent receives an opaque id immediately and can wait for one or more subagents without polling.
- `subagent_list`, `subagent_read`, `subagent_wait`, and `subagent_stop` only discover subagents created in the current Pi session.
- Model selection uses the optional `fast`, `balanced`, or `strong` preset; omitting it inherits the parent model.
- Herdr owns the PTY and process lifecycle; this extension does not duplicate process state or spawn detached Node children.
- The id is the underlying background-terminal task id, so restart recovery, output archival, locking, and pane cleanup remain shared behavior.

The v1 tradeoff is deliberate: agents share the project workspace and are one-shot `pi --print` processes. There is no worktree isolation, follow-up message stream, chain, or parallel batch API yet. Add those only after the single-agent lifecycle is stable; worktree isolation in particular needs an explicit conflict and cleanup contract rather than an implicit directory copy.

## Security boundary

`subagent_run` requires a trusted project, keeps `cwd` inside that project, caps active subagents at eight, and passes a strict `--tools` allowlist to the child. `worker` is intentionally a shared-workspace write mode: use it only when concurrent edits are acceptable.
