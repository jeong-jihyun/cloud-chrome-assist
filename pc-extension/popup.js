const $ = (s) => document.querySelector(s);
const out = (t) => { $('#out').textContent = t; };

// 저장된 설정 불러오기 (주소는 처음엔 기본값 제안)
chrome.storage.local.get(['url', 'key', 'domains'], (v) => {
  $('#url').value = v.url || 'https://cloud-chrome-assist.vercel.app';
  $('#key').value = v.key || '';
  $('#domains').value = v.domains || '';
});

function saveSettings() {
  const data = { url: $('#url').value.trim().replace(/\/+$/, ''), key: $('#key').value.trim(), domains: $('#domains').value.trim() };
  chrome.storage.local.set(data);
  return data;
}

$('#save').onclick = () => { saveSettings(); out('설정을 저장했습니다.'); };

// 지금 보고 있는 탭의 사이트만 쿠키 보내기 칸에 채워 준다
$('#tab').onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return out('현재 탭 주소를 읽을 수 없습니다.');
    const host = new URL(tab.url).hostname.replace(/^www\./, '');
    const base = host.split('.').slice(-2).join('.'); // naver.com, daum.net ...
    $('#domains').value = base;
    saveSettings();
    out('"' + base + '" 만 보내도록 설정했습니다. [로그인 보내기]를 누르세요.');
  } catch (e) { out('오류: ' + e.message); }
};

$('#send').onclick = async () => {
  const cfg = saveSettings();
  if (!cfg.url || !cfg.key) return out('주소와 연결 키를 먼저 입력하세요.');

  out('PC 크롬에서 로그인(쿠키)을 읽는 중...');
  let cookies;
  try { cookies = await chrome.cookies.getAll({}); }
  catch (e) { return out('쿠키를 읽지 못했습니다: ' + e.message); }

  const filters = cfg.domains.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (filters.length) {
    cookies = cookies.filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
      return filters.some((f) => d === f || d.endsWith('.' + f));
    });
  }
  if (!cookies.length) return out('보낼 쿠키가 없습니다. (사이트 이름을 확인하거나 비워 두세요)');

  out('쿠키 ' + cookies.length + '개를 클라우드 크롬으로 보내는 중...');
  try {
    const r = await fetch(cfg.url + '/api/cookies', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + cfg.key },
      body: JSON.stringify({ cookies }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) out('✅ ' + (j.text || '완료했습니다.'));
    else if (j.state) out('⏳ ' + (j.note || '클라우드 크롬을 켜는 중입니다. 잠시 뒤 다시 보내 주세요.'));
    else out('❌ ' + (j.error || ('실패 (HTTP ' + r.status + ')')));
  } catch (e) {
    out('❌ 보내기 실패: ' + e.message);
  }
};
