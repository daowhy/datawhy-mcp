#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# mcp-datawhy 数据层（S1 MVP·双后端）· 工部 2026-10-19
# 用法：stdin 收 {"tool": "...", "args": {...}}，stdout 出 {"ok": true, "data": {...}} / {"ok": false, "error": "..."}
# 后端：DATAWHY_BACKEND=local（默认·stkinfo MySQL 隧道）｜ api（Datawhy 门户·纪要 v2 契约）
#   api 后端：网关 https://info.timelibrary.net/api/v1/market/query/<dataset>·X-API-Key 头
#   key 纪律：只读 env DATAWHY_API_KEY（联调时向主人/侍郎衙支取）——不落卷不进命令行不打印
# 兼容：python3.7（无海象/无 3.8+ 语法）；SQL 一律参数化；LIMIT 硬顶防拖库
import sys, os, json, re, datetime, decimal

try:
    import pymysql
except ImportError:
    pymysql = None  # api 后端无需 pymysql

import urllib.request
import urllib.error
import urllib.parse

DB_CONFIG = os.environ.get("DATAWHY_DB_CONFIG") or os.path.expanduser(
    "~/.agents/skills/stkinfo-db/config.json")
API_BASE = os.environ.get("DATAWHY_API_BASE") or "https://info.timelibrary.net/api/v1"
API_KEY = os.environ.get("DATAWHY_API_KEY") or ""
BACKEND = os.environ.get("DATAWHY_BACKEND") or ("api" if API_KEY else "local")
MAX_LIMIT = 500
RE_SYMBOL = re.compile(r"^[0-9A-Z]{6}\.[A-Z]{2}$")
RE_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def fail(msg):
    print(json.dumps({"ok": False, "error": str(msg)}, ensure_ascii=False))
    sys.exit(0)

def conn():
    if pymysql is None:
        fail("pymysql 未安装（python3 -m pip install pymysql）或改用 DATAWHY_BACKEND=api")
    with open(DB_CONFIG) as f:
        cfg = json.load(f)
    return pymysql.connect(host=cfg["host"], port=int(cfg["port"]), user=cfg["user"],
                           password=cfg["password"], database=cfg["database"],
                           charset="utf8mb4", cursorclass=pymysql.cursors.Cursor,
                           connect_timeout=8, read_timeout=10)

# ── api 后端（门户网关·纪要 v2 契约）─────────────────────────────
def _ssl_ctx():
    """mac 框架版 python 缺系统 CA（环境基线既知）——certifi 优先，次系统 /etc/ssl/cert.pem。"""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        if os.path.exists("/etc/ssl/cert.pem"):
            return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
        return ssl.create_default_context()

def api_get(dataset, params):
    """GET /market/query/<dataset>?<params>·X-API-Key 头。返回解析后 JSON；错误统一 fail()。"""
    ok, payload = api_get_safe(dataset, params)
    if not ok:
        fail(payload)
    return payload

def api_get_safe(dataset, params):
    """同 api_get 但不出错即退：返回 (True, json) 或 (False, 错误串)——供逐标的循环软着陆。"""
    if not API_KEY:
        return False, "api 后端需 DATAWHY_API_KEY（联调时向主人/侍郎衙支取·不留明文）"
    qs = urllib.parse.urlencode(params)
    url = "%s/market/query/%s?%s" % (API_BASE, dataset, qs)
    req = urllib.request.Request(url, headers={"X-API-Key": API_KEY,
                                               "User-Agent": "datawhy-mcp/0.1 (S1 stdio)"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=_ssl_ctx()) as r:
            return True, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
            err = body.get("error", {})
            return False, "网关 %s：%s（%s）" % (e.code, err.get("message", ""), err.get("code", ""))
        except Exception:
            return False, "网关 HTTP %s" % e.code
    except Exception as e:
        return False, "网关不可达：%s：%s" % (type(e).__name__, e)

def _rows_of(resp):
    """从网关响应中辨认数据数组（data/list/rows/items 兼容·联调后按实式收窄）。"""
    if isinstance(resp, dict):
        for k in ("data", "list", "rows", "items", "results"):
            v = resp.get(k)
            if isinstance(v, list):
                return v
    if isinstance(resp, list):
        return resp
    return None

def jdefault(o):
    if isinstance(o, datetime.datetime):
        return o.isoformat(sep=" ")
    if isinstance(o, datetime.date):
        return o.isoformat()
    if isinstance(o, decimal.Decimal):
        return float(o)
    return str(o)

def rows_to_dicts(rows, cols):
    return [dict(zip(cols, r)) for r in rows]

# ── api 源字段归一化（10-21 即开工制·与 local 后端同形）─────────────
FIELD_MAP_DAILY = {
    "trade_date": "date", "open_price": "open", "high_price": "high",
    "low_price": "low", "close_price": "close",
    "pre_close_price": "pre_close", "prev_close_price": "pre_close",
    "change_pct": "change_pct", "volume": "volume", "amount": "amount",
    "turnover_rate": "turnover_rate", "stock_code": "symbol",
    "etf_code": "symbol", "index_code": "symbol", "index_name": "name",
    "etf_name": "name", "stock_name": "name",
}
FIELD_MAP_CAL = {
    "trade_date": "date", "is_trading_day": "trading", "is_half_day": "half_day",
    "holiday_name": "holiday_name", "prev_trade_date": "prev_trade_date",
    "next_trade_date": "next_trade_date",
}

def normalize_rows(rows, mapping):
    out = []
    for r in rows:
        if not isinstance(r, dict):
            out.append(r)
            continue
        d = {}
        for k, v in r.items():
            d[mapping.get(k, k)] = v
        out.append(d)
    return out

def fill_change_pct(rows):
    """无 pre_close/change_pct 时按页内相邻行补算（倒序：次行 close 即前收）。"""
    for i, r in enumerate(rows):
        if not isinstance(r, dict) or r.get("change_pct") is not None:
            continue
        prev = None
        if r.get("pre_close"):
            prev = r["pre_close"]
        elif i + 1 < len(rows) and isinstance(rows[i + 1], dict) and rows[i + 1].get("close"):
            prev = rows[i + 1]["close"]
        if prev and r.get("close"):
            try:
                r["change_pct"] = round((float(r["close"]) / float(prev) - 1) * 100, 4)
            except (TypeError, ZeroDivisionError):
                pass
    return rows

# ── 标的路由：指数 → ETF → 个股（代码带后缀·逐一探表·命中即定）──────
def route_symbol(cur, symbol):
    cur.execute("SELECT 1 FROM trade_index_daily WHERE index_code=%s LIMIT 1", (symbol,))
    if cur.fetchone():
        return "index"
    cur.execute("SELECT 1 FROM trade_etf_daily WHERE etf_code=%s LIMIT 1", (symbol,))
    if cur.fetchone():
        return "etf"
    cur.execute("SELECT 1 FROM trade_stock_daily WHERE stock_code=%s LIMIT 1", (symbol,))
    if cur.fetchone():
        return "stock"
    return None

def q_query_daily(cur, a):
    symbol = a.get("symbol", "").upper()
    if not RE_SYMBOL.match(symbol):
        fail("symbol 格式不合规")
    kind = route_symbol(cur, symbol)
    if kind is None:
        fail("库中无此代码的行情记录：%s（现覆盖：10 指数/ETF/个股日线）" % symbol)
    limit = min(int(a.get("limit", 60)), MAX_LIMIT)
    if kind == "index":
        sql = ("SELECT trade_date AS date, open_price AS open, high_price AS high, low_price AS low, "
               "close_price AS close, pre_close_price AS pre_close, change_pct, volume, amount, index_name AS name "
               "FROM trade_index_daily WHERE index_code=%s")
    elif kind == "etf":
        sql = ("SELECT trade_date AS date, open_price AS open, high_price AS high, low_price AS low, "
               "close_price AS close, prev_close_price AS pre_close, turnover_rate, volume, amount, etf_name AS name "
               "FROM trade_etf_daily WHERE etf_code=%s")
    else:
        sql = ("SELECT trade_date AS date, open_price AS open, high_price AS high, low_price AS low, "
               "close_price AS close, turnover_rate, volume, amount "
               "FROM trade_stock_daily WHERE stock_code=%s")
    cond, params = "", [symbol]
    if a.get("start_date"):
        if not RE_DATE.match(a["start_date"]):
            fail("start_date 格式不合规")
        cond += " AND trade_date>=%s"
        params.append(a["start_date"])
    if a.get("end_date"):
        if not RE_DATE.match(a["end_date"]):
            fail("end_date 格式不合规")
        cond += " AND trade_date<=%s"
        params.append(a["end_date"])
    sql += cond + " ORDER BY trade_date DESC LIMIT %d" % limit
    cur.execute(sql, params)
    rows = rows_to_dicts(cur.fetchall(), [d[0] for d in cur.description])
    return {"tool": "query_daily", "symbol": symbol, "asset": kind, "count": len(rows),
            "order": "date desc", "rows": rows, "source": "stkinfo/trade_%s_daily" % kind}

def q_query_snapshot(cur, a):
    symbols = a.get("symbols", [])
    if not isinstance(symbols, list) or not (1 <= len(symbols) <= 10):
        fail("symbols 应为 1-10 个代码")
    out = []
    for raw in symbols:
        symbol = str(raw).upper()
        if not RE_SYMBOL.match(symbol):
            fail("symbol 格式不合规：%s" % raw)
        cur.execute("SELECT instrument_type, quote_time, last_price, prev_close_price, open_price, "
                    "high_price, low_price, volume, amount FROM trade_quote_snapshot "
                    "WHERE symbol=%s ORDER BY quote_time DESC, id DESC LIMIT 1", (symbol,))
        row = cur.fetchone()
        if row:
            cols = ["instrument_type", "quote_time", "last_price", "prev_close_price", "open_price",
                    "high_price", "low_price", "volume", "amount"]
            d = dict(zip(cols, row))
            last, prev = d["last_price"], d["prev_close_price"]
            d["change_pct"] = round(float((last - prev) / prev * 100), 2) if (last and prev) else None
            d["fallback"] = "snapshot"
        else:
            kind = route_symbol(cur, symbol)
            if kind is None:
                out.append({"symbol": symbol, "error": "库中无此代码"})
                continue
            if kind == "index":
                cur.execute("SELECT trade_date, close_price, pre_close_price, open_price, high_price, "
                            "low_price, volume, amount, change_pct, index_name FROM trade_index_daily "
                            "WHERE index_code=%s ORDER BY trade_date DESC LIMIT 1", (symbol,))
                c = ["date", "last_price", "prev_close_price", "open_price", "high_price", "low_price",
                     "volume", "amount", "change_pct", "name"]
            elif kind == "etf":
                cur.execute("SELECT trade_date, close_price, prev_close_price, open_price, high_price, "
                            "low_price, volume, amount, etf_name FROM trade_etf_daily "
                            "WHERE etf_code=%s ORDER BY trade_date DESC LIMIT 1", (symbol,))
                c = ["date", "last_price", "prev_close_price", "open_price", "high_price", "low_price",
                     "volume", "amount", "name"]
            else:
                cur.execute("SELECT trade_date, close_price, NULL, open_price, high_price, low_price, "
                            "volume, amount FROM trade_stock_daily "
                            "WHERE stock_code=%s ORDER BY trade_date DESC LIMIT 1", (symbol,))
                c = ["date", "last_price", "prev_close_price", "open_price", "high_price", "low_price",
                     "volume", "amount"]
            r = cur.fetchone()
            d = dict(zip(c, r)) if r else {"error": "无数据"}
            d["quote_time"] = d.pop("date", None)
            d["fallback"] = "daily_close"
        d["symbol"] = symbol
        out.append(d)
    return {"tool": "query_snapshot", "count": len(out), "snapshots": out,
            "source": "stkinfo/trade_quote_snapshot(+daily 兜底)", "note": "快照为最近一次采集，盘中非实时"}

EXCHANGE_ALIASES = {"SSE": ["SSE", "SH", "SHSE"], "SZSE": ["SZSE", "SZ"], "BSE": ["BSE", "BJ"]}

# ── api 后端三 handler（端点式照纪要 v2·参数名联调后按实式收窄）──
def a_query_daily(a):
    symbol = str(a.get("symbol", "")).upper()
    if not RE_SYMBOL.match(symbol):
        fail("symbol 格式不合规")
    params = {"symbol": symbol, "page_size": min(int(a.get("limit", 60)), MAX_LIMIT)}
    if a.get("start_date"):
        params["start_date"] = a["start_date"]  # 未验注记：网关区间参数名候联调核实
    if a.get("end_date"):
        params["end_date"] = a["end_date"]
    resp = api_get("stock_daily", params)
    rows = _rows_of(resp)
    rows = fill_change_pct(normalize_rows(rows or [], FIELD_MAP_DAILY))
    return {"tool": "query_daily", "symbol": symbol, "backend": "api",
            "count": len(rows),
            "rows": rows, "raw": resp,
            "source": "datawhy 门户 stock_daily（内测 key）",
            "note": "字段已归一（与 local 后端同形·10-21 即开工制）"}

def a_query_snapshot(a):
    symbols = a.get("symbols", [])
    if not isinstance(symbols, list) or not (1 <= len(symbols) <= 10):
        fail("symbols 应为 1-10 个代码")
    out = []
    for raw in symbols:
        symbol = str(raw).upper()
        if not RE_SYMBOL.match(symbol):
            fail("symbol 格式不合规：%s" % raw)
        # 逐标的软着陆：快照数据集不含指数（10-21 联调实证·指数用 query_daily）
        ok, resp = api_get_safe("quote_snapshot", {"symbol": symbol, "page_size": 1})
        if not ok:
            out.append({"symbol": symbol, "error": resp})
            continue
        rows = _rows_of(resp)
        if not rows:
            out.append({"symbol": symbol, "error": "快照无此代码（数据集不含指数·指数可用 query_daily）"})
            continue
        d = dict(rows[0])
        last, prev = d.get("last_price"), d.get("prev_close_price")
        d["change_pct"] = round(float((last - prev) / prev * 100), 2) if (last and prev) else None
        d["symbol"] = symbol
        out.append(d)
    return {"tool": "query_snapshot", "backend": "api", "count": len(out),
            "snapshots": out, "source": "datawhy 门户 quote_snapshot（内测 key）",
            "note": "快照数据集不含指数（10-21 联调实证）"}

def a_get_calendar(a):
    for k in ("start_date", "end_date"):
        if a.get(k) and not RE_DATE.match(a[k]):
            fail("%s 格式不合规" % k)
    params = {"page_size": 100}  # 网关上限 100（10-21 联调实证·400 被拒）
    if a.get("start_date"):
        params["start_date"] = a["start_date"]
    if a.get("end_date"):
        params["end_date"] = a["end_date"]
    resp = api_get("exchange_calendar", params)
    rows = normalize_rows(_rows_of(resp) or [], FIELD_MAP_CAL)
    return {"tool": "get_calendar", "backend": "api", "trading_only": bool(a.get("trading_only", True)),
            "count": len(rows),
            "days": rows, "raw": resp,
            "source": "datawhy 门户 exchange_calendar（内测 key）",
            "note": "page_size 上限 100（跨限区间候分页·MVP 以 100 日为界）·字段已归一"}

def main():
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        fail("请求体非 JSON")
    tool, args = req.get("tool"), req.get("args") or {}
    if not isinstance(args, dict):
        fail("args 应为对象")
    if BACKEND == "api":
        handlers = {"query_daily": a_query_daily, "query_snapshot": a_query_snapshot,
                    "get_calendar": a_get_calendar}
    else:
        handlers = {"query_daily": q_query_daily, "query_snapshot": q_query_snapshot,
                    "get_calendar": q_get_calendar}
    if tool not in handlers:
        fail("未知工具：%s" % tool)
    if BACKEND != "api":
        try:
            c = conn()
        except Exception as e:
            fail("数据库连接失败（隧道未起？）：%s" % type(e).__name__)
        try:
            with c.cursor() as cur:
                data = handlers[tool](cur, args)
            c.close()
        except SystemExit:
            raise
        except Exception as e:
            fail("查询异常：%s：%s" % (type(e).__name__, e))
    else:
        data = handlers[tool](args)
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False, default=jdefault))

def q_get_calendar(cur, a):
    def norm_date(v, default):
        if v is None:
            return default
        if not RE_DATE.match(v):
            fail("日期格式不合规：%s" % v)
        return v
    today = datetime.date.today()
    start = norm_date(a.get("start_date"), (today - datetime.timedelta(days=30)).isoformat())
    end = norm_date(a.get("end_date"), (today + datetime.timedelta(days=30)).isoformat())
    if start > end:
        fail("start_date 不得晚于 end_date")
    ex = str(a.get("exchange", "SSE")).upper()
    if ex not in EXCHANGE_ALIASES:
        fail("exchange 仅支持 SSE/SZSE/BSE")
    cur.execute("SELECT DISTINCT exchange FROM exchange_calendar")
    have = [r[0] for r in cur.fetchall()]
    real = next((x for x in EXCHANGE_ALIASES[ex] if x in have), None)
    if real is None:
        fail("日历库无 %s 之记录（现有：%s）" % (ex, ",".join(have)))
    trading_only = bool(a.get("trading_only", True))
    sql = ("SELECT trade_date, is_trading_day, is_half_day, holiday_name, prev_trade_date, next_trade_date "
           "FROM exchange_calendar WHERE exchange=%s AND trade_date>=%s AND trade_date<=%s")
    if trading_only:
        sql += " AND is_trading_day=1"
    sql += " ORDER BY trade_date LIMIT 400"
    cur.execute(sql, (real, start, end))
    rows = rows_to_dicts(cur.fetchall(), [d[0] for d in cur.description])
    return {"tool": "get_calendar", "exchange": ex, "trading_only": trading_only,
            "count": len(rows), "days": rows, "source": "stkinfo/exchange_calendar"}

if __name__ == "__main__":
    main()
