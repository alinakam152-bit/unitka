// Сбор данных одного магазина Ozon. Только чтение.
import { F, finAgg, Agg, num, daysAgo, eachDay } from "./lib.mjs";

const HOST = "https://api-seller.ozon.ru";

// Справочник начислений Ozon (/v1/finance/accrual/types) → наши статьи.
const T = {
  acq: [1],
  stor: [46, 58, 60, 78, 79],
  acc: [77, 131, 132],
  ads: [3, 4, 5, 19, 23, 33, 36, 41, 47, 48, 49, 50, 54, 55, 61, 70, 74, 75, 87, 96, 116, 119, 130],
  comp: [10, 25, 81, 104],
  pen: [8, 14, 15, 34, 89, 90, 91, 92, 93, 94],
  logi: [2, 6, 9, 12, 13, 16, 17, 21, 28, 29, 30, 32, 38, 39, 40, 42, 43, 44, 45, 53, 56, 59, 73, 84, 85, 97, 98, 99, 100, 101,
    102, 103, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 120, 121, 133, 134, 135, 136, 137, 138, 71]
};
const BUCKET = new Map();
for (const [k, ids] of Object.entries(T)) for (const id of ids) BUCKET.set(id, F[k]);
// Всё остальное (подписки, сервисы и т.п.) — в «штрафы и прочие удержания».
export const bucketOf = (typeId) => BUCKET.get(typeId) ?? F.pen;

export async function collectOzon(store, clientId, apiKey, { http, log, now = new Date(), finDays = 90, orderDays = 60 }) {
  const headers = { "Client-Id": clientId, "Api-Key": apiKey };
  const post = (path, body) => http(HOST + path, { method: "POST", headers, body });
  const pid = (sku) => `${store.id}:${sku}`;
  const warnings = [];
  const out = { products: [], stocks: null, orders: [], fin: [], ads: [], finTo: null, warnings, tokenExpires: null };

  // 1. Товары
  log("  товары");
  const ids = [];
  let lastId = "";
  for (let guard = 0; guard < 100; guard++) {
    const res = await post("/v3/product/list", { filter: { visibility: "ALL" }, last_id: lastId, limit: 1000 });
    const items = res?.result?.items || [];
    ids.push(...items.map((i) => i.product_id));
    lastId = res?.result?.last_id || "";
    if (!lastId || items.length < 1000) break;
  }
  const prod = new Map();      // sku → product
  const byProductId = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const res = await post("/v3/product/info/list", { product_id: ids.slice(i, i + 1000) });
    for (const it of res?.items || []) {
      const sku = it.sku || it.sources?.find((s) => s.sku)?.sku || it.fbo_sku || it.fbs_sku;
      if (!sku) continue;
      const p = { pid: pid(sku), store: store.id, mp: "ozon", sku: String(sku), offerId: it.offer_id || "", name: it.name || String(sku), category: "",
        photo: (Array.isArray(it.primary_image) ? it.primary_image[0] : it.primary_image) || it.images?.[0] || "", price: num(it.marketing_price || it.price) || null };
      prod.set(String(sku), p); byProductId.set(it.id, p);
      for (const s of it.sources || []) if (s.sku) prod.set(String(s.sku), p);
    }
  }

  // 2. Остатки FBO / FBS
  try {
    log("  остатки");
    const stocks = {};
    let cursor = "";
    for (let guard = 0; guard < 100; guard++) {
      const res = await post("/v4/product/info/stocks", { filter: { visibility: "ALL" }, limit: 1000, cursor });
      for (const it of res?.items || []) {
        const p = byProductId.get(it.product_id);
        if (!p) continue;
        const s = (stocks[p.pid] ||= { fbo: 0, fbs: 0, toClient: 0, fromClient: 0 });
        for (const st of it.stocks || []) {
          if (st.type === "fbo") s.fbo += Math.max(0, num(st.present) - num(st.reserved));
          else if (st.type === "fbs" || st.type === "rfbs") s.fbs += Math.max(0, num(st.present) - num(st.reserved));
        }
      }
      cursor = res?.cursor || "";
      if (!cursor || (res?.items || []).length < 1000) break;
    }
    out.stocks = stocks;
  } catch (e) { warnings.push(`Остатки Ozon: ${e.message}`); }

  // 3. Заказы FBO и FBS
  log("  заказы");
  const ord = new Agg(4);
  const since = daysAgo(orderDays, now) + "T00:00:00.000Z", to = new Date(now).toISOString();
  const addPosting = (p) => {
    const d = String(p.in_process_at || p.created_at).slice(0, 10);
    const cancelled = p.status === "cancelled";
    for (const it of p.products || []) {
      const q = num(it.quantity), sum = num(it.price) * q;
      const sku = String(it.sku);
      ord.add(d, pid(sku), cancelled ? { 2: q, 3: sum, 4: q, 5: sum } : { 2: q, 3: sum });
      if (!prod.has(sku)) prod.set(sku, { pid: pid(sku), store: store.id, mp: "ozon", sku, offerId: it.offer_id || "", name: it.name || sku, category: "", photo: "", price: null });
    }
  };
  // Новые методы Ozon (старые v2 FBO и v3 FBS отключены): постраничный обход по cursor.
  // Ответ разбираем гибко: список может лежать в result.postings или прямо в result.
  const listAll = async (path, label) => {
    let cursor = "", pages = 0;
    for (let guard = 0; guard < 300; guard++) {
      const res = await post(path, { filter: { since, to }, limit: 1000, cursor, sort_dir: "ASC", with: { analytics_data: false, financial_data: false } });
      const r = res?.result ?? res ?? {};
      const list = Array.isArray(r) ? r : r.postings || res?.postings || [];
      list.forEach(addPosting); pages++;
      const next = (!Array.isArray(r) && r.cursor) || res?.cursor || "";
      const hasNext = (!Array.isArray(r) && r.has_next) ?? res?.has_next;
      if (!list.length || !next || hasNext === false || next === cursor) break;
      cursor = next;
    }
    log(`    ${label}: страниц ${pages}`);
  };
  try { await listAll("/v3/posting/fbo/list", "FBO"); } catch (e) { warnings.push(`Заказы FBO Ozon: ${e.message}`); }
  try { await listAll("/v4/posting/fbs/list", "FBS"); } catch (e) { warnings.push(`Заказы FBS Ozon: ${e.message}`); }
  out.orders = ord.rows();

  // 4. Начисления по дням (финансы)
  log("  начисления");
  const fin = finAgg();
  const days = eachDay(daysAgo(finDays, now), daysAgo(1, now));
  for (const d of days) {
    let last = "";
    for (let guard = 0; guard < 500; guard++) {
      const res = await post("/v1/finance/accrual/by-day", { date: d, last_id: last });
      for (const a of res?.accruals || []) addOzonAccrual(fin, a, (sku) => pid(sku), "*" + store.id);
      last = res?.last_id || "";
      if (!last) break;
    }
    out.finTo = d;
  }
  out.fin = fin.rows();
  out.products = [...new Map([...prod.values()].map((p) => [p.pid, p])).values()];
  return out;
}

// Суммы у Ozon приходят то числом/строкой, то объектом {amount, currency}.
const amt = (v) => (v && typeof v === "object" ? num(v.amount) : num(v));

// Одно начисление Ozon → суммы по статьям. Ozon отдаёт расходы со знаком «−», мы храним их положительными.
export function addOzonAccrual(fin, a, pid, star = "*") {
  const d = String(a.date).slice(0, 10);
  const total = amt(a.total_amount);
  let mapped = 0;
  const put = (id, bucket, amount) => {
    mapped += amount;
    const v = { [F.pay]: amount };
    if (bucket === F.comp) v[F.comp] = amount; else v[bucket] = -amount;
    fin.add(d, id, v);
  };
  if (a.accrued_category === "POSTING" && a.posting) {
    for (const p of a.posting.products || []) {
      const id = p.sku ? pid(String(p.sku)) : star;
      const c = p.commission;
      if (c) {
        const sale = amt(c.sale_amount ?? c.seller_price);
        const comm = amt(c.commission ?? c.sale_commission); // отрицательная
        const q = num(p.quantity) || 1;
        fin.add(d, id, { [F.rev]: sale, [sale >= 0 ? F.sold : F.ret]: q, [F.comm]: -comm, [F.pay]: sale + comm });
        mapped += sale + comm;
      }
      for (const s of p.delivery?.services || []) put(id, bucketOf(s.type_id), amt(s.accrued));
    }
  } else if (a.accrued_category === "ITEM" && a.item_fees) {
    for (const it of a.item_fees.fees || []) {
      const id = it.sku ? pid(String(it.sku)) : star;
      for (const f of it.fees || []) put(id, bucketOf(f.type_id), amt(f.accrued));
    }
  } else if (a.non_item_fee) {
    put(star, bucketOf(a.non_item_fee.type_id), amt(a.non_item_fee.accrued));
  }
  // Всё, что не разложилось по статьям (например, грузоместа), — в «прочие» по магазину, чтобы итог сходился.
  const rest = total - mapped;
  if (Math.abs(rest) > 0.009) put(star, a.accrued_category === "CONTAINER" || a.container_fees ? F.logi : F.pen, rest);
}
