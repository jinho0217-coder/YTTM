const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const SHEET_ID = "1arhgy3QSwHxyM9gBy6nXdw76N-94R53kf0ogV4Nq2lA";
const CACHE_MS = 60_000;
const GOOGLE_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=1852116681`;

let cache = null;
let cacheAt = 0;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function fetchCsv(query) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${query}&tqx=out%3Acsv&_=${Date.now()}`;
  const response = await fetch(url, {
    headers: { "user-agent": "YTTM-Role-Dashboard/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Google Sheets returned ${response.status}`);
  return response.text();
}

async function getSheets(force = false) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_MS) return cache;
  const [rolesCsv, agendaCsv] = await Promise.all([
    fetchCsv("gid=1852116681"),
    fetchCsv("sheet=26_Agenda"),
  ]);
  cacheAt = now;
  cache = {
    rolesCsv,
    agendaCsv,
    fetchedAt: new Date(now).toISOString(),
    cacheSeconds: CACHE_MS / 1000,
    source: GOOGLE_SHEET_URL,
  };
  return cache;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      return res.end(error.code === "ENOENT" ? "Not found" : "Server error");
    }
    res.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    return res.end("Method not allowed");
  }
  if (req.url.startsWith("/api/sheets")) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const data = await getSheets(requestUrl.searchParams.has("refresh"));
      return sendJson(res, 200, data);
    } catch (error) {
      return sendJson(res, 502, {
        error: "Google Sheet을 불러오지 못했습니다.",
        detail: error.message,
      });
    }
  }
  return serveStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`YTTM dashboard: http://127.0.0.1:${PORT}`);
});
