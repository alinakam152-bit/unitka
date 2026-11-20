// Проверки робота: node robot/test.mjs
import assert from "node:assert/strict";
import { encrypt, decrypt } from "./crypto.mjs";
import { finAgg, F, OrdAgg, mskParts } from "./lib.mjs";
import { OrderFinance } from "./order-fin.mjs";
import { addWbFinRow } from "./wb.mjs";
import { addOzonAccrual, bucketOf, postingUnitPrice, postingPricePair, ozonOrderReport } from "./ozon.mjs";
import reports from "../rnp-data.js";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

await t("отчёт Ozon: новый заголовок, Москва, сравнимые пары, повторы и доставка", () => {
  const raw = [
    "Номер отправления;Принят в обработку;Статус;SKU;Артикул;Предельная цена;Оплачено покупателем;Количество;Дата доставки;Имя покупателя",
    "a;2026-11-18 22:00:00;Доставлен;1;sku-1;300,00;240,00;2;2026-11-20 22:00:00;не хранить",
    "a;2026-11-18 22:00:00;Доставлен;1;sku-1;300;240;2;2026-11-20 22:00:00;повтор",
    "b;2026-11-19 08:00:00;Отменён;1;sku-1;400;320;1;;",
    "c;2026-11-19 09:00:00;В пути;1;sku-1;300;330;1;;"
  ].join("\r\n");
  const data = reports.parseOzonReport(reports.parseCsv(raw), (sku) => "s:" + sku);
  assert.equal(data.invalidPrices, 1);
  assert.deepEqual(data.rows, [["2026-11-19", "s:1", { orders: 3, knownOrderPrices: 3, reportSellerAmount: 900,
    pairedQty: 2, sellerAmount: 600, buyerAmount: 480, delivered: 2, deliveryDays: 4, deliveryUnits: 2, cancelled: 1 }]]);
  assert.deepEqual(reports.bestPriceRows([["2026-11-19", "s:1", 1, 300, 260]], data.rows), [["2026-11-19", "s:1", 2, 600, 480]]);
});

await t("отчёт Ozon: формируем, ждём появления файла и не передаём реквизиты при загрузке", async () => {
  const times = [], now = new Date("2026-11-20T10:00:00Z");
  const post = async (path, body) => {
    times.push(path);
    if (path.endsWith("create")) {
      assert.deepEqual(body.filter.delivery_schema, ["fbo", "fbs"]);
      return { result: { code: "report" } };
    }
    return times.length === 2 ? { result: { status: "waiting" } } :
      { result: { status: "success", file: "https://cdn.ozon.ru/report.csv" } };
  };
  const file = async (url, options) => {
    assert.equal(url.hostname, "cdn.ozon.ru");
    assert.equal(options.headers, undefined);
    return new Response("Номер отправления;Принят в обработку;Статус;SKU;Ваша цена;Оплачено покупателем;Количество\na;2026-11-19;Доставлен;1;100;80;1");
  };
  const data = await ozonOrderReport(post, file, () => "s:1", now, 0);
  assert.equal(data.rows[0][2].buyerAmount, 80);
  assert.equal(times.length, 3);
});

await t("РНП: Техлист сопоставляет артикулы, Unit сохраняет точные ставки группы", () => {
  const metrics = reports.parseRnpMetrics([
    ["Дата", "Артикул", "Артикул продавца", "Общее название", "Заказы, шт.", "Всего показов", "УНИКИ"],
    [46345, "778", "Вася", "Группа", 4, 100, 75]
  ], (sku) => sku === "778" ? "s:1" : null);
  assert.deepEqual(metrics.rows, [["2026-11-19", "s:1", { listedOrders: 4, views: 100, visitors: 75, funnelOrders: 4 }]]);
  assert.deepEqual(metrics.aliases, { Группа: ["s:1"] });
  const inputs = reports.parseRnpInputs([
    ["Наименование товара", "Полная себестоимость, ₽", "Комиссия Ozon, %", "Тариф логистики, ₽", "% выкупа"],
    ["Группа", 80, 0.52, 116.258, "85,79%"]
  ], (sku, offer, name) => metrics.aliases[name]);
  assert.deepEqual(inputs.rows, [["s:1", { commission: 52, logistics: 116.258, buy: 85.79, cost: 80 }]]);
});

await t("две цены Ozon: отдельные поля, рубли и пропуски", () => {
  const product = { price: { amount: "279", currency: "RUB" } };
  assert.deepEqual(postingPricePair(product, { client_price: "262" }), { seller: 279, buyer: 262 });
  assert.deepEqual(postingPricePair(product, { customer_price: { amount: 250, currency: "RUB" } }), { seller: 279, buyer: 250 });
  assert.deepEqual(postingPricePair({}, { client_price: "262" }), { seller: null, buyer: 262 });
  assert.equal(postingPricePair(product, { client_price: { amount: 3, currency: "USD" } }).buyer, null);
});

await t("две цены: суммы взвешены по штукам, отмены и неполные пары исключены", () => {
  const orders = new OrdAgg();
  const day = "2026-11-19";
  orders.add(day, "s:1", 10, false, false, 279, 2, { seller: 279, buyer: 262 });
  orders.add(day, "s:1", 11, true, false, 100, 1, { seller: 100, buyer: 100 });
  orders.add(day, "s:1", 12, true, true, 279, 4, { seller: 279, buyer: 250 });
  orders.add(day, "s:1", 13, false, false, 279, 1, { seller: 279, buyer: 0 });
  orders.add(day, "s:1", 14, false, false, 279, 1, { seller: 279, buyer: 280 });
  assert.deepEqual(orders.result().orderPrices, [[day, "s:1", 3, 658, 624]]);
  assert.deepEqual(orders.result().orders, [[day, "s:1", 9, 2332, 4, 1116, 0]]);
});

await t("шифрование: правильная фраза расшифровывает", async () => {
  const enc = await encrypt({ a: 1, b: "тест" }, "длинная тестовая фраза");
  assert.deepEqual(await decrypt(enc, "длинная тестовая фраза"), { a: 1, b: "тест" });
  assert.ok(!enc.includes("тест"));
});
await t("шифрование: неправильная фраза не подходит", async () => {
  const enc = await encrypt({ a: 1 }, "длинная тестовая фраза");
  await assert.rejects(decrypt(enc, "другая тестовая фраза"));
});
await t("шифрование: короткую фразу не принимаем", async () => {
  await assert.rejects(encrypt({}, "коротко"));
});

await t("WB: продажа, возврат, логистика, реклама из удержаний не дублируется", async () => {
  const fin = finAgg(); const pid = (x) => "s:" + x;
  addWbFinRow(fin, { rrDate: "2026-11-03", nmId: 1, docTypeName: "Продажа", quantity: 1, retailPriceWithDisc: "1000", forPay: "700", acquiringFee: "20" }, pid, "*s");
  addWbFinRow(fin, { rrDate: "2026-11-03", nmId: 1, docTypeName: "Возврат", quantity: 1, retailPriceWithDisc: "1000", forPay: "700", acquiringFee: "20" }, pid, "*s");
  addWbFinRow(fin, { rrDate: "2026-11-03", nmId: 1, docTypeName: "", deliveryService: "80" }, pid, "*s");
  addWbFinRow(fin, { rrDate: "2026-11-03", nmId: 0, docTypeName: "", deduction: "500", bonusTypeName: "Оказание услуг «ВБ.Продвижение»" }, pid, "*s");
  addWbFinRow(fin, { rrDate: "2026-11-03", nmId: 0, docTypeName: "", paidStorage: "150" }, pid, "*s");
  const rows = Object.fromEntries(fin.rows().map((r) => [r[1], r]));
  const p = rows["s:1"];
  assert.equal(p[F.rev], 0);          // продали и вернули
  assert.equal(p[F.sold], 1); assert.equal(p[F.ret], 1);
  assert.equal(p[F.comm], 0); assert.equal(p[F.logi], 80);
  assert.equal(p[F.pay], -80);
  const s = rows["*s"];
  assert.equal(s[F.pen], 0);          // удержание за продвижение не в штрафах
  assert.equal(s[F.stor], 150);
  assert.equal(s[F.pay], -650);       // но из выплаты вычтено
});
await t("WB: комиссия = цена − к перечислению − эквайринг", async () => {
  const fin = finAgg();
  addWbFinRow(fin, { rrDate: "2026-11-04", nmId: 2, docTypeName: "Продажа", quantity: 2, retailPriceWithDisc: "500", forPay: "640", acquiringFee: "30" }, (x) => "s:" + x);
  const r = fin.rows()[0];
  assert.equal(r[F.rev], 1000); assert.equal(r[F.comm], 330); assert.equal(r[F.acq], 30); assert.equal(r[F.pay], 640);
});

await t("Ozon: начисление по отправлению и сервисы сходятся с итогом", async () => {
  const fin = finAgg();
  addOzonAccrual(fin, { date: "2026-11-10", accrued_category: "POSTING", total_amount: { amount: "345.16" }, posting: { products: [{ sku: 9, quantity: 1,
    commission: { sale_amount: { amount: "1067" }, commission: { amount: "-554.84" } }, delivery: { services: [{ type_id: 32, accrued: { amount: "-142" } }, { type_id: 98, accrued: { amount: "-25" } }] } }] } }, (x) => "o:" + x, "*o");
  const r = fin.rows();
  assert.equal(r.length, 1);
  assert.equal(r[0][F.rev], 1067); assert.equal(r[0][F.comm], 554.84); assert.equal(r[0][F.logi], 167); assert.equal(r[0][F.pay], 345.16);
});
await t("Ozon: эквайринг, оплата за клик, хранение по справочнику", async () => {
  assert.equal(bucketOf(1), F.acq); assert.equal(bucketOf(41), F.ads); assert.equal(bucketOf(46), F.stor); assert.equal(bucketOf(10), F.comp);
  assert.equal(bucketOf(9999), F.pen);
});
await t("Ozon: неразобранный остаток уходит в «прочие», итог сходится", async () => {
  const fin = finAgg();
  addOzonAccrual(fin, { date: "2026-11-10", accrued_category: "CONTAINER", total_amount: { amount: "-77" }, container_fees: { x: 1 } }, (x) => "o:" + x, "*o");
  const r = fin.rows()[0];
  assert.equal(r[1], "*o"); assert.equal(r[F.serviceLogi], 77); assert.equal(r[F.pay], -77);
});

await t("Заказы: по часам и FBS сходятся с итогом, отмены не попадают в часы", async () => {
  const o = new OrdAgg();
  o.add("2026-11-15", "s:1", 13, false, false, 299, 2);
  o.add("2026-11-15", "s:1", 13, true, false, 299, 1);
  o.add("2026-11-15", "s:1", 22, true, true, 299, 1);   // отмена FBS
  const r = o.result();
  assert.deepEqual(r.orders, [["2026-11-15", "s:1", 4, 1196, 1, 299, 0]]);
  assert.deepEqual(r.ordersFbs, [["2026-11-15", "s:1", 2, 598, 1, 299, 0]]);
  assert.deepEqual(r.ordH, [["2026-11-15", "s:1", 13, 3, 897, 1, 299]]);
});
await t("Ozon: время по Гринвичу переводится в московское (и день тоже)", async () => {
  assert.deepEqual(mskParts("2026-11-15T22:30:00Z"), { day: "2026-11-16", hour: 1 });
  assert.deepEqual(mskParts("2026-11-15T09:05:00.000Z"), { day: "2026-11-15", hour: 12 });
});
await t("Начисления относятся к дате заказа, возвраты вычитаются, прогноз берёт 10 выкупов", () => {
  const orders = new OrderFinance();
  orders.order("returned", "s:1", "2026-11-01", true, false, 100);
  orders.charge("returned", "s:1", "2026-11-02", { [F.rev]: 100, [F.sold]: 1, [F.comm]: 25, [F.logi]: 10 });
  orders.charge("returned", "s:1", "2026-11-03", { [F.rev]: -100, [F.ret]: 1, [F.comm]: -25, [F.logi]: 10 });
  for (let i = 1; i <= 11; i++) {
    orders.charge(i, "s:1", `2026-11-${String(i).padStart(2, "0")}`, { [F.sold]: 1, [F.comm]: i, [F.logi]: 2 * i });
  }
  const { orderFinFbs, orderFinFbo, orderAverages } = orders.result();
  assert.deepEqual(orderFinFbs, [["2026-11-01", "s:1", 1, 100, 0, 0, 20, 1, 0, 0]]);
  assert.deepEqual(orderFinFbo, []);
  assert.deepEqual(orderAverages, [["s:1", 6.5, 13, 10]]);
});
await t("Внутренняя логистика выделена из доставки, сумма удержаний сохранена", () => {
  const fin = finAgg();
  addWbFinRow(fin, { rrDate: "2026-11-10", nmId: 9, bonusTypeName: "Непредвиденная логистика", deliveryService: 60 }, (x) => "s:" + x);
  addOzonAccrual(fin, { date: "2026-11-10", accrued_category: "POSTING", total_amount: "-20", posting: {
    products: [{ sku: 9, delivery: { services: [{ type_id: 501, accrued: "-20" }] } }],
  } }, (x) => "s:" + x, "*s", undefined, new Set([501]));
  const [r] = fin.rows();
  assert.equal(r[F.serviceLogi], 80);
  assert.equal(r[F.logi], 0);
  assert.equal(r[F.pay], -80);
});
await t("Цена заказа Ozon из денежного объекта, строки или финансовых данных по SKU", () => {
  assert.equal(postingUnitPrice({ sku: 12, price: { amount: "299.50", currency: "RUB" } }, {}), 299.5);
  assert.equal(postingUnitPrice({ sku: 12, price: "799" }, {}), 799);
  const posting = { financial_data: { products: [{ product_id: 99, price: 100 }, { product_id: 12, price: { amount: 350 } }] } };
  assert.equal(postingUnitPrice({ sku: 12 }, posting), 350);
  assert.equal(postingUnitPrice({ sku: 12, price: { amount: 30, currency: "USD" } }, {}), null);
  assert.equal(postingUnitPrice({ sku: 13 }, posting), null);
});
await t("Без цены: штуки сохраняются, отмены не входят в число заказов без цены", () => {
  const orders = new OrdAgg();
  orders.add("2026-11-11", "s:1", 12, true, false, null, 2);
  orders.add("2026-11-11", "s:1", 12, true, true, null, 1);
  assert.deepEqual(orders.result().ordersFbs, [["2026-11-11", "s:1", 3, 0, 1, 0, 2]]);
});
console.log(`\nВсе проверки пройдены: ${n}`);
