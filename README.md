# YTTM Role Dashboard

Google Sheet의 `26_Roles`와 `26_Agenda` 탭을 읽어 역할 수행, 스피치 이력, 이번 주 아젠다를 보여주는 웹 대시보드입니다.

처음부터 같은 프로그램을 만드는 전체 과정은 [YTTM_BUILD_GUIDE_KO.md](YTTM_BUILD_GUIDE_KO.md)를 참고하세요.

## 실행

Node.js 18 이상이 설치된 환경에서 다음 명령을 실행합니다.

```powershell
npm start
```

## GitHub Pages

`main` 브랜치에 푸시하면 GitHub Actions가 사이트를 GitHub Pages에 배포합니다. 공개 사이트의 Refresh 버튼은 `26_Roles`와 `26_Agenda`를 읽기 전용으로 다시 불러옵니다.

그다음 브라우저에서 [http://127.0.0.1:4173](http://127.0.0.1:4173)을 엽니다.

## 데이터 갱신

- 최초 접속 시 Google Sheet을 읽습니다.
- 서버는 일반 요청을 60초 동안 캐시합니다.
- 화면의 `Refresh` 버튼은 캐시를 우회하고 즉시 다시 읽습니다.
- Google Sheet이 링크를 통한 읽기를 허용하는 동안 별도 API 키는 필요하지 않습니다.

## 집계 기준

- 한국 시간 기준 오늘보다 이전인 정규 모임을 완료 모임으로 계산합니다.
- `No Meeting` 표시는 집계에서 제외합니다.
- `Speaker 1–4`는 `Speaker`, `Evaluator 1–4`는 `Evaluator` 역할로 합산합니다.
- 스피치 상세는 같은 열의 Speaker, Project, Title, Time, Evaluator 값을 연결합니다.
- 이번 주는 오늘 이후 가장 가까운 모임 날짜로 선택합니다.
