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
  if (request.method !== "POST") return reply({ error: "Invalid request." }, 405);
  try {
    const data = await request.json();
    if (data?.action === "status") {
      if (typeof data.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
        return reply({ error: "Check the reservation date." }, 400);
      }
      const query = new URLSearchParams({
        select: "status",
        reservation_date: "eq." + data.date,
        hours: "eq.13:00-14:00",
      });
      const rows = await rest("library_booking_results?" + query);
      return reply({ ok: true, status: rows[0]?.status ?? "unknown" });
    }
    if (data?.action !== "librarySettings") return reply({ error: "Invalid request." }, 400);
    const pin = Deno.env.get("LIBRARY_ADMIN_PIN");
    if (!pin || !/^\d{4}$/.test(pin)) return reply({ error: "The booking admin PIN has not been configured." }, 503);
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
        return reply({ error: "Check the username and password." }, 400);
      }
      secret = JSON.stringify({ username, password, reason: "영어 동호회 활동", participants: 20, consent: true });
    }
    const result = await rest("rpc/library_booking_admin", {
      p_pin_valid: difference === 0,
      p_operation: data.operation === "check" ? "read" : typeof data.operation === "string" ? data.operation : "",
      p_slot: Number.isInteger(data.slot) ? data.slot : null,
      p_secret: secret,
      p_enabled: data.enabled === true,
    });
    if (!result.ok) {
      const errors: Record<string, string> = {
        "PIN 입력 시도가 너무 많습니다. 5분 후 다시 시도하세요.": "Too many PIN attempts. Try again in five minutes.",
        "관리자 PIN을 확인하세요.": "Check your booking admin PIN.",
        "계정을 하나 이상 등록하세요.": "Register at least one booking account.",
      };
      return reply({ error: errors[result.error] || "The booking request could not be completed." }, 400);
    }
    if (data.operation === "check") {
      const date = typeof data.date === "string" ? data.date : "";
      const target = new Date(date + "T00:00:00Z");
      const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", dateStyle: "short" }).format(new Date());
      const lastDate = new Date(today + "T00:00:00Z");
      lastDate.setUTCDate(1);
      lastDate.setUTCMonth(lastDate.getUTCMonth() + 3);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || target.getUTCDay() !== 0 ||
          target.toISOString().slice(0, 10) !== date || date < today || target >= lastDate) {
        return reply({ error: "Choose a Sunday between today and the end of the next two months." }, 400);
      }
      if (!result.accounts.length) return reply({ error: "Register at least one booking account." }, 400);
      const token = Deno.env.get("LIBRARY_GITHUB_TOKEN");
      if (!token) return reply({ error: "Run the reservation check from the GitHub Actions link below the date." }, 503);
      const dispatch = await fetch("https://api.github.com/repos/jinho0217-coder/YTTM/actions/workflows/library-reservation.yml/dispatches", {
        method: "POST",
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main", inputs: { date } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!dispatch.ok) return reply({ error: "GitHub did not accept the reservation check." }, 502);
    }
    return reply({ ok: true, enabled: result.enabled, slots: result.accounts.map((account: { slot: number }) => account.slot) });
  } catch {
    return reply({ error: "The booking request could not be confirmed. Check GitHub Actions before retrying." }, 500);
  }
});
