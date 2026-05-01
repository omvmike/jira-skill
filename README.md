# jira-skill

Read-only Jira Cloud access as an Agent Skill. One codebase, works in **Claude Code** and **Codex CLI**.

Thin Node wrapper over the Jira Cloud REST API. All routing goes through the Atlassian API gateway (`api.atlassian.com/ex/jira/<cloudId>/...`) so it works with the post-2026 scoped API tokens; classic-token Basic-over-direct-site is no longer needed.

## What it does

- Single Node CLI: `bin/jira.mjs`
- Lookup issues by key, search by JQL or convenience flags, list comments & workflow transitions
- Auto-resolves `JIRA_CLOUDID` from `<site>/_edge/tenant_info` on first authenticated call if missing — and tells you the value to persist
- JSON output stays pure (no trailers); text output gets a divider-block hint when the skill emits a notice
- Inline `_hint` field in JSON object output makes skill-emitted messages obvious vs. Jira API responses
- Bearer (OAuth/Forge) and Basic (scoped API token + email) auth both supported via the same `.jira` file
- Zero third-party dependencies; uses `node:fetch` and `curl` only

## Install

Pick the location for the tool you use. Both tools read the exact same files.

### Claude Code

```bash
# personal (available in every project)
git clone https://github.com/omvmike/jira-skill ~/.claude/skills/jira

# or project-scoped (committed with your repo)
git clone https://github.com/omvmike/jira-skill .claude/skills/jira
```

Invoke with `/jira` or let Claude trigger it automatically when you ask about a ticket.

### Codex CLI

```bash
# personal
git clone https://github.com/omvmike/jira-skill ~/.agents/skills/jira

# or project-scoped
git clone https://github.com/omvmike/jira-skill .agents/skills/jira
```

Invoke with `$jira` or let Codex trigger it automatically.

### Update

```bash
cd <install-dir> && git pull
```

## Runtime requirement

Node 18+ (uses native `fetch`, `node:fs`, `node:child_process`). No npm install required — zero third-party dependencies.

## Setup `.jira`

1. Create a scoped Atlassian API token (Jira app, read-only scopes):
   https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken=&appId=jira&selectedScopes=all&expiryDays=30

   On the page, deselect everything except `read:jira-work` and `read:jira-user`.

2. Look up your `cloudId` (one-time, unauthenticated):

   ```bash
   node ~/.claude/skills/jira/bin/jira.mjs --site <your-site>.atlassian.net --cloudid
   ```

3. Save credentials at the project root:

   ```bash
   umask 077
   cat > .jira <<'EOF'
   JIRA_SITE=<your-site>.atlassian.net
   JIRA_USER=<your-atlassian-email>
   JIRA_TOKEN=<paste-api-token>
   JIRA_CLOUDID=<uuid-from-step-2>
   EOF
   chmod 600 .jira
   echo .jira >> .gitignore
   ```

   Skipping `JIRA_CLOUDID` is fine — the CLI auto-resolves it on the first authenticated call and tells you to persist it. For OAuth 2.0 / Forge access tokens, omit `JIRA_USER` to switch to Bearer auth.

4. Verify:

   ```bash
   node ~/.claude/skills/jira/bin/jira.mjs --whoami
   ```

## Daily use

Replace the install path with wherever you cloned.

```bash
# Issue detail (markdown summary)
node ~/.claude/skills/jira/bin/jira.mjs issue get MIODEV-1234 --format table

# Issue detail (JSON, full fields)
node ~/.claude/skills/jira/bin/jira.mjs issue get MIODEV-1234

# JQL search
node ~/.claude/skills/jira/bin/jira.mjs issue search \
  --jql 'project = MIODEV AND assignee = currentUser() AND status = "In Progress"' \
  --limit 10 --format table

# Convenience search (compiles to JQL)
node ~/.claude/skills/jira/bin/jira.mjs issue search \
  --project MIODEV --assignee currentUser --status "In Progress"

# Comments (newest first)
node ~/.claude/skills/jira/bin/jira.mjs issue comments MIODEV-1234 --limit 5

# Workflow transitions
node ~/.claude/skills/jira/bin/jira.mjs issue transitions MIODEV-1234

# Identity / auth check
node ~/.claude/skills/jira/bin/jira.mjs --whoami

# Where am I reading config from?
node ~/.claude/skills/jira/bin/jira.mjs --list-targets

# CloudId lookup (one-time, unauthenticated)
node ~/.claude/skills/jira/bin/jira.mjs --site <your-site>.atlassian.net --cloudid
```

## Configuration

`config.json` in the skill directory holds the runtime defaults.

| Key | Default | Notes |
|-----|---------|-------|
| `defaultFormat` | `json` | Output format when `--format` is not passed (`json` or `table`) |
| `defaultLimit` | `10` | Pagination limit for searches and comments |
| `timeoutMs` | `15000` | HTTP timeout per request |

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 2 | Config / auth (missing `.jira`, invalid token, 401/403) |
| 3 | Not found (404) |
| 4 | Validation (bad flags, unknown command) |
| 5 | Network / timeout / 5xx |
| 6 | Rate-limited (429) |

## How `.jira` is found

The script walks up from `process.cwd()` (the directory you ran `claude` / `codex` from) and stops at the first directory containing a `.git` folder. If `.jira` isn't there, it falls back to `~/.config/jira/.jira`. The resolved path is shown by `--list-targets` and `--whoami`.

## Auth and routing

- **Scoped API tokens** (the post-2026 default) — set `JIRA_USER` (your email) + `JIRA_TOKEN`. Auth header is `Basic base64(email:token)`, routed through `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/...`.
- **OAuth 2.0 / Forge access tokens** — omit `JIRA_USER`, set only `JIRA_TOKEN`. Auth header is `Bearer <token>`, same gateway routing.
- Direct-site URLs (`<site>.atlassian.net/rest/api/3/...`) are no longer used — the gateway is required for scoped tokens and works for OAuth too.

## License

MIT
