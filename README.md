# cloud-chrome-assist

폰의 Claude 앱에서 말만 하면, 클라우드에 있는 크롬을 Claude가 대신 조작합니다. PC는 필요 없습니다.
비밀번호·2단계 인증·캡처(CAPTCHA)는 Claude가 입력하지 않고, 사용자가 폰의 라이브 화면에서 직접 합니다.

## 구조

```
폰 Claude 앱 --MCP--> Vercel 함수(api/mcp.js) --> Vercel Sandbox(크롬, 로그인 저장)
폰 브라우저 ---------------------------------> 라이브 화면(/live) 에서 직접 로그인
```

## 설치 순서 (폰 기준)

1. 이 폴더를 GitHub 저장소 `cloud-chrome-assist`로 올립니다. (올리는 것은 본인이 직접)
2. vercel.com 에 로그인 → **Add New → Project** → 저장소 `cloud-chrome-assist` 선택 → **Import**.
3. 배포 전 **Environment Variables** 칸에 2개를 넣습니다. 값은 서로 다른 영문+숫자 32자 이상 아무 문자열입니다.
   - `ASSIST_KEY` : Claude가 접속할 때 쓰는 열쇠
   - `AGENT_TOKEN` : 크롬 서버와 Vercel이 주고받는 열쇠
4. **Deploy**를 누릅니다. 끝나면 주소(예: `https://cloud-chrome-assist-xxxx.vercel.app`)가 나옵니다.
5. 주소로 들어가 화면이 "401 / 로그인 필요" 모양이면 Vercel 프로젝트 **Settings → Deployment Protection**에서 보호를 끕니다.
6. Claude 앱 → 설정 → 커넥터 → **커스텀 커넥터 추가**
   - 주소: `https://<내 주소>/api/mcp?key=<ASSIST_KEY 값>`
7. 새 대화에서 "클라우드 크롬 상태 확인해줘"라고 말합니다.
   - 처음에는 크롬을 설치하느라 3~6분 걸립니다. "설치 중"이라고 나오면 잠시 뒤 다시 말하면 됩니다.

PC의 Claude Code에서 쓰려면:
`claude mcp add --transport http cloud-chrome "https://<내 주소>/api/mcp?key=<ASSIST_KEY 값>"`

## 사용 예

- "크롬으로 vercel.com 열어줘"
- 로그인이 필요하면 Claude가 라이브 화면 링크를 줍니다. 폰으로 열어 직접 로그인하고 "했어"라고 하면 이어서 진행합니다.
- 작업이 끝나면 Claude가 `browser_stop`으로 꺼서 무료 한도를 아낍니다.

## 무료(Hobby) 한도와 주의

- Sandbox 한 번 켜진 시간은 최대 45분입니다. 끄고 다시 켜도 로그인은 저장됩니다.
- 무료 한도는 CPU 5시간, 메모리 420GB-시간 / 월입니다. 넘으면 다음 달까지 새로 못 켭니다.
- `ASSIST_KEY`, 라이브 화면 링크는 비밀번호와 같습니다. 남에게 보이지 않게 하세요.
- 회사·금융 계정은 이 클라우드 크롬에 로그인하지 않는 것을 권합니다.

## 로컬에서 확인된 것 / 아직 확인 못한 것

확인됨: 크롬 제어 서버(열기, 클릭, 입력, 비밀번호 차단, 스크린샷, 라이브 화면 연결, 토큰 인증), MCP 응답.
미확인(실제 Vercel에서 처음 돌려봐야 함): Sandbox 생성·재개, 크롬 설치 스크립트(dnf 패키지), 공개 주소 연결, Claude 앱 커스텀 커넥터 연결.
