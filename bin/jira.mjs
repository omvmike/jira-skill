#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTarget, fetchCloudId } from '../lib/targets.mjs';
import { makeClient, ApiError, EXIT } from '../lib/api.mjs';
import {
  formatIssueDetail,
  formatIssueList,
  formatComments,
  formatTransitions,
} from '../lib/format.mjs';

const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = JSON.parse(readFileSync(join(SKILL_DIR, 'config.json'), 'utf8'));

const HELP = `jira — Jira Cloud skill CLI

Usage:
  jira <command> [flags]

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
  --format json|table                         Default: ${CONFIG.defaultFormat}
  --limit N                                   Default: ${CONFIG.defaultLimit}
  --timeout MS                                Default: ${CONFIG.timeoutMs}
  -h, --help                                  Show this help

Exit codes: 0=ok 2=auth/config 3=not-found 4=validation 5=network 6=rate-limited`;

const TOKEN_URL =
  'https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken=&appId=jira&expiryDays=30';

function die(msg, exit = EXIT.VALIDATION) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(exit);
}

function emitHintBlock(hints) {
  process.stderr.write('─── jira: setup hint ───\n');
  for (const line of hints) process.stderr.write(`${line}\n`);
  process.stderr.write('─────────────────────────\n');
}

function applyHints(output, hints) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  const isJson = parsed !== undefined && typeof parsed === 'object';
  if (hints.length === 0) return { output, isJson };
  if (isJson && !Array.isArray(parsed)) {
    parsed._hint = hints.map((h) => `[jira] ${h}`).join('\n');
    return { output: JSON.stringify(parsed, null, 2), isJson };
  }
  emitHintBlock(hints);
  return { output, isJson };
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  const bools = new Set(['whoami', 'list-targets', 'cloudid', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (bools.has(key)) {
        flags[key] = true;
      } else {
        flags[key] = argv[i + 1];
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function ensureAuth(target) {
  if (!target.config.path) {
    die(
      `no .jira file found.\n\n` +
        `1. Create a Jira API token (read scopes are enough for this CLI):\n` +
        `   ${TOKEN_URL}\n` +
        `   On the page, tick at minimum: read:jira-work, read:jira-user.\n` +
        `   Optional broader read set: read:dashboard:jira, read:filter:jira,\n` +
        `   read:issue.changelog:jira, read:issue.remote-link:jira, read:issue.transition:jira.\n\n` +
        `2. Copy the template and fill in real values, then secure it:\n` +
        `   cp ~/.claude/skills/jira/.jira.example .jira\n` +
        `   chmod 600 .jira\n` +
        `   echo .jira >> .gitignore\n\n` +
        `Set JIRA_USER (your email) + JIRA_TOKEN. Scoped tokens use Basic auth\n` +
        `(base64(email:token)) routed via the Atlassian API gateway.\n` +
        `JIRA_CLOUDID is required (find via 'jira --site <site>.atlassian.net --cloudid');\n` +
        `if omitted, the CLI auto-resolves it on first run and asks you to persist it.\n` +
        `Bearer tokens (OAuth / Forge) also work — omit JIRA_USER and set only JIRA_TOKEN.`,
      EXIT.CONFIG,
    );
  }
  if (!target.token) die(`JIRA_TOKEN missing in ${target.config.path}. Create one at ${TOKEN_URL}`, EXIT.CONFIG);
  if (target.config.worldReadable) {
    process.stderr.write(`warning: ${target.config.path} is not chmod 600\n`);
  }
}

function ensureSite(target) {
  if (!target.site) {
    die(
      `JIRA_SITE not configured. Set JIRA_SITE=<name>.atlassian.net in .jira, or pass --site.`,
      EXIT.CONFIG,
    );
  }
}

async function cmdWhoami(client, target) {
  const me = await client.get('/myself');
  const lines = [`user:        ${me.displayName ?? me.emailAddress ?? me.accountId ?? '?'}`];
  if (me.accountId) lines.push(`accountId:   ${me.accountId}`);
  if (me.emailAddress) lines.push(`email:       ${me.emailAddress}`);
  lines.push(`site:        ${target.site}${target.source ? ` (source: ${target.source})` : ''}`);
  if (target.cloudId) lines.push(`cloudId:     ${target.cloudId}`);
  lines.push(`baseUrl:     ${client.baseUrl}`);
  lines.push(`.jira:       ${target.config.path ?? '(none)'}`);
  lines.push(`auth:        ${target.user ? 'Basic' : 'Bearer'}`);
  return lines.join('\n');
}

function listTargets(target) {
  const lines = [];
  lines.push(`site:           ${target.site ?? '(unresolved)'}`);
  lines.push(`source:         ${target.source ?? '(none)'}`);
  lines.push(`cloudId:        ${target.cloudId ?? '(none)'}`);
  lines.push(`.jira:          ${target.config.path ?? '(none)'}`);
  lines.push(`has JIRA_TOKEN: ${target.token ? 'yes' : 'no'}`);
  lines.push(`has JIRA_USER:  ${target.user ? 'yes' : 'no'}`);
  lines.push(`has JIRA_SITE:  ${target.config.env?.JIRA_SITE ? 'yes' : 'no'}`);
  return lines.join('\n');
}

async function cmdCloudId(target, timeoutMs) {
  ensureSite(target);
  const cloudId = fetchCloudId(target.site, { timeoutMs });
  return cloudId;
}

async function cmdIssueGet(client, target, key, flags) {
  if (!key) die('issue get requires <KEY>');
  const issue = await client.get(`/issue/${encodeURIComponent(key)}`);
  return formatIssueDetail(issue, { format: flags.format ?? CONFIG.defaultFormat, site: target.site });
}

async function cmdIssueComments(client, key, flags, limit) {
  if (!key) die('issue comments requires <KEY>');
  const { values } = await client.paginated(
    `/issue/${encodeURIComponent(key)}/comment`,
    { orderBy: '-created' },
    { limit, valuesKey: 'comments' },
  );
  return formatComments(values, { format: flags.format ?? CONFIG.defaultFormat });
}

async function cmdIssueTransitions(client, key, flags) {
  if (!key) die('issue transitions requires <KEY>');
  const res = await client.get(`/issue/${encodeURIComponent(key)}/transitions`);
  return formatTransitions(res.transitions ?? [], { format: flags.format ?? CONFIG.defaultFormat });
}

function quoteJqlValue(raw) {
  return `"${raw.replace(/"/g, '\\"')}"`;
}

function buildJql(flags) {
  if (flags.jql) return flags.jql;
  const parts = [];
  if (flags.project) parts.push(`project = ${quoteJqlValue(flags.project)}`);
  if (flags.assignee) {
    if (flags.assignee === 'currentUser') parts.push('assignee = currentUser()');
    else parts.push(`assignee = ${quoteJqlValue(flags.assignee)}`);
  }
  if (flags.status) parts.push(`status = ${quoteJqlValue(flags.status)}`);
  if (parts.length === 0) {
    die('issue search requires --jql or one of --project|--assignee|--status');
  }
  return `${parts.join(' AND ')} ORDER BY updated DESC`;
}

async function cmdIssueSearch(client, target, flags, limit) {
  const jql = buildJql(flags);
  const fields = 'summary,status,assignee,updated,issuetype,priority';
  const { values } = await client.paginated('/search', { jql, fields }, { limit, valuesKey: 'issues' });
  return formatIssueList(values, { format: flags.format ?? CONFIG.defaultFormat, site: target.site });
}

async function main() {
  const startedAt = Date.now();
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || (positional.length === 0 && !flags.whoami && !flags['list-targets'] && !flags.cloudid)) {
    process.stdout.write(`${HELP}\n`);
    process.exit(flags.help ? 0 : EXIT.VALIDATION);
  }

  const cwd = process.cwd();
  let target;
  try {
    target = resolveTarget({ cwd, siteOverride: flags.site, cloudIdOverride: flags['cloud-id'] });
  } catch (err) {
    die(err.message, EXIT.VALIDATION);
  }

  if (flags['list-targets']) {
    process.stdout.write(`${listTargets(target)}\n`);
    process.exit(EXIT.OK);
  }

  const timeoutMs = flags.timeout ? Number(flags.timeout) : CONFIG.timeoutMs;
  const limit = flags.limit ? Number(flags.limit) : CONFIG.defaultLimit;

  const hints = [];
  try {
    let output;
    if (flags.cloudid) {
      output = await cmdCloudId(target, timeoutMs);
    } else {
      ensureAuth(target);
      ensureSite(target);
      if (!target.cloudId) {
        hints.push(
          `JIRA_CLOUDID is required (scoped tokens route via the Atlassian API gateway). Resolving from ${target.site}…`,
        );
        try {
          target.cloudId = fetchCloudId(target.site, { timeoutMs });
        } catch (err) {
          die(`could not resolve cloudId from ${target.site}: ${err.message}`, EXIT.CONFIG);
        }
        hints.push(
          `resolved cloudId=${target.cloudId} — append 'JIRA_CLOUDID=${target.cloudId}' to ${target.config.path} to skip this lookup next time.`,
        );
      }
      const client = makeClient({
        cloudId: target.cloudId,
        user: target.user,
        token: target.token,
        timeoutMs,
      });

      if (flags.whoami) {
        output = await cmdWhoami(client, target);
      } else {
        const [group, sub, ...rest] = positional;
        if (group === 'issue') {
          if (sub === 'get') output = await cmdIssueGet(client, target, rest[0], flags);
          else if (sub === 'comments') output = await cmdIssueComments(client, rest[0], flags, limit);
          else if (sub === 'transitions') output = await cmdIssueTransitions(client, rest[0], flags);
          else if (sub === 'search') output = await cmdIssueSearch(client, target, flags, limit);
          else die(`unknown issue subcommand: ${sub}`);
        } else {
          die(`unknown command: ${group}`);
        }
      }
    }
    const result = applyHints(output, hints);
    process.stdout.write(`${result.output}\n`);
    const elapsed = Date.now() - startedAt;
    if (target.site && !result.isJson) {
      process.stderr.write(`-- ${elapsed}ms from ${target.site}${target.cloudId ? ` (cloudId ${target.cloudId})` : ''}\n`);
    }
    process.exit(EXIT.OK);
  } catch (err) {
    if (err instanceof ApiError) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err.exit);
    }
    process.stderr.write(`error: ${err.stack ?? err.message}\n`);
    process.exit(EXIT.NETWORK);
  }
}

main();
