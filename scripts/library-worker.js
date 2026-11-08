const { createRequire } = require("node:module");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { login, readHistory, selectSlots, submitPreparedReservation } = require("./library-browser");
const { planReservation } = require("./library-reservation-plan");
const { runReservation } = require("./library-run-state");

const BASE = "https://zyiosfhyjwkmfprhmdem.supabase.co";
const SHEET_ENDPOINT = "https://script.google.com/macros/s/AKfycbxD9aeHp1wtRfqhBk-8Yo9eG9-x_vEpWoeu2ztgLSAIRUMnn05qrkAOnkfpjsSTFn2u/exec";

async function rpc(name, body) {
  const key = process.env.LIBRARY_SUPABASE_SERVICE_KEY;
  if (!key) throw new Error("서버 인증 정보가 없습니다.");
  const response = await fetch(`${BASE}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("서버 요청 실패");
  return response.json();
}

async function recordSheet(date, hours, result) {
  const token = process.env.LIBRARY_WORKER_TOKEN;
  if (!token) throw new Error("시트 연결 설정이 없습니다.");
  const response = await fetch(SHEET_ENDPOINT, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ action: "recordLibraryReservation", token, date, hours, status: result.status }), signal: AbortSignal.timeout(15000) });
  if (!response.ok || !(await response.json()).ok) throw new Error("시트 기록 실패");
}

async function automaticBookingEnabled() {
  const response = await fetch(SHEET_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ action: "librarySchedule", token: process.env.LIBRARY_WORKER_TOKEN }),
    signal: AbortSignal.timeout(15000),
  });
  const settings = await response.json();
  if (!response.ok || !settings.ok) throw new Error("자동 예약 설정을 확인할 수 없습니다.");
  return settings.enabled === true;
}

async function main() {
  const scheduled = process.env.LIBRARY_SCHEDULED === "1";
  if (scheduled && !await automaticBookingEnabled()) {
    process.stdout.write("자동 예약 꺼짐\n");
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
  const dryRun = !scheduled && process.env.LIBRARY_LIVE !== "1";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("예약 날짜가 필요합니다.");
  if (!dryRun && (!process.env.LIBRARY_WORKER_TOKEN || !/^[a-f0-9]{64}$/.test(process.env.LIBRARY_APPROVED_TERMS_HASH || ""))) {
    throw new Error("실제 신청에는 승인한 이용 규정과 시트 연결 설정이 필요합니다.");
  }
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
  const sessions = new Map();
  let inspectionStage = "계정 조회";
  try {
    const monthStart = `${date.slice(0, 7)}-01`;
    const monthEnd = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const inspect = async () => {
      const history = [];
      const verifiedAccounts = [];
      for (const account of accounts) {
        const context = await browser.newContext({ locale: "ko-KR", timezoneId: "Asia/Seoul" });
        const page = await context.newPage();
        inspectionStage = "도서관 로그인";
        await login(page, account);
        inspectionStage = "예약 내역 조회";
        history.push(...await readHistory(page, account.id, monthStart, monthEnd));
        verifiedAccounts.push(account.id);
        sessions.set(account.id, { context, page, account });
      }
      const plan = planReservation({ date, startHour, duration, accounts, history, verifiedAccounts });
      if (plan.status !== "ready") return plan;
      inspectionStage = "시간대 조회";
      if (!await selectSlots(sessions.get(plan.accountId).page, date, startHour, duration)) return { status: "failed", reason: "요청 시간 예약 불가" };
      inspectionStage = "신청서 확인";
      const { page, account } = sessions.get(plan.accountId);
      await page.getByRole("button", { name: "다음", exact: true }).click();
      await page.waitForURL("**/community-room/apply-02");
      const body = await page.locator("body").innerText();
      if (!body.includes("커뮤니티룸 2") || !body.includes(date) || !body.includes(`${startHour}:00 ~ ${startHour + duration}:00`)) return { status: "unknown" };
      const participants = Number(account.participants);
      if (!account.reason?.trim() || !Number.isInteger(participants) || participants < 6) return { status: "unknown" };
      await page.getByRole("textbox", { name: "예약사유", exact: true }).fill(`${account.reason.trim()}\n참석 인원: ${participants}명`);
      const terms = body.slice(body.indexOf("1. 신청조건 확인"), body.lastIndexOf("예약사유")).replace(/\s+/g, " ").trim();
      if (!terms.startsWith("1. 신청조건 확인") || !terms.includes("책임") || !terms.includes("동의")) return { status: "unknown" };
      const termsHash = createHash("sha256").update(terms).digest("hex");
      if (dryRun) process.stdout.write(`이용 규정: ${terms}\n이용 규정 확인값: ${termsHash}\n`);
      else if (termsHash !== process.env.LIBRARY_APPROVED_TERMS_HASH) return { status: "unknown", reason: "이용 규정 변경 확인 필요" };
      return plan;
    };
    const submit = async accountId => {
      if (scheduled && !await automaticBookingEnabled()) return { status: "unknown" };
      const { page } = sessions.get(accountId);
      inspectionStage = "예약 제출";
      await page.getByRole("radio", { name: "동의", exact: true }).check();
      const receipt = await submitPreparedReservation(page);
      if (receipt.status !== "submitted") return { status: "unknown" };
      inspectionStage = "제출 결과 확인";
      const history = await readHistory(page, accountId, monthStart, monthEnd);
      const verified = planReservation({ date, startHour, duration, accounts: [{ id: accountId, enabled: true, consent: true }], history, verifiedAccounts: [accountId] });
      return { status: verified.status === "success" ? "success" : "unknown" };
    };
    let claimed = false;
    const result = await runReservation({ dryRun, inspect, submit, claim: async () => { claimed = await rpc("library_claim_run", { p_date: date }); return claimed; }, finish: async value => { if (claimed) await rpc("library_finish_run", { p_date: date, p_state: value.status }); await recordSheet(date, hours, value); } });
    process.stdout.write(`예약 상태: ${result.status}\n`);
    if (result.status === "unknown") process.stdout.write(`확인 필요 단계: ${inspectionStage}\n`);
  } finally {
    await browser.close();
  }
}

const requiredSettings = ["LIBRARY_SUPABASE_SERVICE_KEY"];
if (process.env.LIBRARY_LIVE === "1" || process.env.LIBRARY_SCHEDULED === "1") {
  requiredSettings.push("LIBRARY_WORKER_TOKEN", "LIBRARY_APPROVED_TERMS_HASH");
}
const missingSettings = requiredSettings.filter(name => !process.env[name]?.trim());
if (missingSettings.length) {
  process.stderr.write(`필수 설정 누락: ${missingSettings.join(", ")}\n`);
  process.exitCode = 1;
} else {
  main().catch(() => {
    process.stderr.write("예약 실행 확인이 필요합니다.\n");
    process.exitCode = 1;
  });
}
