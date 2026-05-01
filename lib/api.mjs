export const EXIT = Object.freeze({
  OK: 0,
  CONFIG: 2,
  NOT_FOUND: 3,
  VALIDATION: 4,
  NETWORK: 5,
  RATE_LIMIT: 6,
});

function authHeader({ user, token }) {
  if (!token) return null;
  if (user) {
    const b64 = Buffer.from(`${user}:${token}`).toString('base64');
    return `Basic ${b64}`;
  }
  return `Bearer ${token}`;
}

function buildBaseUrl({ cloudId }) {
  if (cloudId) return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  throw new ApiError('JIRA_CLOUDID is required (scoped tokens route via the Atlassian API gateway)', { exit: EXIT.CONFIG });
}

export class ApiError extends Error {
  constructor(message, { exit, status, body } = {}) {
    super(message);
    this.exit = exit ?? EXIT.NETWORK;
    this.status = status ?? null;
    this.body = body ?? null;
  }
}

function mapStatus(status) {
  if (status === 401 || status === 403) return EXIT.CONFIG;
  if (status === 404) return EXIT.NOT_FOUND;
  if (status === 429) return EXIT.RATE_LIMIT;
  if (status >= 500) return EXIT.NETWORK;
  return EXIT.NETWORK;
}

async function request({ method = 'GET', baseUrl, path, query, body, auth, timeoutMs }) {
  if (!auth) throw new ApiError('JIRA_TOKEN is missing (no auth header built)', { exit: EXIT.CONFIG });
  const url = new URL(path.startsWith('http') ? path : `${baseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Authorization: auth, Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new ApiError(`timeout after ${timeoutMs}ms on ${method} ${url.pathname}`, { exit: EXIT.NETWORK });
    }
    throw new ApiError(`network error on ${method} ${url.pathname}: ${err.message}`, { exit: EXIT.NETWORK });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const exit = mapStatus(res.status);
    const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    const extras = [];
    if (res.status === 429) {
      const retry = res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset');
      if (retry) extras.push(`retry-after=${retry}`);
    }
    throw new ApiError(
      `HTTP ${res.status} on ${method} ${url.pathname}${extras.length ? ` (${extras.join(', ')})` : ''}: ${preview}`,
      { exit, status: res.status, body: preview },
    );
  }

  return res.json();
}

export function makeClient({ cloudId, user, token, timeoutMs = 15000 }) {
  const auth = authHeader({ user, token });
  const baseUrl = buildBaseUrl({ cloudId });
  return {
    baseUrl,
    async get(path, query) {
      return request({ method: 'GET', baseUrl, path, query, auth, timeoutMs });
    },
    async post(path, body) {
      return request({ method: 'POST', baseUrl, path, body, auth, timeoutMs });
    },
    async paginated(path, query, { limit, valuesKey = 'values' }) {
      const pageSize = Math.min(limit, 50);
      const results = [];
      let startAt = 0;
      let total = null;
      while (results.length < limit) {
        const page = await request({
          method: 'GET',
          baseUrl,
          path,
          query: { ...query, startAt, maxResults: pageSize },
          auth,
          timeoutMs,
        });
        const values = page[valuesKey] ?? page.values ?? [];
        for (const v of values) {
          results.push(v);
          if (results.length >= limit) break;
        }
        total = typeof page.total === 'number' ? page.total : total;
        const advanced = startAt + values.length;
        if (values.length === 0) break;
        if (typeof page.total === 'number' && advanced >= page.total) break;
        if (page.isLast === true) break;
        startAt = advanced;
      }
      return { values: results, total, truncated: total != null && results.length < total };
    },
  };
}
