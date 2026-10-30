// MCP server (stateless Streamable HTTP, JSON-RPC) that lets Claude drive the cloud Chrome.
import crypto from 'node:crypto';
import { ensureAgent, callAgent, liveUrl } from '../lib/agent.js';

const obj = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });

const TOOLS = [
  { name: 'browser_status', description: '클라우드 크롬 상태 확인/시작. 처음이면 설치를 시작한다.', inputSchema: obj() },
  { name: 'browser_open', description: 'URL을 열고 화면 요소 목록(번호)과 본문 글자를 돌려준다.', inputSchema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'browser_snapshot', description: '현재 화면의 요소 목록(번호)과 본문 글자를 돌려준다.', inputSchema: obj() },
  { name: 'browser_click', description: '번호(id) 또는 보이는 글자(text)로 클릭한다.', inputSchema: obj({ id: { type: 'number' }, text: { type: 'string' } }) },
  { name: 'browser_type', description: '번호(id) 입력칸에 글자를 넣는다. 비밀번호 칸은 차단된다.', inputSchema: obj({ id: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['id', 'text']) },
  { name: 'browser_key', description: 'Enter, Tab, Escape 같은 키를 누른다.', inputSchema: obj({ key: { type: 'string' } }, ['key']) },
  { name: 'browser_scroll', description: '아래(+)/위(-)로 스크롤한다.', inputSchema: obj({ dy: { type: 'number' } }) },
  { name: 'browser_back', description: '뒤로 가기.', inputSchema: obj() },
  { name: 'browser_screenshot', description: '현재 화면을 이미지로 돌려준다.', inputSchema: obj() },
  { name: 'browser_tabs', description: '열려 있는 탭 목록(번호·제목·주소)을 보여준다. *가 붙은 것이 현재 탭이다.', inputSchema: obj() },
  { name: 'browser_tab_new', description: '새 탭을 열고 그 탭으로 이동한다. url을 주면 그 주소를 연다.', inputSchema: obj({ url: { type: 'string' } }) },
  { name: 'browser_tab_switch', description: '탭 번호(n)로 그 탭으로 이동하고 화면 요소 목록을 돌려준다. 이후 클릭·입력은 이 탭에서 이루어진다.', inputSchema: obj({ n: { type: 'number' } }, ['n']) },
  { name: 'browser_tab_close', description: '탭 번호(n)의 탭을 닫는다. n을 생략하면 현재 탭을 닫는다.', inputSchema: obj({ n: { type: 'number' } }) },
  { name: 'browser_live_view', description: '사용자가 폰에서 직접 로그인할 수 있는 라이브 화면 링크를 돌려준다. 비밀번호/2단계 인증/캡처는 이걸로 사용자가 직접 한다.', inputSchema: obj() },
  { name: 'browser_stop', description: '크롬과 샌드박스를 끈다(로그인 정보는 저장됨). 작업이 끝나면 호출해 한도를 아낀다.', inputSchema: obj() },
];

const ACTION = {
  browser_open: (a) => ({ action: 'navigate', url: a.url }),
  browser_snapshot: () => ({ action: 'snapshot' }),
  browser_tabs: () => ({ action: 'tabs' }),
  browser_tab_new: (a) => ({ action: 'tab_new', url: a.url }),
  browser_tab_switch: (a) => ({ action: 'tab_switch', n: a.n }),
  browser_tab_close: (a) => ({ action: 'tab_close', n: a.n }),
  browser_click: (a) => ({ action: 'click', id: a.id, text: a.text }),
  browser_type: (a) => ({ action: 'type', id: a.id, text: a.text, submit: !!a.submit }),
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
        serverInfo: { name: 'cloud-chrome-assist', version: '0.2.0' },
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
