(function () {
"use strict";

function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0];
  const separator = [";", "\t", ","].reduce((a, b) => first.split(b).length > first.split(a).length ? b : a);
  const rows = [];
  let row = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) { row.push(value); value = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      rows.push([...row, value]);
      row = [];
      value = "";
    } else value += ch;
  }
  if (row.length || value) rows.push([...row, value]);
  return rows;
}

const reportHeader = (value) => String(value ?? "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");

function reportNumber(value) {
  const text = String(value ?? "").trim().replace(/[\s₽%]/g, "").replace(",", ".");
  return text !== "" && Number.isFinite(Number(text)) ? Number(text) : null;
}

function reportDay(value) {
  const text = String(value ?? "").trim();
  if (/^\d{5}$/.test(text) && Number(text) >= 40000 && Number(text) <= 70000) {
    return new Date((Number(text) - 25569) * 86400000).toISOString().slice(0, 10);
  }
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:\b|T)/)?.[1];
  const local = text.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\b|$)/);
  const day = iso || (local ? `${local[3]}-${local[2]}-${local[1]}` : null);
  const time = day ? Date.parse(day + "T00:00:00Z") : NaN;
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(day) ? day : null;
}

function indexRnpRows(rows) {
  return new Map(rows.map((row) => [JSON.stringify(row.slice(0, 2)), row]));
}

function ozonReportTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return NaN;
  return Date.parse(value.replace(" ", "T") + (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? "" : "Z"));
}

// Храним по дню и товару только агрегаты, без номеров отправлений и данных покупателей.
function parseOzonReport(rows, findProduct, { from, to, seen = new Set() } = {}) {
  const columns = {
    date: ["принят в обработку", "дата заказа"], sku: ["sku"], offer: ["артикул"],
    seller: ["предельная цена", "ваша цена"], buyer: ["оплачено покупателем"],
    qty: ["количество"], status: ["статус"], sellerCurrency: ["код валюты товара"],
    buyerCurrency: ["код валюты покупателя"], posting: ["номер отправления"], delivery: ["дата доставки"]
  };
  const header = (rows[0] || []).map(reportHeader);
  const index = Object.fromEntries(Object.entries(columns).map(([field, names]) => [field, header.findIndex((cell) => names.includes(cell))]));
  if (["date", "sku", "seller", "buyer", "qty", "status", "posting"].some((name) => index[name] < 0)) {
    throw new Error("Не найдены поля отчёта об отправлениях Ozon");
  }
  const aggregate = new Map();
  let unmatched = 0, invalidPrices = 0;
  for (const line of rows.slice(1)) {
    const get = (name) => String(line[index[name]] ?? "").trim();
    const started = ozonReportTime(get("date"));
    const date = Number.isFinite(started) ? new Date(started + 10800000).toISOString().slice(0, 10) : reportDay(get("date"));
    const status = reportHeader(get("status"));
    const qty = reportNumber(get("qty")), posting = get("posting");
    if (!date || !posting || !status || !Number.isInteger(qty) || qty <= 0 ||
        (from && date < from) || (to && date > to)) continue;
    const pid = findProduct(get("sku"), get("offer"));
    if (!pid) { unmatched++; continue; }
    const id = JSON.stringify([posting, get("sku") || pid]);
    if (seen.has(id)) continue;
    seen.add(id);
    const group = JSON.stringify([date, pid]);
    const row = aggregate.get(group) || { date, pid };
    aggregate.set(group, row);
    const add = (field, value) => { row[field] = (row[field] || 0) + value; };
    if (/отмен|cancel/.test(status)) { add("cancelled", qty); continue; }
    add("orders", qty);
    const seller = reportNumber(get("seller")), buyer = reportNumber(get("buyer"));
    const rubles = ["sellerCurrency", "buyerCurrency"].every((field) => !get(field) || /^(rub|rur|₽)$/i.test(get(field)));
    if (seller > 0 && (!get("sellerCurrency") || /^(rub|rur|₽)$/i.test(get("sellerCurrency")))) {
      add("knownOrderPrices", qty);
      add("reportSellerAmount", seller * qty);
    }
    if (seller > 0 && buyer > 0 && buyer <= seller && rubles) {
      add("pairedQty", qty);
      add("sellerAmount", seller * qty);
      add("buyerAmount", buyer * qty);
    } else invalidPrices++;
    if (/^(доставлен[оа]?|выдан[оа]?|delivered)$/.test(status)) {
      add("delivered", qty);
      const days = (ozonReportTime(get("delivery")) - started) / 86400000;
      if (Number.isFinite(days) && days >= 0) {
        add("deliveryDays", days * qty);
        add("deliveryUnits", qty);
      }
    }
  }
  return { rows: [...aggregate.values()].map(({ date, pid, ...values }) => [date, pid, values]), unmatched, invalidPrices };
}

function bestPriceRows(orders, reports) {
  const result = indexRnpRows(orders);
  for (const [date, pid, row] of reports) {
    if (!row.pairedQty) continue;
    const id = JSON.stringify([date, pid]);
    if (row.pairedQty >= (result.get(id)?.[2] ?? 0)) {
      result.set(id, [date, pid, row.pairedQty, row.sellerAmount, row.buyerAmount]);
    }
  }
  return [...result.values()];
}

const RNP_METRICS = {
  listedOrders: ["Заказы, шт.", "Заказы, шт"],
  listedOrderSum: ["Заказы, ₽"],
  listedSales: ["Продажи, ₽"],
  listedSalesUnits: ["Продажи, шт.", "Продажи, шт"],
  listedCancelled: ["Отмены, шт."],
  listedReturns: ["Возвраты, шт."],
  views: ["Показы", "Показы всего", "Всего показов"],
  searchViews: ["Показы в поиске и каталоге", "Показы в поиске и категории"],
  opens: ["Открытия карточки", "Переходы в карточку товара", "Посещения карточки товара"],
  uniqueOpens: ["Уникальные посетители карточки", "Уникальные посетители с просмотром карточки товара"],
  visitors: ["Уникальные посетители", "Уникальные посетители, всего", "Уники"],
  carts: ["В корзину", "Добавления в корзину", "В корзину, шт"],
  funnelOrders: ["Заказы", "Заказано товаров"],
  funnelDelivered: ["Доставлено", "Выкупили товаров", "Добставлено"],
  funnelReturns: ["Возвраты", "Возвращено товаров"],
  funnelCancelled: ["Отмены", "Отменено товаров"],
  position: ["Позиция в поиске", "Позиция в поиске и категории", "Средняя позиция в поиске"],
  nonCategoryViews: ["Показы некатегорийный трафик"],
  delivery: ["Время доставки, дни"],
  stock: ["Доступно к продаже", "Доступно к продаже, шт."],
  transit: ["В пути к покупателям", "Товары в пути, шт."],
  fromClient: ["В пути от покупателей"],
  price: ["Цена продавца, ₽"],
  placementViews: ["ПиР - Показы", "ПиР — показы"],
  placementClicks: ["ПиР - Клики", "ПиР — клики"],
  placementSpend: ["ПиР - Расход, ₽", "ПиР — расход, ₽"],
  searchAdViews: ["Поиск - Показы", "Поиск — показы"],
  searchAdClicks: ["Поиск - Клики", "Поиск — клики"],
  searchAdSpend: ["Поиск - Расход, ₽", "Поиск — расход, ₽"],
  orderAdSpend: ["ОЗЗ - Расход, ₽", "ОЗЗ — расход, ₽"],
  buyWindowDelivered: ["Доставлено 30 дн"],
  buyWindowReturned: ["Возвраты 30 дн"],
  buyWindowCancelled: ["Отмены 30 дн"],
  rollingSeller: ["Продажи за 7 дней без соинвеста, ₽"],
  rollingBuyer: ["Продажи за 7 дней с соинвестом, ₽"]
};

function parseRnpMetrics(rows, findProduct) {
  const header = (rows[0] || []).map(reportHeader);
  const dateColumn = header.findIndex((cell) => ["дата", "день"].includes(cell));
  const namedSku = header.findIndex((cell) => ["sku", "артикул wb", "артикул площадки"].includes(cell));
  const namedOffer = header.indexOf("артикул продавца");
  const genericArticle = header.indexOf("артикул");
  const skuColumn = namedSku >= 0 ? namedSku : namedOffer >= 0 ? genericArticle : -1;
  const offerColumn = namedOffer >= 0 ? namedOffer : genericArticle;
  const grouping = header.indexOf("общее название");
  const fields = Object.entries(RNP_METRICS).map(([field, names]) =>
    [field, header.findIndex((cell) => names.some((name) => reportHeader(name) === cell))]).filter(([, column]) => column >= 0);
  if (dateColumn < 0 || (skuColumn < 0 && offerColumn < 0) || !fields.length) throw new Error("Нужны дата, артикул и хотя бы один столбец из шаблона РНП");
  const result = new Map();
  const aliases = new Map();
  let unmatched = 0;
  for (const row of rows.slice(1)) {
    const date = reportDay(row[dateColumn]);
    if (!date) continue;
    const pid = findProduct(String(row[skuColumn] ?? "").trim(), String(row[offerColumn] ?? "").trim());
    if (!pid) { unmatched++; continue; }
    const name = String(row[grouping] ?? "").trim();
    if (name) {
      if (!aliases.has(name)) aliases.set(name, new Set());
      aliases.get(name).add(pid);
    }
    const group = JSON.stringify([date, pid]);
    const values = result.get(group)?.[2] || {};
    for (const [field, column] of fields) {
      const value = reportNumber(row[column]);
      if (value != null && (value >= 0 || field === "listedSales" || field === "listedSalesUnits")) values[field] = value;
    }
    if (values.funnelOrders == null && values.listedOrders != null) values.funnelOrders = values.listedOrders;
    if (Object.keys(values).length) result.set(group, [date, pid, values]);
  }
  return { rows: [...result.values()], unmatched, aliases: Object.fromEntries([...aliases].map(([name, pids]) => [name, [...pids]])) };
}

function parseRnpInputs(rows, findProduct) {
  const aliases = {
    commission: ["комиссия, %", "комиссия ozon, %"], logistics: ["тариф логистики, ₽"],
    nonlocal: ["наценка за нелокальную продажу, %"], buy: ["% выкупа", "выкуп, %"],
    cost: ["себестоимость, ₽", "полная себестоимость, ₽"]
  };
  const headIndex = rows.findIndex((row) => row.some((cell) => aliases.logistics.includes(reportHeader(cell))));
  if (headIndex < 0) throw new Error("Нужен лист Unit или шаблон параметров РНП");
  const header = rows[headIndex].map(reportHeader);
  const sku = header.findIndex((cell) => ["sku", "артикул ozon", "артикул площадки"].includes(cell));
  const offer = header.findIndex((cell) => ["артикул", "артикул продавца", "ваш артикул"].includes(cell));
  const productName = header.indexOf("наименование товара");
  if (sku < 0 && offer < 0 && productName < 0) throw new Error("В листе нет артикула или наименования товара");
  const fields = Object.entries(aliases).map(([field, names]) => [field, header.findIndex((cell) => names.includes(cell))]);
  const sourceUnit = header.includes("комиссия ozon, %");
  const result = new Map();
  let unmatched = 0;
  for (const row of rows.slice(headIndex + 1)) {
    const skuValue = String(row[sku] ?? "").trim(), offerValue = String(row[offer] ?? "").trim();
    const name = String(row[productName] ?? "").trim();
    if (!skuValue && !offerValue && !name) continue;
    const resolved = findProduct(skuValue, offerValue, name);
    if (!resolved) { unmatched++; continue; }
    const values = {};
    for (const [field, column] of fields) {
      const raw = row[column];
      let value = reportNumber(raw);
      if (value == null || value < 0) continue;
      if (sourceUnit && ["commission", "nonlocal", "buy"].includes(field) && !String(raw).includes("%") && value <= 1) value *= 100;
      if (field !== "buy" || value > 0) values[field] = value;
    }
    if (Object.keys(values).length) {
      for (const pid of Array.isArray(resolved) ? resolved : [resolved]) result.set(pid, { ...result.get(pid), ...values });
    }
  }
  return { rows: [...result], unmatched };
}

const reports = { parseCsv, reportDay, reportHeader, reportNumber, indexRnpRows, parseOzonReport, bestPriceRows, RNP_METRICS, parseRnpMetrics, parseRnpInputs };
if (typeof module !== "undefined" && module.exports) module.exports = reports;
else window.UnitkaReports = reports;
})();
