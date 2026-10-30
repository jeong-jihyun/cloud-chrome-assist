// Runs INSIDE the Vercel Sandbox. Controls one persistent Chromium (logins are kept in ./profile)
// and offers: POST /api (for Claude via the MCP function) and /live (phone screen for manual login).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let pw;
try { pw = require('playwright-core'); } catch { pw = require('playwright'); }
const { WebSocketServer } = require('ws');

const ROOT = process.env.AGENT_ROOT || __dirname;
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = fs.readFileSync(path.join(ROOT, 'token.txt'), 'utf8').trim();
const PROFILE = path.join(ROOT, 'profile');
const VIEW = { width: 1100, height: 720 };

if (TOKEN.length < 24) { console.error('token too short'); process.exit(1); }

function okToken(t) {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let ctx = null;
let page = null;
const pageListeners = new Set();

async function ensure() {
  if (ctx && page && !page.isClosed()) return page;
  if (!ctx) {
    ctx = await pw.chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: VIEW,
      locale: 'ko-KR',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    ctx.on('page', (p) => {
      page = p;
      pageListeners.forEach((f) => f(p));
      // when the current tab is closed, fall back to the last remaining tab
      p.on('close', () => {
        if (page !== p) return;
        const ps = livePages();
        page = ps[ps.length - 1] || null;
        if (page) pageListeners.forEach((f) => f(page));
      });
    });
    ctx.on('close', () => { ctx = null; page = null; });
  }
  const pages = ctx.pages();
  page = pages[pages.length - 1] || (await ctx.newPage());
  return page;
}

const livePages = () => (ctx ? ctx.pages().filter((x) => !x.isClosed()) : []);

// Numbered (1-based) list of open tabs; the current tab is marked active.
async function tabList() {
  const ps = livePages();
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    out.push({
      n: i + 1,
      title: String(await ps[i].title().catch(() => '')).slice(0, 40),
      url: ps[i].url().slice(0, 100),
      active: ps[i] === page,
    });
  }
  return out;
}
const tabText = (l) => l.map((t) => `${t.active ? '*' : ' '} [${t.n}] ${t.title || '(제목 없음)'} - ${t.url}`).join('\n') || '(탭 없음)';

async function switchTab(n) {
  const ps = livePages();
  const target = ps[Number(n) - 1];
  if (!target) throw new Error('그런 탭이 없습니다. 탭 번호: 1~' + ps.length);
  page = target;
  await target.bringToFront().catch(() => {});
  pageListeners.forEach((f) => f(target));
  return target;
}

async function newTab(url) {
  if (url && !/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://'); // check before opening a tab
  const np = await ctx.newPage(); // the 'page' event makes it the current tab
  if (url) await np.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return np;
}

async function closeTab(n) {
  const ps = livePages();
  const target = n ? ps[Number(n) - 1] : page;
  if (!target) throw new Error('그런 탭이 없습니다. 탭 번호: 1~' + ps.length);
  await target.close();
  if (!livePages().length) await ensure(); // always keep at least one tab
}

const SNAP_FN = () => {
  document.querySelectorAll('[data-ca-id]').forEach((e) => e.removeAttribute('data-ca-id'));
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true]';
  const out = [];
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
    if (r.bottom < 0 || r.top > innerHeight * 3) continue;
    i += 1;
    el.setAttribute('data-ca-id', String(i));
    const tag = el.tagName.toLowerCase();
    const type = el.type ? ':' + el.type : '';
    const isPw = el.type === 'password';
    const raw = el.getAttribute('aria-label') || el.innerText || (isPw ? '' : el.value) || el.placeholder || el.title || el.alt || '';
    const label = String(raw).replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push('[' + i + '] ' + tag + type + ' "' + label + '"' + (el.href ? ' -> ' + String(el.href).slice(0, 100) : ''));
    if (i >= 150) break;
  }
  return {
    title: document.title,
    url: location.href,
    text: (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 4000),
    items: out,
  };
};

async function snapshot(p) {
  const s = await p.evaluate(SNAP_FN);
  return `URL: ${s.url}\nTitle: ${s.title}\n\n[Interactive elements]\n${s.items.join('\n') || '(none)'}\n\n[Page text]\n${s.text}`;
}

async function settle(p) {
  await p.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(700);
}

const PW_MSG = 'Password fields are never typed by Claude. Ask the user to enter it in the live view.';

async function isSecretField(loc) {
  return loc.evaluate((el) => {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    return el.type === 'password' || /cc-number|cc-csc|one-time-code|current-password|new-password/.test(ac);
  }).catch(() => false);
}

async function act(body) {
  const a = body.action;
  if (a === 'status') {
    const p = ctx && page && !page.isClosed() ? page : null;
    return { text: p ? `browser on. url=${p.url()}` : 'browser idle (starts on first use)' };
  }
  if (a === 'stop') {
    if (ctx) await ctx.close().catch(() => {});
    ctx = null; page = null;
    return { text: 'browser closed (profile kept)' };
  }
  const p = await ensure();
  if (a === 'tabs') return { text: tabText(await tabList()) };
  if (a === 'tab_new') {
    const np = await newTab(String(body.url || ''));
    await settle(np);
    return { text: tabText(await tabList()) + '\n\n' + (await snapshot(np)) };
  }
  if (a === 'tab_switch') {
    const t = await switchTab(body.n);
    return { text: tabText(await tabList()) + '\n\n' + (await snapshot(t)) };
  }
  if (a === 'tab_close') {
    await closeTab(body.n);
    const cur = await ensure();
    return { text: tabText(await tabList()) + '\n\n' + (await snapshot(cur)) };
  }
  if (a === 'navigate') {
    const u = String(body.url || '');
    if (!/^https?:\/\//i.test(u)) throw new Error('url must start with http:// or https://');
    await p.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await settle(p);
    return { text: await snapshot(p) };
  }
  if (a === 'snapshot') return { text: await snapshot(p) };
  if (a === 'click') {
    const loc = body.id ? p.locator(`[data-ca-id="${Number(body.id)}"]`).first() : p.getByText(String(body.text || ''), { exact: false }).first();
    await loc.click({ timeout: 8000 });
    await settle(page || p);
    return { text: await snapshot(page || p) };
  }
  if (a === 'type') {
    const loc = p.locator(`[data-ca-id="${Number(body.id)}"]`).first();
    if (await isSecretField(loc)) throw new Error(PW_MSG);
    await loc.fill(String(body.text ?? ''), { timeout: 8000 });
    if (body.submit) await p.keyboard.press('Enter');
    await settle(page || p);
    return { text: await snapshot(page || p) };
  }
  if (a === 'key') {
    await p.keyboard.press(String(body.key));
    await settle(page || p);
    return { text: await snapshot(page || p) };
  }
  if (a === 'scroll') {
    await p.mouse.wheel(0, Number(body.dy) || 600);
    await p.waitForTimeout(300);
    return { text: await snapshot(p) };
  }
  if (a === 'back') {
    await p.goBack({ timeout: 8000 }).catch(() => {});
    await settle(p);
    return { text: await snapshot(p) };
  }
  if (a === 'screenshot') {
    const buf = await p.screenshot({ type: 'jpeg', quality: 55 });
    return { image: buf.toString('base64'), mime: 'image/jpeg' };
  }
  throw new Error('unknown action: ' + a);
}

const LIVE_HTML = fs.readFileSync(path.join(ROOT, 'live.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
  };
  if (url.pathname === '/health') return send(200, { ok: true });
  if (url.pathname === '/live') {
    if (!okToken(url.searchParams.get('token'))) return send(401, 'unauthorized', 'text/plain');
    return send(200, LIVE_HTML, 'text/html; charset=utf-8');
  }
  if (url.pathname === '/api' && req.method === 'POST') {
    if (!okToken(req.headers['x-token'])) return send(401, { error: 'unauthorized' });
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 100000) return send(413, { error: 'too large' }); }
    try { return send(200, await act(JSON.parse(raw || '{}'))); }
    catch (e) { return send(200, { error: String(e.message || e).slice(0, 500) }); }
  }
  send(404, 'not found', 'text/plain');
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws' || !okToken(url.searchParams.get('token'))) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', async (ws) => {
  let cdp = null;
  let cur = null;
  const stopCast = async () => { try { if (cdp) { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); } } catch {} cdp = null; };
  const startCast = async () => {
    await stopCast();
    cur = await ensure();
    cdp = await ctx.newCDPSession(cur);
    cdp.on('Page.screencastFrame', (f) => {
      if (ws.readyState === 1) ws.send(Buffer.from(f.data, 'base64'));
      cdp && cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 2 });
  };
  const onPage = () => { startCast().catch(() => {}); };
  pageListeners.add(onPage);
  try { await startCast(); } catch (e) { ws.send(JSON.stringify({ error: String(e.message || e) })); }
  ws.on('message', async (m) => {
    try {
      const d = JSON.parse(m.toString());
      const p = await ensure();
      if (d.t === 'click') await p.mouse.click(Number(d.x), Number(d.y));
      else if (d.t === 'text') await p.keyboard.insertText(String(d.v || ''));
      else if (d.t === 'key') await p.keyboard.press(String(d.k));
      else if (d.t === 'scroll') await p.mouse.wheel(0, Number(d.dy) || 300);
      else if (d.t === 'goto' && /^https?:\/\//i.test(String(d.u))) await p.goto(String(d.u), { waitUntil: 'domcontentloaded', timeout: 30000 });
      else if (d.t === 'tab') await switchTab(d.n);
      else if (d.t === 'newtab') await newTab(d.u ? String(d.u) : '');
      else if (d.t === 'closetab') await closeTab(d.n);
      if (['tabs', 'tab', 'newtab', 'closetab', 'goto'].includes(d.t)) ws.send(JSON.stringify({ tabs: await tabList() }));
    } catch (e) { ws.send(JSON.stringify({ error: String(e.message || e).slice(0, 200) })); }
  });
  ws.on('close', () => { pageListeners.delete(onPage); stopCast(); });
});

server.listen(PORT, '0.0.0.0', () => console.log('agent listening on', PORT));
process.on('SIGTERM', async () => { if (ctx) await ctx.close().catch(() => {}); process.exit(0); });
