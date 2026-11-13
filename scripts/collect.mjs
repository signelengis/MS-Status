#!/usr/bin/env node
// Collects public Microsoft status feeds and runs web checks, then writes
// site/data/status.json and site/data/history.json for the dashboard.
//
//   node scripts/collect.mjs                     live run (what GitHub Actions does)
//   node scripts/collect.mjs --fixtures test/fixtures --now 2026-11-13T14:00:00Z
//
// Environment:
//   PAGES_URL   the published site URL; the previous history.json is read from it so
//               history survives without committing data to the repo.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAzureFeed, parseDevOps, parseStatuspage, levelForCheck, describeCheckProblem, slug, worst,
} from './lib/parse.mjs';
import { runCheck } from './lib/webcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = {
  azure: {
    name: 'Azure',
    url: 'https://azure.status.microsoft/en-us/status/feed/',
    page: 'https://azure.status.microsoft/en-us/status',
    fixture: 'azure-feed.xml',
  },
  devops: {
    name: 'Azure DevOps',
    url: 'https://status.dev.azure.com/_apis/status/health?api-version=7.1-preview.1',
    page: 'https://status.dev.azure.com/',
    fixture: 'devops.json',
  },
  github: {
    name: 'GitHub',
    url: 'https://www.githubstatus.com/api/v2/summary.json',
    page: 'https://www.githubstatus.com/',
    fixture: 'github.json',
  },
};
const M365_PAGE = 'https://status.cloud.microsoft/';
const HISTORY_WINDOW_S = 24 * 3600;
const HISTORY_MAX_POINTS = 300;

function args() {
  const a = process.argv.slice(2);
  const get = (k) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    fixtures: get('--fixtures') && path.resolve(get('--fixtures')),
    out: path.resolve(get('--out') || path.join(ROOT, 'site/data')),
    config: path.resolve(get('--config') || path.join(ROOT, 'config/checks.json')),
    regions: path.resolve(get('--regions') || path.join(ROOT, 'config/azure-regions.json')),
    now: get('--now') ? Date.parse(get('--now')) : Date.now(),
  };
}

async function fetchText(url, timeoutMs = 20000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'user-agent': 'ms-status-dashboard/1.0', accept: 'application/json, application/rss+xml, application/xml, */*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function loadSource(key, opt) {
  const s = SOURCES[key];
  if (opt.fixtures) return readFile(path.join(opt.fixtures, s.fixture), 'utf8');
  return fetchText(s.url);
}

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function loadHistory(opt) {
  const base = process.env.PAGES_URL;
  if (base && !opt.fixtures) {
    try {
      return JSON.parse(await fetchText(`${base.replace(/\/$/, '')}/data/history.json?t=${Date.now()}`));
    } catch (e) {
      console.warn(`No previous history from ${base} (${e.message}); starting fresh.`);
    }
  }
  return readJson(path.join(opt.out, 'history.json'), { v: 1, points: {} });
}

function pushPoint(history, key, t, latency, level) {
  const list = (history.points[key] ||= []);
  list.push([t, latency ?? null, level]);
  const cutoff = t - HISTORY_WINDOW_S;
  history.points[key] = list.filter((p) => p[0] >= cutoff).slice(-HISTORY_MAX_POINTS);
}

async function main() {
  const opt = args();
  const config = await readJson(opt.config, null);
  if (!config) throw new Error(`Can't read ${opt.config}`);
  const regionsCfg = await readJson(opt.regions, { geographies: [], regions: [] });
  const d = { timeoutMs: 10000, slowMs: 3000, certWarnDays: 14, ...(config.defaults || {}) };
  const t = Math.floor(opt.now / 1000);
  const problems = [];

  // --- public feeds, each independent: one failing never blocks the others
  const [azureRaw, devopsRaw, githubRaw] = await Promise.allSettled(
    ['azure', 'devops', 'github'].map((k) => loadSource(k, opt))
  );

  const unread = (key, r) => {
    const msg = r.reason?.message || String(r.reason);
    problems.push({ source: key, level: 'unknown', text: `Couldn't read the ${SOURCES[key].name} status feed (${msg}).` });
    return { level: 'unknown', error: msg };
  };

  let azure;
  try {
    if (azureRaw.status === 'rejected') throw azureRaw;
    azure = parseAzureFeed(azureRaw.value, regionsCfg.regions, opt.now);
    for (const inc of azure.incidents.filter((i) => i.active)) {
      problems.push({ source: 'azure', level: 'degraded', text: `Azure: ${inc.title}`, link: inc.link });
    }
  } catch (r) {
    azure = { ...unread('azure', r.reason ? r : { reason: r }), incidents: [], regionLevels: {}, activeCount: 0 };
  }

  let devops;
  try {
    if (devopsRaw.status === 'rejected') throw devopsRaw;
    devops = parseDevOps(JSON.parse(devopsRaw.value));
    if (devops.level !== 'operational') {
      problems.push({ source: 'devops', level: devops.level, text: `Azure DevOps: ${devops.message || devops.level}` });
    }
  } catch (r) {
    devops = { ...unread('devops', r.reason ? r : { reason: r }), services: [], geographies: [] };
  }

  let github;
  try {
    if (githubRaw.status === 'rejected') throw githubRaw;
    github = parseStatuspage(JSON.parse(githubRaw.value));
    if (github.level !== 'operational') {
      problems.push({ source: 'github', level: github.level, text: `GitHub: ${github.description || github.level}` });
    }
  } catch (r) {
    github = { ...unread('github', r.reason ? r : { reason: r }), components: [], incidents: [] };
  }

  // --- web checks
  const fixtureChecks = opt.fixtures ? await readJson(path.join(opt.fixtures, 'webchecks.json'), {}) : {};
  const groups = [];
  for (const g of config.groups || []) {
    const enabled = (g.checks || []).filter((c) => c.enabled !== false);
    const results = await Promise.all(
      enabled.map(async (c) => {
        const id = slug(g.name, c.name);
        const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(c.url);
        const r = opt.fixtures && !isLocal
          ? { status: null, latencyMs: null, ok: false, error: fixtureChecks[c.name] ? null : 'no fixture', certDaysLeft: null, ...(fixtureChecks[c.name] || {}) }
          : await runCheck(c, d);
        const item = { id, name: c.name, url: c.url, ...r };
        item.level = levelForCheck(item, d);
        const text = describeCheckProblem(item, d);
        if (text) problems.push({ source: 'check', level: item.level, text, name: item.name });
        return item;
      })
    );
    groups.push({ name: g.name, items: results });
  }

  // --- history (rolling 24h)
  const history = await loadHistory(opt);
  history.v = 1;
  history.points ||= {};
  for (const g of groups) for (const c of g.items) pushPoint(history, `check:${c.id}`, t, c.latencyMs, c.level);
  pushPoint(history, 'src:azure', t, null, azure.level);
  pushPoint(history, 'src:devops', t, null, devops.level);
  pushPoint(history, 'src:github', t, null, github.level);
  // drop series for checks that no longer exist
  const live = new Set(groups.flatMap((g) => g.items.map((c) => `check:${c.id}`)));
  for (const k of Object.keys(history.points)) if (k.startsWith('check:') && !live.has(k)) delete history.points[k];

  for (const g of groups) {
    for (const c of g.items) {
      const pts = history.points[`check:${c.id}`] || [];
      c.upPct = pts.length ? Math.round((1000 * pts.filter((p) => p[2] !== 'outage').length) / pts.length) / 10 : null;
    }
  }

  const checksLevel = worst(groups.flatMap((g) => g.items.map((c) => c.level)));
  const status = {
    v: 1,
    generatedAt: new Date(opt.now).toISOString(),
    title: config.title || 'Microsoft services status',
    intervalMinutes: config.intervalMinutes || 10,
    overall: {
      level: worst([checksLevel, azure.level, devops.level, github.level]),
      problems: problems.sort((a, b) => ({ outage: 0, degraded: 1, advisory: 2, unknown: 3 }[a.level] - { outage: 0, degraded: 1, advisory: 2, unknown: 3 }[b.level])),
    },
    checks: { level: checksLevel, defaults: d, groups },
    azure: { ...azure, page: SOURCES.azure.page },
    devops: { ...devops, page: SOURCES.devops.page },
    github: { ...github, page: SOURCES.github.page },
    m365Page: M365_PAGE,
    regions: regionsCfg,
  };

  await mkdir(opt.out, { recursive: true });
  await writeFile(path.join(opt.out, 'status.json'), JSON.stringify(status, null, 1));
  await writeFile(path.join(opt.out, 'history.json'), JSON.stringify(history));
  const n = groups.reduce((a, g) => a + g.items.length, 0);
  console.log(`overall=${status.overall.level} checks=${n} azureActive=${azure.activeCount} devops=${devops.level} github=${github.level} problems=${problems.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
