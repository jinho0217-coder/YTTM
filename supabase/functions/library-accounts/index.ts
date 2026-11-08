const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { headers, status });
}

async function rest(path: string, body?: unknown) {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const response = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Database request failed");
  return response.json();
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { headers });
  if (request.method !== "POST") return reply({ error: "잘못된 요청입니다." }, 405);
  try {
    const data = await request.json();
    if (data?.action === "status") {
      if (typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
        return reply({ error: "예약 날짜를 확인하세요." }, 400);
      }
      const query = new URLSearchParams({
        select: "status",
        reservation_date: "eq." + data.date,
        hours: "eq.13:00-14:00",
      });
      const rows = await rest("library_booking_results?" + query);
      return reply({ ok: true, status: rows[0]?.status ?? "unknown" });
    }
    if (data?.action !== "librarySettings") return reply({ error: "잘못된 요청입니다." }, 400);
    const pin = Deno.env.get("LIBRARY_ADMIN_PIN");
    if (!pin || !/^\d{4}$/.test(pin)) return reply({ error: "예약 관리자 PIN 설정이 필요합니다." }, 503);
    const supplied = typeof data.accessKey === "string" ? data.accessKey : "";
    let difference = supplied.length ^ pin.length;
    for (let index = 0; index < pin.length; index++) {
      difference |= pin.charCodeAt(index) ^ (supplied.charCodeAt(index) || 0);
    }
    let secret = null;
    if (difference === 0 && data.operation === "save") {
      const username = typeof data.username === "string" ? data.username.trim() : "";
      const password = typeof data.password === "string" ? data.password : "";
      if (!username || username.length > 200 || !password || password.length > 500) {
        return reply({ error: "아이디와 비밀번호를 확인하세요." }, 400);
      }
      secret = JSON.stringify({ username, password, reason: "영어 동호회 활동", participants: 20, consent: true });
    }
    const result = await rest("rpc/library_booking_admin", {
      p_pin_valid: difference === 0,
      p_operation: typeof data.operation === "string" ? data.operation : "",
      p_slot: Number.isInteger(data.slot) ? data.slot : null,
      p_secret: secret,
      p_enabled: data.enabled === true,
    });
    if (!result.ok) return reply({ error: result.error }, 400);
    return reply({ ok: true, enabled: result.enabled, slots: result.accounts.map((account: { slot: number }) => account.slot) });
  } catch {
    return reply({ error: "예약 설정을 처리하지 못했습니다." }, 500);
  }
});
