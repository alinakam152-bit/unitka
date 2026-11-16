/* Юнитка — этап 1.
   Данные приходят из зашифрованного файла data.enc (его ночью делает робот robot/run.mjs).
   Расшифровка — только здесь, в браузере, по фразе. Себестоимость и налог хранятся в этом браузере. */
(function () {
  "use strict";

  // ================= Настройки в браузере =================
  const KEY = "unitka.v1", PHRASE_KEY = "unitka.phrase";
  const DEFAULTS = {
    costs: {},                                  // себестоимость: { артикул продавца: ₽ за 1 шт }
    tax: { rate: null, base: "revenue" },       // ставка %, база revenue | profit
    vat: 0,                                     // НДС, %: 0 — без НДС; 5, 7, 10, 22 — ставка (НДС внутри цены)
    thresholds: { margin: 15, drr: 20 },        // принято: 15% и 20%
    view: { home: 28, fin: 28, profitSort: "profit", profitDir: -1, abc: "profit", report: "week", stores: "all" }
  };
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
        s.vat = cleanVat(raw.vat);
        if (raw.view) Object.assign(s.view, raw.view);
      }
    } catch (e) {}
    return s;
  }
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
  const F = { date: 0, pid: 1, rev: 2, sold: 3, ret: 4, comm: 5, logi: 6, stor: 7, acc: 8, pen: 9, acq: 10, ads: 11, comp: 12, pay: 13 };
  const COST_KEYS = ["comm", "logi", "stor", "acc", "pen", "acq"];
  let D = null;           // расшифрованные данные
  let IX = null;          // индексы

  function setData(data) {
    D = data;
    const prod = new Map(D.products.map((p) => [p.pid, p]));
    const stores = new Map(D.stores.map((s) => [s.id, s]));
    const today = dayStr(new Date(D.generatedAt));
    const finTos = D.stores.filter((s) => s.finTo).map((s) => s.finTo).sort();
    IX = { prod, stores, today, finTo: finTos[0] || addDays(today, -1), finToMax: finTos[finTos.length - 1] || addDays(today, -1) };
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
    const blank = () => ({ rev: 0, sold: 0, ret: 0, comm: 0, logi: 0, stor: 0, acc: 0, pen: 0, acq: 0, ads: 0, comp: 0, pay: 0, shared: 0 });
    for (const r of D.fin) {
      if (r[0] < from || r[0] > to || !storeOk(r[1])) continue;
      const target = r[1][0] === "*" ? storeLevel : byP;
      const a = target.get(r[1]) || blank();
      for (const k in F) if (k !== "date" && k !== "pid") a[k] += r[F[k]];
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
        for (const k of ["comm", "logi", "stor", "acc", "pen", "acq", "ads", "comp", "pay", "rev"]) {
          const add = s[k] * share; a[k] += add;
          if (k !== "pay" && k !== "rev" && k !== "comp") a.shared += add;
        }
      }
    }
    return { byP, leftovers };
  }

  // Прибыль по одной строке (товар за период)
  function calc(pid, a) {
    const p = IX.prod.get(pid) || { pid, name: pid, offerId: "", store: storeOf(pid), mp: "" };
    const cost = state.costs[p.offerId];
    const hasCost = typeof cost === "number";
    const units = a.sold - a.ret;
    const cogs = hasCost ? cost * units : 0;
    const mpCost = COST_KEYS.reduce((t, k) => t + a[k], 0) - a.comp;
    const pre = a.rev - mpCost - a.ads - cogs;
    // НДС сидит внутри цены: при ставке 5% это 5/105 выручки. Доходы для УСН считаются без НДС.
    const vat = Math.max(0, a.rev) * vatShare();
    const rate = taxRate();
    const tax = rate ? (state.tax.base === "profit" ? Math.max(0, pre - vat) * rate : Math.max(0, a.rev - vat) * rate) : 0;
    const profit = pre - vat - tax;
    const margin = a.rev > 0 ? profit / a.rev : null;
    const drr = a.rev > 0 ? a.ads / a.rev : null;
    const flags = [];
    if (!hasCost && (units > 0 || a.rev > 0)) flags.push("none");
    if (hasCost && profit < 0) flags.push("loss");
    if (hasCost && profit >= 0 && margin != null && margin * 100 < state.thresholds.margin) flags.push("low");
    if (drr != null && drr * 100 > state.thresholds.drr) flags.push("drr");
    if (a.ads > 0 && units <= 0) flags.push("adsnosale");
    return Object.assign({}, a, { pid, p, cost: hasCost ? cost : null, units, cogs, mpCost, vat, tax, profit, margin, drr, flags });
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
  const int = (v) => (v == null || !isFinite(v) ? "—" : signed(nf0.format(Math.round(v))));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dm = (s) => (s ? s.slice(8, 10) + "." + s.slice(5, 7) : "—");
  const dmy = (s) => (s ? dm(s) + "." + s.slice(0, 4) : "—");
  const plural = (n, a, b, c) => { const m = Math.abs(n) % 100, k = m % 10; return m > 10 && m < 20 ? c : k > 1 && k < 5 ? b : k === 1 ? a : c; };
  const mpName = (mp) => (mp === "wb" ? "WB" : mp === "ozon" ? "Ozon" : "");
  const chip = (mp) => (mp ? `<span class="chip ${mp}">${mpName(mp)}</span>` : "");
  const storeName = (id) => IX.stores.get(id)?.name || id;
  const signCls = (v) => (v < 0 ? "num-loss" : "num-profit");
  const FLAG = { loss: ["🔴", "в минусе"], low: ["🟡", "маржа ниже порога"], drr: ["🟠", "ДРР выше порога"], none: ["⚪", "нет себестоимости"], adsnosale: ["📣", "реклама без выкупов"] };
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
    const fn = { home: renderHome, products: renderProducts, profit: renderProfit, item: renderItem, report: renderReport, settings: renderSettings }[page] || renderHome;
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

  // ================= Главная =================
  function renderHome() {
    const n = Number(state.view.home) || 28;
    const to = IX.today, from = addDays(to, -(n - 1));
    const pFrom = addDays(from, -n), pTo = addDays(from, -1);
    const cur = aggOrders(from, to), prev = aggOrders(pFrom, pTo);
    const tot = (m) => [...m.byDay.values()].reduce((t, d) => ({ qty: t.qty + d.qty, sum: t.sum + d.sum, cq: t.cq + d.cq, cs: t.cs + d.cs }), { qty: 0, sum: 0, cq: 0, cs: 0 });
    const c = tot(cur), p = tot(prev);
    // Финансы за последние n дней, по которым есть отчёты
    const fTo = IX.finTo, fFrom = addDays(fTo, -(n - 1));
    const fin = aggFin(fFrom, fTo);
    const rows = [...fin.byP.entries()].map(([pid, a]) => calc(pid, a));
    const fs = rows.reduce((t, r) => ({ rev: t.rev + r.rev, profit: t.profit + r.profit, ads: t.ads + r.ads, units: t.units + r.units }), { rev: 0, profit: 0, ads: 0, units: 0 });
    for (const l of fin.leftovers) { const x = calc("*" + l.storeId, l); fs.rev += x.rev; fs.profit += x.profit; fs.ads += x.ads; }

    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Главная</h1>${seg("home", [[1, "1 день"], [7, "7 дней"], [14, "14 дней"], [28, "28 дней"]], n, "Период")}</div>
      ${storeChips()}
      <div class="home-grid">
        <div class="home-left">
        <section class="panel chart-panel">
          <div class="kpis">
            <div><div class="k">Заказано</div><div class="v">${rub(c.sum - c.cs)}</div><div class="s">${int(c.qty - c.cq)} шт ${delta(c.sum - c.cs, p.sum - p.cs)} ${n === 1 ? "к вчера" : `к прошлым ${n} дн.`}</div></div>
            <div><div class="k">Отмены</div><div class="v">${int(c.cq)} шт</div><div class="s">${pct(c.qty ? c.cq / c.qty : null)} заказов</div></div>
          </div>
          ${n === 1 ? ordersChart(aggOrders(addDays(to, -13), to).byDay, null, addDays(to, -13), to, 14) : ordersChart(cur.byDay, prev.byDay, from, to, n)}
          <p class="muted small">${n === 1 ? `Цифры выше — за ${dmy(to)} (сегодня, день ещё не закончился) в сравнении со вчера. График — последние 14 дней` : `Заказы по дням, ₽ без отмен. Пунктир — предыдущие ${n} дней`}. Данные на ${dm(IX.today)}.</p>
        </section>
        <section class="panel fin-mini">
          <h2>Деньги по отчётам площадок</h2>
          <p class="muted small">${n === 1 ? dmy(fTo) : dm(fFrom) + "–" + dm(fTo)} · отчёты WB приходят раз в неделю, поэтому период заканчивается ${dm(fTo)}</p>
          <div class="kpis four">
            <div><div class="k">Выручка</div><div class="v">${rub(fs.rev)}</div><div class="s">${int(fs.units)} шт выкуплено</div></div>
            <div class="main"><div class="k">Чистая прибыль</div><div class="v ${signCls(fs.profit)}">${rub(fs.profit)}</div></div>
            <div><div class="k">Маржа</div><div class="v">${pct(fs.rev > 0 ? fs.profit / fs.rev : null)}</div></div>
            <div><div class="k">ДРР</div><div class="v">${pct(fs.rev > 0 ? fs.ads / fs.rev : null)}</div></div>
          </div>
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
    const n = Number(state.view.fin) || 28;
    return { n, from: addDays(IX.finTo, -(n - 1)), to: IX.finTo };
  }
  function profitRows() {
    const { from, to } = finPeriod();
    const fin = aggFin(from, to);
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
    const tot = all.reduce((t, r) => ({ rev: t.rev + r.rev, profit: t.profit + r.profit, ads: t.ads + r.ads }), { rev: 0, profit: 0, ads: 0 });
    const abcSum = { A: [0, 0], B: [0, 0], C: [0, 0] };
    for (const r of rows) { abcSum[r[abcKey]][0]++; abcSum[r[abcKey]][1] += Math.max(0, v.abc === "rev" ? r.rev : r.profit); }
    const abcTotal = abcSum.A[1] + abcSum.B[1] + abcSum.C[1] || 1;
    const shown = list.slice(0, listLimit);
    const cols = [["name", "Товар"], ["units", "Выкупы, шт"], ["rev", "Выручка"], ["profit", "Чистая прибыль"], ["margin", "Маржа"], ["drr", "ДРР"], ["abc", "ABC"]];
    const th = cols.map(([k, l]) => `<th scope="col"><button data-act="sort" data-k="${k}" ${key === k ? `data-dir="${dir > 0 ? "↑" : "↓"}"` : ""}>${l}</button></th>`).join("");
    const fNames = { loss: "в минусе", drr: "ДРР выше порога", none: "без себестоимости", low: "маржа ниже порога", adsnosale: "реклама без выкупов" };

    app.innerHTML = `
      ${demoNote()}
      <div class="head-row"><h1>Прибыль по товарам</h1>${seg("fin", [[1, "1 день"], [7, "7 дней"], [14, "14 дней"], [28, "28 дней"], [90, "90 дней"]], n, "Период")}</div>
      ${storeChips()}
      <p class="updated">По отчётам площадок за ${n === 1 ? dmy(to) + " (последний день, по которому есть отчёты)" : dm(from) + "–" + dm(to)}. ${D.stores.map((s) => `${esc(s.name)}: по ${dm(s.finTo)}`).join(" · ")}</p>
      ${!taxRate() ? `<div class="banner small">Налог не указан — прибыль без налога. <a href="#/settings">Указать</a></div>` : ""}
      <section class="totals">
        <div><div class="k">Выручка</div><div class="v">${rub(tot.rev)}</div></div>
        <div class="main"><div class="k">Чистая прибыль</div><div class="v">${rub(tot.profit)}</div></div>
        <div><div class="k">Маржа</div><div class="v">${pct(tot.rev > 0 ? tot.profit / tot.rev : null)}</div></div>
        <div><div class="k">ДРР</div><div class="v">${pct(tot.rev > 0 ? tot.ads / tot.rev : null)}</div></div>
      </section>
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
      <div class="legend"><span>🔴 в минусе</span><span>🟡 маржа ниже ${state.thresholds.margin}%</span><span>🟠 ДРР выше ${state.thresholds.drr}%</span><span>⚪ нет себестоимости</span><span>📣 реклама без выкупов</span></div>
      <div class="tbl-wrap">
        <table class="items">
          <thead><tr>${th}</tr></thead>
          <tbody>${shown.map((c) => `
            <tr class="${c.flags.includes("loss") ? "r-loss" : ""}" data-item="${esc(c.pid)}" tabindex="0">
              <td><div class="name">${thumb(c.p)}<div><b>${esc(c.p.name)}</b><span class="muted small">${chip(c.p.mp)} ${esc(storeName(c.p.store))} · ${esc(c.p.offerId)}</span> <span class="flags">${flagIcons(c)}</span></div></div></td>
              <td data-l="Выкупы">${int(c.units)}</td>
              <td data-l="Выручка">${rub(c.rev)}</td>
              <td data-l="Прибыль" class="${signCls(c.profit)}">${rub(c.profit)}</td>
              <td data-l="Маржа">${pct(c.margin)}</td>
              <td data-l="ДРР">${pct(c.drr)}</td>
              <td data-l="ABC"><span class="abc-l ${c[abcKey]}">${c[abcKey]}</span></td>
            </tr>`).join("") || `<tr><td colspan="7" class="muted">За этот период продаж нет</td></tr>`}</tbody>
        </table>
      </div>
      ${list.length > shown.length ? `<div class="more"><button class="btn" data-act="more">Показать ещё (${list.length - shown.length})</button></div>` : ""}
      ${leftovers.length ? `<p class="muted small">Расходы магазинов без продаж в периоде (не распределены по товарам): ${leftovers.map((l) => `${esc(storeName(l.storeId))} ${rub(l.profit)}`).join(", ")}.</p>` : ""}`;
  }

  // ================= Карточка товара =================
  const LINES = [
    ["comm", "Комиссия", { wb: "Отчёт о реализации: цена − «к перечислению» − эквайринг", ozon: "Начисления: «Вознаграждение за продажу»" }, "var(--s1)"],
    ["logi", "Логистика", { wb: "«Услуги по доставке» и возмещение перевозки", ozon: "Логистика, обратная логистика, выдача, обработка" }, "var(--s2)"],
    ["stor", "Хранение", "Платное хранение (общая сумма магазина делится по выручке, принято)", "var(--s3)"],
    ["acc", "Приёмка", "Платная приёмка / обработка поставки", "var(--s4)"],
    ["pen", "Штрафы и удержания", "Штрафы, удержания, подписки и прочие услуги", "var(--s5)"],
    ["acq", "Эквайринг", "Оплата картой", "var(--s6)"],
    ["ads", "Реклама", { wb: "WB «Продвижение»: статистика кампаний по артикулу", ozon: "Начисления Ozon: продвижение и оплата за клик (общая часть делится по выручке)" }, "var(--s7)"],
    ["cogs", "Себестоимость", "Из настроек", "var(--s8)"],
    ["vat", "НДС", "Из настроек", "var(--drr)"],
    ["tax", "Налог", "Из настроек", "var(--s9)"]
  ];
  function renderItem(parts) {
    const pid = decodeURIComponent(parts.slice(1).join("/"));
    const p = IX.prod.get(pid);
    if (!p) { location.hash = "#/profit"; return; }
    const { n, from, to } = finPeriod();
    const fin = aggFin(from, to);
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
          <div><div class="k">Маржа</div><div class="v ${signCls(w.profit)}">${pct(w.margin)}</div><div class="d muted">ДРР ${pct(w.drr)}</div></div>`;
      };
      panel.addEventListener("input", upd); upd();
    });
  }
  function unitModel(c) {
    const q = c.units > 0 ? c.units : 1;
    const price = c.rev / q;
    const pctPart = c.rev > 0 ? (c.comm + c.acq) / c.rev : 0;
    const fixed = (c.logi + c.stor + c.acc + c.pen - c.comp + c.ads) / q + (c.cost || 0);
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
    const nonAd = c.logi + c.stor + c.acc + c.pen - c.comp + (c.cost || 0) * m.q;
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
      if (f === "pen" && c.comp) { v = c.pen - c.comp; how += `; компенсации ${rub(c.comp)} вычтены`; }
      if (f === "cogs") { v = c.cost == null ? null : c.cogs; how = c.cost == null ? "Не указана — прибыль завышена" : `${rub(c.cost)} за 1 шт, из настроек`; }
      if (f === "vat") how = vatShare() ? `${state.vat}% внутри цены: выручка × ${state.vat}/${100 + state.vat}` : "Без НДС (меняется в настройках)";
      if (f === "tax") how = taxRate() ? `${state.tax.rate}% ${state.tax.base === "profit" ? "от «доходы минус расходы»" : "от выручки"}${vatShare() ? " без НДС" : ""}` : "Не указан в настройках";
      return { f, name, how, color, unit: v == null ? null : v / q };
    }).filter((x) => x.f !== "vat" || vatShare());
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
            <span class="how">Маржа ${pct(c.margin)} · за период ${rub(c.profit)}${c.shared ? ` · из расходов ${rub(c.shared)} — общие расходы магазина, поделённые по выручке` : ""}</span></li>
        </ul>
        <div class="prices">
          <div><div class="k">Минимальная цена без убытка</div><div class="v">${rub(priceFor(c, 0))}</div></div>
          <div><div class="k">Цена для маржи ${state.thresholds.margin}%</div><div class="v">${rub(priceFor(c, state.thresholds.margin / 100))}</div></div>
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

  // ================= Отчёт маркетплейса =================
  const REPORT_ROWS = [
    ["rev", "Продано (выручка)", 1], ["comm", "Комиссия", -1], ["logi", "Логистика", -1], ["stor", "Хранение", -1], ["acc", "Приёмка", -1],
    ["pen", "Штрафы и удержания", -1], ["acq", "Эквайринг", -1], ["ads", "Реклама", -1], ["comp", "Компенсации", 1], ["pay", "К перечислению", 0],
    ["cogs", "Себестоимость", -1], ["vat", "НДС", -1], ["tax", "Налог", -1], ["profit", "Чистая прибыль", 2], ["margin", "Рентабельность", 3]
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
      const t = { rev: 0, comm: 0, logi: 0, stor: 0, acc: 0, pen: 0, acq: 0, ads: 0, comp: 0, pay: 0, cogs: 0, vat: 0, tax: 0, profit: 0 };
      for (const [pid, a] of fin.byP) { const c = calc(pid, a); for (const k in t) t[k] += c[k] || 0; }
      for (const l of fin.leftovers) { const c = calc("*" + l.storeId, l); for (const k in t) t[k] += c[k] || 0; }
      t.margin = t.rev > 0 ? t.profit / t.rev : null;
      return { label, from, to, t };
    });
    const total = { rev: 0, comm: 0, logi: 0, stor: 0, acc: 0, pen: 0, acq: 0, ads: 0, comp: 0, pay: 0, cogs: 0, vat: 0, tax: 0, profit: 0 };
    for (const c of cols) for (const k in total) total[k] += c.t[k];
    total.margin = total.rev > 0 ? total.profit / total.rev : null;
    return { cols, total };
  }
  function renderReport() {
    const kind = state.view.report;
    const { cols, total } = reportData(kind);
    const cell = (k, v) => (k === "margin" ? pct(v) : rub(v));
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
          <tbody>${REPORT_ROWS.map(([k, l, s]) => `<tr class="${s >= 2 ? "strong" : s === 0 ? "sub" : ""}"><th scope="row">${l}</th>${cols.map((c) => `<td class="${k === "profit" ? signCls(c.t[k]) : ""}">${cell(k, c.t[k])}</td>`).join("")}<td class="${k === "profit" ? signCls(total[k]) : ""}"><b>${cell(k, total[k])}</b></td></tr>`).join("")}</tbody>
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
          <p class="muted small">НДС считается внутри цены: при 5% это 5/105 выручки (≈4,76%). Налог УСН с ним считается от выручки без НДС.</p>
        </section>
        <section class="panel">
          <h2>Пороги подсветки</h2>
          <p class="muted small">Ниже какой маржи отмечать 🟡 и выше какого ДРР — 🟠.</p>
          <div class="form-row">
            <div class="field"><label for="th-margin">Маржа, %</label><input id="th-margin" type="number" inputmode="decimal" min="0" max="100" value="${state.thresholds.margin}"></div>
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
  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    const first = text.split(/\r?\n/)[0] || "";
    const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ";" : first.includes("\t") ? "\t" : ",";
    const rows = []; let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
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
      settings: { costs: state.costs, tax: state.tax, vat: state.vat, thresholds: state.thresholds } }, null, 2), "application/json");
    toast("Копия данных скачана");
  }
  function importJson(text) {
    let d; try { d = JSON.parse(text); } catch (e) { toast("Это не файл копии Юнитки"); return; }
    if (!d || d.app !== "unitka" || !d.settings) { toast("Это не файл копии Юнитки"); return; }
    if (!confirm("Заменить текущие себестоимость, налог, НДС и пороги данными из файла?")) return;
    const s = d.settings;
    state.costs = cleanCosts(s.costs);
    if (s.tax) state.tax = { rate: s.tax.rate == null || s.tax.rate === "" ? null : Number(s.tax.rate), base: s.tax.base === "profit" ? "profit" : "revenue" };
    if (s.thresholds) state.thresholds = { margin: num(s.thresholds.margin, 15), drr: num(s.thresholds.drr, 20) };
    state.vat = cleanVat(s.vat);
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
    const out = [["Период", "Магазин", "Площадка", "Артикул продавца", "Артикул МП", "Название", "Выкупы, шт", "Выручка, ₽", "Комиссия", "Логистика", "Хранение", "Приёмка", "Штрафы и удержания", "Эквайринг", "Компенсации", "Реклама", "Себестоимость", "НДС", "Налог", "Чистая прибыль, ₽", "Маржа, %", "ДРР, %", "ABC прибыль", "ABC выручка"]];
    for (const c of rows) out.push([`${from}…${to}`, storeName(c.p.store), mpName(c.p.mp), c.p.offerId, c.p.sku, c.p.name, c.units, c.rev, c.comm, c.logi, c.stor, c.acc, c.pen, c.acq, c.comp, c.ads,
      c.cost == null ? "" : c.cogs, c.vat, c.tax, c.profit, c.margin == null ? "" : c.margin * 100, c.drr == null ? "" : c.drr * 100, c.abc_profit, c.abc_rev]);
    download(`unitka-pribyl-${from}-${to}.csv`, csv(out), "text/csv;charset=utf-8");
    toast("CSV скачан");
  }
  function csvReport() {
    const { cols, total } = reportData(state.view.report);
    const out = [["Показатель", ...cols.map((c) => c.label), "Весь период"]];
    for (const [k, l] of REPORT_ROWS) out.push([l, ...cols.map((c) => (k === "margin" ? (c.t[k] == null ? "" : c.t[k] * 100) : c.t[k])), k === "margin" ? (total[k] == null ? "" : total[k] * 100) : total[k]]);
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
      if (act === "demo") return openDemo();
      if (act === "lock") { D = null; IX = null; location.hash = "#/"; return render(); }
      if (act === "store") { state.view.stores = v; listLimit = 50; save(); const r = route(); r.q.delete("store"); location.hash = "#/" + r.parts.join("/") + (String(r.q) ? "?" + r.q : ""); return render(); }
      if (act === "home" || act === "fin") { state.view[act] = Number(v); save(); return render(); }
      if (act === "abc" || act === "report") { state.view[act] = v; save(); return render(); }
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
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openRow(tr); }
  });
  document.addEventListener("change", (e) => {
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
