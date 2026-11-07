const REQUIRED_STATUSES = new Set(["approved", "pending", "cancelled", "rejected"]);

function planReservation({ date, startHour, duration, accounts, history, verifiedAccounts }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(startHour) || !Number.isInteger(duration) || duration < 1 || duration > 4 || startHour < 10 || startHour + duration > 18) throw new Error("예약 날짜 또는 시간을 확인해주세요.");
  if (!Array.isArray(accounts) || !accounts.length || !Array.isArray(history)) throw new Error("계정과 예약 내역을 확인해주세요.");
  if (!Array.isArray(verifiedAccounts) || accounts.some(account => account.enabled && !verifiedAccounts.includes(account.id))) return { status: "unknown", reason: "모든 계정의 예약 내역 확인 필요" };
  const target = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(target.valueOf()) || target.toISOString().slice(0, 10) !== date || target.getUTCDay() !== 0) throw new Error("예약 날짜는 일요일이어야 합니다.");
  if (history.some(item => !REQUIRED_STATUSES.has(item.status) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !Number.isInteger(item.startHour) || !Number.isInteger(item.endHour) || item.endHour <= item.startHour || !item.accountId)) return { status: "unknown", reason: "예약 내역 확인 필요" };
  const active = history.filter(item => item.status === "approved" || item.status === "pending");
  const overlap = active.filter(item => item.date === date && item.startHour < startHour + duration && startHour < item.endHour);
  const approvedHours = new Set();
  for (const item of overlap.filter(item => item.status === "approved")) {
    for (let hour = Math.max(item.startHour, startHour); hour < Math.min(item.endHour, startHour + duration); hour += 1) approvedHours.add(hour);
  }
  if (approvedHours.size === duration) return { status: "success", reason: "기존 승인 내역 확인" };
  if (overlap.length) return { status: "unknown", reason: "기존 예약과 겹칩니다." };
  for (const account of accounts) {
    if (!account.enabled || !account.consent) continue;
    const monthlyHours = active.filter(item => item.accountId === account.id && item.date.slice(0, 7) === date.slice(0, 7)).reduce((total, item) => total + item.endHour - item.startHour, 0);
    if (monthlyHours + duration <= 4) return { status: "ready", accountId: account.id };
  }
  return { status: "failed", reason: "이용 가능한 계정이 없습니다." };
}

module.exports = { planReservation };
