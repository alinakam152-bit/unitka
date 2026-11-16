"""Юнитка — сбор ОТКРЫТЫХ данных (без ключей) в data.json.

Что собирает:
  1) Курсы ЦБ РФ: юань, доллар, евро (источник cbr-xml-daily.ru — зеркало официальных курсов ЦБ).
  2) Свежие новости про Wildberries и Ozon для продавцов — по 3 заголовка (Google Новости, RSS).

Правило надёжности: если какой-то источник не ответил, для него остаётся то,
что было в старом data.json. Если не ответил ни один — файл не трогаем вообще.
Приложение при этом не ломается.

Запуск: python3 fetch.py   (нужен только Python 3, без дополнительных библиотек)
"""

import json
import os
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data.json")
EKB = timezone(timedelta(hours=5))  # Екатеринбург, UTC+5
UA = "Mozilla/5.0 (unitka open-data bot)"

CURRENCIES = [("CNY", "Юань"), ("USD", "Доллар"), ("EUR", "Евро")]
NEWS_QUERIES = [
    ("wb", "Wildberries", "Wildberries продавцы when:7d"),
    ("ozon", "Ozon", "Ozon продавцы when:7d"),
]
NEWS_PER_MP = 3


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def fetch_rates():
    d = json.loads(get("https://www.cbr-xml-daily.ru/daily_json.js").decode("utf-8"))
    items = []
    for code, name in CURRENCIES:
        v = d["Valute"][code]
        nominal = v["Nominal"] or 1
        value = round(v["Value"] / nominal, 4)
        prev = round(v["Previous"] / nominal, 4)
        items.append({"code": code, "name": name, "value": value, "previous": prev, "change": round(value - prev, 4)})
    return {"date": d["Date"][:10], "source": "ЦБ РФ (cbr-xml-daily.ru)", "items": items}


def fetch_news():
    groups, seen = [], set()
    for key, label, query in NEWS_QUERIES:
        url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
            {"q": query, "hl": "ru", "gl": "RU", "ceid": "RU:ru"})
        root = ET.fromstring(get(url))
        found = []
        for it in list(root.iter("item"))[:10]:  # 10 самых подходящих по мнению Google
            title = (it.findtext("title") or "").strip()
            src_el = it.find("source")
            source = (src_el.text or "").strip() if src_el is not None else ""
            if source and title.endswith(" - " + source):
                title = title[: -len(" - " + source)].strip()
            norm = re.sub(r"\W+", "", title.lower())[:60]
            if not title or norm in seen:
                continue
            try:
                when = parsedate_to_datetime(it.findtext("pubDate")).astimezone(EKB).isoformat(timespec="minutes")
            except Exception:
                when = ""
            found.append({"title": title, "source": source, "link": (it.findtext("link") or "").strip(), "date": when})
        found.sort(key=lambda x: x["date"], reverse=True)  # из подходящих — самые свежие
        top = found[:NEWS_PER_MP]
        if not top:
            raise RuntimeError("нет новостей для " + label)
        for n in top:
            seen.add(re.sub(r"\W+", "", n["title"].lower())[:60])
        groups.append({"mp": key, "label": label, "items": top})
    return {"source": "Google Новости", "groups": groups}


def main():
    old = {}
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            old = {}

    new = dict(old)
    ok, errors = [], []
    for name, fn in (("rates", fetch_rates), ("news", fetch_news)):
        try:
            new[name] = fn()
            new.setdefault("checked", {})[name] = datetime.now(EKB).isoformat(timespec="minutes")
            ok.append(name)
        except Exception as e:  # источник не ответил — оставляем старое
            errors.append(f"{name}: {e}")
            print(f"⚠ {name} не обновлено, оставляю старое: {e}", file=sys.stderr)

    if not ok:
        print("✖ Ни один источник не ответил — data.json не меняю.", file=sys.stderr)
        return 0  # не ломаем задание: старый файл остаётся

    new["updated_at"] = datetime.now(EKB).isoformat(timespec="minutes")
    new["errors"] = errors
    tmp = OUT + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(new, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, OUT)  # подмена одним движением: файл никогда не бывает «полузаписанным»
    print("✓ data.json обновлён:", ", ".join(ok))
    return 0


if __name__ == "__main__":
    sys.exit(main())
