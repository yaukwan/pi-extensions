# pi-paseo-subagent

A Pi extension that delegates work to real [Paseo](https://github.com/getpaseo/paseo) agents. Each subagent runs on any provider the daemon has and appears in Paseo's **Subagents track**, so the user can watch, steer, approve, or detach it while the parent keeps working. Paseo notifies this session when a subagent finishes, errors, or needs permission.

## Install

```bash
pi install npm:pi-paseo-subagent
```

To try it without installing:

```bash
pi -e npm:pi-paseo-subagent
```

Requirements:

- A running Paseo daemon (this extension talks to its agent MCP endpoint over HTTP; no `paseo` binary is needed).
- The Pi session runs **inside a Paseo agent**, so children attach to it as subagents. A session outside Paseo is refused with `paseo_agent_context_missing`.
- The current project is trusted.

> Do not install this package together with `pi-herdr-subagent`. Both register `subagent_*` tools, and Pi silently keeps the last loaded definition.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_run` | Create a Paseo agent as a subagent of this session and return its id. |
| `subagent_list` | List this session's subagents with state and attention flags. |
| `subagent_read` | Read a subagent's activity, optionally waiting for it to settle. Archived subagents return a status line instead (see Lifecycle). |
| `subagent_wait` | Wait for one or more subagents (`all` or `any`) with a shared deadline and return their state; transcripts are opt-in with `include_activity`. |
| `subagent_stop` | Interrupt a subagent, or terminate it by archiving it out of the track. |
| `subagent_send` | Send follow-up work to an existing subagent instead of spawning a new one. |
| `subagent_permit` | List a subagent's pending permission requests, or answer one with allow/deny. |
| `subagent_presets` | List Paseo profiles with ready-to-use `profile` values and selection notes. |

Every tool that takes `subagent_id` also accepts the display name set through `subagent_run`'s `name`, as long as it is unique among this session's subagents.

Human control is also available through:

```text
/subagent list
/subagent read <subagent_id>
/subagent send <subagent_id> <prompt...>
/subagent interrupt <subagent_id>
/subagent terminate <subagent_id>
/subagent permit
/subagent presets
```

Example request shape:

```json
{
  "prompt": "Inspect the authentication flow and report the highest-risk defects.",
  "name": "auth-review",
  "profile": "Reviewer"
}
```

### Choosing a model

`subagent_run` takes one optional `profile`:

| Value | Behavior |
| --- | --- |
| Omitted | Inherit the calling agent's provider, model, and thinking level. |
| `"<profile-name-or-id>"` | Select a saved Paseo profile, e.g. `"Reviewer"` or `"agent_profile_review"`. |

Call `subagent_presets` (or `/subagent presets`) and copy the `profile` value from its JSON fragment, e.g. `{"profile":"agent_profile_review"}`. Profile IDs avoid ambiguity when names resemble task roles. There is no raw `provider` or `provider/model` argument any more: Paseo profiles are the single source of runtime configuration, so a runtime without a saved profile is first created as a profile in Paseo.

There is no `role` argument. Task intent — such as read-only — belongs in `prompt` itself; it is advisory, grants no permissions, and delegation is not a sandbox. Bare `scout`, `default`, `openai`, and `inherit` are not valid profile values and fail with `profile_not_found`; a blank profile fails locally with `invalid_arguments`.

Migration: the old top-level `provider` argument and the `target` experiment have been removed and are rejected by the schema. Replace them with one `profile`; no automatic precedence or fallback is applied. Run `/reload` after updating the installed extension so Pi exposes the new tool definition. An older npm installation must be updated first; editing a separate checkout does not update it.

`thinking` overrides whatever the profile or the parent supplied. A profile's `thinkingOptionId` and its `modeId` are forwarded to the child (`modeId` matters for cross-provider profiles: the daemon refuses to inherit a mode across providers); profile feature values are not forwarded. The package has no configuration of its own: Paseo's profiles are the single source of truth.

### Waiting and notifications

Children are created with Paseo's finish notification enabled, so the parent is woken with the child's result (and with the request id when a child needs permission) instead of polling.

`subagent_wait` is for when the caller is blocked and needs to know that a child settled: it polls in-process with a backing-off interval, returns when all children settle (or the first one, with `mode: "any"`), and never cancels a child when it times out. By default it returns **state only** — status, attention reason, archived flag — because the finish notification already delivers each child's final message; pass `include_activity: true` to fetch curated transcripts here (per-child `output_lines` controls how many activity entries each returns). A child blocked on permission settles immediately with a note instead of burning the deadline.

## Lifecycle

`subagent_stop mode: "interrupt"` calls Paseo's cancel: the agent stops its current run and stays available for another prompt. `subagent_stop mode: "terminate"` archives it: interrupted if running, removed from the parent's Subagents track, and still recoverable in Paseo as `status: "closed"` (visible here through `subagent_list {include_finished: true}`). Nothing in this package hard-deletes an agent — that stays a human action in Paseo.

Paseo archives a subagent together with its parent when the parent is archived, so long-lived subagents should not be attached to a short-lived parent.

`subagent_send` steers or replaces the child's current run and re-arms its finish notification, so follow-up work reuses the child's context instead of consuming another concurrency slot. Sending to an archived child resumes it on the daemon, which is stated in the tool's reply; nothing in this package reads an archived child's transcript, so archived children stay archived after a `subagent_read`.

A subagent blocked on a permission request never times out, keeps one of the eight concurrency slots, and shows as `attention=permission`. `subagent_permit` lists the requests of this session's children (the daemon returns every agent on the host, so the list is filtered to owned children) and answers one: `decision: "allow"` with `answer` for a question request, or `decision: "deny"` with a `comment`. Approval is never automatic — the caller must decide, and the tool refuses to answer a request it cannot verify as owned.

An archived subagent's transcript is not returned by `subagent_read` or `subagent_wait`: Paseo's `get_agent_activity` resumes an archived agent, which clears its archive flag (it reappears in the default `subagent_list`) and fires its finish notification a second time. Those tools answer with the status line and an `archived:` note instead, so archived children stay archived — read their transcript in Paseo.

## Difference from `pi-herdr-subagent`

| | `pi-herdr-subagent` | `pi-paseo-subagent` |
| --- | --- | --- |
| Child execution | One-shot `pi --print` in a Herdr pane | Full Paseo agent owned by the daemon |
| Providers | Pi only | Any provider the daemon has enabled |
| Task roles | Hard `--tools` allowlist per role | None; intent such as read-only goes in the prompt |
| Human visibility | Herdr pane | Paseo Subagents track: watch, steer, approve, detach |
| Working directory | Per-subagent `cwd` inside the project | The caller's `cwd`; isolation needs a separate workspace |
| Steering | None; one-shot process | `subagent_send` follow-ups; also possible directly in Paseo |
| Completion | Polling | Push notification into the parent, polling optional |
| Permissions | Not surfaced | Listed and answered through `subagent_permit` |

## Environment

| Variable | Purpose |
| --- | --- |
| `PASEO_MCP_URL` | Full MCP endpoint, when it is not derivable. Highest priority. |
| `PASEO_HOST` | `host`, `host:port`, or `tcp://host:port`. |
| `PASEO_PASSWORD` | Daemon password, sent as a bearer token. Required only if the daemon has one. |
| `PASEO_HOME` | Overrides `~/.paseo`, where the daemon's listen address is read from `paseo.pid` / `config.json`. |
| `PASEO_AGENT_ID` | Set by Paseo for this session; supplies the caller id and the ownership check. |

Resolution order is `PASEO_MCP_URL` → `PASEO_HOST` → the daemon's recorded listen address → `127.0.0.1:6767`. Remote `ssh://` daemons need an external tunnel for now.

## Security boundary

- Every read, wait, stop, send, and permit call verifies at the daemon that the target's `paseo.parent-agent-id` equals this session's agent id. Paseo itself performs no such check, so the extension never issues a lifecycle call against an unverified id.
- `subagent_permit` never auto-approves: it only lists and forwards an explicit `allow`/`deny` decision, and it filters the daemon's host-wide pending list down to this session's children.
- `subagent_run` requires a trusted project, refuses to run outside a Paseo agent, and caps concurrently active children at eight.
- Children inherit the caller's workspace and edit the same files as the parent. Delegation is not a sandbox; the delegation prompt tells children to stay inside their assigned scope and to treat their final message as the report the parent actually reads.
- Paseo's per-provider tool policy is not a security boundary for an agent with shell access, and this extension reaches the daemon directly. Its own tool surface — six tools, no kill, no workspace or schedule management — is the boundary.
- Note that a daemon listening on `0.0.0.0` without a password exposes its agent control plane to the network. Prefer loopback or a password.

See [docs/design.md](docs/design.md) for the endpoint facts, the tool-surface rationale, the discovery limits, and the verification record.
