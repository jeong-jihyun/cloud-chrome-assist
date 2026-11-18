// PC 크롬 확장(cookie-bridge)이 보낸 로그인 쿠키를 받아 클라우드 크롬에 넣는다.
// 확장(다른 출처)에서 호출하므로 CORS 허용 + OPTIONS(사전요청) 처리.
import crypto from 'node:crypto';
import { ensureAgent, callAgent } from '../lib/agent.js';

function authorized(req) {
  const want = Buffer.from(process.env.ASSIST_KEY || '');
  const got = Buffer.from(String(req.query?.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')));
  return want.length >= 24 && want.length === got.length && crypto.timingSafeEqual(want, got);
}

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,authorization');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const cookies = Array.isArray(body.cookies) ? body.cookies : [];
  if (!cookies.length) return res.status(400).json({ ok: false, error: '쿠키가 비어 있습니다.' });
  if (cookies.length > 5000) return res.status(413).json({ ok: false, error: '쿠키가 너무 많습니다(최대 5000개). 사이트를 지정해 보내 주세요.' });

  try {
    const ag = await ensureAgent();
    if (ag.state !== 'ready') {
      // 클라우드 크롬이 아직 켜지는 중 — 확장이 잠시 뒤 다시 보내면 된다.
      return res.status(200).json({ ok: false, state: ag.state, note: ag.note || '클라우드 크롬을 켜는 중입니다. 20초쯤 뒤 다시 보내 주세요.' });
    }
    const r = await callAgent(ag.url, { action: 'cookies_import', cookies });
    if (r.error) return res.status(200).json({ ok: false, error: r.error });
    return res.status(200).json({ ok: true, text: r.text });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
}
