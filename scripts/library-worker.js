const { createRequire } = require("node:module");
const path = require("node:path");
const { login, readHistory } = require("./library-browser");

const BASE = "https://zyiosfhyjwkmfprhmdem.supabase.co";

async function rest(path, body, prefer) {
  const key = process.env.LIBRARY_SUPABASE_SERVICE_KEY;
  if (!key) throw new Error("서버 인증 정보가 없습니다.");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${BASE}/rest/v1/${path}`, { method: body === undefined ? "GET" : "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("서버 요청 실패");
  const payload = await response.text();
  return payload ? JSON.parse(payload) : null;
}

function rpc(name, body) {
  return rest("rpc/" + name, body);
}

async function automaticCheckEnabled() {
  const [settings] = await rest("library_booking_settings?select=enabled&id=eq.true");
  return settings?.enabled === true;
}

async function main() {
  const scheduled = process.env.LIBRARY_SCHEDULED === "1";
  if (scheduled && !await automaticCheckEnabled()) {
    process.stdout.write("자동 예약 확인 꺼짐\n");
    return;
  }
  let date = process.env.LIBRARY_TARGET_DATE;
  if (scheduled) {
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", dateStyle: "short" }).format(new Date());
    const sunday = new Date(today + "T00:00:00Z");
    sunday.setUTCDate(sunday.getUTCDate() + (7 - sunday.getUTCDay()) % 7);
    date = sunday.toISOString().slice(0, 10);
  }
  const startHour = Number(process.env.LIBRARY_START_HOUR || 13);
  const duration = Number(process.env.LIBRARY_DURATION || 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("예약 날짜가 필요합니다.");
  const hours = `${String(startHour).padStart(2, "0")}:00-${String(startHour + duration).padStart(2, "0")}:00`;
  const accounts = [];
  for (let slot = 1; slot <= 3; slot += 1) {
    const secret = await rpc("library_account_for_worker", { p_slot: slot });
    if (secret) accounts.push({ id: slot, enabled: true, ...JSON.parse(secret) });
  }
  if (!accounts.length) throw new Error("등록된 계정이 없습니다.");
  let playwright;
  try { playwright = require("playwright"); }
  catch { playwright = createRequire(path.join(path.dirname(process.execPath), "..", "node_modules", "placeholder.js"))("playwright"); }
  const browser = await playwright.chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "msedge" } : {}) });
  let inspectionStage = "계정 조회";
  try {
    const monthStart = `${date.slice(0, 7)}-01`;
    const monthEnd = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const history = [];
    let status = "unknown";
    try {
      for (const account of accounts) {
        const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
        try {
          const page = await context.newPage();
          inspectionStage = "도서관 로그인";
          await login(page, account);
          history.push(...await readHistory(page, account.id, monthStart, monthEnd, stage => { inspectionStage = stage; }));
        } finally {
          await context.close();
        }
      }
      const approved = history.filter(item => item.date === date && item.status === "approved");
      const covered = Array.from({ length: duration }, (_, index) => startHour + index)
        .every(hour => approved.some(item => item.startHour <= hour && item.endHour > hour));
      const pending = history.some(item => item.date === date && item.status === "pending" &&
        item.startHour < startHour + duration && item.endHour > startHour);
      status = covered ? "success" : pending ? "unknown" : "failed";
      if (pending && !covered) process.stdout.write("예약 내역에 승인 대기 신청이 있습니다.\n");
    } catch {
      process.stdout.write(`확인 필요 단계: ${inspectionStage}\n`);
    }
    await rest("library_booking_results?on_conflict=reservation_date,hours", {
      reservation_date: date, hours, status,
    }, "resolution=merge-duplicates");
    process.stdout.write(`예약 상태: ${status}\n`);
  } finally {
    await browser.close();
  }
}

if (!process.env.LIBRARY_SUPABASE_SERVICE_KEY?.trim()) {
  process.stderr.write("필수 설정 누락: LIBRARY_SUPABASE_SERVICE_KEY\n");
  process.exitCode = 1;
} else {
  main().catch(() => {
    process.stderr.write("예약 실행 확인이 필요합니다.\n");
    process.exitCode = 1;
  });
}
