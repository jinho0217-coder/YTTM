# YTTM Google Sheets write service

The public dashboard remains read-only until this service is deployed.

1. Open the target Google Sheet and choose **Extensions → Apps Script**.
2. Replace `Code.gs` with `apps-script/Code.gs` from this repository.
3. In **Project Settings**, enable the manifest file and replace it with `apps-script/appsscript.json`.
4. Choose **Deploy → New deployment → Web app**.
5. Set **Execute as** to **Me** and select the required public access level.
6. Authorize the spreadsheet permission and copy the deployed URL ending in `/exec`.
7. Paste that URL into `public/config.js` as `writeEndpoint`.
8. Commit and deploy the updated `public/config.js`.

The service only accepts the first two scheduled meetings from the current Korean-time cutoff. It only updates allowlisted rows in `26_Roles`; past meetings, dates, meeting numbers, other sheets, structure, and formulas are not writable through this endpoint.
