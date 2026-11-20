/* Юнитка — этап 1.
   Данные приходят из зашифрованного файла data.enc (его ночью делает робот robot/run.mjs).
   Расшифровка — только здесь, в браузере, по фразе. Себестоимость и налог хранятся в этом браузере. */
(function () {
  "use strict";
  const { parseCsv, parseOzonReport, bestPriceRows, indexRnpRows, reportDay, RNP_METRICS, parseRnpMetrics, parseRnpInputs } = window.UnitkaReports;

  // ================= Настройки в браузере =================
  const KEY = "unitka.v1", PHRASE_KEY = "unitka.phrase";
  const DEFAULTS = {
    costs: {},                                  // себестоимость: { артикул продавца: ₽ за 1 шт }
    tax: { rate: null, base: "revenue" },       // ставка %, база revenue | profit
    ozonTaxForecast: false,
    vat: 0,                                     // НДС, %: 0 — без НДС; 5, 7, 10, 22 — ставка (НДС внутри цены)
    thresholds: { margin: 15, drr: 20 },        // принято: 15% и 20%
    internal: 0,                                // свои расходы, ₽ на 1 шт (упаковка, фулфилмент…)
    pulstat: { inputs: {}, products: {} },
    view: { home: 28, fin: 28, ord: 1, ordScheme: "all", ordUnit: "rub", profitSort: "profit", profitDir: -1, abc: "profit", report: "week", stores: "all" }
  };
  const PULSTAT_INPUTS = [
    ["vat", "НДС, %", 0], ["tax", "УСН, %", 6], ["acquiring", "Эквайринг, %", 1.5],
    ["loss", "Брак и потери, %", 1], ["delivery", "Доставка до ПВЗ, ₽", 25], ["returns", "Обработка возврата, ₽", 15]
  ];
  const PULSTAT_PRODUCT = [
    ["commission", "Комиссия, %"], ["logistics", "Тариф логистики, ₽"],
    ["nonlocal", "Наценка за нелокальную продажу, %"], ["buy", "Выкуп, %"]
  ];
  function pulstatValues(raw, fields) {
    return Object.fromEntries(fields.flatMap(([field, label]) => {
      const number = raw?.[field];
      const min = field === "buy" ? Number.MIN_VALUE : 0;
      const max = label.endsWith("%") ? 100 : Infinity;
      return Number.isFinite(number) && number >= min && number <= max ? [[field, number]] : [];
    }));
  }
  function cleanPulstat(raw) {
    return {
      inputs: Object.fromEntries(Object.entries(raw?.inputs || {}).map(([id, values]) => [id, pulstatValues(values, PULSTAT_INPUTS)])),
      products: Object.fromEntries(Object.entries(raw?.products || {}).map(([id, values]) => [id, pulstatValues(values, PULSTAT_PRODUCT)]))
    };
  }
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  function loadState() {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    try {
      const raw = JSON.parse(ls.get(KEY) || "null");
      if (raw) {
        s.costs = cleanCosts(raw.costs);
        if (raw.tax) s.tax = { rate: raw.tax.rate == null || raw.tax.rate === "" ? null : Number(raw.tax.rate), base: raw.tax.base === "profit" ? "profit" : "revenue" };
        if (raw.thresholds) s.thresholds = { margin: num(raw.thresholds.margin, 15), drr: num(raw.thresholds.drr, 20) };
        s.ozonTaxForecast = raw.ozonTaxForecast === true;
        s.vat = cleanVat(raw.vat);
        s.internal = cleanMoney(raw.internal);
        s.pulstat = cleanPulstat(raw.pulstat);
        if (raw.view) Object.assign(s.view, raw.view);
      }
    } catch (e) {}
    return s;
  }
  function cleanMoney(v) { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; }
  function cleanVat(v) { const n = Number(v); return isFinite(n) && n > 0 && n < 100 ? n : 0; }
  function cleanCosts(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) { const n = Number(v); if (String(k).trim() && isFinite(n) && n >= 0) out[String(k).trim()] = n; }
    return out;
  }
  const num = (v, d = 0) => { const n = Number(v); return isFinite(n) ? n : d; };
  let state = loadState();
  const save = () => { if (!ls.set(KEY, JSON.stringify(state))) toast("Не получилось сохранить в браузере"); };

  // ================= Расшифровка =================
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function decrypt(text, phrase) {
    const f = JSON.parse(text);
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(phrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(f.salt), iterations: f.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(f.iv) }, key, b64(f.data));
    const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  async function fetchEnc() {
    const res = await fetch("data.enc?" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw Object.assign(new Error("nofile"), { code: "nofile" });
    return res.text();
  }

  // ================= Данные =================
  const F = { date: 0, pid: 1, rev: 2, sold: 3, ret: 4, comm: 5, logi: 6, stor: 7, acc: 8, pen: 9, acq: 10, ads: 11, comp: 12, pay: 13, serviceLogi: 14 };
  const COST_KEYS = ["comm", "logi", "stor", "acc", "pen", "acq", "serviceLogi"];
  let D = null;           // расшифрованные данные
  const RANGE = { ord: null, fin: null };
  const DAY = { home: null, fin: null, ord: null }; // выбранный в календаре день (режим «1 день»); null — по умолчанию
  let IX = null;          // индексы

  function setData(data) {
    D = data;
    const prod = new Map(D.products.map((p) => [p.pid, p]));
    const stores = new Map(D.stores.map((s) => [s.id, s]));
    const today = dayStr(new Date(D.generatedAt));
    const finTos = D.stores.filter((s) => s.finTo).map((s) => s.finTo).sort();
    const minOf = (rows) => rows.reduce((m, r) => (r[0] < m ? r[0] : m), today);
    IX = { prod, stores, today, finTo: finTos[0] || addDays(today, -1), finToMax: finTos[finTos.length - 1] || addDays(today, -1), ordMin: minOf(D.orders), finMin: minOf(D.fin) };
    RANGE.ord = null; RANGE.fin = null;
    DAY.home = null; DAY.fin = null; DAY.ord = null; UNIT = null;
  }
  const dayStr = (d) => new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10); // по Москве, как у площадок
  const addDays = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 86400e3).toISOString().slice(0, 10);
  const storeOf = (pid) => (pid[0] === "*" ? pid.slice(1) : pid.slice(0, pid.indexOf(":")));
  const storeOk = (pid) => state.view.stores === "all" || storeOf(pid) === state.view.stores;

  // Заказы за период: по товарам и по дням
  function aggOrders(from, to) {
    const byP = new Map(), byDay = new Map();
    for (const r of D.orders) {
      if (r[0] < from || r[0] > to || !storeOk(r[1])) continue;
      const p = byP.get(r[1]) || { qty: 0, sum: 0, cq: 0, cs: 0 };
      p.qty += r[2]; p.sum += r[3]; p.cq += r[4]; p.cs += r[5]; byP.set(r[1], p);
      const d = byDay.get(r[0]) || { qty: 0, sum: 0, cq: 0, cs: 0 };
      d.qty += r[2]; d.sum += r[3]; d.cq += r[4]; d.cs += r[5]; byDay.set(r[0], d);
    }
    return { byP, byDay };
  }

  // Финансы за период по товарам. Расходы магазина без артикула («*магазин») делим между его товарами
  // пропорционально выручке за этот же период (принято, как в брифе).
  function aggFin(from, to, { allocate = true } = {}) {
    const byP = new Map(), storeLevel = new Map();
    const blank = () => ({ rev: 0, sold: 0, ret: 0, comm: 0, logi: 0, stor: 0, acc: 0, pen: 0, acq: 0, ads: 0, comp: 0, pay: 0, serviceLogi: 0, shared: 0 });
    for (const r of D.fin) {
      if (r[0] < from || r[0] > to || !storeOk(r[1])) continue;
      const target = r[1][0] === "*" ? storeLevel : byP;
      const a = target.get(r[1]) || blank();
      for (const k in F) if (k !== "date" && k !== "pid") a[k] += r[F[k]] || 0;
      target.set(r[1], a);
    }
    const leftovers = [];
    for (const [sid, s] of storeLevel) {
      const storeId = sid.slice(1);
      const items = [...byP.entries()].filter(([pid]) => storeOf(pid) === storeId);
      const rev = items.reduce((t, [, a]) => t + Math.max(0, a.rev), 0);
      if (!allocate || rev <= 0) { leftovers.push({ storeId, ...s }); continue; }
      for (const [, a] of items) {
        const share = Math.max(0, a.rev) / rev;
        for (const k of ["comm", "logi", "stor", "acc", "pen", "acq", "ads", "comp", "pay", "rev", "serviceLogi"]) {
          const add = s[k] * share; a[k] += add;
          if (k !== "pay" && k !== "rev" && k !== "comp") a.shared += add;
        }
      }
    }
    return { byP, leftovers };
  }

  const internalFromReport = (a) => a.stor + a.acc + a.pen + a.acq + a.serviceLogi;

  // Прибыль по одной строке (товар за период)
  function calc(pid, a) {
    const p = IX.prod.get(pid) || { pid, name: pid, offerId: "", store: storeOf(pid), mp: "" };
    const cost = state.costs[p.offerId];
    const hasCost = typeof cost === "number";
    const units = a.sold - a.ret;
    const cogs = hasCost ? cost * units : 0;
    const ownCosts = pid[0] === "*" ? 0 : cleanMoney(state.internal) * units; // свои расходы на 1 шт × выкуплено
    const mpCost = COST_KEYS.reduce((t, k) => t + a[k], 0) - a.comp;
    const pre = a.rev - mpCost - a.ads - cogs - ownCosts;
    // НДС сидит внутри цены: при ставке 5% это 5/105 выручки. Доходы для УСН считаются без НДС.
    const vat = Math.max(0, a.rev) * vatShare();
    const rate = taxRate();
    const tax = rate ? (state.tax.base === "profit" ? Math.max(0, pre - vat) * rate : Math.max(0, a.rev - vat) * rate) : 0;
    const profit = pre - vat - tax;
    const margin = a.rev > 0 ? profit / a.rev : null;            // рентабельность (как в LiteStat): прибыль после НДС и налога ÷ выручка
    const roi = hasCost && cogs > 0 ? profit / cogs : null;       // ROI: прибыль после НДС и налога ÷ себестоимость
    const drr = a.rev > 0 ? a.ads / a.rev : null;
    const flags = [];
    if (!hasCost && (units > 0 || a.rev > 0)) flags.push("none");
    if (hasCost && profit < 0) flags.push("loss");
    if (hasCost && profit >= 0 && margin != null && margin * 100 < state.thresholds.margin) flags.push("low");
    if (drr != null && drr * 100 > state.thresholds.drr) flags.push("drr");
    if (a.ads > 0 && units <= 0) flags.push("adsnosale");
    return Object.assign({}, a, { pid, p, cost: hasCost ? cost : null, units, cogs, internal: internalFromReport(a), ownCosts, mpCost, vat, tax, profit, margin, roi, drr, flags });
  }
  function vatShare() { const v = cleanVat(state.vat); return v ? v / (100 + v) : 0; }
  function taxRate() { const r = Number(state.tax.rate); return state.tax.rate == null || !isFinite(r) || r <= 0 ? 0 : r / 100; }

  function stockOf(pid) { const s = D.stocks?.[pid]; return s ? s.fbo + s.fbs : null; }
  function storeHasStocks(id) { return Object.keys(D.stocks || {}).some((k) => k.startsWith(id + ":")); }

  // ================= Форматирование =================
  const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const signed = (s) => (s.startsWith("-") ? (/^-[0\s, ]+$/.test(s) ? s.slice(1) : "−" + s.slice(1)) : s);
  const rub = (v) => (v == null || !isFinite(v) ? "—" : signed(nf0.format(Math.round(v))) + " ₽");
  const pct = (v) => (v == null || !isFinite(v) ? "—" : signed(nf1.format(v * 100)) + "%");
  const rub2 = (v) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(v) + " ₽"; // копейки, для мелких сумм
  const int = (v) => (v == null || !isFinite(v) ? "—" : signed(nf0.format(Math.round(v))));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dm = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) : "—");
  const dmy = (s) => (s ? dm(s) + "." + s.slice(0, 4) : "—");
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };
  const mpName = (mp) => (mp === "wb" ? "WB" : mp === "ozon" ? "Ozon" : "");
  const chip = (mp) => (mp ? `<span class="chip ${mp}">${mpName(mp)}</span>` : "");
  const storeName = (id) => IX.stores.get(id)?.name || id;
  const signCls = (v) => (v < 0 ? "num-loss" : "num-profit");
  const FLAG = { loss: ["🔴", "в минусе"], low: ["🟡", "рентабельность ниже порога"], drr: ["🟠", "ДРР выше порога"], none: ["⚪", "нет себестоимости"], adsnosale: ["📣", "реклама без выкупов"] };
  const flagIcons = (c) => c.flags.map((f) => `<span title="${FLAG[f][1]}" aria-label="${FLAG[f][1]}">${FLAG[f][0]}</span>`).join("");
  const delta = (cur, prev) => {
    if (!prev) return "";
    const d = (cur - prev) / prev;
    if (Math.round(d * 100) === 0) return `<span class="delta">0%</span>`;
    return `<span class="delta ${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : "−"}${nf0.format(Math.abs(d * 100))}%</span>`;
  };
  function thumb(p, big) {
    const label = esc((p.name || "?").replace(/^Демо\s+/, "").slice(0, 2));
    const img = p.photo ? `<img src="${esc(p.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
    return `<span class="thumb${big ? " big" : ""}" aria-hidden="true">${label}${img}</span>`;
  }

  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2800);
  }
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const csvCell = (v) => (typeof v === "number" ? String(Math.round(v * 100) / 100).replace(".", ",") : `"${String(v ?? "").replace(/"/g, '""')}"`);
  const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
  const todayIso = () => new Date().toISOString().slice(0, 10);

  // ================= Маршруты =================
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  function route() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, qs] = h.split("?");
    return { parts: path.split("/").filter(Boolean), q: new URLSearchParams(qs || "") };
  }
  function render() {
    if (!D) { nav.hidden = true; return renderLock(); }
    nav.hidden = false;
    const { parts, q } = route();
    const page = parts[0] || "home";
    nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.nav === (page === "item" ? "profit" : page)));
    const fn = { home: renderHome, orders: renderOrders, products: renderProducts, profit: renderProfit, item: renderItem, report: renderReport, rnp: renderRnp, settings: renderSettings }[page] || renderHome;
    fn(parts, q);
  }
  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  // ================= Экран «Фраза» =================
  let lockMsg = "";
  function renderLock() {
    const isFile = location.protocol === "file:";
    app.innerHTML = `
      <section class="lock">
        <h1>Юнитка — прибыль WB и Ozon</h1>
        <p class="muted">Цифры магазинов лежат в зашифрованном файле. Введите фразу-расшифровку — она есть только у вас.</p>
        <form id="lock-form" autocomplete="off">
          <div class="field"><label for="phrase">Фраза</label>
            <input id="phrase" class="secret" type="text" lang="ru" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required minlength="4" placeholder="4–5 слов через пробел"></div>
          <label class="check"><input type="checkbox" id="show-phrase"> Показать фразу</label>
          <label class="check"><input type="checkbox" id="remember" checked> Запомнить на этом устройстве</label>
          <p class="err" role="alert">${esc(lockMsg)}</p>
          <button class="btn primary wide" type="submit">Открыть</button>
        </form>
        ${isFile ? `<p class="muted small">Приложение открыто как файл с компьютера — настоящие данные отсюда не загрузятся. Они появятся по ссылке GitHub Pages.</p>` : ""}
        <div class="lock-demo">
          <p class="muted small">Хотите посмотреть, как всё устроено?</p>
          <button class="btn" data-act="demo">Открыть на выдуманных товарах</button>
        </div>
      </section>
      <div class="pub-lock">${pubPanel()}</div>`;
    // Поле обычное текстовое (не «пароль»): в поле пароля iPhone и Android дают только латиницу.
    // Точки вместо букв рисует CSS-класс .secret; галочка «Показать фразу» его снимает.
    app.querySelector("#show-phrase").addEventListener("change", (e) => {
      app.querySelector("#phrase").classList.toggle("secret", !e.target.checked);
    });
    app.querySelector("#lock-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const phrase = app.querySelector("#phrase").value.trim();
      const remember = app.querySelector("#remember").checked;
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Открываю…";
      try {
        const enc = await fetchEnc();
        setData(await decrypt(enc, phrase));
        if (remember) ls.set(PHRASE_KEY, phrase); else ls.del(PHRASE_KEY);
        lockMsg = ""; location.hash = "#/"; render();
      } catch (err) {
        lockMsg = err.code === "nofile" || err instanceof TypeError ? "Файл с данными не найден. Робот ещё не запускался или страница открыта без интернета." : "Не подходит";
        render();
      }
    });
  }
  async function openDemo() {
    try {
      setData(await decrypt(window.UNITKA_DEMO, window.UNITKA_DEMO_PHRASE));
      location.hash = "#/"; render(); toast("Открыты выдуманные товары");
    } catch (e) { toast("Не получилось открыть выдуманные данные"); }
  }

  // ================= Открытые данные: курсы ЦБ и новости (data.json) =================
  // Файл обновляет задание GitHub «Открытые данные» (fetch.py) дважды в день. Он публичный, без шифрования.
  let PUB = null, PUB_ERR = false;
  async function loadPub() {
    try {
      const r = await fetch("data.json?" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      PUB = await r.json(); PUB_ERR = false;
    } catch (e) { PUB_ERR = true; }
    const el = document.getElementById("pub");
    if (el) el.outerHTML = pubPanel();
  }
  const whenEkb = (iso) => (iso ? `${dmy(iso.slice(0, 10))} в ${iso.slice(11, 16)}` : "—");
  const nf2 = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function pubPanel() {
    if (!PUB) {
      const msg = PUB_ERR
        ? "Не получилось загрузить курсы и новости — нет интернета или файл ещё не создан. Остальная Юнитка работает как обычно."
        : "Загружаю курсы и новости…";
      return `<section class="panel pub" id="pub"><h2>Курсы и новости</h2><p class="muted small">${msg}</p></section>`;
    }
    const r = PUB.rates, n = PUB.news;
    const rates = r ? `<div class="pub-rates">${r.items.map((x) => {
      const ch = x.change, arrow = ch > 0 ? "▲" : ch < 0 ? "▼" : "•";
      return `<div><div class="k">${esc(x.name)}</div><div class="v">${nf2.format(x.value)} ₽</div><div class="s ${ch > 0 ? "num-loss" : ch < 0 ? "num-profit" : "muted"}">${arrow} ${nf2.format(Math.abs(ch))} за день</div></div>`;
    }).join("")}</div><p class="muted small">Курс ЦБ на ${dmy(r.date)}. Рост юаня/доллара — закупка в рублях дорожает.</p>` : "";
    const news = n ? n.groups.map((g) => `<h3>${chip(g.mp)} новости для продавцов</h3><ul class="pub-news">${g.items.map((it) =>
      `<li><a href="${esc(it.link)}" target="_blank" rel="noopener">${esc(it.title)}</a><span class="muted small">${esc(it.source)}${it.date ? " · " + dm(it.date.slice(0, 10)) : ""}</span></li>`).join("")}</ul>`).join("") : "";
    return `<section class="panel pub" id="pub">
      <h2>Курсы и новости</h2>
      <p class="updated">Обновлено ${whenEkb(PUB.updated_at)} (Екб)${PUB_ERR ? " · сейчас без связи, показаны сохранённые" : ""}</p>
      ${rates}${news}
      <p class="muted small">Источники: ЦБ РФ, Google Новости. Обновляется само в 08:00 и 14:00 по Екатеринбургу.</p>
    </section>`;
  }

  // ================= Общие блоки =================
  function storeChips() {
    const cur = state.view.stores;
    const btn = (id, label, mp) => `<button data-act="store" data-v="${esc(id)}" aria-pressed="${cur === id}">${mp ? chip(mp) : ""}${esc(label)}</button>`;
    return `<div class="seg scroll" role="group" aria-label="Магазин">${btn("all", "Все магазины")}${D.stores.map((s) => btn(s.id, s.name, s.mp)).join("")}</div>`;
  }
  function seg(act, opts, cur, label) {
    return `<div class="seg" role="group" aria-label="${esc(label || "")}">${opts.map(([v, l]) => `<button data-act="${act}" data-v="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join("")}</div>`;
  }
  function demoNote() { return D.demo ? `<div class="demo-note">Выдуманные товары для проверки — это не ваши цифры. <button class="link" data-act="lock">Выйти</button></div>` : ""; }

  // ================= Выбор дня (режим «1 день») =================
  function dayPicker(kind, day, min, max) {
    return `<div class="day-pick" role="group" aria-label="Выбор дня">
      <button class="btn" data-act="day-step" data-v="${kind}" data-step="-1" ${day <= min ? "disabled" : ""} aria-label="Предыдущий день">←</button>
      <input type="date" data-day="${kind}" value="${day}" min="${min}" max="${max}" aria-label="День">
      <button class="btn" data-act="day-step" data-v="${kind}" data-step="1" ${day >= max ? "disabled" : ""} aria-label="Следующий день">→</button>
      <button class="btn" data-act="day-set" data-v="${kind}" data-day="${addDays(IX.today, -1)}">Вчера</button>
      <button class="btn" data-act="day-set" data-v="${kind}" data-day="${IX.today}">Сегодня</button>
    </div>`;
  }
  const clampDay = (d, min, max) => (d < min ? min : d > max ? max : d);
  function rangePicker(kind, from, to, min) {
    return `<form class="period-range" data-period-range="${kind}" aria-label="Выбор периода">
      <label class="field">Начало периода<input name="from" type="date" value="${clampDay(from, min, IX.today)}" min="${min}" max="${IX.today}" required></label>
      <label class="field">Конец периода<input name="to" type="date" value="${clampDay(to, min, IX.today)}" min="${min}" max="${IX.today}" required></label>
      <button type="submit" class="btn primary">Применить</button>
      <p class="rnp-range-error small" role="alert" hidden>Начало периода должно быть раньше конца или совпадать с ним.</p>
    </form>`;
  }
  function customPeriod(kind) {
    const range = RANGE[kind];
    if (!range) return null;
    return { ...range, n: Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400e3) + 1 };
  }
  // Какие магазины ещё не прислали отчёт за этот день (WB — раз в неделю)
  function noReportNote(day, orders = false) {
    const late = D.stores.filter((st) => (state.view.stores === "all" || state.view.stores === st.id) && (!st.finTo || st.finTo < day));
    return late.length ? `<p class="banner small">Отчётов за ${dmy(day)} пока нет: ${late.map((st) => `${esc(st.name)} (отчёты по ${dm(st.finTo)})`).join(", ")}. ${orders ? "Расходы из этих отчётов за день ещё не вошли." : "Их цифры за этот день не вошли."}</p>` : "";
  }
  const afterTaxNote = () => (taxRate() || vatShare() ? `<p class="muted small">Рентабельность и ROI посчитаны от прибыли после ${[vatShare() ? `НДС ${state.vat}%` : "", taxRate() ? `налога ${state.tax.rate}%` : ""].filter(Boolean).join(" и ")}.</p>` : "");

  // ================= Главная =================
  function renderHome() {
    const n = Number(state.view.home) || 28;
    const day = n === 1 ? clampDay(DAY.home || IX.today, IX.ordMin, IX.today) : null;
    const to = day || IX.today, from = addDays(to, -(n - 1));
    const pFrom = addDays(from, -n), pTo = addDays(from, -1);
    const cur = aggOrders(from, to), prev = aggOrders(pFrom, pTo);
    const tot = (m) => [...m.byDay.values()].reduce((t, d) => ({ qty: t.qty + d.qty, sum: t.sum + d.sum, cq: t.cq + d.cq, cs: t.cs + d.cs }), { qty: 0, sum: 0, cq: 0, cs: 0 });
    const c = tot(cur), p = tot(prev);
    // Финансы за последние n дней, по которым есть отчёты
    const fTo = day || IX.finTo, fFrom = addDays(fTo, -(n - 1));
    const fin = aggFin(fFrom, fTo);
    const rows = [...fin.byP.entries()].map(([pid, a]) => calc(pid, a));
    const fs = rows.reduce((t, r) => ({ rev: t.rev + r.rev, profit: t.profit + r.profit, ads: t.ads + r.ads, units: t.units + r.units, cogs: t.cogs + r.cogs }), { rev: 0, profit: 0, ads: 0, units: 0, cogs: 0 });
    for (const l of fin.leftovers) { const x = calc("*" + l.storeId, l); fs.rev += x.rev; fs.profit += x.profit; fs.ads += x.ads; }

    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Главная</h1>${seg("home", [[1, "1 день"], [7, "7 дней"], [14, "14 дней"], [28, "28 дней"]], n, "Период")}</div>
      ${storeChips()}
      ${day ? dayPicker("home", day, IX.ordMin, IX.today) : ""}
      <div class="home-grid">
        <div class="home-left">
        <section class="panel chart-panel">
          <div class="kpis">
            <div><div class="k">Заказано</div><div class="v">${rub(c.sum - c.cs)}</div><div class="s">${int(c.qty - c.cq)} шт ${delta(c.sum - c.cs, p.sum - p.cs)} ${n === 1 ? "к предыдущему дню" : `к прошлым ${n} дн.`}</div></div>
            <div><div class="k">Отмены</div><div class="v">${int(c.cq)} шт</div><div class="s">${pct(c.qty ? c.cq / c.qty : null)} заказов</div></div>
          </div>
          ${n === 1 ? ordersChart(aggOrders(addDays(to, -13), to).byDay, null, addDays(to, -13), to, 14) : ordersChart(cur.byDay, prev.byDay, from, to, n)}
          <p class="muted small">${n === 1 ? `Цифры выше — за ${dmy(to)}${to === IX.today ? " (сегодня, день ещё не закончился)" : ""} в сравнении с ${dm(addDays(to, -1))}. График — 14 дней по ${dm(to)}` : `Заказы по дням, ₽ без отмен. Пунктир — предыдущие ${n} дней`}. Данные на ${dm(IX.today)}.</p>
        </section>
        <section class="panel fin-mini">
          <h2>Деньги по отчётам площадок</h2>
          <p class="muted small">${n === 1 ? dmy(fTo) : dm(fFrom) + "–" + dm(fTo) + " · отчёты WB приходят раз в неделю, поэтому период заканчивается " + dm(fTo)}</p>
          ${day ? noReportNote(day) : ""}
          <div class="kpis four">
            <div><div class="k">Выручка</div><div class="v">${rub(fs.rev)}</div><div class="s">${int(fs.units)} шт выкуплено</div></div>
            <div class="main"><div class="k">Чистая прибыль</div><div class="v ${signCls(fs.profit)}">${rub(fs.profit)}</div></div>
            <div><div class="k">Рентабельность</div><div class="v">${pct(fs.rev > 0 ? fs.profit / fs.rev : null)}</div><div class="s">ROI ${pct(fs.cogs > 0 ? fs.profit / fs.cogs : null)}</div></div>
            <div><div class="k">ДРР</div><div class="v">${pct(fs.rev > 0 ? fs.ads / fs.rev : null)}</div></div>
          </div>
          ${afterTaxNote()}
          ${!taxRate() ? `<p class="banner small">Налог не указан — прибыль без налога. <a href="#/settings">Указать</a></p>` : ""}
          <a class="btn" href="#/profit">Прибыль по товарам</a>
        </section>
        </div>
        <section class="panel attention">
          <h2>На что обратить внимание</h2>
          ${attentionList()}
        </section>
      </div>
      ${pubPanel()}`;
  }

  function ordersChart(byDay, prevDay, from, to, n) {
    const days = []; for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
    const vals = days.map((d) => { const x = byDay.get(d); return x ? x.sum - x.cs : 0; });
    const pvals = prevDay ? days.map((d) => { const x = prevDay.get(addDays(d, -n)); return x ? x.sum - x.cs : 0; }) : [];
    const max = Math.max(1, ...vals, ...pvals);
    const W = Math.max(300, Math.min(900, (app.clientWidth || 600) - 64)), H = 190, padB = 22;
    const x = (i) => (days.length < 2 ? W / 2 : (i / (days.length - 1)) * W);
    const y = (v) => H - padB - (v / max) * (H - padB - 10);
    const line = (arr) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const area = line(vals) + `L${W},${H - padB}L0,${H - padB}Z`;
    const step = Math.ceil(days.length / 6);
    const ticks = days.map((d, i) => (i % step === 0 ? `<text x="${x(i)}" y="${H - 4}" text-anchor="${i === 0 ? "start" : "middle"}">${dm(d)}</text>` : "")).join("");
    const best = vals.indexOf(Math.max(...vals));
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Заказы по дням: максимум ${rub(vals[best])} ${dm(days[best])}">
      <line x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" class="grid"/><line x1="0" x2="${W}" y1="${y(max / 2)}" y2="${y(max / 2)}" class="grid"/>
      <text x="${W}" y="${y(max) - 3}" text-anchor="end">${rub(max)}</text>
      <path d="${area}" class="area"/>${pvals.length ? `<path d="${line(pvals)}" class="prev"/>` : ""}<path d="${line(vals)}" class="cur"/>${ticks}</svg>`;
  }

  function attentionList() {
    const items = [];
    const n28 = addDays(IX.finTo, -27);
    const fin = aggFin(n28, IX.finTo);
    const rows = [...fin.byP.entries()].map(([pid, a]) => calc(pid, a));
    const ord = aggOrders(addDays(IX.today, -27), IX.today);
    // ключи и ошибки магазинов
    for (const s of D.stores) {
      if (state.view.stores !== "all" && s.id !== state.view.stores) continue;
      if (s.tokenExpires) {
        const left = Math.round((Date.parse(s.tokenExpires) - Date.parse(IX.today)) / 86400e3);
        if (left <= 30) items.push(["bad", `Ключ API магазина «${s.name}» истекает ${dmy(s.tokenExpires)}`, `${left} ${plural(left, "день", "дня", "дней")}`, null]);
      }
      if (!s.ok) items.push(["bad", `Магазин «${s.name}»: данные не обновились`, s.warnings[0] || "", null]);
      else for (const w of s.warnings) items.push(["warn", `Магазин «${s.name}»`, w, null]);
    }
    const age = (Date.now() - Date.parse(D.generatedAt)) / 3600e3;
    if (!D.demo && age > 36) items.push(["bad", "Данные давно не обновлялись", `последнее обновление ${dmy(dayStr(new Date(D.generatedAt)))}`, null]);
    const noCost = new Set(); rows.forEach((r) => r.flags.includes("none") && r.p.offerId && noCost.add(r.p.offerId));
    for (const [pid] of ord.byP) { const p = IX.prod.get(pid); if (p && p.offerId && state.costs[p.offerId] == null) noCost.add(p.offerId); }
    if (noCost.size) items.push(["warn", "Себестоимость не указана", `${noCost.size} ${plural(noCost.size, "артикул", "артикула", "артикулов")} с продажами`, "#/settings?filter=nocost"]);
    const loss = rows.filter((r) => r.flags.includes("loss"));
    if (loss.length) items.push(["bad", "Убыточные товары", `${loss.length} ${plural(loss.length, "товар", "товара", "товаров")} за 28 дней, ${rub(loss.reduce((t, r) => t + r.profit, 0))}`, "#/profit?filter=loss"]);
    const adsNo = rows.filter((r) => r.flags.includes("adsnosale"));
    if (adsNo.length) items.push(["bad", "Реклама без выкупов", `${adsNo.length} ${plural(adsNo.length, "товар", "товара", "товаров")}, потрачено ${rub(adsNo.reduce((t, r) => t + r.ads, 0))}`, "#/profit?filter=adsnosale"]);
    const drr = rows.filter((r) => r.flags.includes("drr"));
    if (drr.length) items.push(["warn", `ДРР выше ${state.thresholds.drr}%`, `${drr.length} ${plural(drr.length, "товар", "товара", "товаров")}`, "#/profit?filter=drr"]);
    for (const s of D.stores) {
      if ((state.view.stores !== "all" && s.id !== state.view.stores) || !storeHasStocks(s.id)) continue;
      const selling = [...ord.byP.entries()].filter(([pid, o]) => storeOf(pid) === s.id && o.qty - o.cq > 0 && stockOf(pid) === 0);
      if (selling.length) items.push(["bad", `Закончились продающиеся товары — «${s.name}»`, `${selling.length} ${plural(selling.length, "товар", "товара", "товаров")} с заказами за 28 дней и нулевым остатком`, `#/products?store=${encodeURIComponent(s.id)}&tab=out&selling=1`]);
    }
    if (!items.length) return `<p class="muted">Всё спокойно: рисков не нашлось.</p>`;
    return `<ul class="att">${items.map(([lvl, t, sub, href]) => {
      const inner = `<span class="dot ${lvl}" aria-hidden="true"></span><span><b>${esc(t)}</b><span class="muted small">${esc(sub)}</span></span>`;
      return `<li>${href ? `<a href="${href}">${inner}<span class="go" aria-hidden="true">›</span></a>` : `<div>${inner}</div>`}</li>`;
    }).join("")}</ul>`;
  }

  // ================= Товары (список с остатками) =================
  let listLimit = 50;
  function renderProducts(parts, q) {
    if (q.get("store")) { state.view.stores = q.get("store"); }
    const tab = q.get("tab") || "all", selling = q.get("selling") === "1", search = (q.get("s") || "").toLowerCase();
    const ord = aggOrders(addDays(IX.today, -27), IX.today);
    let list = D.products.filter((p) => storeOk(p.pid));
    const st = (p) => stockOf(p.pid);
    const counts = { all: list.length, in: list.filter((p) => st(p) > 0).length, out: list.filter((p) => st(p) === 0).length };
    if (tab === "in") list = list.filter((p) => st(p) > 0);
    if (tab === "out") list = list.filter((p) => st(p) === 0);
    if (selling) list = list.filter((p) => { const o = ord.byP.get(p.pid); return o && o.qty - o.cq > 0; });
    if (search) list = list.filter((p) => (p.name + " " + p.offerId + " " + p.sku).toLowerCase().includes(search));
    list.sort((a, b) => (st(b) ?? -1) - (st(a) ?? -1));
    const tabLink = (t, l, n) => `<a href="#/products?tab=${t}" class="${tab === t ? "on" : ""}">${l} <span class="cnt">${n}</span></a>`;
    const shown = list.slice(0, listLimit);
    const noStocks = D.stores.filter((s) => (state.view.stores === "all" || s.id === state.view.stores) && !storeHasStocks(s.id));

    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Список товаров</h1><button class="btn" data-act="csv-products">Скачать CSV</button></div>
      ${storeChips()}
      <nav class="tabs">${tabLink("all", "Все", counts.all)}${tabLink("in", "В наличии", counts.in)}${tabLink("out", "Нет в наличии", counts.out)}</nav>
      ${selling ? `<p class="banner small">Показаны только товары с заказами за 28 дней. <a href="#/products?tab=${tab}">Показать все</a></p>` : ""}
      ${noStocks.length ? `<p class="banner small">Нет остатков по магазинам: ${noStocks.map((s) => "«" + esc(s.name) + "»").join(", ")}. ${noStocks.some((s) => s.mp === "wb") ? "Для WB нужен доступ ключа «Аналитика»." : ""}</p>` : ""}
      <div class="search"><input type="search" id="search" placeholder="Артикул или название" value="${esc(q.get("s") || "")}" aria-label="Поиск по артикулу или названию"></div>
      <div class="tbl-wrap">
        <table class="items plist">
          <thead><tr><th>Товар</th><th>Магазин</th><th>Категория</th><th>Остаток</th><th>Заказы 28 дн.</th><th>Цена</th></tr></thead>
          <tbody>${shown.map((p) => {
            const s = D.stocks?.[p.pid]; const o = ord.byP.get(p.pid);
            return `<tr data-pid="${esc(p.pid)}" tabindex="0">
              <td><div class="name">${thumb(p)}<div><b>${esc(p.name)}</b><span class="muted small">${esc(p.offerId)} · ${esc(p.sku)}</span></div></div></td>
              <td data-l="Магазин">${chip(p.mp)} ${esc(storeName(p.store))}</td>
              <td data-l="Категория" class="col-cat">${esc(p.category || "—")}</td>
              <td data-l="Остаток" class="${s && s.fbo + s.fbs === 0 ? "num-loss" : ""}">${s ? int(s.fbo + s.fbs) + " шт" : "—"}${s && s.fbs ? `<span class="muted small"> FBO ${int(s.fbo)} / FBS ${int(s.fbs)}</span>` : ""}</td>
              <td data-l="Заказы 28 дн.">${o ? int(o.qty - o.cq) + " шт" : "0"}</td>
              <td data-l="Цена">${rub(p.price)}</td></tr>`;
          }).join("") || `<tr><td colspan="6" class="muted">Ничего не нашлось</td></tr>`}</tbody>
        </table>
      </div>
      ${list.length > shown.length ? `<div class="more"><button class="btn" data-act="more">Показать ещё (${list.length - shown.length})</button></div>` : ""}`;
    const s = app.querySelector("#search");
    s.addEventListener("change", () => { const qq = new URLSearchParams(route().q); s.value ? qq.set("s", s.value) : qq.delete("s"); location.hash = "#/products?" + qq; });
  }

  // ================= Прибыль по товарам + ABC =================
  function finPeriod() {
    if (RANGE.fin) return customPeriod("fin");
    const n = Number(state.view.fin) || 28;
    if (n === 1) { const d = clampDay(DAY.fin || IX.finToMax, IX.finMin, IX.today); return { n, from: d, to: d }; }
    return { n, from: addDays(IX.finTo, -(n - 1)), to: IX.finTo };
  }
  function profitRows() {
    const { from, to } = finPeriod();
    const fin = aggFin(from, to, { allocate: false });
    const rows = [...fin.byP.entries()].map(([pid, a]) => calc(pid, a)).filter((r) => r.rev !== 0 || r.ads !== 0 || r.units !== 0 || r.mpCost !== 0);
    // ABC: A — первые 80% суммы, B — следующие 15%, C — остальное
    for (const key of ["rev", "profit"]) {
      const sorted = rows.filter((r) => r[key] > 0).sort((a, b) => b[key] - a[key]);
      const total = sorted.reduce((t, r) => t + r[key], 0); let acc = 0;
      for (const r of sorted) { acc += r[key]; r["abc_" + key] = acc <= total * 0.8 + 1e-6 || acc === r[key] ? "A" : acc <= total * 0.95 + 1e-6 ? "B" : "C"; }
      for (const r of rows) if (!r["abc_" + key]) r["abc_" + key] = "C";
    }
    return { rows, leftovers: fin.leftovers.map((l) => calc("*" + l.storeId, l)) };
  }
  function renderProfit(parts, q) {
    const { n, from, to } = finPeriod();
    const { rows, leftovers } = profitRows();
    const filter = q.get("filter") || "";
    const v = state.view;
    let list = rows;
    if (filter) list = rows.filter((r) => r.flags.includes(filter));
    const abcKey = v.abc === "rev" ? "abc_rev" : "abc_profit";
    const abcLetter = q.get("abc");
    if (abcLetter) list = list.filter((r) => r[abcKey] === abcLetter);
    const key = v.profitSort, dir = v.profitDir;
    list.sort((a, b) => {
      if (key === "name") return dir * a.p.name.localeCompare(b.p.name, "ru");
      if (key === "abc") return dir * String(a[abcKey]).localeCompare(String(b[abcKey]));
      return dir * ((a[key] ?? -Infinity) - (b[key] ?? -Infinity));
    });
    const all = rows.concat(leftovers);
    const tot = all.reduce((t, r) => ({ rev: t.rev + r.rev, profit: t.profit + r.profit, ads: t.ads + r.ads, cogs: t.cogs + (r.cogs || 0) }), { rev: 0, profit: 0, ads: 0, cogs: 0 });
    const abcSum = { A: [0, 0], B: [0, 0], C: [0, 0] };
    for (const r of rows) { abcSum[r[abcKey]][0]++; abcSum[r[abcKey]][1] += Math.max(0, v.abc === "rev" ? r.rev : r.profit); }
    const abcTotal = abcSum.A[1] + abcSum.B[1] + abcSum.C[1] || 1;
    const shown = list.slice(0, listLimit);
    const cols = [["name", "Товар"], ["units", "Выкупы, шт"], ["rev", "Выручка"], ["profit", "Чистая прибыль"], ["margin", "Рентаб."], ["roi", "ROI"], ["drr", "ДРР"], ["abc", "ABC"]];
    const th = cols.map(([k, l]) => `<th scope="col"><button data-act="sort" data-k="${k}" ${key === k ? `data-dir="${dir > 0 ? "↑" : "↓"}"` : ""}>${l}</button> ${metricHelp(k, l)}</th>`).join("");
    const fNames = { loss: "в минусе", drr: "ДРР выше порога", none: "без себестоимости", low: "рентабельность ниже порога", adsnosale: "реклама без выкупов" };

    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Прибыль по товарам</h1>${seg("fin", [[1, "1 день"], [7, "7 дней"], [14, "14 дней"], [28, "28 дней"], [90, "90 дней"]], RANGE.fin ? "custom" : n, "Период")}</div>
      ${storeChips()}
      ${rangePicker("fin", from, to, IX.finMin)}
      ${n === 1 && !RANGE.fin ? dayPicker("fin", to, IX.finMin, IX.today) : ""}
      <p class="updated">По отчётам площадок за ${n === 1 ? dmy(to) : dm(from) + "–" + dm(to)}. ${D.stores.map((s) => `${esc(s.name)}: по ${dm(s.finTo)}`).join(" · ")}</p>
      ${noReportNote(to)}
      ${!taxRate() ? `<div class="banner small">Налог не указан — прибыль без налога. <a href="#/settings">Указать</a></div>` : ""}
      <section class="totals">
        <div><div class="k">Выручка ${metricHelp("rev", "Выручка")}</div><div class="v">${rub(tot.rev)}</div></div>
        <div class="main"><div class="k">Чистая прибыль ${metricHelp("profit", "Чистая прибыль")}</div><div class="v">${rub(tot.profit)}</div></div>
        <div><div class="k">Рентабельность ${metricHelp("margin", "Рентабельность")}</div><div class="v">${pct(tot.rev > 0 ? tot.profit / tot.rev : null)}</div><div class="s muted small">прибыль ÷ выручка</div></div>
        <div><div class="k">ROI ${metricHelp("roi", "ROI")}</div><div class="v">${pct(tot.cogs > 0 ? tot.profit / tot.cogs : null)}</div><div class="s muted small">прибыль ÷ себестоимость</div></div>
        <div><div class="k">ДРР ${metricHelp("drr", "ДРР")}</div><div class="v">${pct(tot.rev > 0 ? tot.ads / tot.rev : null)}</div></div>
      </section>
      ${afterTaxNote()}
      ${(taxRate() || vatShare()) && D.stores.some((st) => st.mp === "ozon" && (v.stores === "all" || v.stores === st.id)) ? `<p class="banner small">Налог и НДС Ozon оценены по выручке из начислений. Для сверки с LiteStat нужна налоговая база из отчёта реализации.</p>` : ""}
      <section class="abc">
        <div class="abc-head"><h2>ABC-анализ</h2>${seg("abc", [["profit", "По прибыли"], ["rev", "По выручке"]], v.abc, "ABC")}</div>
        <div class="abc-cards">${["A", "B", "C"].map((L) => `<a class="abc-card ${L}${abcLetter === L ? " on" : ""}" href="#/profit?abc=${abcLetter === L ? "" : L}">
          <b>Товары ${L}</b><span>${abcSum[L][0]} шт · ${pct(abcSum[L][1] / abcTotal)} ${v.abc === "rev" ? "выручки" : "прибыли"}</span></a>`).join("")}</div>
        <p class="muted small">A — товары, которые дают 80% ${v.abc === "rev" ? "выручки" : "прибыли"}, B — следующие 15%, C — остальные 5% и убыточные.</p>
      </section>
      <div class="list-head">
        <h2>${filter ? `Фильтр: ${fNames[filter] || filter} <a class="small" href="#/profit">сбросить</a>` : `Товары <span class="muted small">${list.length}</span>`}</h2>
        <div class="btn-row">
          <label class="sort-mobile"><select data-act="sort-select" aria-label="Сортировка">
            ${cols.map(([k, l]) => [-1, 1].map((d) => `<option value="${k}:${d}" ${key === k && dir === d ? "selected" : ""}>${l} ${d > 0 ? "↑" : "↓"}</option>`).join("")).join("")}
          </select></label>
          <button class="btn" data-act="csv-profit">Скачать CSV</button>
        </div>
      </div>
      <div class="legend"><span>🔴 в минусе</span><span>🟡 рентабельность ниже ${state.thresholds.margin}%</span><span>🟠 ДРР выше ${state.thresholds.drr}%</span><span>⚪ нет себестоимости</span><span>📣 реклама без выкупов</span></div>
      <div class="tbl-wrap">
        <table class="items">
          <thead><tr>${th}</tr></thead>
          <tbody>${shown.map((c) => `
            <tr class="${c.flags.includes("loss") ? "r-loss" : ""}" data-item="${esc(c.pid)}" tabindex="0">
              <td><div class="name">${thumb(c.p)}<div><b>${esc(c.p.name)}</b><span class="muted small">${chip(c.p.mp)} ${esc(storeName(c.p.store))} · ${esc(c.p.offerId)}</span> <span class="flags">${flagIcons(c)}</span></div></div></td>
              <td data-l="Выкупы">${int(c.units)}</td>
              <td data-l="Выручка">${rub(c.rev)}</td>
              <td data-l="Прибыль" class="${signCls(c.profit)}">${rub(c.profit)}</td>
              <td data-l="Рентаб.">${pct(c.margin)}</td>
              <td data-l="ROI">${pct(c.roi)}</td>
              <td data-l="ДРР">${pct(c.drr)}</td>
              <td data-l="ABC"><span class="abc-l ${c[abcKey]}">${c[abcKey]}</span></td>
            </tr>`).join("") || `<tr><td colspan="7" class="muted">За этот период продаж нет</td></tr>`}</tbody>
        </table>
      </div>
      ${list.length > shown.length ? `<div class="more"><button class="btn" data-act="more">Показать ещё (${list.length - shown.length})</button></div>` : ""}
      ${leftovers.length ? `<p class="muted small">Начисления магазинов без привязки к товару (учтены в общем итоге): ${leftovers.map((l) => `${esc(storeName(l.storeId))} ${rub(l.profit)}`).join(", ")}.</p>` : ""}`;
  }

  // ================= Карточка товара =================
  const LINES = [
    ["comm", "Комиссия", { wb: "Отчёт о реализации: цена − «к перечислению» − эквайринг", ozon: "Начисления: «Вознаграждение за продажу»" }, "var(--s1)"],
    ["logi", "Логистика", { wb: "«Услуги по доставке» и возмещение перевозки", ozon: "Логистика, обратная логистика, выдача, обработка" }, "var(--s2)"],
    ["ads", "Реклама", { wb: "WB «Продвижение»: статистика кампаний по артикулу", ozon: "Начисления Ozon: продвижение и оплата за клик (общая часть делится по выручке)" }, "var(--s7)"],
    ["cogs", "Себестоимость", "Из настроек", "var(--s8)"],
    ["internal", "Внутренние расходы", "Услуги и удержания из отчётов площадки", "var(--s3)"],
    ["ownCosts", "Свои расходы", "Из настроек", "var(--none)"],
    ["vat", "НДС", "Из настроек", "var(--drr)"],
    ["tax", "Налог", "Из настроек", "var(--s9)"]
  ];
  function renderItem(parts) {
    const pid = decodeURIComponent(parts.slice(1).join("/"));
    const p = IX.prod.get(pid);
    if (!p) { location.hash = "#/profit"; return; }
    const { n, from, to } = finPeriod();
    const fin = aggFin(from, to, { allocate: false });
    // тот же артикул продавца в других магазинах — рядом
    const twins = D.products.filter((x) => x.offerId && x.offerId === p.offerId);
    const list = (twins.length ? twins : [p]).map((x) => ({ x, a: fin.byP.get(x.pid) })).filter((t) => t.a || t.x.pid === pid)
      .sort((a, b) => (a.x.pid === pid ? -1 : b.x.pid === pid ? 1 : 0));
    const ord = aggOrders(addDays(IX.today, -27), IX.today).byP;
    app.innerHTML = `
      ${demoNote()}
      <a class="btn ghost back" href="#/profit">← Назад к списку</a>
      <div class="item-head">${thumb(p, true)}<div><h1>${esc(p.name)}</h1>
        <p class="muted small">${esc(p.offerId)} · ${esc(p.category || "")} · по отчётам за ${dm(from)}–${dm(to)}</p></div></div>
      <div class="cols">${list.map(({ x, a }) => itemPanel(x, a ? calc(x.pid, a) : null, ord.get(x.pid))).join("")}</div>`;
    list.forEach(({ x, a }) => {
      if (!a) return;
      const c = calc(x.pid, a);
      const panel = app.querySelector(`.panel[data-pid="${CSS.escape(x.pid)}"]`);
      if (!panel || c.units <= 0) return;
      const upd = () => {
        const price = Number(panel.querySelector('[data-wi="price"]').value) || 0;
        const ads = Number(panel.querySelector('[data-wi="ads"]').value) || 0;
        const w = whatIf(c, price, ads);
        const d = w.profit - c.profit;
        panel.querySelector("[data-wi-out]").innerHTML = `
          <div><div class="k">Прибыль за период</div><div class="v ${signCls(w.profit)}">${rub(w.profit)}</div><div class="d ${signCls(d)}">${Math.round(d) === 0 ? "как сейчас" : (d > 0 ? "+" : "−") + rub(Math.abs(d)) + " к сейчас"}</div></div>
          <div><div class="k">Рентабельность</div><div class="v ${signCls(w.profit)}">${pct(w.margin)}</div><div class="d muted">ДРР ${pct(w.drr)}</div></div>`;
      };
      panel.addEventListener("input", upd); upd();
    });
  }
  function unitModel(c) {
    const q = c.units > 0 ? c.units : 1;
    const price = c.rev / q;
    const pctPart = c.rev > 0 ? (c.comm + c.acq) / c.rev : 0;
    const fixed = (c.logi + c.internal - c.acq - c.comp + c.ads) / q + (c.cost || 0) + cleanMoney(state.internal);
    return { q, price, pctPart, fixed };
  }
  function priceFor(c, margin) {
    const m = unitModel(c), t = taxRate(), v = vatShare();
    if (state.tax.base === "profit") {
      if (margin === 0) { const den = 1 - m.pctPart - v; return den > 0 ? m.fixed / den : null; }
      const den = (1 - m.pctPart - v) * (1 - t) - margin; return den > 0 ? (m.fixed * (1 - t)) / den : null;
    }
    const den = 1 - m.pctPart - v - t * (1 - v) - margin; return den > 0 ? m.fixed / den : null;
  }
  function whatIf(c, newPrice, newAds) {
    const m = unitModel(c);
    const revenue = newPrice * m.q;
    const nonAd = c.logi + c.internal - c.acq - c.comp + ((c.cost || 0) + cleanMoney(state.internal)) * m.q;
    const pre = revenue * (1 - m.pctPart) - nonAd - newAds;
    const t = taxRate();
    const vat = Math.max(0, revenue) * vatShare();
    const tax = t ? (state.tax.base === "profit" ? Math.max(0, pre - vat) * t : Math.max(0, revenue - vat) * t) : 0;
    const profit = pre - vat - tax;
    return { profit, margin: revenue ? profit / revenue : 0, drr: revenue ? newAds / revenue : 0 };
  }
  function itemPanel(p, c, o) {
    const stock = D.stocks?.[p.pid];
    const head = `<h2>${chip(p.mp)} ${esc(storeName(p.store))} ${c ? `<span class="flags">${flagIcons(c)}</span>` : ""}</h2>
      <p class="muted small">Остаток ${stock ? int(stock.fbo + stock.fbs) + " шт" : "—"} · заказов за 28 дней ${o ? int(o.qty - o.cq) : 0} · цена на витрине ${rub(p.price)}</p>`;
    if (!c || c.units <= 0) return `<section class="panel" data-pid="${esc(p.pid)}">${head}<p class="muted">За этот период выкупов нет — разложить расходы на одну продажу нельзя.</p>
      ${c ? `<p class="small">Расходы за период: ${rub(c.mpCost + c.ads)}${c.ads ? `, из них реклама ${rub(c.ads)}` : ""}.</p>` : ""}</section>`;
    const q = c.units, price = c.rev / q;
    const vals = LINES.map(([f, name, src, color]) => {
      if (typeof src === "object") src = src[p.mp] || "";
      let v = c[f], how = `${src}. ${rub(v)} за период ÷ ${int(q)} шт`;
      if (f === "internal" && c.comp) { v = c.internal - c.comp; how += `; компенсации ${rub(c.comp)} вычтены`; }
      if (f === "cogs") { v = c.cost == null ? null : c.cogs; how = c.cost == null ? "Не указана — прибыль завышена" : `${rub(c.cost)} за 1 шт, из настроек`; }
      if (f === "vat") how = vatShare() ? `${state.vat}% внутри цены: выручка × ${state.vat}/${100 + state.vat}` : "Без НДС (меняется в настройках)";
      if (f === "ownCosts") how = cleanMoney(state.internal) ? `${rub2(state.internal)} на 1 шт, из настроек (упаковка, фулфилмент…)` : "Не указаны в настройках";
      if (f === "tax") how = taxRate() ? `${state.tax.rate}% ${state.tax.base === "profit" ? "от «доходы минус расходы»" : "от выручки"}${vatShare() ? " без НДС" : ""}` : "Не указан в настройках";
      return { f, name, how, color, unit: v == null ? null : v / q };
    }).filter((x) => (x.f !== "vat" || vatShare()) && (x.f !== "ownCosts" || cleanMoney(state.internal)));
    const spent = vals.reduce((s, x) => s + Math.max(0, x.unit || 0), 0);
    const unitProfit = c.profit / q;
    const scale = Math.max(price, spent) || 1;
    const segs = vals.filter((x) => x.unit > 0).map((x) => `<span style="width:${(x.unit / scale) * 100}%;background:${x.color}" title="${esc(x.name)}: ${rub(x.unit)}"></span>`).join("");
    const rest = unitProfit >= 0 ? `<span class="rest-profit" style="width:${(unitProfit / scale) * 100}%"></span>` : "";
    const mark = spent > price ? `<i class="fall-price" style="left:${(price / scale) * 100}%"></i>` : "";
    return `
      <section class="panel" data-pid="${esc(p.pid)}">
        ${head}
        <div class="fall" aria-hidden="true"><div class="fall-bar">${segs}${rest}${mark}</div>
          <div class="fall-cap"><span>Расходы ${rub(spent)}</span><span>${unitProfit >= 0 ? "Остаётся " + rub(unitProfit) : "Не хватает " + rub(-unitProfit)}</span></div></div>
        <ul class="lines">
          <li class="first"><i></i><span class="ttl">Цена продажи</span><span class="val">${rub(price)}</span>
            <span class="how">Выручка ${rub(c.rev)} ÷ ${int(q)} шт (выкуплено ${int(c.sold)}, возвратов ${int(c.ret)})</span></li>
          ${vals.map((x) => `<li><i class="dot" style="background:${x.color}"></i><span class="ttl">${x.name}</span>
            <span class="val">${x.unit == null ? "—" : Math.round(x.unit) === 0 ? "0 ₽" : x.unit < 0 ? "+" + rub(-x.unit) : "−" + rub(x.unit)}</span><span class="how">${esc(x.how)}</span></li>`).join("")}
          <li class="result"><i></i><span class="ttl">Чистая прибыль с 1 шт</span><span class="val ${signCls(unitProfit)}">${rub(unitProfit)}</span>
            <span class="how">Рентабельность ${pct(c.margin)} · ROI ${pct(c.roi)} · за период ${rub(c.profit)}${c.shared ? ` · из расходов ${rub(c.shared)} — общие расходы магазина, поделённые по выручке` : ""}</span></li>
        </ul>
        <div class="prices">
          <div><div class="k">Минимальная цена без убытка</div><div class="v">${rub(priceFor(c, 0))}</div></div>
          <div><div class="k">Цена для рентабельности ${state.thresholds.margin}%</div><div class="v">${rub(priceFor(c, state.thresholds.margin / 100))}</div></div>
        </div>
        <div class="whatif">
          <h3>Что если</h3>
          <p class="muted small">Меняется только здесь, в кабинеты ничего не уходит. Выкупы считаем теми же (принято).</p>
          <div class="whatif-grid">
            <div class="field"><label for="wp-${esc(p.pid)}">Цена, ₽</label><input type="number" inputmode="decimal" min="0" step="any" id="wp-${esc(p.pid)}" data-wi="price" value="${Math.round(price * 100) / 100}"></div>
            <div class="field"><label for="wa-${esc(p.pid)}">Реклама за период, ₽</label><input type="number" inputmode="decimal" min="0" step="any" id="wa-${esc(p.pid)}" data-wi="ads" value="${Math.round(c.ads * 100) / 100}"></div>
          </div>
          <div class="whatif-out" data-wi-out></div>
        </div>
      </section>`;
  }

  // ================= Заказы (как «Аналитика → Заказы» в LiteStat) =================
  function ordRows(from, to, scheme) {
    const take = (rows) => {
      const m = new Map();
      for (const r of rows || []) {
        if (r[0] < from || r[0] > to || !storeOk(r[1])) continue;
        const x = m.get(r[1]) || { qty: 0, sum: 0, cq: 0, cs: 0, unpriced: 0 };
        x.qty += r[2]; x.sum += r[3]; x.cq += r[4]; x.cs += r[5]; x.unpriced += r[6] ?? (r[3] === 0 && IX.prod.get(r[1])?.mp === "ozon" ? r[2] - r[4] : 0); m.set(r[1], x);
      }
      return m;
    };
    const all = take(D.orders);
    if (scheme === "all") return all;
    const fbs = take(D.ordersFbs);
    if (scheme === "fbs") return fbs;
    for (const [pid, f] of fbs) { const a = all.get(pid); if (a) { a.qty -= f.qty; a.sum -= f.sum; a.cq -= f.cq; a.cs -= f.cs; a.unpriced -= f.unpriced; } }
    return all;
  }
  let UNIT = null; // запомненные средние расходы на товар (пересчёт при смене магазина или данных)
  function unitCosts() {
    const tag = D.generatedAt + "|" + state.view.stores;
    if (UNIT && UNIT.tag === tag) return UNIT;
    const to = IX.finToMax, from = addDays(to, -27);
    const fin = aggFin(from, to, { allocate: false });
    const per = new Map(), store = new Map();
    const mk = (a) => {
      const units = a.sold - a.ret;
      return { commR: a.rev > 0 ? a.comm / a.rev : null, logiU: units > 0 ? a.logi / units : null,
        buy: a.sold > 0 ? (a.sold - a.ret) / a.sold : null };
    };
    const blank = () => ({ rev: 0, sold: 0, ret: 0, comm: 0, acq: 0, logi: 0, stor: 0, acc: 0, pen: 0, comp: 0 });
    for (const [pid, a] of fin.byP) {
      per.set(pid, mk(a));
      const sid = storeOf(pid), t = store.get(sid) || blank();
      for (const f in t) t[f] += a[f] || 0;
      store.set(sid, t);
    }
    const st = new Map([...store].map(([sid, a]) => [sid, mk(a)]));
    const recent = new Map((D.orderAverages || []).map(([pid, comm, logi, count]) => [pid, { comm, logi, count }]));
    UNIT = { tag, per, st, recent };
    return UNIT;
  }
  function ordCalc(pid, o, fact, expenses) {
    const U = unitCosts();
    const own = U.per.get(pid), sh = U.st.get(storeOf(pid)) || {};
    const pick = (f) => own?.[f] ?? sh[f] ?? 0;
    const qty = o.qty - o.cq, sum = o.sum - o.cs;
    const [covered, coveredSum, revenue, factComm, factLogi, ret, netSold, logiOnlyQty] = fact;
    const open = Math.max(0, qty - covered), openSum = sum - coveredSum;
    const estimate = U.recent.get(pid);
    const comm = factComm + (estimate ? open * estimate.comm : openSum * pick("commR"));
    const logi = factLogi + Math.max(0, open - logiOnlyQty) * (estimate?.logi ?? pick("logiU"));
    const income = revenue + openSum;
    const units = netSold + open;
    const cost = state.costs[IX.prod.get(pid)?.offerId];
    const cogs = typeof cost === "number" ? cost * units : 0;
    const ownCosts = units * cleanMoney(state.internal);
    const { ads, internal, comp } = expenses;
    const pre = income + comp - comm - logi - ads - internal - ownCosts - cogs;
    const useOzonForecast = state.ozonTaxForecast && state.tax.base === "revenue" && IX.stores.get(storeOf(pid))?.mp === "ozon";
    const grossTaxBase = Math.max(0, income) * (useOzonForecast ? 0.8 : 1);
    const vat = grossTaxBase * vatShare();
    const taxBase = state.tax.base === "profit" ? Math.max(0, pre - vat) : Math.max(0, grossTaxBase - vat);
    const t = taxRate();
    const tax = taxBase * t;
    return { pid, qty, sum, orders: o.qty, cq: o.cq, unpriced: o.unpriced, covered, ret, comm, logi, ads, internal, comp, ownCosts, cogs, vat, taxBase, tax, useOzonForecast,
      profit: pre - vat - tax, noCost: typeof cost !== "number" && units > 0,
      fallback: open > 0 && !estimate, noHist: open > 0 && !estimate && (own?.commR ?? sh.commR) == null, buy: pick("buy") };
  }
  function ordPeriod(from, to, scheme) {
    const m = ordRows(from, to, scheme);
    const all = scheme === "all" ? m : ordRows(from, to, "all");
    const fact = new Map();
    const factRows = [...(scheme === "fbs" ? [] : D.orderFinFbo || []), ...(scheme === "fbo" ? [] : D.orderFinFbs || [])];
    for (const r of factRows) {
      if (r[0] < from || r[0] > to || !m.has(r[1])) continue;
      const total = fact.get(r[1]) || Array(8).fill(0);
      for (let i = 0; i < total.length; i++) total[i] += r[i + 2];
      fact.set(r[1], total);
    }
    const fin = aggFin(from, to, { allocate: false });
    const fields = ["ads", "internal", "comp"];
    const expenses = (a) => a ? { ads: a.ads, internal: internalFromReport(a), comp: a.comp } : { ads: 0, internal: 0, comp: 0 };
    const byDay = new Map();
    for (const r of D.orders) {
      if (r[0] < from || r[0] > to || !all.has(r[1])) continue;
      byDay.set(r[0] + "|" + r[1], { all: r[2] - r[4], fbs: 0 });
    }
    for (const r of D.ordersFbs || []) {
      const day = byDay.get(r[0] + "|" + r[1]);
      if (day) day.fbs = r[2] - r[4];
    }
    const adsByProduct = new Map();
    for (const r of D.fin) {
      if (r[0] < from || r[0] > to || !m.has(r[1]) || !r[F.ads]) continue;
      const day = byDay.get(r[0] + "|" + r[1]);
      if (!day || day.all <= 0) continue;
      const qty = scheme === "fbs" ? day.fbs : scheme === "fbo" ? day.all - day.fbs : day.all;
      adsByProduct.set(r[1], (adsByProduct.get(r[1]) || 0) + r[F.ads] * qty / day.all);
    }
    const rows = [...m].map(([pid, o]) => {
      const full = all.get(pid);
      const own = expenses(fin.byP.get(pid));
      const qty = full.qty - full.cq;
      const share = scheme === "all" ? 1 : qty > 0 ? (o.qty - o.cq) / qty : 0;
      own.internal *= share;
      own.comp *= share;
      own.ads = adsByProduct.get(pid) || 0;
      return ordCalc(pid, o, fact.get(pid) || Array(8).fill(0), own);
    });
    const T = { orders: 0, cq: 0, unpriced: 0, covered: 0, qty: 0, sum: 0, comm: 0, logi: 0, ads: 0, internal: 0, comp: 0, ownCosts: 0, cogs: 0, vat: 0, taxBase: 0, tax: 0, profit: 0, ret: 0, buyW: 0, buyQ: 0 };
    const moneyAndQty = Object.keys(T).filter((f) => f !== "buyW" && f !== "buyQ");
    for (const r of rows) {
      for (const f of moneyAndQty) T[f] += r[f];
      if (r.buy != null) { T.buyW += r.buy * r.qty; T.buyQ += r.qty; }
    }
    if (scheme === "all") {
      const totalExpenses = expenses();
      for (const a of [...fin.byP.values(), ...fin.leftovers].map(expenses)) {
        for (const f of fields) totalExpenses[f] += a[f];
      }
      T.profit += (totalExpenses.comp - T.comp) - (totalExpenses.ads - T.ads) - (totalExpenses.internal - T.internal);
      Object.assign(T, totalExpenses);
    }
    T.buy = T.buyQ > 0 ? T.buyW / T.buyQ : null;
    T.rent = T.sum > 0 ? T.profit / T.sum : null;
    T.roi = T.cogs > 0 ? T.profit / T.cogs : null;
    T.drr = T.sum > 0 ? T.ads / T.sum : null;
    return { rows, T };
  }
  function ordByTime(from, to, scheme, hourly) {
    const qty = new Map(), sum = new Map();
    if (hourly) {
      for (const r of D.ordH || []) {
        if (r[0] < from || r[0] > to || !storeOk(r[1])) continue;
        const q = scheme === "fbs" ? r[5] : scheme === "fbo" ? r[3] - r[5] : r[3];
        const s = scheme === "fbs" ? r[6] : scheme === "fbo" ? r[4] - r[6] : r[4];
        qty.set(r[2], (qty.get(r[2]) || 0) + q); sum.set(r[2], (sum.get(r[2]) || 0) + s);
      }
    } else {
      const add = (rows, sign) => { for (const r of rows || []) { if (r[0] < from || r[0] > to || !storeOk(r[1])) continue;
        qty.set(r[0], (qty.get(r[0]) || 0) + sign * (r[2] - r[4])); sum.set(r[0], (sum.get(r[0]) || 0) + sign * (r[3] - r[5])); } };
      if (scheme === "fbs") add(D.ordersFbs, 1); else { add(D.orders, 1); if (scheme === "fbo") add(D.ordersFbs, -1); }
    }
    return { qty, sum };
  }
  function barChart(cols, cur, prev, labelOf, fmt, legend) {
    const W = Math.max(300, Math.min(900, (app.clientWidth || 600) - 64)), H = 200, padB = 22;
    const vals = cols.map((c) => cur.get(c) || 0), pv = prev ? cols.map((c) => prev.get(c) || 0) : [];
    const max = Math.max(1, ...vals, ...pv);
    const bw = W / cols.length;
    const y = (v) => H - padB - (v / max) * (H - padB - 14);
    const bars = vals.map((v, i) => `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${(H - padB - y(v)).toFixed(1)}" rx="2" class="bar"><title>${esc(labelOf(cols[i]))}: ${esc(fmt(v))}</title></rect>`).join("");
    const line = pv.length ? `<path class="prev" d="${pv.map((v, i) => `${i ? "L" : "M"}${(i * bw + bw / 2).toFixed(1)},${y(v).toFixed(1)}`).join("")}"/>` : "";
    const step = Math.ceil(cols.length / 8);
    const ticks = cols.map((c, i) => (i % step === 0 ? `<text x="${(i * bw + bw / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle">${esc(labelOf(c))}</text>` : "")).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(legend)}"><line x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" class="grid"/>
      <text x="${W}" y="${y(max) - 3}" text-anchor="end">${esc(fmt(max))}</text>${bars}${line}${ticks}</svg>`;
  }
  const deltaN = (cur, prev) => { // для расходов: без окраски «хорошо/плохо»
    if (!prev) return "";
    const d = (cur - prev) / Math.abs(prev);
    return `<span class="delta">${d >= 0 ? "+" : "−"}${nf0.format(Math.abs(d * 100))}%</span>`;
  };
  const METRIC_HELP = {
    name: "Товар и его артикул в выбранном магазине.",
    orders: "Все оформленные заказы в штуках, включая те, которые затем отменили.",
    cq: "Количество отменённых товаров по дате оформления заказа. Доля отмен — отменённые штуки ÷ все заказанные штуки.",
    sum: "Сумма и количество заказанных товаров за вычетом отмен. Сумма берётся по ценам из выгрузки заказов.",
    covered: "Доля неотменённых заказанных штук, по которым удалось связать продажу или возврат из отчёта с заказом.",
    ret: "Возвращённые штуки из отчётов, привязанные к дате оформления исходного заказа.",
    units: "Штуки из отчётов о продажах за вычетом возвращённых штук.",
    rev: "Выручка по отчётам маркетплейса за вычетом возвратов.",
    comm: "Вознаграждение маркетплейса. По связанным продажам берём начисления, по оставшимся штукам — среднее по последним 10 выкупленным заказам товара.",
    logi: "Доставка и возврат конкретных заказов. Используем начисления из отчёта и среднюю стоимость доставки по последним 10 выкупленным заказам для оставшихся штук.",
    ads: "Фактические расходы на рекламу за выбранные даты. В таблицу товара попадает расход на его заказы за день. Остальная реклама учитывается в общем итоге магазина.",
    internal: "Начисления из отчётов за выбранные даты. Сюда входят кросс-докинг, непредвиденная логистика, хранение, приёмка, утилизация, подписки, эквайринг, штрафы и другие услуги. Начисления без артикула входят в итог магазина.",
    comp: "Компенсации и прочие возмещения, полученные от маркетплейса по данным отчётов.",
    cogs: "Себестоимость одной штуки из настроек × количество штук с учётом известных возвратов.",
    ownCosts: "Ваши затраты на штуку из настроек, например упаковка или фулфилмент.",
    vat: "НДС по ставке из настроек. Доля НДС в сумме равна ставке, делённой на 100 плюс ставка.",
    taxBase: "База для расчёта налога после выделения НДС. Для прогноза Ozon можно включить коэффициент 0,8.",
    tax: "Налог по ставке и базе из настроек. При расчёте базы из доходов вычитается НДС.",
    forecast: "Выручка по связанным начислениям плюс сумма оставшихся заказов. Прибавляем компенсации, вычитаем расходы, себестоимость, НДС и налог. Комиссия и логистика оставшихся заказов рассчитаны по истории выкупов.",
    profit: "Выручка и компенсации по отчётам за период за вычетом фактических начислений площадки, рекламы, себестоимости, своих расходов, НДС и налога.",
    rent: "Прогноз прибыли ÷ сумма заказов без отмен × 100%.",
    margin: "Чистая прибыль ÷ выручка × 100%.",
    roi: "Прибыль ÷ себестоимость × 100%.",
    orderDrr: "Расходы на рекламу ÷ сумма заказов без отмен × 100%.",
    drr: "Расходы на рекламу ÷ выручка × 100%.",
    daily: "Сумма или количество заказов без отмен, делённые на число календарных дней периода.",
    buy: "Оценка по отчётам за последние 28 дней. Проданные штуки за вычетом возвратов делятся на проданные штуки. Для итога доли товаров взвешиваются по количеству заказов.",
    abc: "Группа товара по его вкладу в прибыль или выручку в зависимости от выбранного режима.",
    pay: "Сумма к перечислению по отчёту площадки до учёта ваших расходов, НДС и налога.",
  };
  function metricHelp(id, name, description = METRIC_HELP[id]) {
    if (!description) return "";
    return `<button type="button" class="metric-help" data-act="metric-help" data-label="${esc(name)}" data-help="${esc(description)}" aria-label="Что значит «${esc(name)}»?">?</button>`;
  }
  const ORDER_EXPENSES = [
    ["comm", "Комиссия"], ["logi", "Логистика"], ["ads", "Реклама"], ["internal", "Внутренние расходы"],
    ["comp", "Компенсации"], ["cogs", "Себестоимость"], ["taxBase", "База налога"], ["vat", "Невозвратный НДС"], ["tax", "Налог"], ["profit", "Прогноз прибыли"],
  ];
  function renderOrders() {
    const v = state.view;
    const preset = Number(v.ord) || 1, scheme = v.ordScheme || "all", unit = v.ordUnit === "qty" ? "qty" : "rub";
    const day = preset === 1 && !RANGE.ord ? clampDay(DAY.ord || IX.today, IX.ordMin, IX.today) : null;
    const end = day || IX.today;
    const { n, from, to } = customPeriod("ord") || { n: preset, from: addDays(end, 1 - preset), to: end };
    const pFrom = addDays(from, -n), pTo = addDays(from, -1);
    const cur = ordPeriod(from, to, scheme), prev = ordPeriod(pFrom, pTo, scheme);
    const T = cur.T, P = prev.T;
    const incomplete = T.unpriced > 0;
    const status = T.covered === 0 ? "прогноз" : T.covered < T.qty ? "факт и прогноз" : "по отчётам";
    const L = (id, name, val, d, hint) => `<li><span class="nm">${name} ${metricHelp(id, name)}${hint ? ` <span class="muted small">${hint}</span>` : ""}</span><span class="vl">${val}</span><span class="dl">${d || ""}</span></li>`;
    const neg = (x) => rub(-x);
    const hourly = n === 1;
    const tm = ordByTime(from, to, scheme, hourly), tp = ordByTime(pFrom, pTo, scheme, hourly);
    const cols = hourly ? [...Array(24).keys()] : Array.from({ length: n }, (_, i) => addDays(from, i));
    const prevMap = new Map();
    if (hourly) for (const c of cols) prevMap.set(c, (unit === "qty" ? tp.qty : tp.sum).get(c) || 0);
    else cols.forEach((c, i) => prevMap.set(c, (unit === "qty" ? tp.qty : tp.sum).get(addDays(pFrom, i)) || 0));
    const chart = barChart(cols, unit === "qty" ? tm.qty : tm.sum, prevMap, hourly ? (h) => `${String(h).padStart(2, "0")}ч` : (d) => dm(d),
      unit === "qty" ? (x) => int(x) + " шт" : (x) => rub(x), "Заказы " + (hourly ? "по часам" : "по дням"));
    const rows = cur.rows.filter((r) => r.orders > 0).sort((a, b) => b.sum - a.sum);
    const shown = rows.slice(0, listLimit);
    const noCost = rows.filter((r) => r.noCost).length, noHist = rows.filter((r) => r.noHist).length;
    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Заказы</h1>${seg("ord", [[1, "1 день"], [7, "7 дней"], [14, "14 дней"], [28, "28 дней"]], RANGE.ord ? "custom" : n, "Период")}</div>
      ${storeChips()}
      ${rangePicker("ord", from, to, IX.ordMin)}
      <div class="ord-ctl">${seg("ord-scheme", [["all", "Все схемы"], ["fbo", "FBO"], ["fbs", "FBS"]], scheme, "Схема")}</div>
      ${day ? dayPicker("ord", day, IX.ordMin, IX.today) : ""}
      <p class="updated">${n === 1 ? `За ${dmy(to)}${to === IX.today ? " (день ещё идёт)" : ""}` : `За ${dm(from)}–${dm(to)}`} · % — к ${n === 1 ? dm(pTo) : `${dm(pFrom)}–${dm(pTo)}`}</p>
      <div class="ord-grid">
        <section class="panel ord-kpi">
          <h2>Показатели</h2>
          <ul class="kv">
            ${L("orders", "Заказы", int(T.orders) + " шт", delta(T.orders, P.orders))}
            ${L("cq", "Отмены", int(T.cq) + " шт", deltaN(T.cq, P.cq), T.orders ? pct(T.cq / T.orders) : "")}
            ${L("sum", "Итого заказов", `<b>${incomplete ? "—" : rub(T.sum)} / ${int(T.qty)} шт</b>`, incomplete || P.unpriced ? "" : delta(T.sum, P.sum))}
            ${L("covered", "Фактические данные", pct(T.qty ? T.covered / T.qty : null))}
            ${L("ret", "Возвраты", int(T.ret) + " шт", deltaN(T.ret, P.ret))}
            ${L("comm", "Комиссия", neg(T.comm), deltaN(T.comm, P.comm), status)}
            ${L("logi", "Логистика", neg(T.logi), deltaN(T.logi, P.logi), status)}
            ${L("ads", "Реклама", neg(T.ads), deltaN(T.ads, P.ads))}
            ${L("internal", "Внутренние расходы", neg(T.internal), deltaN(T.internal, P.internal), "по отчётам")}
            ${L("comp", "Компенсации", rub(T.comp), deltaN(T.comp, P.comp))}
            ${L("cogs", "Себестоимость", neg(T.cogs), deltaN(T.cogs, P.cogs))}
            ${cleanMoney(state.internal) ? L("ownCosts", "Свои расходы", neg(T.ownCosts), deltaN(T.ownCosts, P.ownCosts)) : ""}
            ${L("vat", "Невозвратный НДС", neg(T.vat), deltaN(T.vat, P.vat), vatShare() ? state.vat + "%" : "без НДС")}
            ${L("taxBase", "Налогооблагаемая база", incomplete ? "—" : rub(T.taxBase))}
            ${L("tax", "Налог", neg(T.tax), deltaN(T.tax, P.tax), taxRate() ? state.tax.rate + "%" : `<a href="#/settings">не указан</a>`)}
            ${L("forecast", "Прогноз прибыли", `<b class="${signCls(T.profit)}">${incomplete ? "—" : rub(T.profit)}</b>`, incomplete || P.unpriced ? "" : delta(T.profit, P.profit))}
            ${L("rent", "Рентабельность", pct(incomplete ? null : T.rent))}
            ${L("roi", "ROI", pct(incomplete ? null : T.roi))}
            ${L("orderDrr", "ДРР", pct(incomplete ? null : T.drr))}
            ${L("daily", "Заказов в день", `${incomplete ? "—" : rub(T.sum / n)} / ${int(T.qty / n)} шт`)}
            ${L("buy", "Выкупаемость", pct(T.buy), "", "по отчётам 28 дн.")}
          </ul>
          ${noCost ? `<p class="banner small">Нет себестоимости у ${noCost} ${plural(noCost, "товара", "товаров", "товаров")} — их прибыль завышена. <a href="#/settings?filter=nocost">Указать</a></p>` : ""}
          ${incomplete ? `<p class="banner small">Нет цены у ${int(T.unpriced)} заказанных шт. Сумма заказов и общий прогноз прибыли появятся после загрузки цен.</p>` : ""}
          ${rows.some((r) => r.useOzonForecast) ? `<p class="muted small">Для Ozon в прогнозе налога и НДС применяется коэффициент 0,8. База из отчёта реализации за прошлый месяц пока недоступна.</p>` : ""}
          ${noReportNote(to, true)}
          ${rows.some((r) => r.fallback) ? `<p class="muted small">При отсутствии связанных выкупов используем средние из отчётов за 28 дней по товару или магазину.${noHist ? ` У ${noHist} товаров нет данных для оценки комиссии.` : ""}</p>` : ""}
        </section>
        <section class="panel ord-chart">
          <div class="abc-head"><h2>${hourly ? "По часам" : "По дням"}</h2>${seg("ord-unit", [["rub", "В рублях"], ["qty", "В штуках"]], unit, "Единицы")}</div>
          ${incomplete && unit === "rub" ? `<p class="muted small">Для графика в рублях пока не хватает цен заказов. Можно переключить на штуки.</p>` : chart}
          <p class="muted small">Столбики — ${hourly ? dmy(to) : "выбранный период"}, линия — ${hourly ? dm(pTo) : "предыдущий период"}. Время московское, отмены не входят.</p>
        </section>
      </div>
      <div class="list-head"><h2>По товарам <span class="muted small">${rows.length}</span></h2></div>
      <details class="panel" id="order-expenses">
        <summary>Расходы по товарам</summary>
        <div class="tbl-wrap scroll-x">
          <table class="report">
            <thead><tr><th scope="col">Артикул</th>${ORDER_EXPENSES.map(([f, l]) => `<th scope="col">${l} ${metricHelp(f === "profit" ? "forecast" : f, l)}</th>`).join("")}</tr></thead>
            <tbody>${shown.map((r) => `<tr><th scope="row">${esc(IX.prod.get(r.pid)?.offerId || r.pid)} · ${esc(storeName(storeOf(r.pid)))}</th>${ORDER_EXPENSES.map(([f]) => `<td>${r.unpriced && ["taxBase", "vat", "tax", "profit"].includes(f) || f === "cogs" && r.noCost ? "—" : rub(r[f])}</td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        </div>
      </details>
      <div class="tbl-wrap">
        <table class="items">
          <thead><tr>${[["name", "Товар"], ["orders", "Заказы, шт"], ["cq", "Отмены"], ["sum", "Сумма"], ["forecast", "Прогноз прибыли"], ["rent", "Рентаб."]].map(([id, label]) => `<th scope="col">${label} ${metricHelp(id, label)}</th>`).join("")}</tr></thead>
          <tbody>${shown.map((r) => { const p = IX.prod.get(r.pid) || { name: r.pid, offerId: "", store: storeOf(r.pid), mp: "" };
            return `<tr data-item="${esc(r.pid)}" tabindex="0"><td class="name">${thumb(p)}<div><b>${esc(p.name)}</b><span class="muted small">${chip(p.mp)} ${esc(storeName(p.store))} · ${esc(p.offerId)}${r.noCost ? " ⚪" : ""}</span></div></td>
              <td data-l="Заказы">${int(r.orders)}</td><td data-l="Отмены">${int(r.cq)}</td><td data-l="Сумма">${r.unpriced ? "—" : rub(r.sum)}</td>
              <td data-l="Прибыль" class="${signCls(r.profit)}">${r.unpriced ? "—" : rub(r.profit)}</td><td data-l="Рентаб.">${pct(!r.unpriced && r.sum > 0 ? r.profit / r.sum : null)}</td></tr>`; }).join("") || `<tr><td colspan="6" class="muted">За этот период заказов нет</td></tr>`}</tbody>
        </table>
      </div>
      ${rows.length > shown.length ? `<div class="more"><button class="btn" data-act="more">Показать ещё (${rows.length - shown.length})</button></div>` : ""}`;
  }

  // ================= Отчёт маркетплейса =================
  const REPORT_ROWS = [
    ["rev", "Продано (выручка)", 1], ["comm", "Комиссия", -1], ["logi", "Логистика", -1], ["ads", "Реклама", -1], ["comp", "Компенсации", 1], ["pay", "К перечислению", 0],
    ["cogs", "Себестоимость", -1], ["internal", "Внутренние расходы", -1], ["ownCosts", "Свои расходы", -1], ["vat", "НДС", -1], ["tax", "Налог", -1], ["profit", "Чистая прибыль", 2], ["margin", "Рентабельность (прибыль ÷ выручка)", 3], ["roi", "ROI (прибыль ÷ себестоимость)", 3]
  ];
  function periodsFor(kind, to) {
    const out = [];
    if (kind === "day") {
      // последние 14 дней, по одному дню в столбце
      for (let i = 13; i >= 0; i--) { const d = addDays(to, -i); out.push([d, d, dm(d)]); }
    } else if (kind === "week") {
      // недели пн–вс, последние 8
      const d = new Date(to + "T00:00:00Z"); const dow = (d.getUTCDay() + 6) % 7;
      let end = addDays(to, 6 - dow > 0 && dow !== 6 ? -dow - 1 : 0);
      if (dow === 6) end = to;
      for (let i = 0; i < 8; i++) { const s = addDays(end, -6); out.unshift([s, end, `${dm(s)}–${dm(end)}`]); end = addDays(s, -1); }
      if (end < to && out[out.length - 1][1] < to) out.push([addDays(out[out.length - 1][1], 1), to, `${dm(addDays(out[out.length - 1][1], 1))}–${dm(to)}`]);
    } else {
      let y = Number(to.slice(0, 4)), m = Number(to.slice(5, 7));
      for (let i = 0; i < 3; i++) {
        const s = `${y}-${String(m).padStart(2, "0")}-01`;
        const e0 = addDays(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01`, -1);
        out.unshift([s, e0 > to ? to : e0, new Date(s + "T00:00:00Z").toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" })]);
        m--; if (!m) { m = 12; y--; }
      }
    }
    return out;
  }
  function reportData(kind) {
    const per = periodsFor(kind, IX.finToMax);
    const cols = per.map(([from, to, label]) => {
      const fin = aggFin(from, to, { allocate: false });
      const t = { rev: 0, comm: 0, logi: 0, stor: 0, acc: 0, pen: 0, acq: 0, ads: 0, comp: 0, pay: 0, cogs: 0, internal: 0, ownCosts: 0, vat: 0, tax: 0, profit: 0 };
      for (const [pid, a] of fin.byP) { const c = calc(pid, a); for (const k in t) t[k] += c[k] || 0; }
      for (const l of fin.leftovers) { const c = calc("*" + l.storeId, l); for (const k in t) t[k] += c[k] || 0; }
      t.margin = t.rev > 0 ? t.profit / t.rev : null;
      t.roi = t.cogs > 0 ? t.profit / t.cogs : null;
      return { label, from, to, t };
    });
    const total = { rev: 0, comm: 0, logi: 0, stor: 0, acc: 0, pen: 0, acq: 0, ads: 0, comp: 0, pay: 0, cogs: 0, internal: 0, ownCosts: 0, vat: 0, tax: 0, profit: 0 };
    for (const c of cols) for (const k in total) total[k] += c.t[k];
    total.margin = total.rev > 0 ? total.profit / total.rev : null;
    total.roi = total.cogs > 0 ? total.profit / total.cogs : null;
    return { cols, total };
  }
  function renderReport() {
    const kind = state.view.report;
    const { cols, total } = reportData(kind);
    const cell = (k, v) => (k === "margin" || k === "roi" ? pct(v) : rub(v));
    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Отчёт маркетплейса</h1>${seg("report", [["day", "По дням"], ["week", "По неделям"], ["month", "По месяцам"]], kind, "Разбивка")}</div>
      ${storeChips()}
      <p class="updated">Данные отчётов: ${D.stores.map((s) => `${esc(s.name)} по ${dm(s.finTo)}`).join(" · ")}. Последний столбец может быть неполным.</p>
      <div class="report-chart">${reportBars(cols)}</div>
      <div class="list-head"><h2>Сводные данные</h2><button class="btn" data-act="csv-report">Скачать CSV</button></div>
      <div class="tbl-wrap scroll-x">
        <table class="report">
          <thead><tr><th scope="col">Показатель</th>${cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join("")}<th scope="col">Весь период</th></tr></thead>
          <tbody>${REPORT_ROWS.map(([k, l, s]) => `<tr class="${s >= 2 ? "strong" : s === 0 ? "sub" : ""}"><th scope="row">${l} ${metricHelp(k, l, k === "comm" ? "Фактическая комиссия из отчётов о продажах." : k === "logi" ? "Фактическая доставка и возврат заказов по отчётам." : k === "ads" ? "Фактические расходы на рекламу из данных площадок." : undefined)}</th>${cols.map((c) => `<td class="${k === "profit" ? signCls(c.t[k]) : ""}">${cell(k, c.t[k])}</td>`).join("")}<td class="${k === "profit" ? signCls(total[k]) : ""}"><b>${cell(k, total[k])}</b></td></tr>`).join("")}</tbody>
        </table>
      </div>
      <p class="muted small">Расходы показаны положительными числами. Себестоимость = выкупы минус возвраты × себестоимость из настроек. «К перечислению» — что площадка перечисляет вам до себестоимости, НДС и налога.</p>`;
  }
  function reportBars(cols) {
    const max = Math.max(1, ...cols.map((c) => c.t.rev));
    return `<div class="bars" role="img" aria-label="Выручка и прибыль по периодам">${cols.map((c) => `<div class="bar-col">
      <div class="bar-stack"><span class="b-rev" style="height:${(c.t.rev / max) * 100}%" title="Выручка ${rub(c.t.rev)}"></span>
      <span class="b-pr ${c.t.profit < 0 ? "neg" : ""}" style="height:${(Math.abs(c.t.profit) / max) * 100}%" title="Прибыль ${rub(c.t.profit)}"></span></div>
      <span class="bar-l">${esc(c.label.replace(/ \d{4} г\.$/, ""))}</span></div>`).join("")}</div>
      <div class="bar-legend"><span><i class="b-rev"></i>Выручка</span><span><i class="b-pr"></i>Чистая прибыль</span></div>`;
  }

  // ================= РНП =================
  const rnpRatio = (value, base) => Number.isFinite(value) && base > 0 ? value / base : null;

  const rnpImports = () => {
    try { return JSON.parse(ls.get(D.demo ? "unitka.rnp.demo" : "unitka.rnp")) || {}; }
    catch { return {}; }
  };

  function combineRnpRows(original, updates) {
    const result = indexRnpRows(original);
    for (const row of updates) {
      const id = JSON.stringify(row.slice(0, 2));
      result.set(id, [row[0], row[1], { ...result.get(id)?.[2], ...row[2] }]);
    }
    return [...result.values()];
  }

  function addRnpValues(target, values) {
    for (const [metric, value] of Object.entries(values)) {
      if (Number.isFinite(value)) target[metric] = (target[metric] ?? 0) + value;
    }
  }

  function rnpHistory(products) {
    const end = addDays(IX.today, -14);
    const start = addDays(end, -27);
    const history = new Map(products.map((p) => [p.pid, {}]));
    for (const [date, pid, qty, , cancelled] of D.orders) {
      if (date >= start && date <= end && history.has(pid)) addRnpValues(history.get(pid), { orders: qty - cancelled });
    }
    for (const [date, pid, , , , , , , sold] of [...(D.orderFinFbo || []), ...(D.orderFinFbs || [])]) {
      const finTo = IX.stores.get(storeOf(pid))?.finTo;
      if (date >= start && date <= end && finTo >= end && history.has(pid)) {
        addRnpValues(history.get(pid), { sold });
      }
    }
    const fin = new Map();
    for (const row of D.fin) {
      if (!history.has(row[1])) continue;
      const last = IX.stores.get(storeOf(row[1]))?.finTo;
      if (!last || row[0] > last || row[0] < addDays(last, -27)) continue;
      if (!fin.has(row[1])) fin.set(row[1], {});
      addRnpValues(fin.get(row[1]), Object.fromEntries(Object.entries(F).slice(2).map(([field, i]) => [field, row[i] ?? 0])));
    }
    for (const [pid, values] of history) {
      const row = fin.get(pid);
      const units = row ? row.sold - row.ret : 0;
      values.buy = rnpRatio(values.sold, values.orders);
      if (values.buy < 0 || values.buy > 1) values.buy = null;
      values.commission = row && units > 0 ? rnpRatio(row.comm, row.rev) : null;
      values.costPerSale = row ? rnpRatio(row.logi + internalFromReport(row), units) : null;
    }
    return history;
  }

  function rnpForecast(pid, row, history) {
    if (!(row.orders > 0)) return { forecastProfit: row.spend == null ? null : -row.spend };
    const cost = state.costs[IX.prod.get(pid)?.offerId];
    const store = storeOf(pid);
    if (IX.stores.get(store)?.mp === "ozon") {
      const inputs = state.pulstat.inputs[store] || {};
      const saved = state.pulstat.products[pid];
      return pulstatForecast(row, cost, inputs, { buy: row.windowBuy != null ? row.windowBuy * 100 : null, ...saved });
    }
    if (row.unpriced || !(row.orderSum > 0) || row.spend == null || !Number.isFinite(state.tax.rate) ||
        !Number.isFinite(cost) || history?.buy == null ||
        (history.buy > 0 && (history.commission == null || history.costPerSale == null))) {
      return { forecastMissing: 1 };
    }
    const units = row.orders * history.buy;
    const revenue = row.orderSum * history.buy;
    const cogs = units * cost;
    const pre = revenue - revenue * (history.commission ?? 0) -
      units * ((history.costPerSale ?? 0) + state.internal) - cogs - row.spend;
    const vat = revenue * vatShare();
    const taxBase = state.tax.base === "profit" ? pre - vat : revenue - vat;
    return { forecastProfit: pre - vat - Math.max(0, taxBase) * taxRate(), forecastRevenue: revenue, forecastCogs: cogs, forecastOrders: row.orders };
  }

  // PULSTAT: ноябрьская РНП, строки 192–194. Ставки формы заданы в процентах.
  function pulstatForecast(row, cost, inputs, product) {
    const missing = {
      pulstatMissingPrice: row.unpriced || !(row.orderSum > 0),
      pulstatMissingAds: !Number.isFinite(row.spend),
      pulstatMissingCost: !Number.isFinite(cost),
      pulstatMissingInputs: !PULSTAT_INPUTS.every(([field]) => Number.isFinite(inputs[field])),
      pulstatMissingProduct: !PULSTAT_PRODUCT.every(([field]) => Number.isFinite(product?.[field]))
    };
    if (Object.values(missing).some(Boolean)) {
      return { forecastMissing: 1, ...Object.fromEntries(Object.entries(missing).filter(([, absent]) => absent).map(([field]) => [field, row.orders])) };
    }
    const buy = product.buy / 100;
    const sellerPrice = row.orderSum / row.orders;
    const buyerPrice = sellerPrice * (row.pulstatBuyerFactor ?? 1);
    const vat = inputs.vat / 100;
    const tax = (1 - vat) * inputs.tax / 100 + vat;
    const adjustedCost = cost * (1 + inputs.loss / 100);
    const orderDrr = row.spend / row.orderSum;
    const failedDelivery = (2 * product.logistics + inputs.delivery + inputs.returns) * (1 - buy) / buy;
    const margin = (sellerPrice * (1 - product.commission / 100 - inputs.acquiring / 100 - orderDrr / buy) -
      buyerPrice * tax - adjustedCost - product.logistics - sellerPrice * product.nonlocal / 100 -
      inputs.delivery - failedDelivery) / sellerPrice;
    const revenue = row.orderSum * buy;
    const profit = margin * revenue;
    return { forecastProfit: profit || -row.spend, forecastRevenue: revenue, pulstatMargin: margin,
      forecastCogs: row.orders * buy * adjustedCost, forecastOrders: row.orders };
  }

  function rnpColumns(selected, product, storeIds, dates, imports) {
    const byDate = new Map(dates.map((date) => [date, new Map()]));
    const visibleStores = new Set(storeIds);
    const history = rnpHistory(selected);
    const totals = {};
    const reportIndex = indexRnpRows(D.orderReport || []);
    for (const row of imports.orders || []) {
      const id = JSON.stringify(row.slice(0, 2));
      const existing = reportIndex.get(id);
      if (!existing || (row[2]?.orders ?? 0) >= (existing[2]?.orders ?? 0)) reportIndex.set(id, row);
    }
    const reports = [...reportIndex.values()];
    const priceRows = bestPriceRows(D.orderPrices || [], reports);
    function collect(rows, values) {
      for (const row of rows) {
        const items = byDate.get(row[0]);
        if (!items || !visibleStores.has(storeOf(row[1])) || (product && row[1] !== product.pid)) continue;
        if (!items.has(row[1])) items.set(row[1], {});
        addRnpValues(items.get(row[1]), values(row));
      }
    }
    collect(D.orders, (r) => ({
      orders: r[2] - r[4], orderSum: r[3] - r[5], cancelledOrders: r[4],
      unpriced: r[6] ?? (r[3] === 0 && IX.prod.get(r[1])?.mp === "ozon" ? r[2] - r[4] : 0)
    }));
    collect(priceRows, (r) => ({ pairedQty: r[2], sellerAmount: r[3], buyerAmount: r[4] }));
    collect(reports, ([, , row]) => ({ ...row, reportOrders: row.orders, reportCancelled: row.cancelled,
      reportDelivered: row.delivered, orders: null, cancelled: null, delivered: null, pairedQty: null, sellerAmount: null, buyerAmount: null }));
    const metrics = combineRnpRows(D.funnel || [], imports.metrics || []);
    collect(metrics, ([, , row]) => {
      const { stock, transit, fromClient, price, delivery, ...fields } = row;
      return { ...fields, manualDelivery: delivery };
    });
    const pulstatPrices = new Map();
    for (const [date, pid, , seller, buyer] of priceRows) {
      if (IX.stores.get(storeOf(pid))?.mp !== "ozon" || !visibleStores.has(storeOf(pid))) continue;
      for (let i = 0; i < 7; i++) {
        const day = addDays(date, i);
        if (!byDate.has(day)) continue;
        const group = day + "|" + pid;
        if (!pulstatPrices.has(group)) pulstatPrices.set(group, {});
        addRnpValues(pulstatPrices.get(group), { seller, buyer });
      }
    }
    for (const linked of [D.orderFinFbo, D.orderFinFbs]) {
      collect(linked || [], (r) => r[2] > 0 ? { linkedOrders: r[2], linkedSales: r[8] } : {});
    }
    const finFields = Object.entries(F).slice(2).filter(([field]) => field !== "ads");
    collect(D.fin, (r) => {
      const store = IX.stores.get(storeOf(r[1]));
      const covered = store?.finTo && r[0] <= store.finTo;
      return {
        sales: covered ? r[F.rev] : null,
        units: covered ? r[F.sold] - r[F.ret] : null,
        spend: covered && store.mp === "ozon" ? r[F.ads] ?? 0 : null,
        ozonSpend: covered && store.mp === "ozon" ? r[F.ads] ?? 0 : null,
        ...Object.fromEntries(finFields.map(([field, i]) => [field, covered ? r[i] ?? 0 : null]))
      };
    });
    collect(D.ads || [], (r) => ({ impressions: r[3], clicks: r[4], wbSpend: r[2], spend: r[2] }));
    const columns = dates.map((date) => {
      const day = {};
      const stores = new Map(storeIds.map((id) => {
        const store = IX.stores.get(id);
        const updated = store.updatedAt ? dayStr(new Date(store.updatedAt)) : null;
        const warnings = store.warnings || [];
        const ordersCovered = updated && date <= updated && date >= (store.orderFrom || addDays(updated, -60)) &&
          !warnings.some((warning) => /^Заказы FB[OS] Ozon:/.test(warning));
        const finCovered = store.finTo && date <= store.finTo && date >= (store.finFrom || addDays(store.finTo, -89));
        const wbAdsCovered = store.mp === "wb" && updated && date <= updated && date >= addDays(updated, -90) &&
          Array.isArray(D.ads) && !warnings.some((warning) => warning.startsWith("Реклама WB:"));
        return [id, { values: {}, finCovered, ordersCovered, adsCovered: store.mp === "ozon" ? finCovered : wbAdsCovered }];
      }));
      for (const [pid, row] of byDate.get(date)) {
        const store = stores.get(storeOf(pid));
        if (row.orders == null && row.listedOrders != null) {
          row.orders = row.listedOrders;
          row.unpriced = row.listedOrderSum == null ? row.listedOrders : 0;
          row.orderSum = row.listedOrderSum;
        } else if (row.unpriced && row.listedOrders === row.orders && row.listedOrderSum > 0) {
          row.orderSum = row.listedOrderSum;
          row.unpriced = 0;
        }
        if (row.orders == null && row.reportOrders != null) {
          row.orders = row.reportOrders;
          row.unpriced = Math.max(0, row.reportOrders - (row.knownOrderPrices ?? 0));
          row.orderSum = row.reportSellerAmount;
        } else if (row.unpriced && row.knownOrderPrices === row.orders && row.reportSellerAmount > 0) {
          row.orderSum = row.reportSellerAmount;
          row.unpriced = 0;
        }
        row.cancelledOrders ??= row.listedCancelled ?? row.reportCancelled;
        row.sales ??= row.listedSales;
        row.units ??= row.listedSalesUnits;
        row.saleReturns = row.ret ?? row.listedReturns;
        if (row.manualDelivery != null) {
          const weight = row.reportDelivered ?? row.funnelDelivered ?? row.funnelOrders ?? 1;
          row.deliveryDays = row.manualDelivery * Math.max(1, weight);
          row.deliveryUnits = Math.max(1, weight);
        }
        if (row.position > 0) {
          row.positionWeight = row.searchViews > 0 ? row.searchViews : 1;
          row.positionTotal = row.position * row.positionWeight;
        }
        if (row.buyoutPercent != null && row.funnelOrders > 0) {
          row.buyObservedTotal = row.buyoutPercent * row.funnelOrders / 100;
          row.buyObservedOrders = row.funnelOrders;
        } else if (row.funnelDelivered != null && row.funnelCancelled != null) {
          const units = row.funnelDelivered + row.funnelCancelled;
          row.buyObservedTotal = Math.max(0, row.funnelDelivered - (row.funnelReturns ?? 0));
          row.buyObservedOrders = units;
        }
        if (row.buyWindowDelivered != null && row.buyWindowCancelled != null) {
          const volume = row.buyWindowDelivered + row.buyWindowCancelled;
          const buy = rnpRatio(row.buyWindowDelivered - (row.buyWindowReturned ?? 0), volume);
          if (buy != null && buy > 0 && buy <= 1) {
            row.windowBuy = buy;
            row.windowBuyTotal = buy * volume;
            row.windowBuyBase = volume;
          }
        }
        const cardVisits = row.uniqueOpens != null ? "uniqueOpens" : "opens";
        for (const [name, numerator, denominator] of [
          ["frequency", "views", "visitors"], ["organicCtr", cardVisits, "visitors"], ["cartCr", "carts", cardVisits],
          ["orderCr", "funnelOrders", "carts"], ["viewOrderCr", "funnelOrders", "visitors"],
          ["placementCtr", "placementClicks", "placementViews"], ["placementCpc", "placementSpend", "placementClicks"],
          ["searchCtr", "searchAdClicks", "searchAdViews"], ["searchCpc", "searchAdSpend", "searchAdClicks"]
        ]) {
          if (row[numerator] != null && row[denominator] != null) {
            row[name + "Value"] = row[numerator];
            row[name + "Base"] = row[denominator];
          }
        }
        const outsideSearch = row.searchViews == null ? null : row.views - row.searchViews;
        const outsideCategory = row.nonCategoryViews ?? outsideSearch;
        if (row.views != null && outsideCategory != null && outsideCategory >= 0 && outsideCategory <= row.views) {
          row.nonSearchViews = outsideCategory;
          row.nonSearchBase = row.views;
        }
        if (row.placementSpend != null || row.searchAdSpend != null || row.orderAdSpend != null) {
          row.spend ??= (row.placementSpend ?? 0) + (row.searchAdSpend ?? 0) + (row.orderAdSpend ?? 0);
        }
        if (store.adsCovered) row.spend ??= 0;
        const pair = pulstatPrices.get(date + "|" + pid);
        if (!(row.rollingBuyer > 0 && row.rollingBuyer <= row.rollingSeller)) {
          row.rollingSeller = pair?.seller;
          row.rollingBuyer = pair?.buyer;
        }
        row.pulstatBuyerFactor = rnpRatio(row.rollingBuyer, row.rollingSeller);
        addRnpValues(store.values, row);
        addRnpValues(day, rnpForecast(pid, row, history.get(pid)));
        if (row.orders > 0) {
          const buy = IX.stores.get(storeOf(pid))?.mp === "ozon"
            ? rnpRatio(state.pulstat.products[pid]?.buy, 100) ?? row.windowBuy : history.get(pid)?.buy;
          addRnpValues(day, buy == null ? { unknownBuy: row.orders } : { expectedUnits: row.orders * buy });
        }
        if (store.finCovered && (row.rev || row.units || row.spend || COST_KEYS.some((field) => row[field]) || row.comp)) {
          const fact = Object.fromEntries(Object.keys(F).slice(2).map((field) => [field, row[field] ?? 0]));
          fact.ads = row.spend ?? 0;
          const result = calc(pid, fact);
          const missing = !Number.isFinite(row.spend) || !Number.isFinite(state.tax.rate) ||
            (result.cost == null && result.units !== 0);
          addRnpValues(day, missing ? { factMissing: 1 } : { factProfit: result.profit, factRevenue: result.rev });
        }
      }
      for (const [id, { values: store, finCovered, ordersCovered, adsCovered }] of stores) {
        if (ordersCovered) {
          store.orders ??= 0;
          store.orderSum ??= 0;
          store.cancelledOrders ??= 0;
        }
        if (finCovered) {
          store.sales ??= 0;
          store.units ??= 0;
          store.saleReturns ??= 0;
        }
        if (adsCovered) {
          store.spend ??= 0;
          if (IX.stores.get(id).mp === "ozon") store.ozonSpend ??= 0;
        }
        addRnpValues(day, store);
        if (store.spend != null && store.orderSum != null && !store.unpriced) {
          addRnpValues(day, { orderSpend: store.spend, matchedOrders: store.orderSum });
        }
        if (store.spend != null && store.sales != null) {
          addRnpValues(day, { salesSpend: store.spend, matchedSales: store.sales });
        }
        if (!finCovered) addRnpValues(day, { factUnclosed: 1 });
        else if (!adsCovered) addRnpValues(day, { factMissing: 1 });
        if (!adsCovered && store.spend == null) addRnpValues(day, { adsUnclosed: 1 });
        if (!adsCovered || !ordersCovered) addRnpValues(day, { forecastMissing: 1 });
      }
      const { factProfit, factRevenue, factMissing, factUnclosed, forecastProfit, forecastRevenue, forecastCogs, forecastMissing,
        adsUnclosed, rollingSeller, rollingBuyer, windowBuyTotal, windowBuyBase, ...metrics } = day;
      addRnpValues(totals, metrics);
      if (rollingSeller > 0) Object.assign(totals, { rollingSeller, rollingBuyer });
      if (windowBuyBase > 0) Object.assign(totals, { windowBuyTotal, windowBuyBase });
      if (!factUnclosed && day.sales != null) addRnpValues(totals, { stockDays: 1, stockSales: day.units });
      if (factProfit != null || (!factMissing && !factUnclosed && day.sales != null)) {
        day.factProfit = factProfit ?? 0;
        day.factRevenue = factRevenue ?? 0;
        addRnpValues(totals, { factProfit: day.factProfit, factRevenue: day.factRevenue, factDays: 1 });
        if (factMissing || factUnclosed) addRnpValues(totals, { partialFactDays: 1 });
      }
      if (day.forecastOrders > 0 || forecastProfit || (!forecastMissing && day.orders != null)) {
        day.forecastProfit = forecastProfit ?? 0;
        addRnpValues(totals, { forecastProfit: day.forecastProfit, forecastRevenue, forecastCogs });
      } else {
        day.forecastProfit = null;
      }
      return day;
    });
    const stocks = indexRnpRows(D.stockHistory || []);
    for (const p of selected) {
      const stock = stockOf(p.pid);
      if (stock == null) continue;
      const store = IX.stores.get(storeOf(p.pid));
      const updated = store?.updatedAt ? dayStr(new Date(store.updatedAt)) : null;
      if (!byDate.has(updated)) continue;
      const id = JSON.stringify([updated, p.pid]);
      if (stocks.has(id)) continue;
      const partial = store.stockPartial || store.warnings?.some((warning) => /^Остатки.*WB:/.test(warning));
      const source = D.stocks[p.pid];
      stocks.set(id, [updated, p.pid, { stock, price: p.price, stockPartial: partial,
        transit: store.mp === "wb" && !partial ? source.toClient : null,
        fromClient: store.mp === "wb" && !partial ? source.fromClient : null }]);
    }
    const manualStocks = (imports.metrics || []).filter(([, , values]) =>
      values.stock != null || values.transit != null || values.fromClient != null || values.price != null);
    const productIndex = new Map(selected.map((p) => [p.pid, p]));
    const dateIndex = new Map(dates.map((date, index) => [date, index]));
    const lastSnapshot = new Map();
    for (const [date, pid, values] of combineRnpRows([...stocks.values()], manualStocks)) {
      const index = dateIndex.get(date), p = productIndex.get(pid);
      if (index == null || !p) continue;
      const { stock, transit, fromClient, price, stockPartial } = values;
      const cost = state.costs[p.offerId];
      const quantity = Number.isFinite(stock) ? stock + (transit ?? 0) : null;
      const snapshot = {
        stock, inStock: stock == null ? null : Number(stock > 0), listed: stock == null ? null : 1,
        stockPartial: stockPartial ? 1 : 0, transit, fromClient,
        stockCost: quantity === 0 || Number.isFinite(cost) && quantity != null ? quantity * (cost ?? 0) : null,
        stockMissingCost: quantity > 0 && !Number.isFinite(cost) ? 1 : 0,
        stockValue: quantity === 0 || price > 0 && quantity != null ? quantity * price : null,
        stockMissingPrice: quantity > 0 && !(price > 0) ? 1 : 0
      };
      addRnpValues(columns[index], snapshot);
      if (lastSnapshot.get(pid)?.date <= date || !lastSnapshot.has(pid)) lastSnapshot.set(pid, { date, snapshot });
    }
    for (const { snapshot } of lastSnapshot.values()) addRnpValues(totals, snapshot);
    return { dates, columns, totals };
  }

  function pulstatFields(fields, values) {
    return fields.map(([field, label]) => `<label class="field">${label}
      <input type="number" name="${field}" inputmode="decimal" min="${field === "buy" ? "0.000001" : "0"}"
        ${label.endsWith("%") ? 'max="100"' : ""} step="any" value="${values[field] ?? ""}" placeholder="—">
    </label>`).join("");
  }

  function pulstatSettings(products, current) {
    if (!products.length) return "";
    return `<details class="rnp-method pulstat-settings">
      <summary>Вводные PULSTAT · Ozon</summary>
      <p>Задай параметры магазина и товара. Себестоимость берётся из <a href="#/settings">настроек «Юнитки»</a>. Кнопка подставляет ставки и расходы из образца, чтобы их можно было сверить перед сохранением.</p>
      <form id="pulstat-form">
        <fieldset><legend>Магазин и товар</legend>
          <label class="field">Артикул <select name="pid">${products.map((p) =>
            `<option value="${esc(p.pid)}"${p === current ? " selected" : ""}>${esc(p.offerId || p.sku)} · ${esc(p.name || "")} · ${esc(storeName(p.store))}</option>`).join("")}</select></label>
        </fieldset>
        <fieldset><legend>Вводные магазина Ozon</legend><div class="pulstat-fields" id="pulstat-store-fields"></div>
          <button class="btn" type="button" id="pulstat-example">Подставить значения образца</button>
        </fieldset>
        <fieldset><legend>Параметры артикула из Unit</legend>
          <div class="pulstat-fields" id="pulstat-product-fields"></div>
        </fieldset>
        <button class="btn primary" type="submit">Сохранить вводные</button>
      </form>
    </details>`;
  }

  function bindPulstatSettings() {
    const form = app.querySelector("#pulstat-form");
    if (!form) return;
    const select = form.elements.namedItem("pid");
    const storeFields = form.querySelector("#pulstat-store-fields");
    const productFields = form.querySelector("#pulstat-product-fields");
    let currentStore;
    const showProduct = () => {
      const store = storeOf(select.value);
      if (store !== currentStore) {
        storeFields.innerHTML = pulstatFields(PULSTAT_INPUTS, state.pulstat.inputs[store] || {});
        currentStore = store;
      }
      productFields.innerHTML = pulstatFields(PULSTAT_PRODUCT, state.pulstat.products[select.value] || {});
    };
    showProduct();
    select.addEventListener("change", showProduct);
    form.querySelector("#pulstat-example").addEventListener("click", () => {
      for (const [field, , example] of PULSTAT_INPUTS) form.elements.namedItem(field).value = example;
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const pid = select.value;
      const read = (fields) => pulstatValues(Object.fromEntries(fields.map(([field]) =>
        [field, form.elements.namedItem(field).valueAsNumber])), fields);
      state.pulstat.inputs[storeOf(pid)] = read(PULSTAT_INPUTS);
      state.pulstat.products[pid] = read(PULSTAT_PRODUCT);
      save();
      render();
      const updated = app.querySelector("#pulstat-form");
      updated.closest("details").open = true;
      updated.elements.namedItem("pid").value = pid;
      updated.elements.namedItem("pid").dispatchEvent(new Event("change"));
      toast("Вводные PULSTAT сохранены");
    });
  }

  function rnpReportControls(stores) {
    return `<details class="rnp-method pulstat-settings">
      <summary>Загрузить данные РНП из отчёта</summary>
      <p>Можно загрузить отчёт Ozon об отправлениях, лист «Техлист» с дневными показателями или параметры товаров из Unit. Для связки по названию сначала загрузи «Техлист». Отдельные отчёты FBO и FBS выбирай одновременно. Импорт применяется в этом браузере к выбранному магазину.</p>
      <form id="rnp-import" class="rnp-import">
        <label class="field">Магазин<select name="store">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} · ${mpName(s.mp)}</option>`).join("")}</select></label>
        <label class="field">Что загружаем<select name="kind"><option value="orders">Отправления Ozon</option><option value="metrics">Техлист или показатели по дням</option><option value="inputs">Параметры артикулов из Unit</option></select></label>
        <label class="field">Файлы CSV или XLSX<input name="files" type="file" accept=".csv,.tsv,.xlsx" multiple required></label>
        <div class="btn-row">
          <button class="btn primary" type="submit">Загрузить</button>
          <button class="btn" type="button" id="rnp-template">Скачать шаблон</button>
        </div>
        <p class="small" id="rnp-import-status" role="status"></p>
      </form>
    </details>`;
  }

  function bindRnpReports() {
    const form = app.querySelector("#rnp-import");
    if (!form) return;
    const field = (name) => form.elements.namedItem(name);
    const status = form.querySelector("#rnp-import-status");
    form.querySelector("#rnp-template").addEventListener("click", () => {
      const kind = field("kind").value;
      const headers = kind === "inputs" ? ["Артикул продавца", "SKU", "Себестоимость, ₽", ...PULSTAT_PRODUCT.map(([, label]) => label)] :
        kind === "metrics" ? ["Дата", "Артикул продавца", "SKU", ...Object.values(RNP_METRICS).map(([label]) => label)] :
          ["Номер отправления", "Принят в обработку", "Статус", "SKU", "Артикул", "Предельная цена", "Оплачено покупателем", "Количество", "Дата доставки"];
      download("unitka-rnp-" + kind + ".csv", csv([headers]), "text/csv;charset=utf-8");
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const sid = field("store").value, kind = field("kind").value;
      if (kind !== "metrics" && IX.stores.get(sid)?.mp !== "ozon") {
        status.textContent = "Этот формат нужен для магазина Ozon.";
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      status.textContent = "Читаю файлы…";
      const products = D.products.filter((p) => storeOf(p.pid) === sid);
      const saved = rnpImports();
      const skus = new Map(products.filter((p) => p.sku).map((p) => [String(p.sku), p.pid]));
      const offers = new Map(), names = new Map();
      for (const p of products) {
        if (p.offerId) offers.set(p.offerId, offers.has(p.offerId) ? null : p.pid);
        if (p.name) names.set(p.name, names.has(p.name) ? null : p.pid);
      }
      const storedAliases = saved.aliases?.[sid] || {};
      const resolve = (sku, offer, name) => skus.get(sku) || offers.get(offer) ||
        (Object.hasOwn(storedAliases, name) ? storedAliases[name] : names.get(name));
      try {
        const incoming = [], seen = new Set();
        const aliases = { ...saved.aliases?.[sid] };
        let unmatched = 0, invalidPrices = 0;
        for (const file of field("files").files) {
          const buffer = await file.arrayBuffer();
          let rows;
          if (/\.xlsx$/i.test(file.name)) rows = await parseXlsx(buffer);
          else {
            let contents;
            try { contents = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
            catch { contents = new TextDecoder("windows-1251").decode(buffer); }
            rows = parseCsv(contents);
          }
          const parsed = kind === "orders" ? parseOzonReport(rows, resolve, { seen }) :
            kind === "metrics" ? parseRnpMetrics(rows, resolve) : parseRnpInputs(rows, resolve);
          incoming.push(...parsed.rows);
          for (const [name, pids] of Object.entries(parsed.aliases || {})) {
            Object.defineProperty(aliases, name, { value: [...new Set([...(Object.hasOwn(aliases, name) ? aliases[name] : []), ...pids])],
              enumerable: true, configurable: true, writable: true });
          }
          unmatched += parsed.unmatched;
          invalidPrices += parsed.invalidPrices ?? 0;
        }
        if (!incoming.length) throw new Error("Нет данных для артикулов выбранного магазина");
        if (kind === "inputs") {
          for (const [pid, { cost, ...values }] of incoming) {
            state.pulstat.products[pid] = { ...state.pulstat.products[pid], ...pulstatValues(values, PULSTAT_PRODUCT) };
            const offer = IX.prod.get(pid)?.offerId;
            if (offer && Number.isFinite(cost) && state.costs[offer] == null) state.costs[offer] = cost;
          }
          save();
        } else {
          const imports = saved;
          if (kind === "orders") {
            const batch = new Map();
            for (const row of incoming) {
              const id = JSON.stringify(row.slice(0, 2));
              if (!batch.has(id)) batch.set(id, [row[0], row[1], {}]);
              addRnpValues(batch.get(id)[2], row[2]);
            }
            const existing = indexRnpRows(imports.orders || []);
            for (const [id, row] of batch) existing.set(id, row);
            imports.orders = [...existing.values()];
          } else {
            imports.metrics = combineRnpRows(imports.metrics || [], incoming);
            imports.aliases = { ...imports.aliases, [sid]: aliases };
          }
          if (!ls.set(D.demo ? "unitka.rnp.demo" : "unitka.rnp", JSON.stringify(imports))) {
            throw new Error("Не удалось сохранить отчёт в браузере");
          }
        }
        const message = `Загружено строк: ${int(incoming.length)}${unmatched ? ` · без совпадения: ${int(unmatched)}` : ""}${invalidPrices ? ` · без сопоставимых цен: ${int(invalidPrices)}` : ""}`;
        render();
        const result = app.querySelector("#rnp-import-status");
        if (result) {
          result.closest("details").open = true;
          result.textContent = message;
        }
      } catch (error) { status.textContent = error.message; }
      finally { submit.disabled = false; }
    });
  }

  function renderRnp(parts, q) {
    const scope = q.get("scope") ?? state.view.stores;
    const stores = D.stores.filter((s) => scope === "all" || scope === s.id || scope === "mp-" + s.mp);
    const visibleStores = new Set(stores.map((store) => store.id));
    const products = D.products.filter((p) => visibleStores.has(storeOf(p.pid)));
    const inStock = products.filter((p) => stockOf(p.pid) > 0)
      .sort((a, b) => String(a.offerId || a.sku).localeCompare(String(b.offerId || b.sku), "ru", { numeric: true }));
    const showAll = q.get("items") === "all";
    const productList = showAll ? [...inStock, ...products.filter((p) => !(stockOf(p.pid) > 0))] : inStock;
    const product = productList.find((p) => p.pid === q.get("product"));
    const presets = [14, 30, 60];
    const preset = presets.includes(Number(q.get("period"))) ? Number(q.get("period")) : 14;
    const requestedEnd = reportDay(q.get("to"));
    const dateTo = requestedEnd && requestedEnd <= IX.today ? requestedEnd : IX.today;
    const requestedStart = reportDay(q.get("from"));
    const custom = requestedStart && requestedStart <= dateTo;
    const dateFrom = custom ? requestedStart : addDays(dateTo, 1 - preset);
    const dayCount = (Date.parse(dateTo) - Date.parse(dateFrom)) / 86400000 + 1;
    const wideDates = Array.from({ length: dayCount }, (_, i) => addDays(dateFrom, i));
    const { dates, columns, totals } = rnpColumns(product ? [product] : products, product,
      product ? [storeOf(product.pid)] : [...visibleStores], wideDates, rnpImports());
    const ozonProducts = !product || product.mp === "ozon" ? products.filter((p) => p.mp === "ozon") : [];
    const ratio = rnpRatio;
    const factProfit = (c) => c.factProfit;
    const forecastProfit = (c) => c.forecastProfit;
    const factMargin = (c) => ratio(factProfit(c), c.factRevenue);
    const forecastMargin = (c) => product?.mp === "ozon" && c !== totals ? c.pulstatMargin : ratio(forecastProfit(c), c.forecastRevenue);
    const forecastRoi = (c) => ratio(forecastProfit(c), c.forecastCogs);
    const buyRate = (c) => c.unknownBuy ? null : ratio(c.expectedUnits, c.orders);
    const stockDays = (c) => ratio(c.stock, totals.stockDays > 0 ? totals.stockSales / totals.stockDays : null);
    const linkedBuy = (c) => c.linkedSales >= 0 && c.linkedSales <= c.linkedOrders ? ratio(c.linkedSales, c.linkedOrders) : null;
    const orderDrr = (c) => ratio(c.orderSpend, c.matchedOrders);
    const salesDrr = (c) => ratio(c.salesSpend, c.matchedSales);
    const money2 = (value) => value == null ? "—" : value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
    const pct2 = (value) => value == null ? "—" : value.toLocaleString("ru-RU", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\s/g, "");
    const quotient = (name) => (c) => ratio(c[name + "Value"], c[name + "Base"]);
    const dailyBuy = (c) => ratio(c.buyObservedTotal, c.buyObservedOrders) ?? linkedBuy(c);
    const missingPulstat = [
      ["pulstatMissingPrice", "цены заказа"], ["pulstatMissingAds", "данных о рекламе"],
      ["pulstatMissingCost", "себестоимости"], ["pulstatMissingInputs", "вводных магазина"], ["pulstatMissingProduct", "параметров артикула"]
    ].filter(([field]) => totals[field] > 0).map(([field, label]) => `${label} (${int(totals[field])} шт.)`);
    const rows = [
      ["Продажи и остатки", [
        ["Заказы, ₽", (c) => c.unpriced ? null : c.orderSum], ["Продажи, ₽", (c) => c.sales],
        ["Заказы, шт.", (c) => c.orders],
        ["Продажи, шт.", (c) => c.units], ["Отмены, шт.", (c) => c.cancelledOrders], ["Возвраты, шт.", (c) => c.saleReturns],
        ["Средняя цена заказа, ₽", (c) => c.unpriced ? null : ratio(c.orderSum, c.orders)],
        ["Цена продавца по парам, ₽", (c) => ratio(c.sellerAmount, c.pairedQty), money2],
        ["Цена для покупателя, ₽", (c) => ratio(c.buyerAmount, c.pairedQty), money2],
        ["Соинвест, %", (c) => ratio(c.sellerAmount - c.buyerAmount, c.sellerAmount), pct2],
        ["Соинвест за 7 дней · Ozon, %", (c) => ratio(c.rollingSeller - c.rollingBuyer, c.rollingSeller), pct2],
        ["Заказано с обеими ценами, шт.", (c) => c.pairedQty],
        ["В пути к покупателям, шт.", (c) => c.transit], ["В пути от покупателей, шт.", (c) => c.fromClient],
        ["Доступно к продаже, шт.", (c) => c.stock],
        ["Артикулы в наличии / с данными", (c) => c.listed ? `${int(c.inStock)} / ${int(c.listed)}` : null],
        ["Среднее время доставки, дни", (c) => ratio(c.deliveryDays, c.deliveryUnits), money2],
        ["Оборачиваемость по темпу продаж, дни", stockDays, money2]
      ]],
      ["Воронка", [
        ["Средняя позиция в поиске", (c) => ratio(c.positionTotal, c.positionWeight), money2],
        ["Показы, шт.", (c) => c.views], ["Частота показов", quotient("frequency"), money2],
        ["Уникальные посетители", (c) => c.visitors], ["Открытия карточки", (c) => c.opens],
        ["Уникальные посетители карточки", (c) => c.uniqueOpens],
        ["Добавления в корзину", (c) => c.carts], ["CTR общий, %", quotient("organicCtr"), pct],
        ["CR в корзину, %", quotient("cartCr"), pct], ["CR в заказ, %", quotient("orderCr"), pct],
        ["CR показы → заказы, %", quotient("viewOrderCr"), pct],
        ["Доля показов вне поиска и каталога, %", (c) => ratio(c.nonSearchViews, c.nonSearchBase), pct],
        ["Выкуп за день, %", dailyBuy, pct], ["Выкуп за месяц, %", (c) => ratio(c.windowBuyTotal, c.windowBuyBase) ?? buyRate(c), pct]
      ]],
      ["Реклама", [
        ["Показы · WB", (c) => c.impressions], ["Клики · WB", (c) => c.clicks],
        ["CTR · WB, %", (c) => ratio(c.clicks, c.impressions), pct],
        ["CPC · WB, ₽", (c) => ratio(c.wbSpend, c.clicks), money2],
        ["Расход · WB, ₽", (c) => c.wbSpend],
        ["Расход · Ozon, ₽", (c) => c.ozonSpend],
        ["Полки и рекомендации · показы", (c) => c.placementViews], ["Полки и рекомендации · клики", (c) => c.placementClicks],
        ["Полки и рекомендации · CTR, %", quotient("placementCtr"), pct], ["Полки и рекомендации · CPC, ₽", quotient("placementCpc"), money2],
        ["Полки и рекомендации · расход, ₽", (c) => c.placementSpend],
        ["Поиск · показы", (c) => c.searchAdViews], ["Поиск · клики", (c) => c.searchAdClicks],
        ["Поиск · CTR, %", quotient("searchCtr"), pct], ["Поиск · CPC, ₽", quotient("searchCpc"), money2],
        ["Поиск · расход, ₽", (c) => c.searchAdSpend], ["Оплата за заказ · расход, ₽", (c) => c.orderAdSpend],
        ["Реклама итого, ₽", (c) => c.adsUnclosed && !c.spend ? null : c.spend, int, "emphasis"],
        ["ДРР от заказов, %", orderDrr, pct, "drr"],
        ["ДРР от продаж, %", salesDrr, pct, "drr"]
      ]],
      ["Прибыль по начислениям", [
        ["Чистая прибыль, ₽", factProfit, int, "profit"],
        ["Маржа, %", factMargin, pct, "margin"]
      ]],
      ["Прогноз по заказам", [
        ["Ожидаемая выручка, ₽", (c) => c.forecastRevenue],
        ["Ожидаемая прибыль, ₽", forecastProfit, money2, "profit"],
        ["Ожидаемая маржа, %", forecastMargin, pct2, "margin"],
        ["Ожидаемый ROI, %", forecastRoi, pct2, "profit"]
      ]],
      ["Стоимость запасов", [
        ["По себестоимости, ₽", (c) => c.stockMissingCost ? null : c.stockCost],
        ["По цене продавца, ₽", (c) => c.stockMissingPrice ? null : c.stockValue]
      ]]
    ];
    function rowHtml([label, value = () => null, format = int, kind = ""]) {
      function cell(column, total = false) {
        const v = value(column);
        let tone = "";
        if (v != null) {
          if (kind === "drr") tone = v > state.thresholds.drr / 100 ? " rnp-high" : " rnp-good";
          if (kind === "profit" || kind === "margin") {
            tone = v < 0 ? " rnp-high" : kind === "margin" && v < state.thresholds.margin / 100 ? " rnp-low" : " rnp-good";
          }
        }
        return `<td class="${total ? "rnp-total" : ""}${tone}">${typeof v === "string" ? v : format(v)}</td>`;
      }
      return `<tr class="rnp-${kind}"><th scope="row">${label}</th>${cell(totals, true)}${columns.map((c) => cell(c)).join("")}</tr>`;
    }
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" });
    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>РНП</h1></div>
      <form class="rnp-filters" id="rnp-filter-form">
        <label class="field">Площадка или магазин<select id="rnp-scope">
          ${[["all", "Все магазины"], ...[["mp-wb", "Все магазины WB"], ["mp-ozon", "Все магазины Ozon"]].filter(([id]) => D.stores.some((s) => id === "mp-" + s.mp)),
            ...D.stores.map((s) => [s.id, s.name + " · " + mpName(s.mp)])].map(([id, label]) =>
            `<option value="${esc(id)}"${id === scope ? " selected" : ""}>${esc(label)}</option>`).join("")}
        </select></label>
        <label class="field">Начало периода<input id="rnp-start" type="date" value="${dateFrom}" max="${IX.today}" required></label>
        <label class="field">Конец периода<input id="rnp-end" type="date" value="${dateTo}" max="${IX.today}" required></label>
        <label class="field">Быстрый период<select id="rnp-period">
          <option value="custom"${custom ? " selected" : ""}>Свой период</option>
          ${presets.map((n) => `<option value="${n}"${!custom && n === preset ? " selected" : ""}>${n} дней</option>`).join("")}
        </select></label>
        <button type="submit" class="btn primary" aria-label="Применить период">Применить</button>
        <p class="rnp-range-error small" id="rnp-range-error" role="alert" hidden></p>
        <label class="field rnp-article">Артикул<select id="rnp-product">
            <option value="">Все артикулы</option>
            ${productList.map((p) => `<option value="${esc(p.pid)}"${p === product ? " selected" : ""}>${esc(p.offerId || p.sku || p.pid)} · ${esc(p.name || "")} · ${esc(storeName(storeOf(p.pid)))}</option>`).join("")}
        </select></label>
        <label class="rnp-check"><input type="checkbox" id="rnp-items"${showAll ? " checked" : ""}> Показать товары без остатка</label>
      </form>
      ${product ? `<div class="rnp-product-header">${thumb(product)}<div><strong>${esc(product.name || product.offerId || product.sku)}</strong><div class="small">${esc(product.offerId || product.sku)}${product.offerId && product.sku ? ` · Артикул площадки: ${esc(product.sku)}` : ""} · ${esc(storeName(storeOf(product.pid)))}</div></div></div>` : ""}
      <p class="updated">${dmy(dates[0])} — ${dmy(dateTo)} · Даты отчётов по Москве</p>
      <div class="rnp-summary">
        <div><span>Чистая прибыль · ${totals.factDays ?? 0} из ${dates.length} дн.</span><strong class="${factProfit(totals) == null ? "" : signCls(factProfit(totals))}">${rub(factProfit(totals))}</strong></div>
        <div><span>Ожидаемая прибыль · ${int(totals.forecastOrders ?? 0)} из ${int(totals.orders ?? 0)} заказанных шт.</span><strong class="${forecastProfit(totals) == null ? "" : signCls(forecastProfit(totals))}">${rub(forecastProfit(totals))}</strong></div>
        <div><span>Соинвест · ${int(totals.pairedQty ?? 0)} из ${int(totals.orders ?? 0)} заказанных шт.</span><strong>${pct2(ratio(totals.sellerAmount - totals.buyerAmount, totals.sellerAmount))}</strong></div>
        <div><span>ДРР от продаж</span><strong>${pct(salesDrr(totals))}</strong></div>
      </div>
      ${!Number.isFinite(state.tax.rate) ? '<p class="banner small">Для прибыли по начислениям укажи ставку налога в <a href="#/settings">настройках</a>.</p>' : ""}
      ${totals.partialFactDays ? `<p class="muted small">По прибыли есть неполные данные за ${int(totals.partialFactDays)} дн. В итог вошли только рассчитанные строки.</p>` : ""}
      ${totals.stockPartial ? '<p class="muted small">Часть снимков остатков загружена с неполным покрытием складов.</p>' : ""}
      ${rnpReportControls(stores.length ? stores : D.stores)}
      ${pulstatSettings(ozonProducts, product)}
      ${missingPulstat.length ? `<p class="muted small">Для прогноза Ozon не хватает ${missingPulstat.join(", ")}. У одного заказа может быть несколько пропусков.</p>` : ""}
      <div class="rnp-scroll" tabindex="0" role="region" aria-label="Показатели по дням">
        <table class="rnp-table" aria-label="РНП с ${dmy(dateFrom)} по ${dmy(dateTo)}">
          <thead><tr><th scope="col">Показатель</th><th scope="col" class="rnp-total">За период</th>${dates.map((date) =>
            `<th scope="col"><time datetime="${date}">${dm(date)}.${date.slice(2, 4)}</time><span>${weekday.format(new Date(date))}</span></th>`).join("")}</tr></thead>
          ${rows.map(([label, items]) => `<tbody><tr class="rnp-section"><th scope="rowgroup">${label}</th><td class="rnp-total"></td><td colspan="${dates.length}"></td></tr>${items.map(rowHtml).join("")}</tbody>`).join("")}
        </table>
      </div>
      <details class="rnp-method">
        <summary>Как считаются показатели</summary>
        <p>Цена покупателя и соинвест считаются по сопоставимым парам цен, взвешенным по количеству. Для WB цена покупателя указана без скидки WB Кошелька. У соинвеста Ozon за 7 дней итог показывает последний рассчитанный день. ДРР делит расходы на заказы или продажи по совпадающим дням и магазинам. Заказы показаны без отмен, продажи — за вычетом возвратов.</p>
        <p>Фактическая прибыль берётся из начислений и настроек. Для WB прогноз использует 28 дней начислений и оценку выкупа по связанным заказам. Последние 14 дней исключены из оценки выкупа, чтобы дать заказам время на доставку и возврат.</p>
        <p>Для Ozon используются ноябрьские формулы PULSTAT. В расчёт входят комиссия, эквайринг, совокупный налог УСН и НДС, себестоимость с браком, тариф логистики, наценка за нелокальную продажу, доставка до ПВЗ, обработка возврата и реклама. Цена для налога учитывает соинвест по доступным парам цен за семь дней. При отсутствии пар берётся цена продавца, как в образце. Маржа делится на ожидаемую выручку, ROI — на ожидаемую себестоимость. Сводка прогноза суммирует рассчитанные позиции.</p>
        <p>Показатели воронки и рекламы берутся из отчётов. Уникальные посетители в сводке — сумма по товарам и дням, один человек может входить несколько раз. Переходы в карточку WB выводятся отдельно от уникальных посетителей. Время доставки WB берётся из воронки продаж, время Ozon — из доставленных отправлений с обеими датами.</p>
        <p>В каждой дате показан снимок остатков, итог берётся по последнему снимку каждого товара за период. Оценка стоимости включает товар в пути к покупателю, когда по нему есть данные. Прочерк означает, что данных для расчёта нет.${product ? " Расходы без артикула входят в сводку магазина." : ""}</p>
      </details>`;
    const navigate = () => { location.hash = "#/rnp" + (q.size ? "?" + q : ""); };
    const periodForm = app.querySelector("#rnp-filter-form");
    const start = periodForm.querySelector("#rnp-start");
    const end = periodForm.querySelector("#rnp-end");
    const quick = periodForm.querySelector("#rnp-period");
    const rangeError = periodForm.querySelector("#rnp-range-error");
    for (const field of [start, end]) {
      field.addEventListener("input", () => {
        quick.value = "custom";
        rangeError.hidden = true;
      });
    }
    quick.addEventListener("change", () => {
      const length = Number(quick.value);
      if (!presets.includes(length) || !end.reportValidity()) return;
      start.value = addDays(end.value, 1 - length);
      periodForm.requestSubmit();
    });
    periodForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (start.value > end.value) {
        rangeError.textContent = "Начало периода должно быть раньше конца или совпадать с ним.";
        rangeError.hidden = false;
        start.focus();
        return;
      }
      if (quick.value === "custom") {
        q.set("from", start.value);
        q.delete("period");
      } else {
        q.delete("from");
        q.set("period", quick.value);
      }
      q.set("to", end.value);
      navigate();
    });
    for (const [control, param] of [["scope", "scope"], ["product", "product"], ["items", "items"]]) {
      app.querySelector("#rnp-" + control).addEventListener("change", (event) => {
        const value = control === "items" ? (event.target.checked ? "all" : "") : event.target.value;
        if (value) q.set(param, value);
        else q.delete(param);
        if (control === "scope") q.delete("product");
        navigate();
      });
    }
    bindPulstatSettings();
    bindRnpReports();
  }

  // ================= Настройки =================
  function renderSettings(parts, q) {
    const filter = q.get("filter") || "";
    const search = (q.get("s") || "").toLowerCase();
    const ord = aggOrders(addDays(IX.today, -27), IX.today).byP;
    const arts = new Map();
    for (const p of D.products) {
      if (!p.offerId) continue;
      const a = arts.get(p.offerId) || { offerId: p.offerId, name: p.name, stores: new Set(), orders: 0 };
      a.stores.add(p.store); const o = ord.get(p.pid); if (o) a.orders += o.qty - o.cq;
      arts.set(p.offerId, a);
    }
    for (const k of Object.keys(state.costs)) if (!arts.has(k)) arts.set(k, { offerId: k, name: "", stores: new Set(), orders: 0 });
    let list = [...arts.values()];
    const noCostCount = list.filter((a) => state.costs[a.offerId] == null && a.orders > 0).length;
    if (filter === "nocost") list = list.filter((a) => state.costs[a.offerId] == null && a.orders > 0);
    if (search) list = list.filter((a) => (a.offerId + " " + a.name).toLowerCase().includes(search));
    list.sort((a, b) => b.orders - a.orders || a.offerId.localeCompare(b.offerId, "ru"));
    const shown = list.slice(0, listLimit);
    const t = state.tax;
    app.innerHTML = `
      ${demoNote()}
      <h1 class="page-h">Настройки</h1>
      <div class="set-grid">
        <section class="panel wide">
          <h2>Себестоимость за 1 шт</h2>
          <p class="muted small">По артикулу продавца — одна цифра для всех магазинов. Сохраняется сразу.
            Быстрее всего: скачайте таблицу, заполните колонку «себестоимость» в Excel и загрузите обратно (CSV или XLSX).</p>
          <div class="btn-row">
            <button class="btn" data-act="cost-template">Скачать таблицу</button>
            <button class="btn primary" data-act="cost-upload">Загрузить таблицу</button>
          </div>
          <nav class="tabs">
            <a href="#/settings" class="${!filter ? "on" : ""}">Все <span class="cnt">${arts.size}</span></a>
            <a href="#/settings?filter=nocost" class="${filter === "nocost" ? "on" : ""}">Не указана, есть заказы <span class="cnt">${noCostCount}</span></a>
          </nav>
          <div class="search"><input type="search" id="cost-search" placeholder="Артикул или название" value="${esc(q.get("s") || "")}" aria-label="Поиск артикула"></div>
          <ul class="cost-list">${shown.map((a) => {
            const v = state.costs[a.offerId];
            return `<li data-art="${esc(a.offerId)}"><div><div class="nm">${esc(a.name || a.offerId)}</div><div class="sku">${esc(a.offerId)}${a.stores.size ? " · " + [...a.stores].map(storeName).map(esc).join(", ") : ""}${a.orders ? ` · ${int(a.orders)} заказов за 28 дн.` : ""}</div></div>
              <input type="number" inputmode="decimal" min="0" step="any" aria-label="Себестоимость ${esc(a.offerId)}" data-cost value="${v == null ? "" : v}" placeholder="нет">
              <button class="icon-btn" data-act="cost-del" aria-label="Удалить себестоимость ${esc(a.offerId)}" ${v == null ? "disabled" : ""}>×</button></li>`;
          }).join("") || `<li class="muted">Ничего не нашлось</li>`}</ul>
          ${list.length > shown.length ? `<div class="more"><button class="btn" data-act="more">Показать ещё (${list.length - shown.length})</button></div>` : ""}
        </section>
        <section class="panel">
          <h2>Налог</h2>
          <p class="muted small">Ставку и базу называете вы. Пока налог не указан, прибыль считается без него.</p>
          <div class="form-row">
            <div class="field"><label for="tax-rate">Ставка, %</label><input id="tax-rate" type="number" inputmode="decimal" min="0" max="100" step="0.1" value="${t.rate == null ? "" : esc(t.rate)}" placeholder="например, 6"></div>
            <div class="field"><label for="tax-base">База</label><select id="tax-base">
              <option value="revenue" ${t.base === "revenue" ? "selected" : ""}>От выручки</option>
              <option value="profit" ${t.base === "profit" ? "selected" : ""}>Доходы минус расходы</option></select></div>
          </div>
          <div class="form-row">
            <div class="field"><label for="vat-rate">НДС</label><select id="vat-rate">
              ${[[0, "Без НДС"], [5, "5 %"], [7, "7 %"], [10, "10 %"], [22, "22 %"]].map(([v, l]) => `<option value="${v}" ${cleanVat(state.vat) === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
          </div>
          <label><input id="ozon-tax-forecast" type="checkbox" ${state.ozonTaxForecast ? "checked" : ""}> Применять коэффициент 0,8 для прогноза УСН «Доходы» и НДС по заказам Ozon</label>
          <p class="muted small">Коэффициент 0,8 — резервное значение LiteStat при отсутствии базы за предыдущий закрытый месяц. В «Прибыли» налог Ozon пока оценивается от выручки из начислений.</p>
          <p class="muted small">НДС считается внутри цены: при 5% это 5/105 выручки (≈4,76%). Налог УСН с ним считается от выручки без НДС.</p>
        </section>
        <section class="panel">
          <h2>Свои расходы</h2>
          <p class="muted small">Ваши расходы сверх себестоимости: упаковка, фулфилмент, доставка до склада. Внутренние расходы маркетплейсов загружаются из отчётов автоматически.</p>
          <div class="form-row">
            <div class="field"><label for="internal-cost">₽ на 1 шт</label><input id="internal-cost" type="number" inputmode="decimal" min="0" step="any" value="${cleanMoney(state.internal) || ""}" placeholder="например, 4.3"></div>
          </div>
        </section>
        <section class="panel">
          <h2>Пороги подсветки</h2>
          <p class="muted small">Ниже какой рентабельности отмечать 🟡 и выше какого ДРР — 🟠.</p>
          <div class="form-row">
            <div class="field"><label for="th-margin">Рентабельность, %</label><input id="th-margin" type="number" inputmode="decimal" min="0" max="100" value="${state.thresholds.margin}"></div>
            <div class="field"><label for="th-drr">ДРР, %</label><input id="th-drr" type="number" inputmode="decimal" min="0" max="100" value="${state.thresholds.drr}"></div>
          </div>
        </section>
        <section class="panel">
          <h2>Копия данных</h2>
          <p class="muted small">Себестоимость, налог и пороги хранятся только в этом браузере. Скачайте копию, чтобы не потерять их и перенести на телефон.</p>
          <div class="btn-row"><button class="btn primary" data-act="export">Скачать копию данных</button><button class="btn" data-act="import">Загрузить копию</button></div>
        </section>
        <section class="panel">
          <h2>Магазины</h2>
          <ul class="stores">${D.stores.map((s) => `<li>${chip(s.mp)} <b>${esc(s.name)}</b>
            <span class="muted small">${s.ok ? "обновлено " + dmy(dayStr(new Date(s.updatedAt))) : "не обновилось"}, отчёты по ${dm(s.finTo)}${s.tokenExpires ? ", ключ до " + dmy(s.tokenExpires) : ""}</span>
            ${s.warnings.map((w) => `<span class="warn-line small">${esc(w)}</span>`).join("")}</li>`).join("")}</ul>
          <p class="muted small">Данные собраны ${new Date(D.generatedAt).toLocaleString("ru-RU", { timeZone: "Asia/Yekaterinburg", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} по Екатеринбургу.</p>
        </section>
        <section class="panel">
          <h2>Это устройство</h2>
          <p class="muted small">${ls.get(PHRASE_KEY) ? "Фраза запомнена на этом устройстве." : "Фраза не запомнена — при следующем открытии её нужно ввести."}</p>
          <div class="btn-row"><button class="btn danger" data-act="forget">Забыть фразу на этом устройстве</button></div>
        </section>
      </div>`;
    const num = (id) => { const v = document.getElementById(id).value; return v === "" ? null : Number(v); };
    app.querySelector("#tax-rate").addEventListener("input", () => { state.tax.rate = num("tax-rate"); save(); });
    app.querySelector("#tax-base").addEventListener("change", (e) => { state.tax.base = e.target.value; save(); toast("База налога сохранена"); });
    app.querySelector("#internal-cost").addEventListener("input", () => { state.internal = cleanMoney(num("internal-cost")); save(); });
    app.querySelector("#ozon-tax-forecast").addEventListener("change", (e) => { state.ozonTaxForecast = e.target.checked; save(); });
    app.querySelector("#vat-rate").addEventListener("change", (e) => { state.vat = cleanVat(e.target.value); save(); toast(state.vat ? `НДС ${state.vat}% сохранён` : "Без НДС"); });
    app.querySelector("#th-margin").addEventListener("input", () => { const v = num("th-margin"); if (v != null) { state.thresholds.margin = v; save(); } });
    app.querySelector("#th-drr").addEventListener("input", () => { const v = num("th-drr"); if (v != null) { state.thresholds.drr = v; save(); } });
    app.querySelectorAll("[data-cost]").forEach((inp) => inp.addEventListener("change", () => {
      const art = inp.closest("li").dataset.art;
      if (inp.value === "") delete state.costs[art];
      else { const n = Number(inp.value); if (!(n >= 0)) { toast("Нужно число 0 или больше"); return; } state.costs[art] = n; }
      save(); inp.closest("li").querySelector("[data-act=cost-del]").disabled = inp.value === ""; toast("Себестоимость сохранена");
    }));
    const s = app.querySelector("#cost-search");
    s.addEventListener("change", () => { const qq = new URLSearchParams(route().q); s.value ? qq.set("s", s.value) : qq.delete("s"); location.hash = "#/settings?" + qq; });
  }

  // ================= Таблица себестоимости: CSV и XLSX =================
  function costTemplate() {
    const ord = aggOrders(addDays(IX.today, -27), IX.today).byP;
    const arts = new Map();
    for (const p of D.products) {
      if (!p.offerId) continue;
      const a = arts.get(p.offerId) || { name: p.name, orders: 0 };
      const o = ord.get(p.pid); if (o) a.orders += o.qty - o.cq;
      arts.set(p.offerId, a);
    }
    const rows = [["артикул", "название", "заказов за 28 дней", "себестоимость"]];
    for (const [k, a] of [...arts.entries()].sort((x, y) => y[1].orders - x[1].orders)) rows.push([k, a.name, a.orders, state.costs[k] ?? ""]);
    download(`unitka-sebestoimost-${todayIso()}.csv`, csv(rows), "text/csv;charset=utf-8");
    toast("Таблица скачана");
  }
  function applyCostTable(rows) {
    if (!rows.length) return 0;
    let head = rows.findIndex((r) => r.some((c) => /артикул/i.test(c)) && r.some((c) => /себестоим/i.test(c)));
    let ci = 0, vi = rows[0].length - 1;
    if (head >= 0) {
      ci = rows[head].findIndex((c) => /артикул/i.test(c) && !/wb|ozon|мп/i.test(c));
      if (ci < 0) ci = rows[head].findIndex((c) => /артикул/i.test(c));
      vi = rows[head].findIndex((c) => /себестоим/i.test(c));
    }
    let n = 0;
    for (const r of rows.slice(head + 1)) {
      const art = String(r[ci] ?? "").trim();
      const raw = String(r[vi] ?? "").replace(/\s|₽/g, "").replace(",", ".");
      if (!art || raw === "") continue;
      const v = Number(raw);
      if (!isFinite(v) || v < 0) continue;
      state.costs[art] = v; n++;
    }
    return n;
  }
  // Минимальное чтение .xlsx: это zip-архив с XML внутри.
  async function parseXlsx(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Это не файл Excel (xlsx)");
    const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let i = 0; i < count; i++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
      files[name] = { method, csize, off }; p += 46 + nlen + elen + clen;
    }
    const read = async (name) => {
      const f = files[name]; if (!f) return null;
      const start = f.off + 30 + dv.getUint16(f.off + 26, true) + dv.getUint16(f.off + 28, true);
      const data = u8.subarray(start, start + f.csize);
      if (f.method === 0) return new TextDecoder().decode(data);
      return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    };
    const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
    const ssText = await read("xl/sharedStrings.xml");
    const shared = ssText ? [...xml(ssText).getElementsByTagName("si")].map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")) : [];
    const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
    const sheet = xml(await read(sheetName));
    const colIdx = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
    return [...sheet.getElementsByTagName("row")].map((r) => {
      const out = [];
      for (const c of r.getElementsByTagName("c")) {
        const v = c.getElementsByTagName("v")[0]?.textContent ?? c.getElementsByTagName("t")[0]?.textContent ?? "";
        out[colIdx(c.getAttribute("r") || "A")] = c.getAttribute("t") === "s" ? shared[Number(v)] ?? "" : v;
      }
      return Array.from(out, (x) => x ?? "");
    });
  }

  // ================= Копия настроек =================
  function exportJson() {
    download(`unitka-kopiya-${todayIso()}.json`, JSON.stringify({ app: "unitka", version: 2, savedAt: new Date().toISOString(),
      settings: { costs: state.costs, tax: state.tax, ozonTaxForecast: state.ozonTaxForecast, vat: state.vat, internal: state.internal, thresholds: state.thresholds, pulstat: state.pulstat } }, null, 2), "application/json");
    toast("Копия данных скачана");
  }
  function importJson(text) {
    let d; try { d = JSON.parse(text); } catch (e) { toast("Это не файл копии Юнитки"); return; }
    if (!d || d.app !== "unitka" || !d.settings) { toast("Это не файл копии Юнитки"); return; }
    if (!confirm("Заменить текущие себестоимость, налог, НДС, внутренние расходы и пороги данными из файла?")) return;
    const s = d.settings;
    state.costs = cleanCosts(s.costs);
    if (s.tax) state.tax = { rate: s.tax.rate == null || s.tax.rate === "" ? null : Number(s.tax.rate), base: s.tax.base === "profit" ? "profit" : "revenue" };
    if (s.thresholds) state.thresholds = { margin: num(s.thresholds.margin, 15), drr: num(s.thresholds.drr, 20) };
    state.ozonTaxForecast = s.ozonTaxForecast === true;
    state.vat = cleanVat(s.vat); state.internal = cleanMoney(s.internal);
    if (s.pulstat) state.pulstat = cleanPulstat(s.pulstat);
    save(); render(); toast("Копия загружена");
  }

  // ================= CSV-выгрузки =================
  function csvProducts() {
    const ord = aggOrders(addDays(IX.today, -27), IX.today).byP;
    const rows = [["Магазин", "Площадка", "Артикул продавца", "Артикул МП", "Название", "Категория", "Остаток FBO", "Остаток FBS", "Заказы 28 дн., шт", "Цена, ₽"]];
    for (const p of D.products.filter((x) => storeOk(x.pid))) {
      const s = D.stocks?.[p.pid], o = ord.get(p.pid);
      rows.push([storeName(p.store), mpName(p.mp), p.offerId, p.sku, p.name, p.category, s ? s.fbo : "", s ? s.fbs : "", o ? o.qty - o.cq : 0, p.price ?? ""]);
    }
    download(`unitka-tovary-${todayIso()}.csv`, csv(rows), "text/csv;charset=utf-8");
  }
  function csvProfit() {
    const { from, to } = finPeriod();
    const { rows } = profitRows();
    const out = [["Период", "Магазин", "Площадка", "Артикул продавца", "Артикул МП", "Название", "Выкупы, шт", "Выручка, ₽", "Комиссия", "Логистика", "Хранение", "Приёмка", "Штрафы и удержания", "Эквайринг", "Компенсации", "Внутренняя логистика", "Реклама", "Себестоимость", "Свои расходы", "НДС", "Налог", "Чистая прибыль, ₽", "Рентабельность, %", "ROI, %", "ДРР, %", "ABC прибыль", "ABC выручка"]];
    for (const c of rows) out.push([`${from}…${to}`, storeName(c.p.store), mpName(c.p.mp), c.p.offerId, c.p.sku, c.p.name, c.units, c.rev, c.comm, c.logi, c.stor, c.acc, c.pen, c.acq, c.comp, c.serviceLogi, c.ads,
      c.cost == null ? "" : c.cogs, c.ownCosts, c.vat, c.tax, c.profit, c.margin == null ? "" : c.margin * 100, c.roi == null ? "" : c.roi * 100, c.drr == null ? "" : c.drr * 100, c.abc_profit, c.abc_rev]);
    download(`unitka-pribyl-${from}-${to}.csv`, csv(out), "text/csv;charset=utf-8");
    toast("CSV скачан");
  }
  function csvReport() {
    const { cols, total } = reportData(state.view.report);
    const out = [["Показатель", ...cols.map((c) => c.label), "Весь период"]];
    for (const [k, l] of REPORT_ROWS) out.push([l, ...cols.map((c) => (k === "margin" || k === "roi" ? (c.t[k] == null ? "" : c.t[k] * 100) : c.t[k])), k === "margin" || k === "roi" ? (total[k] == null ? "" : total[k] * 100) : total[k]]);
    download(`unitka-otchet-${todayIso()}.csv`, csv(out), "text/csv;charset=utf-8");
  }

  // ================= События =================
  const fileJson = document.getElementById("file-json"), fileCost = document.getElementById("file-cost");
  fileJson.addEventListener("change", () => { const f = fileJson.files[0]; if (f) f.text().then(importJson); fileJson.value = ""; });
  fileCost.addEventListener("change", async () => {
    const f = fileCost.files[0]; if (!f) return; fileCost.value = "";
    try {
      let rows;
      if (/\.xlsx$/i.test(f.name)) rows = await parseXlsx(await f.arrayBuffer());
      else if (/\.xls$/i.test(f.name)) { toast("Старый формат .xls: сохраните файл как .xlsx или .csv"); return; }
      else rows = parseCsv(await f.text());
      const n = applyCostTable(rows); save(); render();
      toast(n ? `Себестоимость загружена: ${n} ${plural(n, "артикул", "артикула", "артикулов")}` : "В файле не нашлось колонок «артикул» и «себестоимость»");
    } catch (e) { toast("Не получилось прочитать файл: " + e.message); }
  });

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) {
      const act = b.dataset.act, v = b.dataset.v;
      if (act === "metric-help") {
        const dialog = document.getElementById("metric-dialog");
        dialog.querySelector("h2").textContent = b.dataset.label;
        dialog.querySelector("p").textContent = b.dataset.help;
        dialog.showModal();
        return;
      }
      if (act === "demo") return openDemo();
      if (act === "lock") { D = null; IX = null; location.hash = "#/"; return render(); }
      if (act === "store") { state.view.stores = v; listLimit = 50; save(); const r = route(); r.q.delete("store"); location.hash = "#/" + r.parts.join("/") + (String(r.q) ? "?" + r.q : ""); return render(); }
      if (act === "home" || act === "fin" || act === "ord") {
        if (act !== "home") RANGE[act] = null;
        state.view[act] = Number(v); listLimit = 50; save(); return render();
      }
      if (act === "day-set") { DAY[v] = b.dataset.day; return render(); }
      if (act === "day-step") { const cur = app.querySelector(`input[data-day="${v}"]`); if (cur) { DAY[v] = addDays(cur.value, Number(b.dataset.step)); return render(); } }
      if (act === "abc" || act === "report") { state.view[act] = v; save(); return render(); }
      if (act === "ord-scheme") { state.view.ordScheme = v; save(); return render(); }
      if (act === "ord-unit") { state.view.ordUnit = v; save(); return render(); }
      if (act === "sort") {
        const k = b.dataset.k;
        if (state.view.profitSort === k) state.view.profitDir = -state.view.profitDir; else { state.view.profitSort = k; state.view.profitDir = k === "name" || k === "abc" ? 1 : -1; }
        save(); return render();
      }
      if (act === "more") { listLimit += 100; return render(); }
      if (act === "csv-products") return csvProducts();
      if (act === "csv-profit") return csvProfit();
      if (act === "csv-report") return csvReport();
      if (act === "cost-template") return costTemplate();
      if (act === "cost-upload") return fileCost.click();
      if (act === "export") return exportJson();
      if (act === "import") return fileJson.click();
      if (act === "cost-del") { const art = b.closest("li").dataset.art; delete state.costs[art]; save(); render(); toast("Себестоимость удалена"); return; }
      if (act === "forget") { ls.del(PHRASE_KEY); toast("Фраза забыта на этом устройстве"); return render(); }
      return;
    }
    const tr = e.target.closest("tr[data-item], tr[data-pid]");
    if (tr) openRow(tr);
  });
  function openRow(tr) {
    const pid = tr.dataset.item || tr.dataset.pid;
    location.hash = "#/item/" + encodeURIComponent(pid);
  }
  document.addEventListener("keydown", (e) => {
    const tr = e.target.closest && e.target.closest("tr[data-item], tr[data-pid]");
    if (tr && !e.target.closest("button, a, input, select") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRow(tr); }
  });
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form.matches("form[data-period-range]")) return;
    e.preventDefault();
    const start = form.elements.from;
    const from = start.value, to = form.elements.to.value;
    if (from > to) {
      form.querySelector('[role="alert"]').hidden = false;
      start.focus();
      return;
    }
    RANGE[form.dataset.periodRange] = { from, to };
    listLimit = 50;
    render();
  });
  document.addEventListener("input", (e) => {
    const form = e.target.closest("form[data-period-range]");
    if (form) form.querySelector('[role="alert"]').hidden = true;
  });
  document.addEventListener("change", (e) => {
    if (e.target.matches("input[data-day]") && e.target.value) { DAY[e.target.dataset.day] = e.target.value; return render(); }
    if (e.target.matches('[data-act="sort-select"]')) { const [k, d] = e.target.value.split(":"); state.view.profitSort = k; state.view.profitDir = Number(d); save(); render(); }
  });
  window.addEventListener("hashchange", () => { listLimit = 50; }, true);

  // ================= Старт =================
  (async function start() {
    const phrase = ls.get(PHRASE_KEY);
    if (phrase && location.protocol !== "file:") {
      app.innerHTML = `<p class="loading">Открываю данные…</p>`;
      try { setData(await decrypt(await fetchEnc(), phrase)); }
      catch (e) { lockMsg = e.code === "nofile" ? "" : "Запомненная фраза больше не подходит — введите её заново"; }
    }
    render();
    loadPub();
  })();
})();
