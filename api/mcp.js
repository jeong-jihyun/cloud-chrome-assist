// MCP server (stateless Streamable HTTP, JSON-RPC) that lets Claude drive the cloud Chrome.
import crypto from 'node:crypto';
import { ensureAgent, callAgent, liveUrl } from '../lib/agent.js';

const obj = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

const STEP = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['navigate', 'click', 'type', 'key', 'scroll', 'back', 'wait', 'tab_new', 'tab_switch', 'tab_close'] },
    url: { type: 'string', description: 'navigate / tab_new 주소 (http:// 또는 https://). {{변수}} 사용 가능' },
    text: { type: 'string', description: 'click: 보이는 글자 / type: 입력할 글자. {{변수}} 사용 가능' },
    field: { type: 'string', description: 'type: 입력칸을 찾을 안내글·라벨·name·id' },
    selector: { type: 'string', description: 'click: CSS 선택자(글자로 못 찾을 때)' },
    key: { type: 'string', description: 'key: Enter, Tab 같은 키' },
    dy: { type: 'number', description: 'scroll: 아래(+)/위(-) 픽셀' },
    ms: { type: 'number', description: 'wait: 기다릴 밀리초(최대 10000)' },
    n: { type: 'number', description: 'tab_switch / tab_close: 탭 번호' },
    submit: { type: 'boolean', description: 'type: 입력 뒤 Enter' },
  },
  required: ['action'],
};

const TOOLS = [
  { name: 'browser_status', description: '클라우드 크롬 상태 확인/시작. 처음이면 설치를 시작한다.', inputSchema: obj() },
  { name: 'browser_open', description: 'URL을 열고 화면 요소 목록(번호)과 본문 글자를 돌려준다.', inputSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'browser_snapshot', description: '현재 화면의 요소 목록(번호)과 본문 글자를 돌려준다.', inputSchema: obj() },
  { name: 'browser_click', description: '번호(id), 보이는 글자(text), 또는 CSS 선택자(selector)로 클릭한다.', inputSchema: obj({ id: { type: 'number' }, text: { type: 'string' }, selector: { type: 'string' } }) },
  { name: 'browser_type', description: '번호(id) 또는 입력칸 안내글·이름(field)으로 찾은 입력칸에 글자를 넣는다. 비밀번호 칸은 차단된다.', inputSchema: obj({ id: { type: 'number' }, field: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['text']) },
  { name: 'browser_key', description: 'Enter, Tab, Escape 같은 키를 누른다.', inputSchema: obj({ key: { type: 'string' } }, ['key']) },
  { name: 'browser_scroll', description: '아래(+)/위(-)로 스크롤한다.', inputSchema: obj({ dy: { type: 'number' } }) },
  { name: 'browser_back', description: '뒤로 가기.', inputSchema: obj() },
  { name: 'browser_screenshot', description: '현재 화면을 이미지로 돌려준다.', inputSchema: obj() },
  { name: 'browser_tabs', description: '열려 있는 탭 목록(번호·제목·주소)을 보여준다. *가 붙은 것이 현재 탭이다.', inputSchema: obj() },
  { name: 'browser_tab_new', description: '새 탭을 열고 그 탭으로 이동한다. url을 주면 그 주소를 연다.', inputSchema: obj({ url: { type: 'string' } }) },
  { name: 'browser_tab_switch', description: '탭 번호(n)로 그 탭으로 이동하고 화면 요소 목록을 돌려준다. 이후 클릭·입력은 이 탭에서 이루어진다.', inputSchema: obj({ n: { type: 'number' } }, ['n']) },
  { name: 'browser_tab_close', description: '탭 번호(n)의 탭을 닫는다. n을 생략하면 현재 탭을 닫는다.', inputSchema: obj({ n: { type: 'number' } }) },
  { name: 'browser_macro_save', description: '매크로 저장: 이름과 단계 목록을 저장한다. 같은 이름이면 덮어쓴다. 입력칸은 번호(id)가 아니라 field(안내글·라벨·이름)로, 클릭은 text나 selector로 적는다. 바뀌는 값은 {{변수}}로 쓰고 실행할 때 vars로 준다. 비밀번호는 매크로에 쓸 수 없다(차단됨).', inputSchema: obj({ name: { type: 'string' }, note: { type: 'string', description: '한 줄 설명(선택)' }, steps: { type: 'array', items: STEP, description: '최대 50단계' } }, ['name', 'steps']) },
  { name: 'browser_macro_run', description: '저장된 매크로를 이름으로 실행한다. 단계를 차례로 실행하고, 실패하면 그 단계에서 멈추고 알려준다. 끝나면 마지막 화면을 돌려준다.', inputSchema: obj({ name: { type: 'string' }, vars: { type: 'object', additionalProperties: { type: 'string' }, description: '{{변수}}에 넣을 값' } }, ['name']) },
  { name: 'browser_macro_list', description: '저장된 매크로 이름과 단계를 보여준다.', inputSchema: obj() },
  { name: 'browser_macro_delete', description: '저장된 매크로를 이름으로 삭제한다.', inputSchema: obj({ name: { type: 'string' } }, ['name']) },
  { name: 'browser_live_view', description: '사용자가 폰에서 직접 로그인할 수 있는 라이브 화면 링크를 돌려준다. 비밀번호/2단계 인증/캡처는 이걸로 사용자가 직접 한다.', inputSchema: obj() },
  { name: 'browser_stop', description: '크롬과 샌드박스를 끈다(로그인 정보는 저장됨). 작업이 끝나면 호출해 한도를 아낀다.', inputSchema: obj() },
];

const ACTION = {
  browser_open: (a) => ({ action: 'navigate', url: a.url }),
  browser_snapshot: () => ({ action: 'snapshot' }),
  browser_macro_save: (a) => ({ action: 'macro_save', name: a.name, note: a.note, steps: a.steps }),
  browser_macro_run: (a) => ({ action: 'macro_run', name: a.name, vars: a.vars }),
  browser_macro_list: () => ({ action: 'macro_list' }),
  browser_macro_delete: (a) => ({ action: 'macro_delete', name: a.name }),
  browser_tabs: () => ({ action: 'tabs' }),
  browser_tab_new: (a) => ({ action: 'tab_new', url: a.url }),
  browser_tab_switch: (a) => ({ action: 'tab_switch', n: a.n }),
  browser_tab_close: (a) => ({ action: 'tab_close', n: a.n }),
  browser_click: (a) => ({ action: 'click', id: a.id, text: a.text, selector: a.selector }),
  browser_type: (a) => ({ action: 'type', id: a.id, field: a.field, text: a.text, submit: !!a.submit }),
  browser_key: (a) => ({ action: 'key', key: a.key }),
  browser_scroll: (a) => ({ action: 'scroll', dy: a.dy }),
  browser_back: () => ({ action: 'back' }),
  browser_screenshot: () => ({ action: 'screenshot' }),
};

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

async function runTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return text('알 수 없는 도구: ' + name, true);
  const ag = await ensureAgent();
  if (ag.state !== 'ready') return text(`상태: ${ag.state}\n${ag.note || ''}`);
  if (name === 'browser_status') return text('상태: ready\n' + (await callAgent(ag.url, { action: 'status' })).text);
  if (name === 'browser_live_view') return text('폰에서 이 링크를 열어 직접 로그인하세요(링크는 비밀입니다):\n' + liveUrl(ag.url));
  if (name === 'browser_stop') {
    await callAgent(ag.url, { action: 'stop' }).catch(() => {});
    if (ag.sb) await ag.sb.stop();
    return text('꺼졌습니다. 로그인 정보는 저장되었습니다.');
  }
  const r = await callAgent(ag.url, ACTION[name](args || {}));
  if (r.error) return text('오류: ' + r.error, true);
  if (r.image) return { content: [{ type: 'image', data: r.image, mimeType: r.mime }] };
  return text(r.text);
}

function authorized(req) {
  const want = Buffer.from(process.env.ASSIST_KEY || '');
  const got = Buffer.from(String(req.query?.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')));
  return want.length >= 24 && want.length === got.length && crypto.timingSafeEqual(want, got);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const msg = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const reply = (result) => res.status(200).json({ jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'cloud-chrome-assist', version: '0.3.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return res.status(202).end();
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      try { return reply(await runTool(msg.params?.name, msg.params?.arguments)); }
      catch (e) { return reply(text('오류: ' + String(e.message || e).slice(0, 400), true)); }
    default:
      return res.status(200).json({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: 'method not found' } });
  }
}
