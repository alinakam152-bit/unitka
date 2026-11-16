// Общие помощники робота.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Дата в часовом поясе Москвы (так считают WB и Ozon) — "YYYY-MM-DD".
export function day(d) {
  const t = d instanceof Date ? d : new Date(d);
  return new Date(t.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
}
export function daysAgo(n, from = new Date()) {
  return day(new Date(from.getTime() - n * 86400e3));
}
export function eachDay(fromStr, toStr) {
  const out = [];
  for (let t = Date.parse(fromStr + "T00:00:00Z"); t <= Date.parse(toStr + "T00:00:00Z"); t += 86400e3)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
export const num = (v) => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "0").replace(",", ".")); return isFinite(n) ? n : 0; };
export const r2 = (v) => Math.round(v * 100) / 100;

const MAX_WAIT_MS = 3 * 60 * 1000; // дольше 3 минут на один ответ не ждём
const fmtWait = (ms) => (ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1).replace(".", ",")} ч` : `${Math.round(ms / 60e3)} мин`);

// HTTP с повтором при 429/5xx. fetchImpl можно подменить (демо и тесты).
export function makeHttp(fetchImpl = globalThis.fetch, log = () => {}) {
  return async function http(url, { method = "GET", headers = {}, body, tries = 5, okEmpty = [] } = {}) {
    for (let i = 1; i <= tries; i++) {
      let res;
      try {
        res = await fetchImpl(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body == null ? undefined : JSON.stringify(body) });
      } catch (e) {
        if (i === tries) throw new Error(`Сеть: ${e.message}`);
        await sleep(5000 * i); continue;
      }
      if (okEmpty.includes(res.status)) return null;
      if (res.status === 429 || res.status >= 500) {
        if (i === tries) throw new Error(`HTTP ${res.status} ${url}`);
        const wait = Number(res.headers?.get?.("X-Ratelimit-Retry") || res.headers?.get?.("Retry-After") || 0) * 1000 || 20000 * i;
        // Площадка просит ждать слишком долго (бывает 6 часов) — не ждём, этот раздел пропускаем до следующего запуска
        if (wait > MAX_WAIT_MS) {
          const err = new Error(`площадка временно ограничила запросы (лимит), просит подождать ${fmtWait(wait)} — возьмём в следующий запуск`);
          err.status = 429; err.limit = true; throw err;
        }
        log(`  …${res.status}, жду ${Math.round(wait / 1000)} с`);
        await sleep(wait); continue;
      }
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${new URL(url).pathname}: ${text.slice(0, 200)}`);
        err.status = res.status; throw err;
      }
      return text ? JSON.parse(text) : null;
    }
  };
}

// Финансовые строки: сумма по (день, товар). Товар "*" — расходы магазина без артикула.
export const F = { date: 0, pid: 1, rev: 2, sold: 3, ret: 4, comm: 5, logi: 6, stor: 7, acc: 8, pen: 9, acq: 10, ads: 11, comp: 12, pay: 13 };
export const FIN_FIELDS = ["rev", "sold", "ret", "comm", "logi", "stor", "acc", "pen", "acq", "ads", "comp", "pay"];
export class Agg {
  constructor(width) { this.map = new Map(); this.width = width; }
  add(date, pid, values) {
    const k = date + "|" + pid;
    let row = this.map.get(k);
    if (!row) { row = [date, pid, ...new Array(this.width).fill(0)]; this.map.set(k, row); }
    for (const [i, v] of Object.entries(values)) row[Number(i)] += v || 0;
  }
  rows() {
    return [...this.map.values()].map((r) => r.map((v, i) => (i < 2 ? v : r2(v))))
      .filter((r) => r.slice(2).some((v) => v !== 0))
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
}
export const finAgg = () => new Agg(12);
// fin.add(date, pid, {[F.rev]: 100, ...})

// Срок действия токена WB (это JWT, в нём есть поле exp).
export function jwtExpires(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return p.exp ? new Date(p.exp * 1000).toISOString().slice(0, 10) : null;
  } catch { return null; }
}
