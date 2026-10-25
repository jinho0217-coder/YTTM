// Local-only browser verification. All writes stay in memory; Google is never
// contacted. Run: node scripts/verify-instant-save.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const publicDir = path.join(__dirname, "../public");
const payload = JSON.parse(fs.readFileSync(path.join(publicDir, "data/sheets.json"), "utf8"));
const port = 4186;
const drafts = { revision: 0, meetings: {}, fieldVersions: {} };
const results = new Map();
function send(res, value, callback) {
  res.writeHead(200, { "content-type": callback ? "application/javascript" : "application/json", "cache-control": "no-store" });
  res.end(callback ? `${callback}(${JSON.stringify(value)});` : JSON.stringify(value));
}
http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/config.js") {
    res.writeHead(200, { "content-type": "application/javascript" });
    return res.end(`window.YTTM_CONFIG = { writeEndpoint: "http://127.0.0.1:${port}/fake" };`);
  }
  if (url.pathname === "/api/sheets") return send(res, payload);
  if (url.pathname === "/fake") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const operation = JSON.parse(body);
        console.log(`Received save ${operation.requestId}; confirmation delayed 8 seconds.`);
        setTimeout(() => {
          if (!results.has(operation.requestId)) {
            drafts.meetings[operation.meetingDate] ||= {};
            drafts.meetings[operation.meetingDate][operation.section] ||= {};
            Object.assign(drafts.meetings[operation.meetingDate][operation.section], operation.updates);
            Object.keys(operation.updates).forEach(label => {
              const key = `${operation.meetingDate}|${operation.section}|${label}`;
              drafts.fieldVersions[key] = Number(drafts.fieldVersions[key] || 0) + 1;
            });
            drafts.revision++;
            results.set(operation.requestId, JSON.parse(JSON.stringify({ ok: true, updated: Object.keys(operation.updates).length, drafts, fieldVersions: drafts.fieldVersions })));
          }
          console.log(`Confirmed save ${operation.requestId}.`);
          send(res, results.get(operation.requestId));
        }, 8000);
      });
      return;
    }
    const action = url.searchParams.get("action");
    const result = action === "status" ? (results.get(url.searchParams.get("requestId")) || { pending: true })
      : action === "getSheets" ? { ok: true, ...payload } : { ok: true, drafts };
    return send(res, result, url.searchParams.get("callback"));
  }
  const target = path.resolve(publicDir, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  if (!target.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(target, (error, content) => {
    if (error) { res.writeHead(404); return res.end(); }
    const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg" }[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(content);
  });
}).listen(port, "127.0.0.1", () => console.log(`Mock verification server: http://127.0.0.1:${port} (8-second confirmations, memory-only writes)`));
