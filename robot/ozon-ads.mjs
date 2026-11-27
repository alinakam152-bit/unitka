import { daysAgo } from "./lib.mjs";
import reports from "../rnp-data.js";

const HOST = "https://api-performance.ozon.ru";
const PLACEMENT_GROUPS = new Map([
  ["PLACEMENT_TOP_PROMOTION", "searchAd"],
  ["PLACEMENT_PDP", "placement"],
  ["PLACEMENT_SEARCH_AND_CATEGORY", "combinedAd"]
]);

export async function ozonAdStats(http, resolve, { clientId, clientSecret }, now) {
  const token = await http(HOST + "/api/client/token", { method: "POST", body: {
    client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials"
  } });
  if (!token?.access_token) throw new Error("Ozon не выдал доступ к Performance API");
  const headers = { Authorization: "Bearer " + token.access_token };
  const campaigns = new Map();
  const pageSize = 100;
  for (let page = 1; ; page++) {
    const response = await http(HOST + `/api/client/campaign?advObjectType=SKU&page=${page}&pageSize=${pageSize}`, { headers });
    if (!Array.isArray(response?.list)) throw new Error("не удалось прочитать список рекламных кампаний");
    for (const campaign of response.list) {
      if (!campaign.id || ["CAMPAIGN_STATE_MODERATION_DRAFT", "CAMPAIGN_STATE_PLANNED"].includes(campaign.state)) continue;
      if (reports.reportDay(campaign.toDate) && campaign.toDate.slice(0, 10) < daysAgo(1, now)) continue;
      campaigns.set(String(campaign.id), campaign.placement);
    }
    if (response.list.length < pageSize) break;
    if (page >= 100) throw new Error("превышено число страниц рекламных кампаний");
  }
  const dateFrom = daysAgo(1, now), dateTo = daysAgo(0, now);
  const ids = [...campaigns.keys()], rows = new Map(), seen = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const response = await http(HOST + "/api/client/statistics/products/sku", { method: "POST", headers, body: {
      campaignIds: ids.slice(i, i + 50), dateFrom, dateTo
    } });
    if (!Array.isArray(response?.rows)) throw new Error("не удалось прочитать статистику рекламных кампаний");
    for (const item of response.rows) {
      const sku = String(item.sku ?? ""), id = resolve(sku);
      const date = reports.reportDay(item.date);
      const campaign = String(item.campaignId);
      if (!id || !date || date < dateFrom || date > dateTo || !campaigns.has(campaign)) continue;
      const itemDay = date + "|" + sku + "|" + campaign;
      if (seen.has(itemDay)) continue;
      seen.add(itemDay);
      const placements = [campaigns.get(campaign)].flat().filter(Boolean);
      const placement = placements.length === 1 ? placements[0] : null;
      const group = PLACEMENT_GROUPS.get(placement);
      const idDay = date + "|" + id;
      const row = rows.get(idDay) || [date, id, {}];
      for (const [source, name] of [["views", "Views"], ["clicks", "Clicks"], ["expense", "Spend"]]) {
        const value = item[source];
        const number = typeof value === "string" && value.trim() ? Number(value.trim().replace(",", ".")) : value;
        if (!Number.isFinite(number)) continue;
        for (const prefix of group ? ["ozonClickAd", group] : ["ozonClickAd"]) {
          const field = prefix + name;
          row[2][field] = (row[2][field] ?? 0) + number;
        }
      }
      if (Object.keys(row[2]).length) rows.set(idDay, row);
    }
  }
  return [...rows.values()];
}
