// Связываем по номеру отправления и товару внутри одного магазина.
// В выгрузку идут только суммы и количество по датам, без номеров отправлений.
import { Agg, F, r2 } from "./lib.mjs";

export class OrderFinance {
  constructor() {
    this.orders = new Map();
    this.charges = new Map();
  }
  order(ref, pid, date, fbs, cancelled, price, qty = 1) {
    if (!ref) return false;
    const id = JSON.stringify([String(ref), pid]);
    if (this.orders.has(id)) return true;
    this.orders.set(id, { pid, date, fbs, cancelled, price, qty });
    return false;
  }
  charge(ref, pid, date, v) {
    if (!ref) return;
    const id = JSON.stringify([String(ref), pid]);
    const row = this.charges.get(id) || { pid, saleDate: "", rev: 0, sold: 0, ret: 0, comm: 0, logi: 0, hasLogi: false };
    for (const f of ["rev", "sold", "ret", "comm", "logi"]) row[f] += v[F[f]] || 0;
    if (v[F.logi]) row.hasLogi = true;
    if (v[F.sold] && date > row.saleDate) row.saleDate = date;
    this.charges.set(id, row);
  }
  result() {
    const byDate = [new Agg(8), new Agg(8)];
    const recent = new Map();
    for (const [id, a] of this.charges) {
      const o = this.orders.get(id);
      if (a.sold > 0 && a.ret === 0 && !o?.cancelled) {
        const history = recent.get(a.pid) || [];
        history.push(a);
        recent.set(a.pid, history);
      }
      if (!o) continue;
      const covered = o.cancelled ? 0 : Math.min(o.qty, a.sold || a.ret);
      byDate[Number(o.fbs)].add(o.date, o.pid, {
        2: covered, 3: covered * o.price, 4: a.rev, 5: a.comm, 6: a.logi, 7: a.ret, 8: a.sold - a.ret, 9: a.hasLogi && !a.sold && !a.ret && !o.cancelled ? o.qty : 0,
      });
    }
    const averages = [...recent].map(([pid, rows]) => {
      const sample = rows.sort((a, b) => b.saleDate.localeCompare(a.saleDate)).slice(0, 10);
      const qty = sample.reduce((sum, row) => sum + row.sold, 0);
      return [pid, r2(sample.reduce((sum, row) => sum + row.comm, 0) / qty),
        r2(sample.reduce((sum, row) => sum + row.logi, 0) / qty), sample.length];
    });
    return { orderFinFbo: byDate[0].rows(), orderFinFbs: byDate[1].rows(), orderAverages: averages };
  }
}
