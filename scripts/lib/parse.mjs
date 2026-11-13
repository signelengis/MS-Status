// Pure parsing helpers: no network, no file system. Everything here is unit-testable.

/** Status levels, worst last. "unknown" means we could not read the source. */
export const RANK = { operational: 0, advisory: 1, unknown: 1, degraded: 2, outage: 3 };

export function worst(levels) {
  let out = 'operational';
  for (const l of levels) {
    if (!l) continue;
    if (RANK[l] > RANK[out] || (RANK[l] === RANK[out] && l === 'advisory')) out = l;
  }
  return out;
}

// ---------- tiny RSS reader ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? cdata[1] : decodeEntities(v);
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(br|\/p|\/li|\/div|\/h\d)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const b = m[1];
    items.push({
      title: htmlToText(tag(b, 'title')),
      link: tag(b, 'link'),
      guid: tag(b, 'guid'),
      published: tag(b, 'pubDate'),
      category: tag(b, 'category'),
      text: htmlToText(tag(b, 'description')),
    });
  }
  return items;
}

// ---------- Azure regions ----------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Returns the ids of regions named in free text. Longer names are matched first and
 * blanked out, so "West Central US" never also counts as "Central US", and
 * "East US 2" never also counts as "East US".
 */
export function matchRegions(text, regions) {
  const candidates = [];
  for (const r of regions) {
    for (const n of [r.name, ...(r.aliases || [])]) candidates.push({ id: r.id, n });
  }
  candidates.sort((a, b) => b.n.length - a.n.length);
  let t = ` ${text} `;
  const hits = new Set();
  for (const c of candidates) {
    const pattern = `(?<![A-Za-z0-9])${escapeRe(c.n).replace(/ /g, '\\s+')}(?![A-Za-z0-9]|\\s+\\d)`;
    if (new RegExp(pattern, 'i').test(t)) {
      hits.add(c.id);
      t = t.replace(new RegExp(pattern, 'gi'), ' ␟ ');
    }
  }
  return [...hits];
}

// ---------- Azure status RSS ----------

const RESOLVED = /\b(has been mitigated|is mitigated|now mitigated|mitigated at|resolved|post incident review|preliminary post incident review|PIR)\b/i;
const MAX_ACTIVE_AGE_MS = 3 * 24 * 3600 * 1000;

export function parseAzureFeed(xml, regions, now = Date.now()) {
  const items = parseRss(xml);
  const incidents = items.map((it) => {
    const body = `${it.title}\n${it.text}`;
    const published = Date.parse(it.published);
    const age = Number.isFinite(published) ? now - published : 0;
    const active = !RESOLVED.test(body) && age < MAX_ACTIVE_AGE_MS;
    return {
      title: it.title,
      link: it.link || it.guid || null,
      published: Number.isFinite(published) ? new Date(published).toISOString() : null,
      summary: it.text.slice(0, 600),
      regions: matchRegions(body, regions),
      active,
    };
  });
  const regionLevels = {};
  for (const inc of incidents) {
    if (!inc.active) continue;
    for (const id of inc.regions) regionLevels[id] = 'degraded';
  }
  const activeCount = incidents.filter((i) => i.active).length;
  return { level: activeCount ? 'degraded' : 'operational', incidents, regionLevels, activeCount };
}

// ---------- Azure DevOps status API ----------

const DEVOPS_LEVEL = { healthy: 'operational', advisory: 'advisory', degraded: 'degraded', unhealthy: 'outage', unknown: 'unknown' };

export function parseDevOps(json) {
  const services = (json.services || []).map((s) => ({
    id: s.id,
    geographies: (s.geographies || []).map((g) => ({
      id: g.id,
      name: g.name,
      health: g.health,
      level: DEVOPS_LEVEL[g.health] || 'unknown',
    })),
  }));
  const geoOrder = [];
  for (const s of services) for (const g of s.geographies) if (!geoOrder.find((x) => x.id === g.id)) geoOrder.push({ id: g.id, name: g.name });
  const health = json.status?.health || 'unknown';
  return {
    level: DEVOPS_LEVEL[health] || 'unknown',
    message: json.status?.message || '',
    lastUpdated: json.lastUpdated || null,
    services,
    geographies: geoOrder,
  };
}

// ---------- GitHub (Atlassian Statuspage summary.json) ----------

const SP_COMPONENT = {
  operational: 'operational',
  under_maintenance: 'advisory',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  major_outage: 'outage',
};
const SP_INDICATOR = { none: 'operational', maintenance: 'advisory', minor: 'degraded', major: 'outage', critical: 'outage' };

export function parseStatuspage(json) {
  const components = (json.components || [])
    .filter((c) => !c.group && !/^Visit www\./i.test(c.name))
    .map((c) => ({ name: c.name, status: c.status, level: SP_COMPONENT[c.status] || 'unknown' }));
  const incidents = (json.incidents || []).map((i) => ({
    name: i.name,
    impact: i.impact,
    status: i.status,
    link: i.shortlink || null,
    updated: i.updated_at || null,
  }));
  return {
    level: SP_INDICATOR[json.status?.indicator] || worst(components.map((c) => c.level)),
    description: json.status?.description || '',
    components,
    incidents,
  };
}

// ---------- web checks ----------

export function slug(...parts) {
  return parts
    .join('-')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function levelForCheck(r, d) {
  if (!r.ok) return 'outage';
  if (r.latencyMs != null && r.latencyMs > d.slowMs) return 'degraded';
  if (r.certDaysLeft != null && r.certDaysLeft < d.certWarnDays) return 'advisory';
  return 'operational';
}

export function describeCheckProblem(c, d) {
  if (c.level === 'outage') {
    if (c.error) return `${c.name} is not responding (${c.error}).`;
    return `${c.name} returned HTTP ${c.status}.`;
  }
  if (c.level === 'degraded') return `${c.name} is slow (${(c.latencyMs / 1000).toFixed(1)} s, limit ${(d.slowMs / 1000).toFixed(1)} s).`;
  if (c.level === 'advisory' && c.certDaysLeft != null) return `${c.name} certificate expires in ${c.certDaysLeft} day${c.certDaysLeft === 1 ? '' : 's'}.`;
  return null;
}
