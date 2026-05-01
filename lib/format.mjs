function truncate(str, max) {
  if (str == null) return '';
  const s = String(str).replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function mdTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const pad = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ');
  const sep = widths.map((w) => '-'.repeat(w)).join('-|-');
  return [`| ${pad(headers)} |`, `|-${sep}-|`, ...rows.map((r) => `| ${pad(r)} |`)].join('\n');
}

export function adfToText(node, depth = 0) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const type = node.type;
  const children = Array.isArray(node.content) ? node.content : [];
  const renderChildren = (sep = '') => children.map((c) => adfToText(c, depth + 1)).join(sep);
  switch (type) {
    case 'doc':
      return children.map((c) => adfToText(c, depth)).filter(Boolean).join('\n\n');
    case 'paragraph':
    case 'heading':
      return renderChildren();
    case 'text':
      return node.text ?? '';
    case 'hardBreak':
      return '\n';
    case 'mention':
      return node.attrs?.text ?? `@${node.attrs?.id ?? ''}`;
    case 'emoji':
      return node.attrs?.shortName ?? '';
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ?? '';
    case 'codeBlock':
      return `\`\`\`\n${renderChildren()}\n\`\`\``;
    case 'blockquote':
      return renderChildren('\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'bulletList':
      return children
        .map((li) => `- ${adfToText(li, depth + 1).replace(/\n/g, '\n  ')}`)
        .join('\n');
    case 'orderedList':
      return children
        .map((li, i) => `${i + 1}. ${adfToText(li, depth + 1).replace(/\n/g, '\n   ')}`)
        .join('\n');
    case 'listItem':
      return renderChildren('\n');
    case 'rule':
      return '---';
    case 'mediaSingle':
    case 'mediaGroup':
      return '[media]';
    default:
      return renderChildren(children.length > 1 ? '\n' : '');
  }
}

function issueLink(site, key) {
  if (!site || !key) return '';
  return `https://${site}/browse/${key}`;
}

export function formatIssueDetail(issue, { format, site }) {
  if (format === 'json') {
    const f = issue.fields ?? {};
    return JSON.stringify(
      {
        key: issue.key,
        id: issue.id,
        summary: f.summary,
        status: f.status?.name,
        statusCategory: f.status?.statusCategory?.name,
        type: f.issuetype?.name,
        priority: f.priority?.name,
        assignee: f.assignee?.displayName ?? null,
        assigneeAccountId: f.assignee?.accountId ?? null,
        reporter: f.reporter?.displayName ?? null,
        labels: f.labels ?? [],
        components: (f.components ?? []).map((c) => c.name),
        created: f.created,
        updated: f.updated,
        resolution: f.resolution?.name ?? null,
        link: issueLink(site, issue.key),
        description: f.description ? adfToText(f.description) : null,
        descriptionAdf: f.description ?? null,
      },
      null,
      2,
    );
  }
  const f = issue.fields ?? {};
  const lines = [
    `# ${issue.key}: ${f.summary ?? ''}`,
    '',
    `- **status**: ${f.status?.name ?? ''}${f.status?.statusCategory?.name ? ` (${f.status.statusCategory.name})` : ''}`,
    `- **type**: ${f.issuetype?.name ?? ''}`,
    `- **priority**: ${f.priority?.name ?? ''}`,
    `- **assignee**: ${f.assignee?.displayName ?? '(unassigned)'}`,
    `- **reporter**: ${f.reporter?.displayName ?? ''}`,
    `- **created**: ${shortDate(f.created)}`,
    `- **updated**: ${shortDate(f.updated)}`,
    `- **link**: ${issueLink(site, issue.key)}`,
  ];
  if (f.labels?.length) lines.push(`- **labels**: ${f.labels.join(', ')}`);
  if (f.components?.length) lines.push(`- **components**: ${f.components.map((c) => c.name).join(', ')}`);
  if (f.resolution?.name) lines.push(`- **resolution**: ${f.resolution.name}`);
  if (f.description) {
    const text = adfToText(f.description).trim();
    if (text) lines.push('', '## description', '', text);
  }
  return lines.join('\n');
}

export function formatIssueList(values, { format, site }) {
  if (format === 'json') {
    return JSON.stringify(
      values.map((issue) => {
        const f = issue.fields ?? {};
        return {
          key: issue.key,
          summary: f.summary,
          status: f.status?.name,
          assignee: f.assignee?.displayName ?? null,
          updated: f.updated,
          link: issueLink(site, issue.key),
        };
      }),
      null,
      2,
    );
  }
  const rows = values.map((issue) => {
    const f = issue.fields ?? {};
    return [
      issue.key,
      truncate(f.summary, 60),
      truncate(f.status?.name ?? '', 18),
      truncate(f.assignee?.displayName ?? '', 22),
      shortDate(f.updated),
    ];
  });
  return mdTable(['key', 'summary', 'status', 'assignee', 'updated'], rows);
}

export function formatComments(values, { format }) {
  if (format === 'json') {
    return JSON.stringify(
      values.map((c) => ({
        id: c.id,
        author: c.author?.displayName ?? null,
        created: c.created,
        updated: c.updated,
        body: c.body ? adfToText(c.body) : null,
        bodyAdf: c.body ?? null,
      })),
      null,
      2,
    );
  }
  const lines = [];
  for (const c of values) {
    const who = c.author?.displayName ?? '?';
    lines.push(`[${shortDate(c.created)}] ${who}`);
    if (c.body) {
      const text = adfToText(c.body).trim();
      if (text) lines.push(text.split('\n').map((l) => `  ${l}`).join('\n'));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatTransitions(values, { format }) {
  if (format === 'json') {
    return JSON.stringify(
      values.map((t) => ({
        id: t.id,
        name: t.name,
        to: t.to?.name ?? null,
        toCategory: t.to?.statusCategory?.name ?? null,
      })),
      null,
      2,
    );
  }
  const rows = values.map((t) => [t.id, t.name, t.to?.name ?? '', t.to?.statusCategory?.name ?? '']);
  return mdTable(['id', 'name', 'to status', 'category'], rows);
}
