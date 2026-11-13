// Offline tests: parsers, region matching, a real HTTP check against a local server,
// and a simulated 24 hours of collector runs that leaves demo data in site/data/
// so you can preview the dashboard locally.
//
//   node test/run.mjs              (incident scenario)
//   node test/run.mjs calm         (everything healthy)

import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRegions, parseRss, parseAzureFeed, parseDevOps, parseStatuspage, worst } from '../scripts/lib/parse.mjs';
import { runCheck } from '../scripts/lib/webcheck.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2] || 'incident';
const regions = JSON.parse(readFileSync(path.join(ROOT, 'config/azure-regions.json'), 'utf8')).regions;
let passed = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log(`  ok  ${name}`); });

await t('region matching prefers the longest name', () => {
  assert.deepEqual(matchRegions('issues in East US 2 only', regions), ['eastus2']);
  assert.deepEqual(matchRegions('West Central US and Central US', regions).sort(), ['centralus', 'westcentralus']);
  assert.deepEqual(matchRegions('Australia Central 2', regions), ['australiacentral2']);
  assert.deepEqual(matchRegions('South Central US, East US', regions).sort(), ['eastus', 'southcentralus']);
  assert.deepEqual(matchRegions('Nothing regional here', regions), []);
});

await t('RSS parsing handles CDATA and entities', () => {
  const items = parseRss('<rss><channel><item><title>A &amp; B</title><description><![CDATA[<p>x <b>y</b></p>]]></description><pubDate>Fri, 13 Nov 2026 13:05:00 Z</pubDate></item></channel></rss>');
  assert.equal(items[0].title, 'A & B');
  assert.equal(items[0].text, 'x y');
});

await t('Azure feed: mitigated items are not active, old items expire', () => {
  const xml = readFileSync(path.join(ROOT, 'test/fixtures/incident/azure-feed.xml'), 'utf8');
  const a = parseAzureFeed(xml, regions, Date.parse('2026-11-13T14:00:00Z'));
  assert.equal(a.activeCount, 1);
  assert.deepEqual(Object.keys(a.regionLevels).sort(), ['eastus2', 'southcentralus']);
  const later = parseAzureFeed(xml, regions, Date.parse('2026-11-20T14:00:00Z'));
  assert.equal(later.activeCount, 0);
  assert.equal(parseAzureFeed('<rss><channel></channel></rss>', regions).level, 'operational');
});

await t('DevOps and Statuspage mapping', () => {
  const d = parseDevOps(JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/incident/devops.json'), 'utf8')));
  assert.equal(d.level, 'degraded');
  assert.equal(d.geographies.length, 8);
  const g = parseStatuspage(JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/incident/github.json'), 'utf8')));
  assert.equal(g.level, 'degraded');
  assert.ok(!g.components.some((c) => c.name.startsWith('Visit')));
  assert.equal(worst(['operational', 'unknown', 'advisory']), 'advisory');
  assert.equal(worst(['operational', 'unknown']), 'unknown');
});

await t('web check against a local server (200, 302, 503, timeout, refused)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('ok');
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (req.url === '/down') { res.writeHead(503); return res.end(); }
    if (req.url === '/hang') return; // never answers
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const d = { timeoutMs: 800, slowMs: 3000, certWarnDays: 14 };
  const ok = await runCheck({ url: `${base}/ok` }, d);
  assert.equal(ok.ok, true); assert.equal(ok.status, 200);
  assert.equal((await runCheck({ url: `${base}/redirect` }, d)).ok, true);
  const down = await runCheck({ url: `${base}/down` }, d);
  assert.equal(down.ok, false); assert.equal(down.status, 503);
  assert.equal((await runCheck({ url: `${base}/down`, okStatus: [503] }, d)).ok, true);
  const hang = await runCheck({ url: `${base}/hang` }, d);
  assert.equal(hang.ok, false); assert.equal(hang.error, 'timed out');
  srv.closeAllConnections(); srv.close();
  const refused = await runCheck({ url: `${base}/ok` }, d);
  assert.equal(refused.error, 'connection refused');
});

await t(`collector: 24 simulated hours (${scenario})`, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'msdash-'));
  const fx = path.join(tmp, 'fx');
  const out = path.join(ROOT, 'site/data');
  rmSync(path.join(out, 'history.json'), { force: true });
  cpSync(path.join(ROOT, 'test/fixtures/calm'), fx, { recursive: true });
  const calmChecks = JSON.parse(readFileSync(path.join(fx, 'webchecks.json'), 'utf8'));
  const end = Date.parse('2026-11-13T14:00:00Z');
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const steps = 144;
  for (let i = steps - 1; i >= 0; i--) {
    const last = i === 0;
    if (last) cpSync(path.join(ROOT, `test/fixtures/${scenario}`), fx, { recursive: true });
    else {
      const jittered = structuredClone(calmChecks);
      for (const [name, c] of Object.entries(jittered)) {
        c.latencyMs = Math.round(c.latencyMs * (0.7 + rand() * 0.7));
        if (name === 'Teams' && i < 30) c.latencyMs = Math.round(c.latencyMs * (1 + (30 - i) / 3));
        if (name === 'Outlook on the web' && i > 60 && i < 64) Object.assign(c, { ok: false, status: 503 });
      }
      writeFileSync(path.join(fx, 'webchecks.json'), JSON.stringify(jittered));
    }
    const now = new Date(end - i * 600_000).toISOString();
    execFileSync('node', [path.join(ROOT, 'scripts/collect.mjs'), '--fixtures', fx, '--out', out, '--now', now], { stdio: last ? 'inherit' : 'ignore' });
  }
  const status = JSON.parse(readFileSync(path.join(out, 'status.json'), 'utf8'));
  const hist = JSON.parse(readFileSync(path.join(out, 'history.json'), 'utf8'));
  assert.equal(hist.points['check:microsoft-365-teams'].length, steps);
  const outlook = status.checks.groups[0].items.find((c) => c.name === 'Outlook on the web');
  assert.ok(outlook.upPct < 100);
  rmSync(tmp, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
