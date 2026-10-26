# YTTM Google Sheets write service

## 예정 배정 및 참석자 명단 (2026-10-26)

- 웹사이트 배포 시 `public/meeting-people.js`도 `app.js`, `index.html`, `styles.css`와 함께 포함합니다.
- 예정 배정은 역할 셀의 이름 앞에 `◷ `를 저장합니다. 확정하면 접두사가 제거됩니다. 사이트는 이름 검색 시 이를 제외하고, 준비율과 완료 역할 집계에서 예정 배정을 제외합니다.
- 직접 이름을 입력·수정하거나 Clear를 누르면 해당 필드의 예정 토글을 끕니다. 수동 입력의 기본값은 확정이며, 입력 후 ◷ 버튼을 명시적으로 켜야 예정으로 저장합니다. 편집 창을 열기만 하거나 다른 필드를 수정하는 경우 기존 예정 배정은 유지합니다. 이 동작은 일반 역할과 연사·평가자에 공통 적용합니다.
- 참석자와 게스트 표시는 모임 날짜별 `Attendees` 행의 JSON으로 저장합니다. 역할 담당자는 자동으로 명단에 합쳐 표시됩니다. 수동 추가 명단은 기존 공용 초안·충돌 검증·관리자 승인 흐름을 따릅니다.
- 참석자 명단과 상단 인원수에는 확정 역할 담당자와 역할 없이 직접 추가한 사람을 포함합니다. 예정 역할만 있는 사람은 별도 참석자 기록이 있어도 제외하며, 이름을 다시 추가하는 방식으로도 이 규칙을 우회할 수 없습니다. 확정 역할이 하나라도 있으면 포함하고 예정 역할 표시는 제외합니다. 역할 추천의 중복 배정 검사에서는 예정 역할도 계속 예약된 것으로 취급합니다.
- **참석자 저장 기능을 사용하려면 Apps Script의 `Code.gs`도 새 버전으로 배포해야 합니다.** 관리자 승인으로 참석자 명단을 처음 반영할 때만 `26_Roles` 맨 아래에 `Attendees` 행을 자동 추가합니다. 기존 `/exec` URL은 유지합니다.
- 로컬 브라우저 검증: `node scripts/verify-instant-save.js`, [미리보기](http://127.0.0.1:4186). 이 환경의 저장은 메모리에서만 처리하며 Google Sheets를 변경하지 않습니다.
- `Role assignments`의 ✦ 버튼은 직전 모임 참석 기록에서 후보를 고릅니다. 역할별 최초 수행을 우선하고 한 사람당 한 역할씩 추천하며, 이미 입력된 배정과 게스트는 제외합니다. 추천은 이력 기반 매칭으로 계산하며 선택한 후보만 예정 배정으로 저장합니다. 연사가 있는 스피치의 빈 Evaluator 1–4도 포함하며, 연사는 준비 여부를 추정해 자동 배정하지 않습니다.
- 모임 날짜가 되면 한국 시간 00:00부터 예정 배정을 확정으로 표시합니다. 열린 페이지는 날짜 변경을 10초마다 확인합니다. 서버는 사이트 조회 시 날짜가 지난 시트의 예정 접두사를 제거하고, 미승인 배정은 이름을 시트에 쓰지 않고 공용 초안에서만 확정합니다. 외부 시트 변경의 재검사는 최대 5분 간격이며, 모임이 없는 날짜와 역할 외 필드 및 수식 셀은 자동 수정하지 않습니다. 당일 새로 입력한 역할도 확정으로 저장합니다. 서버 자동 변경은 잠금·필드 버전·감사 기록을 사용하며, 나머지 시트 변경은 관리자 승인을 유지합니다.

The public dashboard uses this service for shared drafts and live sheet reads. It remains read-only until the service is deployed.

1. Open the target Google Sheet and choose **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps-script/Code.gs` from this repository.
3. In **Project Settings**, enable the manifest file and replace it with `apps-script/appsscript.json`.
4. Choose **Deploy → New deployment → Web app**.
5. Set **Execute as** to **Me** and select the required public access level.
6. Authorize the spreadsheet permission and copy the deployed URL ending in `/exec`.
7. Paste that URL into `public/config.js` as `writeEndpoint`.
8. Commit and deploy the updated `public/config.js`.

The dashboard calls the same `/exec` URL with `action=getSheets` to read the live `26_Roles` and `26_Agenda` values directly from Apps Script. After changing `Code.gs`, create a new web-app deployment version so this read endpoint is available; otherwise the dashboard falls back to Google's cached Visualization CSV feed.

## 저장 지연 개선 반영

- `public/app.js`, `public/draft-sync.js`, `public/index.html`, `public/styles.css`를 함께 배포합니다. 저장 버튼을 누르면 화면과 편집 창을 즉시 갱신하고 서버 저장은 백그라운드에서 순서대로 처리합니다.
- 서버 확인 전 변경사항은 브라우저 저장소에 보관하고 새로고침 후 복구합니다. 동기화 중 표시와 실패 시 재시도/명시적 삭제 기능을 제공하며, 미확인 변경사항이 있으면 관리자 시트 적용을 잠시 비활성화합니다.
- 연속 재수정은 필드 버전을 순서대로 증가시킵니다. 충돌한 입력은 기기에 남겨두고, 사용자가 검토 및 재전송을 명시적으로 선택해야 최신 버전으로 다시 제출합니다.
- 서버 최적화까지 반영하려면 `apps-script/Code.gs`를 Apps Script에 복사하고 **Deploy → Manage deployments → Edit → New version → Deploy**로 기존 웹 앱을 업데이트하세요. 기존 `/exec` URL은 유지합니다.
- 새 서버는 시트 데이터를 한 번 읽어 변경 항목을 검증하고, 저장된 전체 초안과 필드 버전을 응답합니다. 동시 수정 및 시트 변경 충돌 검증은 유지됩니다.
- 재시도와 새로고침은 동일한 요청 ID를 사용합니다. 서버는 잠금 안에서 최근 완료된 요청의 결과를 확인해 중복 저장을 방지합니다.
- 저장 후 20초 및 시트 충돌 후 1분의 재편집 대기를 제거했습니다. 최신 내용을 확인한 후 바로 다시 편집할 수 있습니다. 기존에 저장된 대기 정보도 무시합니다. 이 변경은 웹사이트와 Apps Script 양쪽을 모두 배포해야 완전히 반영됩니다.
- 로컬 검증은 `node --test`로 실행합니다. 실제 저장 시간은 Google Apps Script 응답 시간과 네트워크 상태에 따라 달라집니다.

The service accepts the immediately previous regular meeting plus every meeting date from the current Korean-time cutoff onward. It only updates allowlisted rows in `26_Roles`; older past meetings, dates, meeting numbers, other sheets, structure, and formulas are not writable through this endpoint. The allowlist includes the `Special Event` row.
