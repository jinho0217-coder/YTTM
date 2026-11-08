const BASE = "https://www.library.kr/ggl";

async function login(page, account) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "아이디", exact: true }).fill(account.username);
  await page.getByRole("textbox", { name: "비밀번호", exact: true }).fill(account.password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  try {
    await page.getByRole("button", { name: "로그아웃", exact: true }).waitFor({ timeout: 10000 });
  } catch {
    await page.goto(`${BASE}/mypage/facilityreserve-list`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "시설예약", exact: true }).waitFor({ timeout: 15000 });
    if (!new URL(page.url()).pathname.startsWith("/ggl/mypage/")) throw new Error("로그인 확인 필요");
  }
}

async function readHistory(page, accountId, start, end, reportStage = () => {}) {
  reportStage("예약 내역 페이지 열기");
  await page.goto(`${BASE}/mypage/facilityreserve-list`, { waitUntil: "domcontentloaded" });
  reportStage("예약 내역 날짜 입력");
  const dates = page.getByRole("textbox", { name: "Datepicker input", exact: true });
  await dates.nth(1).waitFor({ timeout: 15000 });
  if (await dates.count() !== 2) throw new Error("예약 내역 검색 화면 확인 필요");
  await dates.nth(0).fill(start);
  await dates.nth(0).press("Enter");
  await dates.nth(1).fill(end);
  await dates.nth(1).press("Enter");
  const countPattern = /^전체\s*\d+\s*건$/;
  const resultCount = page.getByText(countPattern);
  const previousCount = await resultCount.count() === 1
    ? await resultCount.elementHandle({ timeout: 3000 })
    : null;
  const previousText = await previousCount?.innerText();
  reportStage("예약 내역 검색 버튼 클릭");
  await page.getByRole("button", { name: "검색", exact: true }).click({ timeout: 15000 });
  reportStage("예약 내역 검색 결과 대기");
  if (previousCount) {
    await page.waitForFunction(({ node, text }) => !node.isConnected || node.innerText !== text,
      { node: previousCount, text: previousText }, { timeout: 15000 });
  }
  await resultCount.waitFor({ timeout: 15000 });
  reportStage("예약 내역 건수 확인");
  const text = await page.locator("body").innerText();
  const count = text.match(/전체\s*(\d+)\s*건/);
  if (!count) throw new Error("예약 내역 건수 확인 필요");
  const total = Number(count[1]);
  if (total === 0) return [];
  reportStage("예약 내역 목록 형식 확인");
  const chunks = text.split(/커뮤니티룸\s*2/).slice(1);
  if (chunks.length !== total) throw new Error("모든 예약 내역 확인 필요");
  return chunks.map(chunk => {
    reportStage("예약 내역 날짜·시간·상태 확인");
    const match = chunk.match(/(\d{4}-\d{2}-\d{2})[^\n]*?(\d{2}):00\s*[~～]\s*(\d{2}):00/);
    const status = chunk.match(/상태\s*(승인완료|신청완료|승인대기|예약취소|취소완료|반려)/);
    if (!match || !status) throw new Error("예약 내역 형식 확인 필요");
    const states = { 승인완료: "approved", 신청완료: "pending", 승인대기: "pending", 예약취소: "cancelled", 취소완료: "cancelled", 반려: "rejected" };
    return { accountId, date: match[1], startHour: Number(match[2]), endHour: Number(match[3]), status: states[status[1]] };
  });
}

module.exports = { login, readHistory };
