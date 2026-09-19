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
| `subagent_wait` | Wait for one or more subagents (`all` or `any`) with a shared deadline. |
| `subagent_stop` | Interrupt a subagent, or terminate it by archiving it out of the track. |
| `subagent_presets` | List Paseo profiles with ready-to-use `profile` values and selection notes. |

Human control is also available through:

```text
/subagent list
/subagent read <subagent_id>
/subagent interrupt <subagent_id>
/subagent terminate <subagent_id>
/subagent presets
```

Example request shape:

```json
{
  "prompt": "Inspect the authentication flow and report the highest-risk defects.",
  "name": "auth-review",
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

`thinking` overrides whatever the profile or the parent supplied. Profiles keep their `thinkingOptionId` and, when present, their `modeId` and feature values. The package has no configuration of its own: Paseo's profiles are the single source of truth.

### Waiting and notifications

Children are created with Paseo's finish notification enabled, so the parent is woken with the child's result (and with the request id when a child needs permission) instead of polling. `subagent_wait` is for when the answer is needed now: it polls in-process, returns when all children settle (or the first one, with `mode: "any"`), and never cancels a child when it times out. A child blocked on permission is reported immediately rather than waiting for the deadline.

## Lifecycle

`subagent_stop mode: "interrupt"` calls Paseo's cancel: the agent stops its current run and stays available for another prompt. `subagent_stop mode: "terminate"` archives it: interrupted if running, removed from the parent's Subagents track, and still recoverable in Paseo as `status: "closed"` (visible here through `subagent_list {include_finished: true}`). Nothing in this package hard-deletes an agent — that stays a human action in Paseo.

Paseo archives a subagent together with its parent when the parent is archived, so long-lived subagents should not be attached to a short-lived parent.

An archived subagent's transcript is not returned by `subagent_read` or `subagent_wait`: Paseo's `get_agent_activity` resumes an archived agent, which clears its archive flag (it reappears in the default `subagent_list`) and fires its finish notification a second time. Those tools answer with the status line and an `archived:` note instead, so archived children stay archived — read their transcript in Paseo.

## Difference from `pi-herdr-subagent`

| | `pi-herdr-subagent` | `pi-paseo-subagent` |
| --- | --- | --- |
| Child execution | One-shot `pi --print` in a Herdr pane | Full Paseo agent owned by the daemon |
| Providers | Pi only | Any provider the daemon has enabled |
| Task roles | Hard `--tools` allowlist per role | None; intent such as read-only goes in the prompt |
| Human visibility | Herdr pane | Paseo Subagents track: watch, steer, approve, detach |
| Working directory | Per-subagent `cwd` inside the project | The caller's `cwd`; isolation needs a separate workspace |
| Steering | None; one-shot process | Follow-up prompts, permission decisions, detach in Paseo |
| Completion | Polling | Push notification into the parent, polling optional |
| Permissions | Not surfaced | Visible in Paseo; approval here is planned |

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

- Every read, wait, and stop call verifies at the daemon that the target's `paseo.parent-agent-id` equals this session's agent id. Paseo itself performs no such check, so the extension never issues a lifecycle call against an unverified id.
- `subagent_run` requires a trusted project, refuses to run outside a Paseo agent, and caps concurrently active children at eight.
- Children inherit the caller's workspace and edit the same files as the parent. Delegation is not a sandbox.
- Paseo's per-provider tool policy is not a security boundary for an agent with shell access, and this extension reaches the daemon directly. Its own tool surface — six tools, no kill, no workspace or schedule management — is the boundary.
- Note that a daemon listening on `0.0.0.0` without a password exposes its agent control plane to the network. Prefer loopback or a password.

See [docs/design.md](docs/design.md) for the endpoint facts, the tool-surface rationale, the discovery limits, and the verification record.
