// Runs on GitHub Actions every ~5 min. Reads new requests from the phone's request box in the sandbox and,
// when a request clearly matches ONE saved macro, runs that macro and marks the request done.
// Anything it cannot match stays "new" for Claude to handle. Secrets: AGENT_URL (https://sb-xxxx.vercel.run), AGENT_TOKEN.
const URL_BASE = (process.env.AGENT_URL || '').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN || '';
if (!URL_BASE || !TOKEN) { console.log('AGENT_URL / AGENT_TOKEN not set'); process.exit(0); }

async function api(body, ms = 120000) {
  const r = await fetch(URL_BASE + '/api', {
    method: 'POST', headers: { 'x-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

const STOP = new Set(['열기', '열어', '열어줘', '실행', '해줘', '줘', '좀', '을', '를', '해', '주세요']);
const words = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

(async () => {
  let hist, macros;
  try {
    hist = (await api({ action: 'history_data' }, 20000)).data;
    macros = (await api({ action: 'macro_data' }, 20000)).data.macros;
  } catch (e) { console.log('sandbox not reachable (stopped or asleep?): ' + e.message); return; }

  const pending = (hist.requests || []).filter((q) => q.status === 'new');
  console.log('pending requests: ' + pending.length + ', macros: ' + macros.length);
  for (const q of pending) {
    const text = q.text.toLowerCase();
    // a macro matches when every meaningful word of its name appears in the request; macros that need {{variables}} are skipped
    const hits = macros.filter((m) => !m.vars.length && words(m.name).length && words(m.name).every((w) => text.includes(w)));
    if (hits.length !== 1) { console.log('skip "' + q.text + '" -> ' + hits.length + ' macro matches'); continue; }
    const m = hits[0];
    try {
      const r = await api({ action: 'macro_run', name: m.name, vars: {}, via: 'auto' });
      const first = String(r.text || '완료').split('\n')[0].slice(0, 200);
      await api({ action: 'request_done', id: q.id, result: '자동 실행: ' + m.name + ' — ' + first });
      console.log('ran "' + m.name + '" for request ' + q.id);
    } catch (e) { console.log('macro failed for ' + q.id + ': ' + e.message); }
  }
})();
