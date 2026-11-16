// Сбор данных одного магазина Wildberries. Только чтение.
import { F, finAgg, Agg, OrdAgg, num, day, daysAgo, sleep, jwtExpires } from "./lib.mjs";

const H = {
  content: "https://content-api.wildberries.ru",
  prices: "https://discounts-prices-api.wildberries.ru",
  stats: "https://statistics-api.wildberries.ru",
  finance: "https://finance-api.wildberries.ru",
  adv: "https://advert-api.wildberries.ru",
  analytics: "https://seller-analytics-api.wildberries.ru",
  market: "https://marketplace-api.wildberries.ru"
};

export async function collectWB(store, token, { http, log, now = new Date(), finDays = 90, orderDays = 60, pause = 61000 }) {
  const auth = { Authorization: token };
  const pid = (nm) => `${store.id}:${nm}`;
  const warnings = [];
  const out = { products: [], stocks: null, orders: [], ordersFbs: [], ordH: [], fin: [], ads: [], finTo: null, warnings, tokenExpires: jwtExpires(token) };

  // 1. Карточки товаров
  log("  карточки");
  const cards = [];
  let cursor = { limit: 100 };
  for (let guard = 0; guard < 200; guard++) {
    const res = await http(`${H.content}/content/v2/get/cards/list`, { method: "POST", headers: auth, body: { settings: { cursor, filter: { withPhoto: -1 } } } });
    const list = res?.cards || [];
    cards.push(...list);
    if (list.length < cursor.limit) break;
    cursor = { limit: 100, updatedAt: res.cursor.updatedAt, nmID: res.cursor.nmID };
  }
  const chrtToNm = new Map();
  const prod = new Map();
  for (const c of cards) {
    prod.set(c.nmID, { pid: pid(c.nmID), store: store.id, mp: "wb", sku: String(c.nmID), offerId: c.vendorCode || "", name: [c.brand, c.title].filter(Boolean).join(" ") || String(c.nmID),
      category: c.subjectName || "", photo: c.photos?.[0]?.tm || c.photos?.[0]?.c246x328 || "", price: null });
    for (const s of c.sizes || []) chrtToNm.set(s.chrtID, c.nmID);
  }

  // 2. Цены
  try {
    log("  цены");
    for (let offset = 0, guard = 0; guard < 50; guard++, offset += 1000) {
      const res = await http(`${H.prices}/api/v2/list/goods/filter?limit=1000&offset=${offset}`, { headers: auth });
      const goods = res?.data?.listGoods || [];
      for (const g of goods) {
        const p = prod.get(g.nmID);
        const s = g.sizes?.[0];
        if (p && s) p.price = num(s.discountedPrice || s.price);
      }
      if (goods.length < 1000) break;
    }
  } catch (e) { warnings.push(`Цены WB: ${e.message}`); }

  // 3. Заказы (последние 60 дней — чтобы сравнивать 28 дней с прошлыми 28)
  log("  заказы");
  const ord = new OrdAgg();
  const orderFrom = daysAgo(orderDays, now);
  let dateFrom = orderFrom + "T00:00:00";
  for (let guard = 0; guard < 20; guard++) {
    const list = (await http(`${H.stats}/api/v1/supplier/orders?dateFrom=${encodeURIComponent(dateFrom)}&flag=0`, { headers: auth })) || [];
    for (const o of list) {
      const d = String(o.date).slice(0, 10);
      if (d < orderFrom) continue;
      // время заказа WB приходит уже по Москве: "2026-11-15T13:45:00"
      const hour = Number(String(o.date).slice(11, 13));
      const fbs = /продавц/i.test(String(o.warehouseType || ""));
      ord.add(d, pid(o.nmId), hour, fbs, !!o.isCancel, num(o.priceWithDisc));
      if (!prod.has(o.nmId)) prod.set(o.nmId, { pid: pid(o.nmId), store: store.id, mp: "wb", sku: String(o.nmId), offerId: o.supplierArticle || "", name: [o.brand, o.subject].filter(Boolean).join(" "), category: o.subject || "", photo: "", price: null });
    }
    if (list.length < 80000) break;
    dateFrom = list[list.length - 1].lastChangeDate;
    await sleep(pause);
  }
  Object.assign(out, ord.result());

  // 4. Отчёт о реализации (финансы)
  log("  отчёт о реализации");
  const fin = finAgg();
  const dFrom = daysAgo(finDays, now), dTo = daysAgo(1, now);
  let rrdId = 0, maxDate = null;
  try {
    for (let guard = 0; guard < 100; guard++) {
      const rows = (await http(`${H.finance}/api/finance/v1/sales-reports/detailed`, { method: "POST", headers: auth, body: { dateFrom: dFrom, dateTo: dTo, limit: 100000, rrdId } })) || [];
      for (const r of rows) addWbFinRow(fin, r, pid, "*" + store.id);
      for (const r of rows) if (r.dateTo && (!maxDate || r.dateTo > maxDate)) maxDate = r.dateTo;
      if (rows.length < 100000) break;
      rrdId = rows[rows.length - 1].rrdId;
      await sleep(pause);
    }
  } catch (e) {
    if (!e.limit) throw e;
    warnings.push(`Отчёт о реализации WB: ${e.message}`); // остальное (заказы, реклама, остатки) всё равно соберём
  }

  // 5. Реклама по артикулам (статистика кампаний)
  log("  реклама");
  try {
    const cnt = await http(`${H.adv}/adv/v1/promotion/count`, { headers: auth });
    const since = daysAgo(finDays + 2, now);
    const ids = [];
    for (const g of cnt?.adverts || []) for (const a of g.advert_list || [])
      if (g.status === 9 || g.status === 11 || String(a.changeTime).slice(0, 10) >= since) ids.push(a.advertId);
    const adsAgg = new Agg(5); // spend, views, clicks, orders, ordersSum
    // окна не длиннее 30 дней, по 50 кампаний
    for (let start = finDays; start > 0; start -= 30) {
      const begin = daysAgo(start, now), end = daysAgo(Math.max(start - 29, 0), now);
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50).join(",");
        const res = await http(`${H.adv}/adv/v3/fullstats?ids=${part}&beginDate=${begin}&endDate=${end}`, { headers: auth, okEmpty: [400, 404] });
        for (const c of res || []) for (const d of c.days || []) for (const app of d.apps || []) for (const n of app.nms || [])
          adsAgg.add(String(d.date).slice(0, 10), pid(n.nmId), { 2: num(n.sum), 3: num(n.views), 4: num(n.clicks), 5: num(n.orders), 6: num(n.sum_price) });
        await sleep(pause / 3);
      }
    }
    out.ads = adsAgg.rows();
    for (const a of out.ads) fin.add(a[0], a[1], { [F.ads]: a[2] });
  } catch (e) { warnings.push(`Реклама WB: ${e.message}`); }

  out.fin = fin.rows();
  out.finTo = maxDate;

  // 6. Остатки на складах WB (нужен доступ «Аналитика»)
  const stocks = {};
  try {
    log("  остатки WB");
    for (let offset = 0, guard = 0; guard < 100; guard++, offset += 1000) {
      const res = await http(`${H.analytics}/api/analytics/v1/stocks-report/wb-warehouses`, { method: "POST", headers: auth, body: { limit: 1000, offset } });
      const items = findArray(res);
      for (const it of items) {
        const nm = it.nmId ?? it.nmID;
        if (nm == null) continue;
        const s = (stocks[pid(nm)] ||= { fbo: 0, fbs: 0, toClient: 0, fromClient: 0 });
        s.fbo += num(it.quantity ?? it.stockCount ?? it.amount);
        s.toClient += num(it.inWayToClient);
        s.fromClient += num(it.inWayFromClient);
      }
      if (items.length < 1000) break;
    }
  } catch (e) {
    warnings.push(e.status === 403 ? "Остатки на складах WB: у ключа нет доступа «Аналитика»" : `Остатки WB: ${e.message}`);
  }
  // Остатки на своих складах (FBS)
  try {
    log("  остатки FBS");
    const whs = (await http(`${H.market}/api/v3/warehouses`, { headers: auth })) || [];
    const chrts = [...chrtToNm.keys()];
    for (const w of whs) {
      for (let i = 0; i < chrts.length; i += 1000) {
        const res = await http(`${H.market}/api/v3/stocks/${w.id}`, { method: "POST", headers: auth, body: { chrtIds: chrts.slice(i, i + 1000) } });
        for (const s of res?.stocks || []) {
          const nm = chrtToNm.get(s.chrtId);
          if (nm == null) continue;
          (stocks[pid(nm)] ||= { fbo: 0, fbs: 0, toClient: 0, fromClient: 0 }).fbs += num(s.amount);
        }
      }
    }
  } catch (e) { warnings.push(`Остатки FBS WB: ${e.message}`); }
  out.stocks = Object.keys(stocks).length ? stocks : null;

  out.products = [...prod.values()];
  return out;
}

// Одна строка отчёта о реализации → суммы по статьям. Расходы — положительными числами.
export function addWbFinRow(fin, r, pid, star = "*") {
  const d = String(r.rrDate || r.saleDt || r.dateTo).slice(0, 10);
  const id = r.nmId ? pid(r.nmId) : star;
  const type = String(r.docTypeName || "");
  const s = type === "Возврат" ? -1 : type === "Продажа" ? 1 : 0;
  const qty = num(r.quantity);
  const v = {};
  if (s) {
    const sale = num(r.retailPriceWithDisc) * qty;
    const forPay = num(r.forPay);
    const acq = num(r.acquiringFee);
    v[F.rev] = s * sale;
    v[s > 0 ? F.sold : F.ret] = qty;
    v[F.comm] = s * (sale - forPay - acq);
    v[F.acq] = s * acq;
    v[F.pay] = s * forPay;
  }
  const logi = num(r.deliveryService) + num(r.rebillLogisticCost);
  const stor = num(r.paidStorage), acc = num(r.paidAcceptance), pen = num(r.penalty);
  let ded = num(r.deduction);
  // Удержания за «ВБ.Продвижение» не считаем — рекламу берём из статистики кампаний по артикулам.
  if (/продвижен/i.test(String(r.bonusTypeName || ""))) ded = 0;
  const comp = num(r.additionalPayment);
  v[F.logi] = (v[F.logi] || 0) + logi;
  v[F.stor] = stor; v[F.acc] = acc; v[F.pen] = pen + ded; v[F.comp] = comp;
  v[F.pay] = (v[F.pay] || 0) - logi - stor - acc - pen - num(r.deduction) + comp;
  fin.add(d, id, v);
}

function findArray(res) {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== "object") return [];
  for (const k of ["items", "data", "stocks", "result"]) {
    const v = res[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") { const a = findArray(v); if (a.length) return a; }
  }
  return [];
}
