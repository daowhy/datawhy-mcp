# Datawhy MCP · 小智问数

> A 股行情数据的 MCP（Model Context Protocol）接入——把「小智问数」（datawhy.cn）装进你的 AI。

## 快速接入（远程·推荐）

- 端点（Streamable HTTP）：`https://info.timelibrary.net/mcp-server/mcp`
- 鉴权：请求头 `X-API-Key`（于 [datawhy.cn](https://datawhy.cn) 注册后，个人中心创建）

```json
{
  "mcpServers": {
    "datawhy": {
      "type": "http",
      "url": "https://info.timelibrary.net/mcp-server/mcp",
      "headers": { "X-API-Key": "你的密钥" }
    }
  }
}
```

## 工具

| 工具 | 能力 |
|---|---|
| `query_daily` | 指数 / ETF / 个股日线（开高低收、涨跌幅、量额、换手率） |
| `query_snapshot` | 最新行情快照（个股 / ETF；指数用 query_daily） |
| `get_calendar` | 交易日历（交易日 / 休市、节假日、前后交易日） |

代码带交易所后缀：`000001.SH` 上证指数、`399006.SZ` 创业板指、`510300.SH` 沪深300ETF、`600519.SH` 贵州茅台。

## 本仓库内容

- `mcp-datawhy/`——stdio 本地型 MCP server（Node＋Python 双后端·零 npm 依赖）与远程型 `remote/server.js`
- skill 包（datawhy_info r2·sha256 `b6f84c7aacdd79669dcbdef0ce4c8781422add0d4d5d03ec27ac5abf4ca87a82`）：
  - [Release 下载](https://github.com/daowhy/datawhy-mcp/releases/download/skill-r2/datawhy-info-skill-r2.tar.gz)
  - [仓内直取](./skill/datawhy-info-skill-r2.tar.gz)
  - 安装指引：[datawhy.cn agent-access](https://www.datawhy.cn/#/agent-access)

## 数据与口径

数据来自 datawhy.cn 行情数据门户；额度与限速按账户口径（个人中心可查用量）。行情数据存在延迟，输出不构成任何投资参考依据。

© 2026 [datawhy.cn](https://datawhy.cn) · 小智问数 · [治数时光](https://www.timelibrary.net/)
