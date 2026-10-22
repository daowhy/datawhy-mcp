# mcp-datawhy · Datawhy 问数 MCP server（S1 stdio MVP·双后端）

> 工部承建 · 御批 2026-10-18（公告板）· 规格＝《MCP接入评估_20261017》§S1＋《API探查纪要 v2》· **10-21 呈验**
> 形态：stdio 型 MCP server（JSON-RPC 2.0·行分隔）· **零 npm 依赖** · 数据层**双后端**（本地 stkinfo 库｜门户 API·X-API-Key）
> 免费额度：**10 问/日**（成功调用计数·预扣退款制·落盘 quota.json）

## 〇、双后端（10-19 增）

| 后端 | 启用法 | 数据源 | 状态 |
|---|---|---|---|
| `local`（默认） | 不设 env 即用 | stkinfo MySQL 隧道（127.0.0.1:13306·凭据读 skill config） | **已验**（烟测 8/8＋inspector 实测） |
| `api` | `DATAWHY_BACKEND=api`＋`DATAWHY_API_KEY=<dac_...>`（env 注入·**不留明文**·Key 在管家库 credentials/datawhy-api.json） | Datawhy 门户网关 `info.timelibrary.net/api/v1/market/query/<dataset>`（纪要 v2 契约·stock_daily/quote_snapshot/exchange_calendar 已接） | **✅ 实数联调讫（10-21·主人授 Key·耗内测额度 6 次）**：query_daily 600519.SH 10-20 日线真数（**T+0 鲜度胜本地库 T+1**）·snapshot ETF/个股真数（**数据集不含指数→软着陆报错注**·指数用 query_daily）·calendar 21 日真数（**page_size 上限 100**）·全链 MCP 协议复验过·额度账实相符 |

- 后端选择：`DATAWHY_BACKEND` 显式指定；未指定时有 `DATAWHY_API_KEY` 即 api、无则 local；
- key 纪律：只读 env（server.js 透传）——不落卷、不进命令行、不打印；网关错误（401/403 等）原样透传为工具 isError 文案；
- 未验注记：api 后端区间参数名（start_date/end_date）与响应字段式（data/list/rows 兼容辨认）候联调收窄——README 此注随联调撤；
- 额度双层：MCP 层 10 问/日（quota.json·免费档口径）照旧把门；内测 key 上游 999/日额度属产品侧另记（纪要 §一）。

## 一、件目

| 件 | 职 |
|---|---|
| `server.js` | stdio MCP server：协议握手/tools 清单与调用/额度门/子进程调度（stdout 只走协议·日志一律 stderr） |
| `dataquery.py` | 数据层：stdin 收请求→stdout 出 JSON；SQL 一律参数化；凭据只从 `~/.agents/skills/stkinfo-db/config.json` 读，**不落卷不进命令行不打印** |
| `quota.json` | 额度账（运行时自生：`{date, used}`·跨日自动归零） |
| `烟测.sh` | 全链八验（握手/清单/三工具实查/超额拦截/错参如实报/账实相符）——**今日实跑 8/8 PASS** |

## 二、三工具

1. **query_daily**——指数/ETF/个股日线（开高低收·涨跌幅·量额·换手）。代码带后缀：`000001.SH` 上证指数、`399006.SZ` 创业板指、`510300.SH` 沪深300ETF、`600519.SH` 个股。参数：`symbol`（必）·`start_date`/`end_date`（YYYY-MM-DD 可选）·`limit`（1-500·缺省 60·按日期倒序）。标的路由：指数表→ETF 表→个股表逐一探定。
2. **query_snapshot**——最新行情快照（最新价/昨收/涨跌幅/当日高低/量额）。`symbols` 数组 1-10 个；快照表缺该标的时**自动回退最近收盘**并标 `fallback: "daily_close"`。
3. **get_calendar**——交易日历（逐日交易/休市·节假日名·半日市·前后交易日）。`start_date`/`end_date`（缺省今日±30 天）·`exchange`（SSE/SZSE/BSE·缺省 SSE）·`trading_only`（缺省 true）。

## 三、额度制（免费 10 问/日）

- **预扣退款**：调用时同步「读-验-写」预扣一问（单线程内无竞态），查询失败自动退款——**账面只涨成功**；
- 超额返回 `isError` 文案（附「额度口径归 PM V2.1 定档」导引）；
- 环境变量：`DATAWHY_MCP_QUOTA_FILE`（账本路径·烟测指 /tmp）·`DATAWHY_MCP_DAILY_LIMIT`（限额·测试用）；
- 待 PM 定：免费/付费档在 MCP 层之映射（参数卡 V1 口径）·认证方式（API key vs token）·计费对账口径。

## 四、接入配置（引擎侧）

Kimi（智能体→MCP→添加自定义 MCP）或 Claude Desktop（`claude_desktop_config.json`）同式：

```json
{
  "mcpServers": {
    "datawhy": {
      "command": "node",
      "args": ["/绝对路径/三省六部/工部/工具/mcp-datawhy/server.js"],
      "env": { "DATAWHY_MCP_DAILY_LIMIT": "10" }
    }
  }
}
```

依赖：node ≥ 18（本机 v24 ✓）·python3 + pymysql（本机 ✓）·stkinfo 隧道已起（127.0.0.1:13306）。

## 五、验讫记录（2026-10-18）

- 数据三工具实查过：上证指数 10/16 收 3716.284（与研判台账互证）·沪深300ETF 快照 15:00:34（last 4.236 与日线收盘一致）·日历 10/10-11 周末正确排除；
- 全链八验（`bash 烟测.sh`）：8/8 PASS；
- **真实第三方客户端实测（10-18 补强）**：官方 `@modelcontextprotocol/inspector`（--cli stdio）握手＋tools/list（三工具 schema 全列）＋tools/call 实查（query_daily 2 行·最新 10/16 收 3716.284）俱过——协议合规超出自测范畴；
- **额度跨日归零验（10-18 补强）**：昨日满额账（used=10）今读自动归零（date 换日即清）✓；
- 开发中勘缺陷两枚已修：①stdin 早闭杀在途查询（改在途计数归零方退）②并发额度竞态（改预扣退款制）。

## 六、边界与后续

- S1 为**本地 MVP**：额度门在 server 侧（本地可绕·正式防滥用须 API key+服务端频控，S3 议）；数据延迟：日线 T+1 入库·快照为最近一次采集非实时；
- S2（接入文档+/mcp 静态页）候登服务器之权（御览台§二之12）；S3（SSE 远程型）候源码卷位（后端地址/鉴权）；
- 本包不动门户任何配置——纯新增件，回退＝删本目录。

——工部（2026-10-18·S1 动工当日主体讫·候呈验）
