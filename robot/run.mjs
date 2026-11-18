// Ночной робот Юнитки.
//   node robot/run.mjs            — настоящие данные: ключи берутся из переменных окружения (GitHub Secrets)
//   node robot/run.mjs --demo     — выдуманный магазин (подменный API), пишет demo-data.js
//   node robot/run.mjs --json x   — дополнительно сохранить расшифрованный JSON (только для проверки на своём компьютере)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeHttp } from "./lib.mjs";
import { collectWB } from "./wb.mjs";
import { collectOzon } from "./ozon.mjs";
import { encrypt, decrypt } from "./crypto.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DEMO = args.includes("--demo");
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
export const DEMO_PHRASE = "демо юнитка выдуманные товары";

const log = (...a) => console.log(...a);

async function main() {
  const now = new Date();
  let stores, env, fetchImpl, pause;
  if (DEMO) {
    const mock = await import("./mock.mjs");
    stores = mock.DEMO_STORES; env = mock.DEMO_ENV; fetchImpl = mock.mockFetch(now); pause = 0;
  } else {
    stores = JSON.parse(readFileSync(join(ROOT, "robot/stores.json"), "utf8")).stores;
    env = process.env; fetchImpl = globalThis.fetch; pause = 61000;
  }
  const phrase = DEMO ? DEMO_PHRASE : env.UNITKA_PHRASE;
  if (!phrase) throw new Error("Нет фразы-расшифровки: задайте секрет UNITKA_PHRASE");
  // Проверяем длину сразу, чтобы не собирать данные зря (шифрование требует от 12 символов)
  if (phrase.length < 12) throw new Error(`Фраза в секрете UNITKA_PHRASE слишком короткая: ${phrase.length} симв., нужно от 12 (4–5 слов через пробел)`);

  // Прошлые данные — чтобы при сбое одного магазина не потерять его цифры
  const encPath = join(ROOT, "data.enc");
  let prev = null;
  if (!DEMO && existsSync(encPath)) {
    try { prev = await decrypt(readFileSync(encPath, "utf8"), phrase); } catch { log("Прошлый data.enc не расшифровался — начинаю с нуля"); }
  }

  const http = makeHttp(fetchImpl, log);
  const data = { v: 1, generatedAt: now.toISOString(), demo: DEMO, stores: [], products: [], stocks: {}, orders: [], ordersFbs: [], ordH: [], orderFinFbo: [], orderFinFbs: [], orderAverages: [], fin: [], ads: [] };

  for (const st of stores) {
    log(`Магазин «${st.name}» (${st.mp})`);
    const meta = { id: st.id, name: st.name, mp: st.mp, ok: false, updatedAt: null, finTo: null, warnings: [], tokenExpires: null };
    let part = null;
    try {
      if (st.mp === "wb") {
        const token = env[st.token];
        if (!token) throw new Error(`нет ключа ${st.token} в Secrets`);
        part = await collectWB(st, token, { http, log, now, pause });
      } else if (st.mp === "ozon") {
        const cid = env[st.clientId], key = env[st.apiKey];
        if (!cid || !key) throw new Error(`нет ключей ${st.clientId} / ${st.apiKey} в Secrets`);
        part = await collectOzon(st, cid, key, { http, log, now });
      }
      Object.assign(meta, { ok: true, updatedAt: now.toISOString(), finTo: part.finTo, warnings: part.warnings, tokenExpires: part.tokenExpires });
    } catch (e) {
      log(`  ОШИБКА: ${e.message}`);
      meta.warnings.push(`Данные не обновились: ${e.message}`);
      const old = prev && takeStore(prev, st.id);
      if (old) {
        part = old.part;
        Object.assign(meta, { updatedAt: old.meta.updatedAt, finTo: old.meta.finTo, tokenExpires: old.meta.tokenExpires });
        meta.warnings.push("Показаны прошлые данные");
      }
    }
    for (const w of meta.warnings) log("  ! " + w);
    data.stores.push(meta);
    if (part) {
      data.products.push(...part.products);
      Object.assign(data.stocks, part.stocks || {});
      data.orders.push(...part.orders); data.fin.push(...part.fin); data.ads.push(...part.ads);
      for (const field of ["orderFinFbo", "orderFinFbs", "orderAverages"]) data[field] = data[field].concat(part[field] || []);
      data.ordersFbs.push(...(part.ordersFbs || [])); data.ordH.push(...(part.ordH || []));
    }
  }

  const enc = await encrypt(data, phrase);
  if (DEMO) {
    writeFileSync(join(ROOT, "demo-data.js"), `// Выдуманные данные для проверки. Фраза: «${DEMO_PHRASE}».\nwindow.UNITKA_DEMO = ${JSON.stringify(enc)};\nwindow.UNITKA_DEMO_PHRASE = ${JSON.stringify(DEMO_PHRASE)};\n`);
    log(`Готово: demo-data.js (${(enc.length / 1024).toFixed(0)} КБ)`);
  } else {
    writeFileSync(encPath, enc);
    log(`Готово: data.enc (${(enc.length / 1024).toFixed(0)} КБ)`);
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(data));
  if (!DEMO && data.stores.every((s) => !s.ok)) process.exitCode = 1;
}

function takeStore(prev, id) {
  const meta = prev.stores?.find((s) => s.id === id);
  if (!meta) return null;
  const mine = (pid) => String(pid).startsWith(id + ":") || pid === "*" + id;
  const stocks = {};
  for (const [k, v] of Object.entries(prev.stocks || {})) if (mine(k)) stocks[k] = v;
  return { meta, part: {
    orderFinFbo: (prev.orderFinFbo || []).filter((r) => mine(r[1])),
    orderFinFbs: (prev.orderFinFbs || []).filter((r) => mine(r[1])),
    orderAverages: (prev.orderAverages || []).filter((r) => mine(r[0])),
    products: (prev.products || []).filter((p) => p.store === id), stocks,
    orders: (prev.orders || []).filter((r) => mine(r[1])), ordersFbs: (prev.ordersFbs || []).filter((r) => mine(r[1])), ordH: (prev.ordH || []).filter((r) => mine(r[1])), fin: (prev.fin || []).filter((r) => mine(r[1])), ads: (prev.ads || []).filter((r) => mine(r[1]))
  } };
}

main().catch((e) => { console.error("Робот остановился:", e.message); process.exit(1); });
