# Multiplay Tier Maker

TierMaker 링크를 가져와 여러 사람이 같은 방에서 실시간으로 이미지를 옮길 수 있는 MVP입니다.

## 실행

```powershell
npm install
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다.

## 템플릿 찾기

첫 화면의 `템플릿 찾기`에서 검색어를 입력합니다.

검색 결과에서 `바로 방 만들기`를 누르면 해당 TierMaker 템플릿으로 방 생성을 시도합니다. `미리보기`로 이미지와 티어 줄을 먼저 확인할 수도 있고, 원본 페이지 확인이 필요하면 `원본 열기`를 사용합니다.

## Windows 런처

빌드된 실행 파일은 `dist\MultiplayTierMaker.exe`에 생성됩니다.

실행하면 로컬 웹서버를 켜고 브라우저를 자동으로 엽니다. PC 밖 친구와 바로 테스트하려면 `cloudflared`가 PATH에 있어야 하며, 있으면 무료 Cloudflare Tunnel 주소도 같이 생성됩니다.

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
- 검색어로 TierMaker 템플릿 찾기
- `tiermaker.com/create/...` 링크로 방 생성
- 앱 안에서 TierMaker 템플릿 검색 후 선택 가져오기
- 선택한 템플릿 미리보기와 원본 사이트 열기
- Socket.IO 기반 실시간 이미지 이동 동기화
- 참가자별 색상 커서 표시
- 방별 참가자 표시
- 이미지 파일을 360x360 썸네일로 줄여 추가
- 티어 줄 추가
- 이미지 클릭 시 참가자 색상 하이라이트 표시
- 다른 곳을 클릭하면 이미지 하이라이트 해제
- 이미지 더블클릭 확대 보기
- 현재 티어 보드를 PNG 이미지로 저장
- 초대 링크 복사, 보드 초기화, 방 삭제

TierMaker가 서버 요청을 Cloudflare로 막는 경우가 있어, importer는 직접 HTML 요청 후 Jina Reader 마크다운 경유 파싱을 시도합니다.
