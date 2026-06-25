# Multiplay Tier Maker

TierMaker 템플릿과 PIKU 이상형월드컵을 가져와 여러 사람이 같은 방에서 실시간으로 플레이할 수 있는 웹 앱입니다.

## 실행

```powershell
npm install
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다.

## 템플릿 찾기

첫 화면에서 게임 종류를 고른 뒤 검색어나 원본 링크로 방을 만듭니다.

- `티어메이커`: TierMaker 검색 결과나 `tiermaker.com/create/...` 링크를 가져옵니다.
- `이상형월드컵`: PIKU 검색 결과나 `piku.co.kr/w/...` 링크를 가져옵니다.

검색 결과에서 `바로 방 만들기`를 누르면 해당 템플릿으로 방 생성을 시도합니다. 월드컵은 원본에서 가능한 N강 옵션을 읽어오며, 16강/32강/64강/128강/256강/512강처럼 템플릿이 지원하는 규모를 선택할 수 있습니다.

## Windows 런처

빌드된 실행 파일은 `dist\MultiplayTierMaker.exe`에 생성됩니다.

실행하면 로컬 웹서버를 켜고 브라우저를 자동으로 엽니다. PC 밖 친구와 바로 테스트하려면 `cloudflared`가 PATH에 있어야 하며, 있으면 무료 Cloudflare Tunnel 주소도 같이 생성됩니다. 초대 링크는 가능한 경우 이 공개 주소를 사용합니다.

```powershell
npm run build:launcher
```

주의: 이 런처는 앱 서버를 쉽게 켜는 용도이며 Node.js는 PC에 설치되어 있어야 합니다.

## 무료 공개 배포

여러 사람이 각자 다른 장소에서 접속하려면 공개 URL이 필요합니다. 이 앱은 Socket.IO WebSocket 서버가 필요하므로 정적 호스팅이 아니라 Node 웹 서비스로 배포해야 합니다.

### Render 추천 경로

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New > Web Service`를 선택합니다.
3. 저장소를 연결합니다.
4. 설정은 다음처럼 둡니다.
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: `Free`
5. 배포가 끝나면 `https://...onrender.com` 주소를 친구들에게 공유합니다.

저장소 루트의 `render.yaml`도 같은 설정을 담고 있어서 Blueprint 방식으로도 배포할 수 있습니다.

### 무료 배포의 한계

- 현재 방 상태는 서버 메모리에 저장됩니다.
- 무료 서버가 잠들거나 재시작되면 열려 있던 방은 사라집니다.
- 사람이 늘거나 방을 오래 보존하려면 Redis/Postgres 같은 저장소를 붙이는 단계가 필요합니다.

### 임시 테스트 공유

내 PC를 켜둔 채로 빠르게 친구와 테스트하려면 Cloudflare Tunnel을 사용할 수 있습니다.

```powershell
npm start
npm run tunnel
```

터널 출력에 나오는 `https://...trycloudflare.com` 주소로 접속하면 다른 인터넷에서도 같이 플레이할 수 있습니다. 이 방식은 배포라기보다 개발용 공개 링크에 가깝고, PC나 터널이 꺼지면 링크도 끊깁니다.

## 주요 기능

- 닉네임 저장 후 방 입장
- 현재 열린 방 목록
- 게임 종류 선택: 티어메이커 / 이상형월드컵
- 검색어로 TierMaker 템플릿 또는 PIKU 월드컵 찾기
- `tiermaker.com/create/...` 링크로 방 생성
- `piku.co.kr/w/...` 링크로 월드컵 방 생성
- 앱 안에서 TierMaker 템플릿 검색 후 선택 가져오기
- 선택한 템플릿 미리보기와 원본 사이트 열기
- Socket.IO 기반 실시간 이미지 이동 동기화
- 참가자별 색상 커서 표시
- 방별 참가자 표시
- 이미지 파일을 360x360 썸네일로 줄여 추가
- 티어 줄 추가
- 티어 순서 드래그 변경
- 방장 권한으로 방 삭제, 초기화, 티어 수정
- 이미지 클릭 시 참가자 색상 하이라이트 표시
- 다른 참가자가 잡고 있는 이미지는 잠금 처리
- 다른 곳을 클릭하면 이미지 하이라이트 해제
- 이미지 더블클릭 확대 보기
- 현재 티어 보드를 PNG 이미지로 저장
- 초대 링크 복사, 보드 초기화, 방 삭제
- 월드컵 투표 진행, 동률 시 랜덤 선택 모션
- 방 생성이 오래 걸릴 때 진행률 표시
- 모바일 보드 줌 조절
- 모바일 월드컵 화면에서 후보 2개를 좌우 배치로 표시

TierMaker가 서버 요청을 Cloudflare로 막는 경우가 있어, importer는 직접 HTML 요청 후 Jina Reader 마크다운 경유 파싱을 시도합니다. PIKU 월드컵은 랭킹 데이터와 원본 시작 페이지에서 후보, 이미지, N강 옵션을 가져옵니다.

## 테스트

로컬 서버를 켠 뒤 스모크 테스트를 실행할 수 있습니다.

```powershell
npm run check
npm run smoke:templates
npm run smoke:worldcup
```

`smoke:templates`는 여러 TierMaker 링크의 이미지 로딩을 확인하고, `smoke:worldcup`은 PIKU 검색/미리보기/16강/512강 생성/이미지 프록시/투표 ACK를 확인합니다.
