(() => {
  'use strict';

  const RELOAD_MS = 2 * 60 * 1000;
  const LABEL = { operational: 'Working', advisory: 'Notice', degraded: 'Degraded', outage: 'Down', unknown: 'Unknown' };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Theme: the <head> script sets the starting theme (dark unless chosen otherwise);
  // this button flips it and remembers the choice in this browser.
  const root = document.documentElement;
  function syncThemeButton() {
    const dark = root.dataset.theme !== 'light';
    $('theme-label').textContent = dark ? 'Light mode' : 'Dark mode';
    $('theme-toggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  $('theme-toggle').addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('msdash-theme', root.dataset.theme); } catch {}
    syncThemeButton();
  });
  syncThemeButton();

  /** Shape and colour both carry the level, so the board reads without colour. */
  function mark(level, label = LABEL[level]) {
    const shapes = {
      operational: '<circle cx="8" cy="8" r="7" fill="currentColor"/>',
      advisory: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="2.6" fill="currentColor"/>',
      degraded: '<path d="M8 1 15.4 14.5H.6Z" fill="currentColor"/>',
      outage: '<rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="currentColor"/>',
      unknown: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.4"/>',
    };
    return `<svg class="mark lvl-${level}" viewBox="0 0 16 16" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${shapes[level] || shapes.unknown}</svg>`;
  }

  function ago(iso) {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 90) return 'just now';
    const m = Math.round(s / 60);
    if (m < 90) return `${m} minutes ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
  }
  const clock = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  function headline(status) {
    const p = status.overall.problems;
    const down = p.filter((x) => x.level === 'outage');
    const degraded = p.filter((x) => x.level === 'degraded');
    if (down.length === 1) return down[0].name ? `${down[0].name} is down.` : 'One service is down.';
    if (down.length > 1) return `${down.length} services are down.`;
    if (degraded.length === 1) return degraded[0].source === 'check' ? `${degraded[0].name} is slow.` : 'One service is degraded.';
    if (degraded.length > 1) return `${degraded.length} services need watching.`;
    if (p.some((x) => x.level === 'unknown') && !p.some((x) => x.level === 'advisory')) return 'Some status sources couldn’t be read.';
    return 'Everything is responding.';
  }

  function renderHero(s) {
    $('masthead').textContent = s.title;
    document.title = `${s.overall.level === 'operational' ? '' : '⚠ '}${s.title}`;
    $('hero').dataset.level = s.overall.level;
    $('verdict-mark').innerHTML = mark(s.overall.level);
    $('headline').textContent = headline(s);
    $('problems').innerHTML = s.overall.problems
      .map((x) => `<li>${mark(x.level)}<span>${x.link ? `<a href="${esc(x.link)}">${esc(x.text)}</a>` : esc(x.text)}</span></li>`)
      .join('');
    const next = new Date(Date.parse(s.generatedAt) + s.intervalMinutes * 60000);
    $('freshness').textContent = `Checked ${ago(s.generatedAt)} (${clock(s.generatedAt)}). Next check due around ${next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    const ageMin = (Date.now() - Date.parse(s.generatedAt)) / 60000;
    const stale = ageMin > s.intervalMinutes * 3 + 5;
    $('stale').hidden = !stale;
    if (stale) $('stale').textContent = `This data is ${Math.round(ageMin)} minutes old. The scheduled GitHub job may be delayed or failing; check the Actions tab of the repository.`;
  }

  function spark(points, slowMs) {
    if (!points || points.length < 2) return '<span class="svc-note">Collecting history</span>';
    const W = 240, H = 30, pad = 2;
    const t0 = points[0][0], t1 = points[points.length - 1][0];
    const span = Math.max(1, t1 - t0);
    const lat = points.map((p) => p[1]).filter((v) => v != null);
    const max = Math.max(...lat, 1);
    const top = Math.max(max, Math.min(slowMs * 1.05, max * 1.8));
    const x = (t) => ((t - t0) / span) * W;
    const y = (v) => H - pad - (v / top) * (H - pad * 2);
    let d = '';
    let pen = false;
    for (const p of points) {
      if (p[1] == null || p[2] === 'outage') { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`;
      pen = true;
    }
    const downs = points.filter((p) => p[2] === 'outage').map((p) => `<rect class="down" x="${(x(p[0]) - 1.5).toFixed(1)}" y="${H - 6}" width="3" height="6"/>`).join('');
    const limit = slowMs <= top ? `<line class="limit" x1="0" x2="${W}" y1="${y(slowMs).toFixed(1)}" y2="${y(slowMs).toFixed(1)}"/>` : '';
    const nDown = points.filter((p) => p[2] === 'outage').length;
    const label = `Response time, last ${Math.round(span / 3600)} hours: low ${Math.min(...lat)} ms, high ${max} ms${nDown ? `, ${nDown} failed checks` : ''}`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${limit}<path class="line" d="${d}"/>${downs}</svg>`;
  }

  function renderServices(s, h) {
    const d = s.checks.defaults;
    $('services').innerHTML = s.checks.groups.map((g) => `
      <div class="svc-group">
        <h3>${esc(g.name)}</h3>
        <ul class="svc-list panel">
          ${g.items.map((c) => {
            const note = c.level === 'outage'
              ? (c.error ? `Not responding: ${c.error}` : `HTTP ${c.status}`)
              : c.level === 'degraded' ? `Slower than ${(d.slowMs / 1000).toFixed(1)} s` : '';
            const cert = c.certDaysLeft == null ? '–' : `${c.certDaysLeft} days`;
            return `<li class="svc">
              ${mark(c.level)}
              <div class="svc-name"><a href="${esc(c.url)}" rel="noopener">${esc(c.name)}</a>${note ? `<span class="svc-note lvl-${c.level}">${esc(note)}</span>` : ''}</div>
              <div class="num svc-lat">${c.latencyMs == null ? '–' : `${c.latencyMs.toLocaleString()} ms`}</div>
              <div class="svc-spark">${spark(h.points?.[`check:${c.id}`], d.slowMs)}</div>
              <div class="num svc-up">${c.upPct == null ? '–' : `${c.upPct}%`}<small>up, 24 h</small></div>
              <div class="num svc-cert ${c.certDaysLeft != null && c.certDaysLeft < d.certWarnDays ? 'lvl-advisory' : ''}">${cert}<small>certificate</small></div>
            </li>`;
          }).join('')}
        </ul>
      </div>`).join('');
  }

  function timeline(points) {
    if (!points || !points.length) return '';
    const first = points[0][0];
    const hours = Math.max(1, Math.round((points[points.length - 1][0] - first) / 3600));
    const bad = points.filter((p) => p[2] !== 'operational').length;
    return `<div class="timeline" role="img" aria-label="${esc(`Last ${hours} hours: ${bad ? `${bad} of ${points.length} checks showed a problem` : 'no problems seen'}`)}">${points.map((p) => `<span class="t-${p[2]}"></span>`).join('')}</div>
      <div class="timeline-axis" aria-hidden="true"><span>${hours} h ago</span><span>now</span></div>`;
  }

  function renderClouds(s, h) {
    const az = s.azure, dv = s.devops, gh = s.github;
    const cards = [
      { name: 'Azure', level: az.level, msg: az.error ? `Feed unreadable: ${az.error}` : az.activeCount ? `${az.activeCount} active public incident${az.activeCount > 1 ? 's' : ''}` : 'No active public incidents', page: az.page, key: 'azure' },
      { name: 'Azure DevOps', level: dv.level, msg: dv.error ? `Feed unreadable: ${dv.error}` : dv.message, page: dv.page, key: 'devops' },
      { name: 'GitHub', level: gh.level, msg: gh.error ? `Feed unreadable: ${gh.error}` : gh.description, page: gh.page, key: 'github' },
      { name: 'Microsoft 365', level: s.checks.groups.find((g) => g.name === 'Microsoft 365') ? worstOf(s.checks.groups.find((g) => g.name === 'Microsoft 365').items.map((c) => c.level)) : 'unknown', msg: 'No public feed from Microsoft. Status here comes from your web checks above.', page: s.m365Page },
    ];
    $('clouds').innerHTML = cards.map((c) => `
      <article class="cloud panel">
        <div class="cloud-top">${mark(c.level)}<span class="cloud-name">${esc(c.name)}</span></div>
        <p class="cloud-msg">${esc(c.msg)}</p>
        ${c.key ? timeline(h.points?.[`src:${c.key}`]) : ''}
        <a href="${esc(c.page)}" rel="noopener">Open ${esc(c.name)} status page</a>
      </article>`).join('');

    const byId = Object.fromEntries((s.regions.regions || []).map((r) => [r.id, r.name]));
    const inc = [...(az.incidents || [])].sort((a, b) => (b.active - a.active) || String(b.published).localeCompare(String(a.published)));
    const ghInc = gh.incidents || [];
    $('incidents').innerHTML = inc.length || ghInc.length ? `<ul class="incidents">
      ${inc.map((i) => `<li class="incident panel ${i.active ? '' : 'is-past'}">
        <h3>${mark(i.active ? 'degraded' : 'operational', i.active ? 'Active' : 'Mitigated')}<span>${i.link ? `<a href="${esc(i.link)}" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</span></h3>
        <p class="meta">Azure, ${i.active ? 'active' : 'mitigated'}${i.published ? `, posted ${esc(ago(i.published))}` : ''}${i.regions.length ? `. Regions named: ${i.regions.map((r) => esc(byId[r] || r)).join(', ')}` : '. No region named'}.</p>
        <p>${esc(i.summary.length > 320 ? `${i.summary.slice(0, 320)}…` : i.summary)}</p>
      </li>`).join('')}
      ${ghInc.map((i) => `<li class="incident panel">
        <h3>${mark(i.impact === 'major' || i.impact === 'critical' ? 'outage' : 'degraded')}<span>${i.link ? `<a href="${esc(i.link)}" rel="noopener">${esc(i.name)}</a>` : esc(i.name)}</span></h3>
        <p class="meta">GitHub, ${esc(i.status)}${i.updated ? `, updated ${esc(ago(i.updated))}` : ''}.</p>
      </li>`).join('')}
    </ul>` : '';
  }

  function worstOf(levels) {
    const rank = { operational: 0, advisory: 1, unknown: 1, degraded: 2, outage: 3 };
    return levels.reduce((a, l) => (rank[l] > rank[a] ? l : a), 'operational');
  }

  function renderRegions(s) {
    const cfg = s.regions;
    const hits = s.azure.regionLevels || {};
    const nHit = Object.keys(hits).length;
    $('regions-aside').textContent = s.azure.error
      ? 'The Azure feed couldn’t be read, so region status is unknown.'
      : `${cfg.regions.length} public regions. ${nHit ? `${nHit} named in active incidents, highlighted below.` : 'None named in an active public incident.'} Regions are matched by name in Microsoft’s incident text.`;
    $('regions').innerHTML = cfg.geographies.map((geo) => {
      const list = cfg.regions.filter((r) => r.geo === geo);
      const n = list.filter((r) => hits[r.id]).length;
      return `<div class="geo panel">
        <h3>${esc(geo)} <small>${n ? `${n} affected` : `${list.length} regions`}</small></h3>
        <ul class="region-list">
          ${list.map((r) => {
            const lvl = s.azure.error ? 'unknown' : hits[r.id] || 'operational';
            return `<li class="region ${hits[r.id] ? 'is-hit' : ''}">${mark(lvl)}<span>${esc(r.name)}</span><span class="place">${esc(r.place)}</span></li>`;
          }).join('')}
        </ul>
      </div>`;
    }).join('');
  }

  function renderDevOps(s) {
    const dv = s.devops;
    if (dv.error || !dv.services.length) {
      $('devops').innerHTML = `<tbody><tr><td class="empty">${esc(dv.error ? `The Azure DevOps feed couldn’t be read (${dv.error}).` : 'No data yet.')}</td></tr></tbody>`;
      return;
    }
    $('devops').innerHTML = `<thead><tr><th scope="col"><span class="visually-hidden">Service</span></th>${dv.geographies.map((g) => `<th scope="col" title="${esc(g.name)}">${esc(g.name)}</th>`).join('')}</tr></thead>
      <tbody>${dv.services.map((sv) => `<tr><th scope="row">${esc(sv.id)}</th>${dv.geographies.map((g) => {
        const cell = sv.geographies.find((x) => x.id === g.id);
        const lvl = cell ? cell.level : 'unknown';
        return `<td class="${lvl === 'operational' ? '' : `is-bad tint-${lvl}`}">${mark(lvl, `${sv.id}, ${g.name}: ${LABEL[lvl]}`)}</td>`;
      }).join('')}</tr>`).join('')}</tbody>`;
  }

  function renderGitHub(s) {
    const gh = s.github;
    $('github').className = 'components panel';
    $('github').innerHTML = gh.error
      ? `<li class="empty">The GitHub feed couldn’t be read (${esc(gh.error)}).</li>`
      : gh.components.map((c) => `<li class="${c.level === 'operational' ? '' : 'is-hit'}">${mark(c.level)}<span>${esc(c.name)}</span></li>`).join('');
  }

  function renderFooter(s) {
    $('legend').innerHTML = ['operational', 'advisory', 'degraded', 'outage', 'unknown'].map((l) => `<li>${mark(l)}<span>${LABEL[l]}</span></li>`).join('');
    $('sources').innerHTML = `Sources: <a href="${esc(s.azure.page)}">Azure status</a>, <a href="${esc(s.devops.page)}">Azure DevOps status</a>, <a href="${esc(s.github.page)}">GitHub status</a>, <a href="${esc(s.m365Page)}">Microsoft 365 status</a>. The data refreshes every ${s.intervalMinutes} minutes; this page reloads it every 2 minutes.`;
  }

  async function load() {
    try {
      const bust = `?t=${Math.floor(Date.now() / 60000)}`;
      const [s, h] = await Promise.all([
        fetch(`data/status.json${bust}`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
        fetch(`data/history.json${bust}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : { points: {} })).catch(() => ({ points: {} })),
      ]);
      renderHero(s);
      renderServices(s, h);
      renderClouds(s, h);
      renderRegions(s);
      renderDevOps(s);
      renderGitHub(s);
      renderFooter(s);
    } catch (e) {
      $('hero').dataset.level = 'unknown';
      $('verdict-mark').innerHTML = mark('unknown');
      $('headline').textContent = 'No status data yet.';
      $('freshness').textContent = `The page couldn’t load data/status.json (${e.message}). If the site was just set up, run the “Collect status” workflow once from the repository’s Actions tab.`;
    }
  }

  load();
  setInterval(load, RELOAD_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
