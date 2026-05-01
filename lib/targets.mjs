import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

function findGitRoot(startDir) {
  let dir = resolve(startDir);
  while (true) {
    try {
      statSync(join(dir, '.git'));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

function parseEnvFile(contents) {
  const out = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadJiraConfig(cwd) {
  const gitRoot = findGitRoot(cwd) ?? cwd;
  const candidates = [join(gitRoot, '.jira'), join(homedir(), '.config', 'jira', '.jira')];
  for (const path of candidates) {
    try {
      const st = statSync(path);
      const env = parseEnvFile(readFileSync(path, 'utf8'));
      const worldReadable = (st.mode & 0o077) !== 0;
      return { path, env, worldReadable };
    } catch {}
  }
  return { path: null, env: {}, worldReadable: false };
}

function normalizeSite(raw) {
  if (!raw) return null;
  return raw
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function resolveTarget({ cwd, siteOverride, cloudIdOverride }) {
  const config = loadJiraConfig(cwd);
  const site = normalizeSite(siteOverride ?? config.env.JIRA_SITE);
  const cloudId = cloudIdOverride ?? config.env.JIRA_CLOUDID ?? null;
  let source = null;
  if (siteOverride) source = 'flag';
  else if (config.env.JIRA_SITE) source = 'env';

  return {
    site,
    cloudId,
    source,
    config,
    token: config.env.JIRA_TOKEN || null,
    user: config.env.JIRA_USER || null,
  };
}

export function fetchCloudId(site, { timeoutMs = 5000 } = {}) {
  // Synchronous helper using curl (avoids pulling network code into resolveTarget).
  // Returns the cloudId for a site by hitting the unauthenticated _edge/tenant_info endpoint.
  if (!site) throw new Error('site is required to fetch cloudId');
  const url = `https://${site}/_edge/tenant_info`;
  const out = execFileSync('curl', ['-fsS', '--max-time', String(Math.ceil(timeoutMs / 1000)), url], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  if (!parsed.cloudId) throw new Error(`tenant_info response missing cloudId: ${out}`);
  return parsed.cloudId;
}
