// Проверки робота: node robot/test.mjs
import assert from "node:assert/strict";
import { encrypt, decrypt } from "./crypto.mjs";
import { finAgg, F } from "./lib.mjs";
import { addWbFinRow } from "./wb.mjs";
import { addOzonAccrual, bucketOf } from "./ozon.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("✓", name); };

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
  assert.equal(r[1], "*o"); assert.equal(r[F.logi], 77); assert.equal(r[F.pay], -77);
});

console.log(`\nВсе проверки пройдены: ${n}`);
