# pi-paseo-subagent design

How this package delegates work to Paseo: the transport, the tool surface, the ownership rules, and what is still to build.

## Architecture

The extension talks to Paseo's agent MCP endpoint directly over HTTP — one JSON-RPC `tools/call` per operation, no process spawns, no state on disk. Each subagent is a real Paseo agent: it appears in the user's Subagents track, it can be watched, steered, approved, or detached from the app, and it may run on any provider the daemon has.

```
Pi session (inside a Paseo agent)
  └── pi-paseo-subagent ──HTTP JSON-RPC──▶ http://<daemon>/mcp/agents?callerAgentId=<this agent>
                                              └── Paseo daemon ──▶ child agent (any provider)
```

`mcp-client.ts` is the whole transport: endpoint and credential resolution, one `callTool`, and error mapping. `index.ts` holds the tool surface, value parsing, ownership checks, and the `/subagent` command.

## Endpoint facts

Verified against the running daemon unless marked otherwise.

| Fact | Detail |
| --- | --- |
| URL | `POST <base>/mcp/agents`, optional `?callerAgentId=<agentId>`. The client always appends the caller id. |
| Protocol | Streamable HTTP: JSON-RPC body, SSE response (`event: message` + `data: <json>`); a plain JSON body is also accepted. `serverInfo: agent-mcp 2.0.0`, `protocolVersion 2025-06-18`. |
| Handshake | **None needed.** The endpoint is stateless: no `initialize`, no session header, no `notifications/initialized`. Verified with a bare `tools/call` as the first request. |
| Auth | `auth.ts:143` in the Paseo repo: no daemon password ⇒ every request is authorized; with a password, `Authorization: Bearer <password>`. The per-daemon capability token is only injected into agent configs, which the Pi provider never receives, so `PASEO_PASSWORD` is the only credential this package can use. |
| Endpoint resolution | `PASEO_MCP_URL` → `PASEO_HOST` → `$PASEO_HOME/paseo.pid` `listen` → `$PASEO_HOME/config.json` `daemon.listen` → `127.0.0.1:6767`. `PASEO_HOME` defaults to `~/.paseo`. Wildcard binds (`0.0.0.0`, `::`) are rewritten to loopback, so a daemon listening on all interfaces is still reached on `127.0.0.1`. `ssh://` targets are parsed but need an external tunnel (see Phases). |
| Catalog | 61 tools top-level; adding `callerAgentId` adds `get_agent_activity`, `set_agent_mode`, `list_pending_permissions`, `respond_to_permission`, and drops `background` from `create_agent` (agent-scoped creation is always asynchronous). |
| Errors | Tool failures are a JSON-RPC **success** with `isError: true` and `content[0].text`; JSON-RPC-level errors are separate. Both map to `paseo_tool_failed`. HTTP 401/403 map to `paseo_auth_required`, unreachable daemons to `paseo_unavailable`, malformed bodies to `paseo_invalid_output`. |
| Ownership | **Not enforced by the daemon.** `cancel_agent`, `archive_agent`, `kill_agent`, `get_agent_activity`, `set_agent_mode`, and `respond_to_permission` take a raw `agentId` and never check the caller, so an agent-scoped client can act on any agent on the host, including its own parent. This package refuses to call them until it has verified `labels["paseo.parent-agent-id"] === PASEO_AGENT_ID`. |
| Parentage | Stamped by the daemon and merged last (`create-agent/intent.ts`), so a caller cannot spoof or clear `paseo.parent-agent-id`. |
| Push | `notifyOnFinish` (on for every child) makes the daemon send a prompt into the parent agent on finished / errored / needs-permission / closed, carrying the child id, title, reason, and up to 4000 chars of its last assistant message; permission notifications include the `agentId`/`requestId` to answer. Delivery uses `activeTurnBehavior: "steer"`, so it arrives after the parent's current tool calls. |
| Bypass caveat | Paseo's per-provider `paseoTools` policy limits the catalog *presented* to an agent and is explicitly not a security boundary for anything with shell access. This extension reaches the endpoint directly, so its own tool surface is the boundary. |

## Reading Paseo's preset provider settings

`list_profiles` is the only supported read path (there is no CLI profile command). It returns the host's saved agent profiles:

```json
{"id": "agent_profile_mtveb527_1p0w2rngx16", "name": "h-deepseek-flash", "icon": "microscope",
 "provider": "pi", "model": "h/deepseek-flash", "thinkingOptionId": "medium"}
```

Field mapping onto `create_agent`, which has no profile parameter (documented in `paseo.sh/docs/mcp`):

| Profile field | `create_agent` field |
| --- | --- |
| `provider` + optional `model` | `provider` as `provider/model`, e.g. `pi/nikoapi/gpt-5.6-sol` |
| `modeId` | `settings.modeId` |
| `thinkingOptionId` | `settings.thinkingOptionId` |
| `featureValues` | `settings.features` |
| `notes` | orchestrator selection guidance; the task goes in `initialPrompt` |

`subagent_run` resolves its target in this order:

1. `provider` argument (`provider` or `provider/model`) — explicit override.
2. `profile` argument (profile name or id) — resolved through `list_profiles`.
3. Neither — inherit the calling agent's own `provider`, `model`, and `effectiveThinkingOptionId` from `get_agent_status`.

An explicit `thinking` argument overrides whatever the profile or the parent supplied. Paseo thinking ids are provider-specific, so the profile's and the parent's ids are forwarded as-is while an explicit override is passed through unchanged. `provider` and `profile` together are rejected as ambiguous.

Paseo profiles replaced this package's earlier `pi-paseo-subagent.presets` setting, which duplicated configuration the user already curates in Paseo (and required nesting Pi provider ids inside Paseo provider ids). There is no package-level preset configuration any more.

## Subagent design

Rules the implementation follows:

1. **Ownership first.** Every read, wait, stop, and future permit call resolves the target with `get_agent_status` and requires the parent label. A non-owned or unknown id fails with `subagent_not_found` before any lifecycle call.
2. **Two labels per child.** `paseo.parent-agent-id` (daemon-stamped, ownership) and `pi-paseo-subagent=<pi session id>` (ours, so rows are identifiable in the Paseo UI and through `paseo ls --label`).
3. **Push by default, wait opt-in.** Children are created with `notifyOnFinish: true`, so the parent is woken with the result instead of polling. `subagent_wait` remains for "I need the answer now", implemented as in-process polling of `list_agents` at 500 ms with one shared deadline.
4. **No `kill_agent`.** `interrupt` = `cancel_agent` (the agent survives and can be prompted again), `terminate` = `archive_agent` (soft delete, recoverable, and still visible through `list_agents {includeArchived: true}` as `status: "closed"`). Hard deletion stays a human action in Paseo.
5. **Roles stay honest.** `scout` / `reviewer` / `worker` shape the child's prompt and title. Where a provider exposes modes, `settings.modeId` can become real enforcement; for the `pi` provider (`modes: []`, `AvailableModes: []`) the role is prompt-level only, and the tool descriptions say so.
6. **Stateless.** Nothing is remembered between calls: discovery is derived from the daemon's own labels, so children stay visible after an extension reload or session resume.

### Tool surface

| Tool | MCP calls | Notes |
| --- | --- | --- |
| `subagent_run` | `get_agent_status` (inherit), `list_profiles` (profile), `list_agents` (cap), `create_agent` | `prompt`, `role`, `name`, `profile`, `provider`, `thinking`. Returns the child id; the daemon's `guidance` string is passed through in `details`. |
| `subagent_list` | `list_agents` | Filters by parent label, shows role, status, `attention=...`, `archived`; `include_finished` maps to `includeArchived`. |
| `subagent_read` | `get_agent_status`, `get_agent_activity` (+ `list_agents` when waiting) | Returns the daemon's curated activity plus a status line; `wait_ms` first waits for the child to settle. |
| `subagent_wait` | `list_agents`, `get_agent_activity` | `all` / `any`, one shared deadline; a child blocked on permission settles immediately with a note; nothing is cancelled by a timeout. |
| `subagent_stop` | `cancel_agent` / `archive_agent` | `interrupt` / `terminate`. |
| `subagent_presets` | `list_profiles` | Read-only: names, ids, provider/model, thinking, notes. |

Human control: `/subagent list|read|interrupt|terminate|presets [id]`.

Limits: prompts up to 32 KiB, names up to 40 characters, at most eight concurrently active children per parent, waits up to five minutes, activity up to 2000 items.

### Discovery limits

Discovery is `list_agents` filtered by parent label, and `list_agents` is scoped by the daemon in ways worth knowing:

- **Caller `cwd` scope.** Without an explicit `cwd`, the daemon returns only agents whose `cwd` is the caller's `cwd` or below. Children inherit the caller's `cwd`, so they are always in scope today; a child placed in another directory would not be. Worktree-isolated children (Phases) need an explicit `cwd` or a Paseo-side filter.
- **200-row cap** (`limit` max 200) and a **30-day archived window** (`sinceHours` max 720). The client always asks for the maximum, but a very busy daemon can truncate the tail.
- `get_agent_status` is unaffected: an id plus the parent label is always enough to read or stop a child, even one outside the list scope.

## Verification

Unit tests (`pnpm test`, 50 tests across the monorepo, 29 for this package) cover endpoint resolution, host parsing, SSE and plain-JSON parsing, credential headers, the whole error vocabulary, profile and child parsing, wait notes, target resolution (inherit / profile / explicit / ambiguous), the active-child cap, trust and missing-context refusals, ownership refusals (non-existent and non-owned ids), listing and archived listing, read, `wait` in `all` and `any` modes, stop mapping, and profile listing. They run against a fake `fetch`, so CI needs no daemon.

`tsc --noEmit --strict` passes for `index.ts`, `mcp-client.ts`, and `index.test.ts` (TypeScript 5.0.2; this repo has no typecheck script, so the flags are `--module nodenext --moduleResolution nodenext --allowImportingTsExtensions --target es2022`).

Live end-to-end against the running daemon:

- `subagent_run` created a child on `pi/h/deepseek-flash` with `thinking=minimal`; the daemon stamped `paseo.parent-agent-id` and reported `guidance`.
- `subagent_list` found exactly the children of this session, including `attention=finished`.
- `subagent_wait` and `subagent_read` returned the curated activity (`pong`) — also for an archived child (`[closed] ... archived`).
- **Push worked**: the notification for the finished child arrived in this session as a `<paseo-system>` prompt carrying the child's last message.
- `subagent_stop mode: "terminate"` archived the child (`success: true`), after which the default list was empty and `include_finished` showed `[closed] ... archived`.
- `subagent_read` on the parent's own id was refused with `subagent_not_found: ... is not a subagent of this session`.
- The extension loads in a real `pi -e` session (relative `./mcp-client.ts` import included) and `subagent_presets` returned the four profiles configured in Paseo.

Not yet verified:

- A daemon with a password set (needs `PASEO_PASSWORD`; the 401 mapping is unit-tested but not live-tested).
- The permission path end to end: a child that blocks on approval, then `respond_to_permission` (needs a provider that asks for approval; the only enabled provider here, `pi`, exposes no modes and raised no requests in testing).
- A child on a non-Pi provider (claude/codex/copilot/opencode/omp are all `enabled: false` on this host).
- Cross-directory or worktree-isolated children (see Discovery limits).
- `ssh://` remote daemons.

## Phases

**Done (P0).** MCP transport; the six tools; ownership enforcement; label convention; push-by-default with opt-in wait; profile-based model selection replacing package presets; unit tests on a fake daemon; live verification on a real one.

**P1.**

1. `isolation: "shared" | "worktree"` on `subagent_run`: `create_workspace({isolation: "worktree", path})` → `create_agent({workspaceId})`, with the workspace id stamped into the child's labels, an explicit `cwd` for discovery, and a teardown rule.
2. `subagent_permit`: `list_pending_permissions` + `respond_to_permission`, filtered to owned children, never auto-approving.
3. `subagent_send`: `send_agent_prompt` for steering and follow-ups.
4. Role → `settings.modeId` where the provider exposes a read-only or plan mode, validated against `list_providers(...).modes`.
5. Surface `pendingPermissions` and `requiresAttention` per child in `subagent_list` (needs `get_agent_status` per child; decided against for P0 to keep listing to one call).

**P2.**

1. Remote daemons: build the SSH tunnel the CLI uses, or document `PASEO_MCP_URL` as the supported escape hatch.
2. Nesting policy: Paseo models nested subagents correctly; decide whether to bound depth or leave it to the per-parent cap.
3. Notification/wait de-duplication when a finish notification and an explicit `subagent_wait` report the same child in one turn.

## Appendix: why not the `paseo` CLI

The CLI works and was the first implementation: `paseo run` executed by a Paseo agent creates a subagent because the CLI resolves the caller from `PASEO_AGENT_ID` and the daemon stamps parentage. It was replaced because the MCP endpoint is a strict improvement on every axis that mattered:

| | CLI | MCP |
| --- | --- | --- |
| Setup | `paseo` binary on `PATH` | none (HTTP to the daemon) |
| Cost per call | one Node process per operation (~0.5 s) | one HTTP request (milliseconds) |
| Reads | scraped text from `paseo logs --filter text` | `get_agent_activity` curated payload |
| Waiting | one `paseo wait` process per child | in-process polling, cancellable |
| Completion | polling only | push notification into the parent |
| Permissions | invisible | `list_pending_permissions` / `respond_to_permission` |
| Archived children | vanish from `paseo ls` | visible as `status: "closed"` |
| Steering a child | not available | `send_agent_prompt` |
| Transport risk | argv limits, prefix ids, stderr parsing | JSON-RPC error mapping |

The one thing the CLI still does better is SSH targets, which need a tunnel for HTTP. That is tracked in P2.
