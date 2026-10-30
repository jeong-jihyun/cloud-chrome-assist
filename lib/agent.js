// Starts/resumes the persistent Vercel Sandbox that holds the Chrome, and talks to the agent inside it.
import { Sandbox } from '@vercel/sandbox';
import fs from 'node:fs';
import path from 'node:path';

const NAME = 'chrome-assist';
const PORT = 3000;
let DIR = '/vercel/agent'; // set from the sandbox's working directory in ensureAgent(), because writeFiles puts "agent/..." there
const TOKEN = () => process.env.AGENT_TOKEN || '';

const FILES = ['server.js', 'live.html', 'setup.sh', 'package.json'];
const readAgentFile = (f) => fs.readFileSync(path.join(process.cwd(), 'sandbox-agent', f));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const healthy = (url) =>
  fetch(url + '/health', { signal: AbortSignal.timeout(4000) }).then((r) => r.ok).catch(() => false);

async function sh(sb, cmd) {
  const r = await sb.runCommand('sh', ['-c', cmd]);
  return { code: r.exitCode, out: (await r.stdout()).trim() };
}

// Returns { state: 'ready'|'installing'|'starting', url, sb, note }
export async function ensureAgent() {
  if (process.env.MOCK_AGENT_URL) return { state: 'ready', url: process.env.MOCK_AGENT_URL, sb: null };
  if (TOKEN().length < 24) throw new Error('AGENT_TOKEN env var must be at least 24 characters');

  const sb = await Sandbox.getOrCreate({
    name: NAME,
    ports: [PORT],
    timeout: 44 * 60 * 1000, // Hobby max session is 45 minutes
    resume: true,
  });

  DIR = (await sh(sb, 'pwd')).out + '/agent';

  let url;
  try { url = sb.domain(PORT); } catch { await sb.update({ ports: [PORT] }); url = sb.domain(PORT); }
  if (await healthy(url)) return { state: 'ready', url, sb };

  const ready = (await sh(sb, `test -f ${DIR}/.ready && echo yes || echo no`)).out === 'yes';
  if (!ready) {
    // "[s]h" keeps pgrep from matching its own shell command line (that made it always report "running").
    const running = (await sh(sb, 'pgrep -f "[s]h setup.sh" >/dev/null && echo yes || echo no')).out === 'yes';
    if (!running) {
      await sb.writeFiles(FILES.map((f) => ({ path: `agent/${f}`, content: readAgentFile(f) })));
      await sb.runCommand({
        cmd: 'sh',
        args: ['-c', `cd ${DIR} && sh setup.sh > setup.log 2>&1`],
        detached: true,
      });
      return { state: 'installing', url, sb, note: '처음 한 번 크롬을 설치하는 중입니다. 3~6분 뒤 다시 확인하세요.' };
    }
    const tail = (await sh(sb, `tail -n 3 ${DIR}/setup.log 2>/dev/null`)).out;
    return { state: 'installing', url, sb, note: '설치 중입니다. 잠시 뒤 다시 확인하세요.\n' + tail };
  }

  await sb.writeFiles([
    { path: 'agent/token.txt', content: Buffer.from(TOKEN()) },
    ...FILES.filter((f) => f !== 'setup.sh').map((f) => ({ path: `agent/${f}`, content: readAgentFile(f) })),
  ]);
  await sb.runCommand({
    cmd: 'sh',
    args: ['-c', `cd ${DIR} && PORT=${PORT} PLAYWRIGHT_BROWSERS_PATH=${DIR}/browsers node server.js > server.log 2>&1`],
    detached: true,
  });
  for (let i = 0; i < 10; i++) {
    await sleep(2500);
    if (await healthy(url)) return { state: 'ready', url, sb };
  }
  return { state: 'starting', url, sb, note: '서버를 켜는 중입니다. 10초 뒤 다시 시도하세요.' };
}

export async function callAgent(url, body) {
  const r = await fetch(url + '/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': TOKEN() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error('agent http ' + r.status);
  return r.json();
}

export const liveUrl = (url) => `${url}/live?token=${encodeURIComponent(TOKEN())}`;
