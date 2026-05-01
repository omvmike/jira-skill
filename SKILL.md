---
name: jira
description: Use when the user asks Claude to read, look up, or summarize a Jira Cloud issue by key, search issues with JQL, or list comments/transitions for an issue. Triggers on phrases like "what is MIODEV-1234", "show me the ticket", "look up the jira issue", "find tickets assigned to me", "comments on this issue", "what are the transitions". Reads JIRA_SITE/JIRA_USER/JIRA_TOKEN/JIRA_CLOUDID from a local .jira file.
allow_implicit_invocation: true
allowed-tools: Bash(node *), Read
---

# jira — Jira Cloud skill

Thin Node.js wrapper over the Jira Cloud v3 REST API. Use it when the user
asks to read a Jira issue, search by JQL, or see comments/transitions —
replaces ad-hoc curl calls and keeps the API token out of shell history.

## When to use

- Looking up an issue by key (`MIODEV-1234`, `PROJ-42`, etc.)
- Searching issues by JQL or simple filters (project / assignee / status)
- Listing comments on an issue
- Listing the workflow transitions available on an issue
- Surfacing the cloudId for a site (for scoped tokens / API gateway)

## When NOT to use

- Writing to Jira (creating issues, transitioning, commenting, editing) —
  v1 of this skill is read-only. Say so and fall back to the Jira UI.
- Jira Server / Data Center — this skill only speaks Jira Cloud
  (`*.atlassian.net` or `api.atlassian.com/ex/jira/<cloudId>`).
- Confluence, Bitbucket, or other Atlassian products — separate skills.

## Bootstrap (one-time, per clone)

If `jira --whoami` returns exit code 2 with "no .jira file found", guide the
user through:

1. Open the API-token page (Jira app, all scopes, 30-day expiry prefilled):
   `https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken=&appId=jira&selectedScopes=all&expiryDays=30`

   On the page, **deselect everything except `read:jira-work` and
   `read:jira-user`** before clicking Create. Those two scopes cover
   everything this skill does.

2. Resolve your cloudId (one-time, unauthenticated):
   ```sh
   node ~/.claude/skills/jira/bin/jira.mjs --site <your-site>.atlassian.net --cloudid
   ```

3. At the project root:
   ```sh
   umask 077
   cat > .jira <<'EOF'
   JIRA_SITE=<your-site>.atlassian.net
   JIRA_USER=<your-atlassian-email>
   JIRA_TOKEN=<paste-api-token>
   JIRA_CLOUDID=<uuid-from-step-2>
   EOF
   echo .jira >> .gitignore
   ```

If you skip step 2, the CLI will resolve `JIRA_CLOUDID` automatically on the
first authenticated call and tell you to persist it; copying it once up
front just avoids the extra round-trip.

For OAuth 2.0 / Forge access tokens, omit `JIRA_USER` — the CLI will use
`Authorization: Bearer <token>` instead of Basic auth.

Never invent a token. Never write a token into a tracked file.

## Step order Claude must follow

1. Run `jira --whoami` first to confirm auth + site. If the site looks wrong,
   stop and confirm with the user before issuing further calls.
2. Default output is `--format json` (slimmed to relevant fields). When
   surfacing results directly to the user, pass `--format table` to render a
   markdown summary, or reformat the JSON yourself.
3. For "what's this ticket?" prompts, prefer `issue get <KEY>` over
   `issue search`. Search is for "find me tickets matching X", not lookups.
4. JQL with status names that contain spaces requires quoting (the CLI
   handles this automatically when you pass `--status`).

## CLI reference

```
node ~/.claude/skills/jira/bin/jira.mjs <command> [flags]

General:
  --whoami                                    Show site + auth + identity
  --list-targets                              Show detected site + .jira info (no network)
  --cloudid                                   Print cloudId for the resolved site

Issues:
  issue get <KEY>                             Issue detail
  issue comments <KEY> [--limit N]            Comments newest→oldest
  issue transitions <KEY>                     Available workflow transitions
  issue search --jql <q> [--limit N]          JQL search (raw)
  issue search [--project K] [--assignee currentUser|<accountId>]
               [--status <name>] [--limit N]  Convenience flags compiled into JQL

Global flags:
  --site <name>.atlassian.net                 Override JIRA_SITE
  --cloud-id <uuid>                           Override JIRA_CLOUDID (forces gateway routing)
  --format json|table                         Default: json
  --limit N                                   Default: 10
  --timeout MS                                Default: 15000
```

## Exit codes

| Code | Meaning | Response |
|------|---------|----------|
| 0 | Success | — |
| 2 | Config / auth (missing .jira, invalid token, 401/403) | Guide through bootstrap or ask for a fresh token |
| 3 | Not found (404) | Surface to user; don't retry |
| 4 | Validation (bad flags, unknown command, missing search criteria) | Fix the command and retry |
| 5 | Network / timeout / 5xx | Retry once, then surface |
| 6 | Rate-limited (429) | Back off; surface `retry-after` from stderr |

## Config precedence

- Site: `--site` flag > `JIRA_SITE` in `.jira` > error
- CloudId: `--cloud-id` flag > `JIRA_CLOUDID` in `.jira` > unset (use direct site)
- `.jira` location: project root (walking up from CWD to first `.git`) > `~/.config/jira/.jira`

## Token-deprecation note

Atlassian retired classic (unscoped) API tokens between **2026-03-14 and
2026-05-12**. The replacement — scoped API tokens — uses Basic auth
(`base64(email:token)`) but **must route through the Atlassian API gateway**:
`https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`. Direct-site URLs
(`<site>.atlassian.net/...`) reject scoped tokens.

Concretely: `JIRA_USER` + `JIRA_TOKEN` + `JIRA_CLOUDID` are all required
(`JIRA_CLOUDID` auto-resolves on first run if missing). Direct-site routing is
no longer supported. Bearer auth is reserved for OAuth 2.0 / Forge access
tokens and activates when `JIRA_USER` is omitted.
