const TERMINAL_STATES = new Set(["success", "failed", "unknown"]);

async function runReservation({ claim, inspect, submit, finish, dryRun = true }) {
  let inspection;
  try {
    inspection = await inspect();
  } catch {
    inspection = { status: "unknown", reason: "예약 내역 확인 실패" };
  }
  if (!inspection || inspection.status !== "ready") {
    const result = inspection && TERMINAL_STATES.has(inspection.status) ? inspection : { status: "unknown", reason: "예약 내역 확인 필요" };
    if (!dryRun) await finish(result);
    return result;
  }
  if (dryRun) return { status: "dry_run", accountId: inspection.accountId };
  if (!await claim()) return { status: "unknown", reason: "이미 실행되었거나 확인이 필요합니다." };
  let result;
  try {
    result = await submit(inspection.accountId);
    if (!result || !TERMINAL_STATES.has(result.status)) result = { status: "unknown" };
  } catch {
    result = { status: "unknown", reason: "신청 결과 확인 필요" };
  }
  await finish(result);
  return result;
}

module.exports = { runReservation };
