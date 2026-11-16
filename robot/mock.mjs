// Подменный API WB и Ozon с ВЫДУМАННЫМИ товарами. Нужен только для проверки робота и экранов.
import { daysAgo, eachDay } from "./lib.mjs";

export const DEMO_STORES = [
  { id: "demo-wb", name: "Демо WB", mp: "wb", token: "T1" },
  { id: "demo-oz1", name: "Демо Ozon 1", mp: "ozon", clientId: "C1", apiKey: "K1" },
  { id: "demo-oz2", name: "Демо Ozon 2", mp: "ozon", clientId: "C2", apiKey: "K2" }
];
// Токен WB в виде JWT с exp через 20 дней — чтобы проверить предупреждение «ключ истекает».
const exp = Math.floor(Date.now() / 1000) + 20 * 86400;
const jwt = "x." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".y";
export const DEMO_ENV = { T1: jwt, C1: "1", K1: "k", C2: "2", K2: "k" };

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const NAMES = [
  ["Органайзер для косметики", "Хранение вещей", 1290], ["Коврик для йоги 6 мм", "Коврики для йоги", 1890], ["Термокружка 450 мл", "Термокружки", 990],
  ["Набор контейнеров, 5 шт", "Контейнеры", 760], ["Подушка для шеи", "Подушки дорожные", 1150], ["Ночник «Луна» 15 см", "Ночники", 1490],
  ["Чехол для чемодана L", "Чехлы для чемоданов", 1090], ["Бутылка для воды 750 мл", "Бутылки", 640], ["Кухонные весы до 10 кг", "Весы кухонные", 890],
  ["Плед флисовый 150×200", "Пледы", 1390], ["Сушилка для обуви", "Сушилки", 1190], ["Массажный ролик 33 см", "Ролики массажные", 690],
  ["Елочная игрушка «Шар» 8 см", "Елочные украшения", 349], ["Свечи светодиодные, 3 шт", "Свечи", 590], ["Рюмки на ножке, 6 шт", "Рюмки", 733],
  ["Солонка с крышкой", "Наборы для специй", 360], ["Гирлянда-нить 10 м", "Гирлянды", 450], ["Подставка для ножей", "Подставки", 820]
];
// Товары магазина: часть совсем без продаж (нулевой остаток), часть убыточна.
function storeItems(storeIdx) {
  const r = rng(77 + storeIdx * 13);
  return NAMES.map((n, i) => {
    const on = storeIdx === 0 ? i < 15 : storeIdx === 1 ? i % 2 === 0 || i > 12 : i % 3 !== 1;
    return on ? { i, name: n[0], cat: n[1], price: Math.round(n[2] * (0.9 + r() * 0.25)), perDay: [0, 0.2, 0.6, 1.5, 3, 6][Math.floor(r() * 6)],
      offer: `DEMO-${String(i + 1).padStart(2, "0")}`, sku: 900000000 + storeIdx * 1000 + i, stock: r() < 0.25 ? 0 : Math.round(r() * 400),
      commRate: 0.18 + r() * 0.12, logi: 70 + Math.round(r() * 120), heavyAds: r() < 0.2 } : null;
  }).filter(Boolean);
}
function salesFor(it, dayStr, salt) {
  const r = rng(it.sku * 31 + Number(dayStr.replace(/-/g, "")) + salt);
  const n = it.perDay * (0.4 + r() * 1.2);
  return Math.floor(n) + (r() < n % 1 ? 1 : 0);
}

export function mockFetch(now) {
  const wbItems = storeItems(0);
  const ozItems = { "1": storeItems(1), "2": storeItems(2) };
  const ok = (data) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(data) });
  const fail = (status, text) => ({ ok: false, status, headers: { get: () => null }, text: async () => text });

  return async function (url, opts = {}) {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    const path = u.pathname;
    const today = daysAgo(0, now);

    // ---------- WB ----------
    if (path === "/content/v2/get/cards/list")
      return ok({ cards: body.settings.cursor.nmID ? [] : wbItems.map((it) => ({ nmID: it.sku, vendorCode: it.offer, brand: "Демо", title: it.name, subjectName: it.cat, photos: [], sizes: [{ chrtID: it.sku * 10 }] })), cursor: { updatedAt: "x", nmID: 1 } });
    if (path === "/api/v2/list/goods/filter")
      return ok({ data: { listGoods: u.searchParams.get("offset") === "0" ? wbItems.map((it) => ({ nmID: it.sku, sizes: [{ price: it.price * 2, discountedPrice: it.price }] })) : [] } });
    if (path === "/api/v1/supplier/orders") {
      const from = u.searchParams.get("dateFrom").slice(0, 10);
      const list = [];
      for (const d of eachDay(from, today)) for (const it of wbItems) {
        const n = salesFor(it, d, 1) + (Math.random() < 0 ? 1 : 0);
        for (let k = 0; k < n; k++) list.push({ date: d + "T" + String((7 + k * 5 + it.i * 3) % 24).padStart(2, "0") + ":" + String((k * 17) % 60).padStart(2, "0") + ":00", lastChangeDate: d + "T20:00:00", warehouseType: it.i % 5 === 0 && k % 2 ? "Склад продавца" : "Склад WB", nmId: it.sku, supplierArticle: it.offer, subject: it.cat, brand: "Демо", priceWithDisc: it.price, isCancel: k === 3 });
      }
      return ok(list);
    }
    if (path === "/api/finance/v1/sales-reports/detailed") {
      if (body.rrdId) return ok([]);
      const rows = []; let id = 1;
      // отчёт готов по прошлое воскресенье
      const end = lastSunday(now);
      for (const d of eachDay(body.dateFrom, end < body.dateTo ? end : body.dateTo)) {
        for (const it of wbItems) {
          const n = Math.max(0, salesFor(it, d, 2) - (it.i % 4 === 0 ? 1 : 0));
          for (let k = 0; k < n; k++) {
            const isRet = k === 2 && it.i % 3 === 0;
            const sale = it.price, comm = Math.round(sale * it.commRate * 100) / 100, acq = Math.round(sale * 0.02 * 100) / 100;
            rows.push(wbRow(id++, d, it, isRet ? "Возврат" : "Продажа", { quantity: 1, retailPriceWithDisc: sale, forPay: sale - comm - acq, acquiringFee: acq }));
            rows.push(wbRow(id++, d, it, "", { deliveryService: it.logi * (isRet ? 2 : 1) }));
          }
        }
        if (d.endsWith("5")) rows.push(wbRow(id++, d, null, "", { paidStorage: 1800 }));
        if (d.endsWith("12")) rows.push(wbRow(id++, d, null, "", { penalty: 500 }));
        rows.push(wbRow(id++, d, null, "", { deduction: 900, bonusTypeName: "Оказание услуг «ВБ.Продвижение»" }));
      }
      return ok(rows);
    }
    if (path === "/adv/v1/promotion/count") return ok({ adverts: [{ type: 9, status: 9, advert_list: [{ advertId: 1, changeTime: today }] }] });
    if (path === "/adv/v3/fullstats") {
      const days = eachDay(u.searchParams.get("beginDate"), u.searchParams.get("endDate"));
      return ok([{ advertId: 1, days: days.map((d) => ({ date: d + "T00:00:00Z", apps: [{ appType: 32, nms: wbItems.filter((it) => it.perDay > 0).map((it) => {
        const views = Math.round(it.perDay * 300), clicks = Math.round(views * 0.05);
        return { nmId: it.sku, views, clicks, orders: Math.round(it.perDay * 0.4), sum_price: Math.round(it.perDay * 0.4 * it.price), sum: Math.round(it.price * it.perDay * (it.heavyAds ? 0.3 : 0.07)) };
      }) }] })) }]);
    }
    if (path === "/api/analytics/v1/stocks-report/wb-warehouses")
      return ok({ data: { items: body.offset ? [] : wbItems.map((it) => ({ nmId: it.sku, quantity: it.stock, inWayToClient: Math.round(it.perDay * 3), inWayFromClient: Math.round(it.perDay * 0.3) })) } });
    if (path === "/api/v3/warehouses") return ok([{ id: 7, name: "Свой склад" }]);
    if (path.startsWith("/api/v3/stocks/")) return ok({ stocks: wbItems.map((it) => ({ chrtId: it.sku * 10, amount: it.i % 5 === 0 ? 120 : 0 })) });

    // ---------- Ozon ----------
    const items = ozItems[opts.headers?.["Client-Id"]] || [];
    if (path === "/v3/product/list") return ok({ result: { items: body.last_id ? [] : items.map((it) => ({ product_id: it.sku + 5 })), last_id: "" } });
    if (path === "/v3/product/info/list") return ok({ items: items.map((it) => ({ id: it.sku + 5, sku: it.sku, offer_id: it.offer, name: it.name, marketing_price: String(it.price), primary_image: [] })) });
    if (path === "/v4/product/info/stocks") return ok({ items: items.map((it) => ({ product_id: it.sku + 5, stocks: [{ type: "fbo", present: it.stock, reserved: 2 }, { type: "fbs", present: it.i % 4 === 0 ? 50 : 0, reserved: 0 }] })), cursor: "" });
    if (path === "/v3/posting/fbo/list" || path === "/v4/posting/fbs/list") {
      if (body.cursor) return ok({ result: { postings: [], cursor: "", has_next: false } });
      const salt = path.includes("fbs") ? 5 : 3;
      const posts = [];
      for (const d of eachDay(body.filter.since.slice(0, 10), today)) for (const it of items) {
        const n = salesFor(it, d, salt);
        for (let k = 0; k < n; k++) posts.push({ in_process_at: d + "T" + String((4 + k * 7 + it.i * 2) % 24).padStart(2, "0") + ":30:00Z", status: k === 2 ? "cancelled" : "delivered", products: [{ sku: it.sku, offer_id: it.offer, price: String(it.price), quantity: 1 }] });
      }
      return ok({ result: { postings: posts, cursor: "", has_next: false } });
    }
    if (path === "/v1/finance/accrual/by-day") {
      const d = body.date, acc = [];
      for (const it of items) {
        const n = salesFor(it, d, 4);
        for (let k = 0; k < n; k++) {
          const sale = it.price, comm = -Math.round(sale * it.commRate), logi = -it.logi;
          acc.push({ date: d, accrued_category: "POSTING", total_amount: { amount: String(sale + comm + logi) }, posting: { products: [{ sku: it.sku, quantity: 1, commission: { sale_amount: String(sale), commission: String(comm) }, delivery: { services: [{ type_id: 32, accrued: { amount: String(logi) } }] } }] } });
          acc.push({ date: d, accrued_category: "ITEM", total_amount: { amount: String(-Math.round(sale * 0.015)) }, item_fees: { fees: [{ sku: it.sku, fees: [{ type_id: 1, accrued: { amount: String(-Math.round(sale * 0.015)) } }] }] } });
        }
        if (it.heavyAds && it.perDay > 0) acc.push({ date: d, accrued_category: "ITEM", total_amount: { amount: String(-Math.round(it.price * it.perDay * 0.25)) }, item_fees: { fees: [{ sku: it.sku, fees: [{ type_id: 54, accrued: { amount: String(-Math.round(it.price * it.perDay * 0.25)) } }] }] } });
      }
      acc.push({ date: d, accrued_category: "NON_ITEM", total_amount: { amount: "-350" }, non_item_fee: { type_id: 41, accrued: { amount: "-350" } } });
      if (d.endsWith("1")) acc.push({ date: d, accrued_category: "NON_ITEM", total_amount: { amount: "-1200" }, non_item_fee: { type_id: 46, accrued: { amount: "-1200" } } });
      return ok({ accruals: acc, last_id: "" });
    }
    return fail(404, `mock: нет пути ${path}`);
  };
}

function lastSunday(now) {
  const t = new Date(now.getTime() + 3 * 3600e3);
  const back = t.getUTCDay() === 0 ? 7 : t.getUTCDay();
  return new Date(t.getTime() - back * 86400e3).toISOString().slice(0, 10);
}
function wbRow(rrdId, d, it, docTypeName, extra) {
  return Object.assign({ rrdId, rrDate: d, dateTo: d, nmId: it ? it.sku : 0, docTypeName, quantity: 0, retailPriceWithDisc: 0, forPay: 0, acquiringFee: 0,
    deliveryService: 0, rebillLogisticCost: 0, paidStorage: 0, paidAcceptance: 0, penalty: 0, deduction: 0, additionalPayment: 0, bonusTypeName: "" }, extra);
}
