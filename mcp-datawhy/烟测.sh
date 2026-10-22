#!/bin/bash
# mcp-datawhy S1 烟测（工部·2026-10-18）——全链七验，临时额度位不动真额度
# 用法：bash 烟测.sh   （需：stkinfo 隧道已起·node≥18·python3+pymysql）
set -u
cd "$(dirname "$0")"
Q=/tmp/mcp_datawhy_smoke_quota.json
OUT=/tmp/mcp_datawhy_smoke_out.json
rm -f "$Q" "$OUT"
export DATAWHY_MCP_QUOTA_FILE="$Q" DATAWHY_MCP_DAILY_LIMIT=3
PASS=0; FAIL=0
ck(){ if [ "$2" = "0" ]; then echo "✓ $1"; PASS=$((PASS+1)); else echo "× $1"; FAIL=$((FAIL+1)); fi }

printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"query_daily","arguments":{"symbol":"000001.SH","limit":1}}}' \
'{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"query_snapshot","arguments":{"symbols":["510300.SH"]}}}' \
'{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_calendar","arguments":{}}}' \
'{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"query_daily","arguments":{"symbol":"000001.SH","limit":1}}}' \
'{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"nope","arguments":{}}}' \
'{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"query_daily","arguments":{"symbol":"坏代码"}}}' \
| node server.js 2>/dev/null > "$OUT"

python3 - "$OUT" "$Q" <<'EOF'
import json, sys
out, qf = sys.argv[1], sys.argv[2]
rs = {}
for line in open(out):
    m = json.loads(line)
    if m.get("id") is not None:
        rs[m["id"]] = m.get("result", {})
def txt(i): return rs[i]["content"][0]["text"]
checks = [
  ("1 initialize 握手（协议版本+serverInfo）", rs.get(1, {}).get("serverInfo", {}).get("name") == "datawhy-mcp"),
  ("2 tools/list 三工具齐", [t["name"] for t in rs.get(2, {}).get("tools", [])] == ["query_daily", "query_snapshot", "get_calendar"]),
  ("3 query_daily 指数日线实查", rs.get(3, {}).get("isError") is None and json.loads(txt(3))["count"] == 1),
  ("4 query_snapshot 快照实查", rs.get(4, {}).get("isError") is None and json.loads(txt(4))["count"] == 1),
  ("5 get_calendar 日历实查", rs.get(5, {}).get("isError") is None and json.loads(txt(5))["count"] > 0),
  ("6 第4问超额拦截（限额3）", rs.get(6, {}).get("isError") is True and "额度已用尽" in txt(6)),
  ("7+8 未知工具/坏参数如实报错", rs.get(7, {}).get("isError") is True and rs.get(8, {}).get("isError") is True),
  ("9 额度账实相符（=3·拦截不扣）", json.load(open(qf))["used"] == 3),
]
for name, ok in checks:
    print(("✓ " if ok else "× ") + name)
    sys.exit_code = 0
import sys as _s
fails = [n for n, ok in checks if not ok]
print(f"── 烟测小结：{len(checks)-len(fails)}/{len(checks)} 过" + ("" if not fails else "·未过：" + "；".join(fails)))
_s.exit(1 if fails else 0)
EOF
RC=$?
[ $RC -eq 0 ] && echo "═ 烟测 PASS ═" || echo "═ 烟测 FAIL（退出码 $RC）═"
exit $RC
