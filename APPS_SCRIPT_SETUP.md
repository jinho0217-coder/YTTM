# YTTM Google Sheets write service

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

- `public/app.js`를 배포하면 저장 확인 직후 화면에 반영합니다. 저장 창을 닫기 위해 전체 시트와 초안을 다시 불러오지 않습니다. 기존 Apps Script 배포와도 호환됩니다.
- 서버 최적화까지 반영하려면 `apps-script/Code.gs`를 Apps Script에 복사하고 **Deploy → Manage deployments → Edit → New version → Deploy**로 기존 웹 앱을 업데이트하세요. 기존 `/exec` URL은 유지합니다.
- 새 서버는 시트 데이터를 한 번 읽어 변경 항목을 검증하고, 저장된 전체 초안과 필드 버전을 응답합니다. 동시 수정 및 시트 변경 충돌 검증은 유지됩니다.
- 저장 후 20초 및 시트 충돌 후 1분의 재편집 대기를 제거했습니다. 최신 내용을 확인한 후 바로 다시 편집할 수 있습니다. 기존에 저장된 대기 정보도 무시합니다. 이 변경은 웹사이트와 Apps Script 양쪽을 모두 배포해야 완전히 반영됩니다.
- 로컬 검증은 `node --test`로 실행합니다. 실제 저장 시간은 Google Apps Script 응답 시간과 네트워크 상태에 따라 달라집니다.

The service accepts the immediately previous regular meeting plus every meeting date from the current Korean-time cutoff onward. It only updates allowlisted rows in `26_Roles`; older past meetings, dates, meeting numbers, other sheets, structure, and formulas are not writable through this endpoint. The allowlist includes the `Special Event` row.
