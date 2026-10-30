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
// Size of every tab, in CSS pixels, plus the pixel density. The phone reports its own size (see 'viewport' below).
let VIEWSPEC = { w: VIEW.width, h: VIEW.height, dpr: 1 };
const viewSessions = new Map(); // page -> CDP session that holds the size override (it must stay open to keep it)

if (TOKEN.length < 24) { console.error('token too short'); process.exit(1); }

function okToken(t) {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let ctx = null;
let page = null;
const pageListeners = new Set();

// Many sites (Daum, Kakao...) keep you logged in with "session cookies", which Chromium drops when it closes.
// So cookies are saved to a file (while running and right before stopping) and put back when Chrome starts.
const COOKIE_FILE = path.join(ROOT, 'cookies.json');
const COOKIE_DAYS = 30;
let cookieTimer = null;

async function saveCookies() {
  if (!ctx) return;
  try {
    const cookies = await ctx.cookies();
    if (cookies.length) fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies), { mode: 0o600 });
  } catch {}
}

async function loadCookies() {
  try {
    const soon = Math.floor(Date.now() / 1000) + COOKIE_DAYS * 86400;
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')).map((c) => ({ ...c, expires: c.expires > 0 ? c.expires : soon }));
    await ctx.addCookies(cookies);
  } catch {}
}

async function applyView(p) {
  try {
    let sess = viewSessions.get(p);
    if (!sess) { sess = await ctx.newCDPSession(p); viewSessions.set(p, sess); p.on('close', () => viewSessions.delete(p)); }
    await sess.send('Emulation.setDeviceMetricsOverride', { width: VIEWSPEC.w, height: VIEWSPEC.h, deviceScaleFactor: VIEWSPEC.dpr, mobile: false });
  } catch {}
}

// Set the size, then check the page really got it; if not, start over with a fresh connection (a silent failure left
// Chrome at its default size and 1x density, so the picture was wrong and taps missed).
// All size changes run one after another and each reads the NEWEST size when it runs; two overlapping runs used to
// finish in the wrong order and leave an old size on the page.
let viewLock = Promise.resolve();
function ensureView(p, tries = 4) {
  const run = viewLock.then(() => ensureViewNow(p, tries));
  viewLock = run.catch(() => {});
  return run;
}
const viewMatches = (p) => p.evaluate(([w, h, d]) => innerWidth === w && innerHeight === h && Math.abs(devicePixelRatio - d) < 0.05, [VIEWSPEC.w, VIEWSPEC.h, VIEWSPEC.dpr]).catch(() => false);
async function ensureViewNow(p, tries) {
  for (let i = 0; i < tries; i++) {
    if (p.isClosed()) return false; // a closed page must not hold up the queue for the pages that matter
    if (await viewMatches(p)) return true; // already right: sending it again would only make the page re-layout
    await applyView(p);
    if (await viewMatches(p)) return true;
    const old = viewSessions.get(p);
    viewSessions.delete(p);
    if (old) old.detach().catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('could not apply the page size', JSON.stringify(VIEWSPEC));
  return false;
}

async function ensure() {
  if (ctx && page && !page.isClosed()) return page;
  if (!ctx) {
    ctx = await pw.chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: null, // the size is set by applyView() below
      locale: 'ko-KR',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    ctx.on('page', (p) => {
      ensureView(p);
      p.on('domcontentloaded', () => ensureView(p, 2)); // a new page load must keep the size
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
    ctx.on('close', () => { ctx = null; page = null; clearInterval(cookieTimer); viewSessions.clear(); });
    for (const pg of ctx.pages()) { ensureView(pg); pg.on('domcontentloaded', () => ensureView(pg, 2)); }
    await loadCookies();
    cookieTimer = setInterval(saveCookies, 20000);
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

// A text field found by what the page shows (placeholder, label) or by its name/id attribute: works across page loads.
function fieldLocator(p, f) {
  const q = f.replace(/["\\]/g, '');
  const fields = p.locator('input:not([type=hidden]),textarea,[contenteditable=true]');
  return p.getByPlaceholder(f).or(p.getByLabel(f)).or(p.locator(`[name="${q}"],[id="${q}"]`)).and(fields).first();
}

// ---- macros: named lists of steps saved by Claude and replayed by name ----
const MACRO_FILE = path.join(ROOT, 'macros.json');
const MACRO_ACTIONS = ['navigate', 'click', 'type', 'key', 'scroll', 'back', 'wait', 'tab_new', 'tab_switch', 'tab_close'];
const MACRO_FIELDS = ['action', 'url', 'text', 'field', 'selector', 'key', 'dy', 'ms', 'n', 'submit'];
const readMacros = () => { try { return JSON.parse(fs.readFileSync(MACRO_FILE, 'utf8')); } catch { return {}; } };
const writeMacros = (m) => fs.writeFileSync(MACRO_FILE, JSON.stringify(m, null, 1), { mode: 0o600 });
const macroName = (n) => {
  const v = String(n || '').trim();
  if (!/^[\w가-힣 -]{1,40}$/.test(v)) throw new Error('매크로 이름은 글자·숫자·공백·-·_ 만 쓰고 40자 이하여야 합니다.');
  return v;
};
const describeStep = (st) => {
  const bits = [st.url, st.text && '"' + st.text + '"', st.field && '[' + st.field + ']', st.selector, st.key, st.n != null && '#' + st.n, st.ms && st.ms + 'ms'].filter(Boolean);
  return st.action + (bits.length ? ' ' + bits.join(' ') : '');
};
const fillVars = (st, vars) => {
  const out = {};
  for (const [k, v] of Object.entries(st)) {
    out[k] = typeof v === 'string'
      ? v.replace(/\{\{(\w+)\}\}/g, (_, name) => {
          if (vars[name] === undefined) throw new Error('변수 {{' + name + '}} 값이 필요합니다. 실행할 때 vars로 알려 주세요.');
          return String(vars[name]);
        })
      : v;
  }
  return out;
};

async function runMacro(body) {
  const name = macroName(body.name);
  const macro = readMacros()[name];
  if (!macro) throw new Error('"' + name + '" 매크로가 없습니다. 목록: ' + (Object.keys(readMacros()).join(', ') || '(없음)'));
  const vars = body.vars && typeof body.vars === 'object' ? body.vars : {};
  const log = [];
  let last = '';
  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i];
    try {
      const filled = fillVars(step, vars);
      if (filled.action === 'wait') { await new Promise((r) => setTimeout(r, Math.min(Number(filled.ms) || 1000, 10000))); last = ''; }
      else { const r = await act(filled); if (r.error) throw new Error(r.error); last = r.text || ''; }
      log.push((i + 1) + '. ' + describeStep(step) + ' ✓');
    } catch (e) {
      log.push((i + 1) + '. ' + describeStep(step) + ' ✗ ' + String(e.message || e).slice(0, 200));
      return { text: '매크로 "' + name + '" 이(가) ' + (i + 1) + '번째 단계에서 멈췄습니다.\n' + log.join('\n') };
    }
  }
  last = await snapshot(await ensure()); // always end with what the page shows now
  return { text: '매크로 "' + name + '" 완료 (' + macro.steps.length + '단계)\n' + log.join('\n') + '\n\n' + last };
}

async function act(body) {
  const a = body.action;
  if (a === 'status') {
    const p = ctx && page && !page.isClosed() ? page : null;
    return { text: p ? `browser on. url=${p.url()}` : 'browser idle (starts on first use)' };
  }
  if (a === 'stop') {
    await saveCookies();
    if (ctx) await ctx.close().catch(() => {});
    ctx = null; page = null;
    return { text: 'browser closed (profile and logins kept)' };
  }
  if (a === 'macro_list') {
    const all = readMacros();
    const names = Object.keys(all);
    return { text: names.length ? names.map((n) => n + ' (' + all[n].steps.length + '단계' + (all[n].note ? ' - ' + all[n].note : '') + ')\n   ' + all[n].steps.map(describeStep).join(' → ')).join('\n') : '저장된 매크로가 없습니다.' };
  }
  if (a === 'macro_save') {
    const name = macroName(body.name);
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (!steps.length) throw new Error('steps(단계 목록)가 비어 있습니다.');
    if (steps.length > 50) throw new Error('단계는 최대 50개입니다.');
    const clean = steps.map((st, i) => {
      if (!st || !MACRO_ACTIONS.includes(st.action)) throw new Error((i + 1) + '번째 단계의 action이 올바르지 않습니다. 사용 가능: ' + MACRO_ACTIONS.join(', '));
      if (st.action === 'type' && !st.field) throw new Error((i + 1) + '번째 단계: type은 field(입력칸의 안내글·이름)가 필요합니다. 번호(id)는 페이지를 열 때마다 바뀌어 매크로에 쓸 수 없습니다.');
      if (st.action === 'click' && !st.text && !st.selector) throw new Error((i + 1) + '번째 단계: click은 text 또는 selector가 필요합니다.');
      if (st.action === 'navigate' && !/^https?:\/\//i.test(String(st.url || ''))) throw new Error((i + 1) + '번째 단계: navigate의 url은 http(s)://로 시작해야 합니다.');
      return Object.fromEntries(MACRO_FIELDS.filter((k) => st[k] !== undefined).map((k) => [k, st[k]]));
    });
    const all = readMacros();
    const existed = !!all[name];
    all[name] = { steps: clean, note: String(body.note || '').slice(0, 80), saved: new Date().toISOString() };
    writeMacros(all);
    return { text: '매크로 "' + name + '" ' + (existed ? '덮어써서 ' : '') + '저장했습니다 (' + clean.length + '단계).\n' + clean.map((st, i) => (i + 1) + '. ' + describeStep(st)).join('\n') };
  }
  if (a === 'macro_delete') {
    const name = macroName(body.name);
    const all = readMacros();
    if (!all[name]) throw new Error('"' + name + '" 매크로가 없습니다.');
    delete all[name];
    writeMacros(all);
    return { text: '매크로 "' + name + '" 삭제했습니다.' };
  }
  if (a === 'macro_run') return runMacro(body);
  if (a === 'wait') { await new Promise((r) => setTimeout(r, Math.min(Number(body.ms) || 1000, 10000))); return { text: 'waited' }; }
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
    const loc = body.id ? p.locator(`[data-ca-id="${Number(body.id)}"]`).first()
      : body.selector ? p.locator(String(body.selector)).first()
      : p.getByText(String(body.text || ''), { exact: false }).first();
    await loc.click({ timeout: 8000 });
    await settle(page || p);
    return { text: await snapshot(page || p) };
  }
  if (a === 'type') {
    const loc = body.field ? fieldLocator(p, String(body.field)) : p.locator(`[data-ca-id="${Number(body.id)}"]`).first();
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
  // One capture at a time; if the screen changes meanwhile, capture again right after. The next capture starts only
  // when the previous picture has been written to the network, so slow connections never pile up old pictures.
  let busy = false, dirty = false, viewTimer = null;
  const pump = async () => {
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      do {
        dirty = false;
        if (!cdp || ws.readyState !== 1) break;
        // capture through the same connection that holds the size/density setting, otherwise it comes out 1x
        const shooter = (cur && viewSessions.get(cur)) || cdp;
        const r = await shooter.send('Page.captureScreenshot', { format: 'jpeg', quality: 55, fromSurface: true });
        if (ws.readyState === 1) await new Promise((res) => ws.send(Buffer.from(r.data, 'base64'), res));
      } while (dirty);
    } catch {}
    busy = false;
    // a capture that failed because the size changed meanwhile must not leave the old picture on the phone
    if (dirty) { dirty = false; pump(); }
  };
  const startCast = async () => {
    await stopCast();
    cur = await ensure();
    cdp = await ctx.newCDPSession(cur);
    // Chrome's screencast frames are always page-sized (never sharper on a phone), so they are used only as the
    // signal "the screen changed". The picture sent to the phone is a real capture at full pixel density.
    cdp.on('Page.screencastFrame', (f) => {
      cdp && cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      pump();
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 120, maxHeight: 120, everyNthFrame: 1 });
    pump();
  };
  const onPage = () => { startCast().catch(() => {}); };
  pageListeners.add(onPage);
  const reply = (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  // Messages are handled strictly one after another (typed letters used to run at the same time and could arrive
  // out of order), and the handler is attached BEFORE the screen starts so nothing sent right after connecting is lost.
  let queue = Promise.resolve();
  let tabsQueued = false;
  ws.on('message', (m) => {
    let t = '';
    try { t = JSON.parse(m.toString()).t; } catch {}
    if (t === 'tabs') { if (tabsQueued) return; tabsQueued = true; } // never pile up the periodic tab polls
    queue = queue.then(async () => { if (t === 'tabs') tabsQueued = false; await handle(m); });
  });
  const handle = async (m) => {
    try {
      const d = JSON.parse(m.toString());
      const p = await ensure();
      if (d.t === 'click') await p.mouse.click(Number(d.x), Number(d.y));
      else if (d.t === 'text') await p.keyboard.insertText(String(d.v || ''));
      else if (d.t === 'edit') {
        // phone typing: delete the letters that changed, then insert the new ones (one message per change)
        for (let k = 0; k < Math.min(Number(d.del) || 0, 200); k++) await p.keyboard.press('Backspace');
        if (d.add) await p.keyboard.insertText(String(d.add));
      }
      else if (d.t === 'key') await p.keyboard.press(String(d.k));
      else if (d.t === 'scroll') {
        // finger drags send exact distances at the touched spot; the ▲/▼ buttons send only dy
        if (d.x !== undefined) await p.mouse.move(Number(d.x), Number(d.y));
        await p.mouse.wheel(Number(d.dx) || 0, d.dy === undefined ? 300 : Number(d.dy) || 0);
      }
      else if (d.t === 'goto' && /^https?:\/\//i.test(String(d.u))) await p.goto(String(d.u), { waitUntil: 'domcontentloaded', timeout: 30000 });
      else if (d.t === 'viewport') {
        // the phone tells its screen size: make every tab exactly that big, then restart the picture at the new size
        const cl = (v, a, b) => Math.min(b, Math.max(a, v));
        VIEWSPEC = { w: cl(Math.round(Number(d.w)) || VIEW.width, 200, 2000), h: cl(Math.round(Number(d.h)) || VIEW.height, 200, 3000), dpr: cl(Number(d.dpr) || 1, 1, 3) };
        // Requests that arrive close together (the screen size can settle in two steps) are merged: only the last one is applied.
        clearTimeout(viewTimer);
        viewTimer = setTimeout(async () => {
          try {
            for (const pg of livePages()) await ensureView(pg);
            await startCast();
            // the page needs a moment to lay out at the new size: capture again so the phone never keeps the old-size picture
            setTimeout(pump, 250); setTimeout(pump, 800);
            // Chrome sometimes drops a resize that arrives right after another one: look again and fix it if so
            for (const delay of [700, 1600]) setTimeout(async () => { try { for (const pg of livePages()) await ensureView(pg, 2); pump(); } catch {} }, delay);
          } catch {}
        }, 250);
      }
      else if (d.t === 'back') await p.goBack({ timeout: 8000 }).catch(() => {});
      else if (d.t === 'reload') await p.reload({ timeout: 15000 }).catch(() => {});
      else if (d.t === 'tab') await switchTab(d.n);
      else if (d.t === 'newtab') await newTab(d.u ? String(d.u) : '');
      else if (d.t === 'closetab') await closeTab(d.n);
      if (['tabs', 'tab', 'newtab', 'closetab', 'goto'].includes(d.t)) reply({ tabs: await tabList() });
    } catch (e) { reply({ error: String(e.message || e).slice(0, 200) }); }
  };
  try { await startCast(); } catch (e) { reply({ error: String(e.message || e) }); }
  ws.on('close', () => { pageListeners.delete(onPage); stopCast(); });
});

server.listen(PORT, '0.0.0.0', () => console.log('agent listening on', PORT));
process.on('SIGTERM', async () => { await saveCookies(); if (ctx) await ctx.close().catch(() => {}); process.exit(0); });
