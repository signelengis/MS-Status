import tls from 'node:tls';

const UA = 'ms-status-dashboard/1.0 (+https://github.com; scheduled availability check)';

/** Days until the TLS certificate for host expires, or null if it can't be read. */
export function certDaysLeft(host, port = 443, timeoutMs = 8000, now = Date.now()) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      resolve(v);
    };
    const socket = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const t = cert && Date.parse(cert.valid_to);
      finish(Number.isFinite(t) ? Math.floor((t - now) / 86400000) : null);
    });
    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
  });
}

function errorCode(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  const code = e?.cause?.code || e?.code;
  const map = {
    ENOTFOUND: 'DNS lookup failed',
    EAI_AGAIN: 'DNS lookup failed',
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    CERT_HAS_EXPIRED: 'certificate expired',
    UND_ERR_CONNECT_TIMEOUT: 'connect timed out',
    UND_ERR_HEADERS_TIMEOUT: 'timed out',
  };
  return map[code] || code || e?.message || 'request failed';
}

/**
 * One HTTP availability check. A redirect counts as up (sign-in pages redirect),
 * unless okStatus lists the exact codes to accept.
 */
export async function runCheck(check, d) {
  const timeoutMs = check.timeoutMs ?? d.timeoutMs;
  const start = performance.now();
  const out = { status: null, latencyMs: null, ok: false, error: null, certDaysLeft: null };
  try {
    const res = await fetch(check.url, {
      method: check.method || 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    out.latencyMs = Math.round(performance.now() - start);
    out.status = res.status;
    try { await res.body?.cancel(); } catch {}
    out.ok = Array.isArray(check.okStatus) ? check.okStatus.includes(res.status) : res.status >= 200 && res.status < 400;
  } catch (e) {
    out.error = errorCode(e);
  }
  const u = new URL(check.url);
  if (u.protocol === 'https:' && check.checkCert !== false) {
    out.certDaysLeft = await certDaysLeft(u.hostname, Number(u.port) || 443, timeoutMs);
  }
  return out;
}
