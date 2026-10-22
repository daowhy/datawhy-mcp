#!/usr/bin/env node
// datawhy-mcp-remote · SSE/Streamable HTTP 远程型 MCP server（工部 · 奉谕直办 2026-10-22）
// 形态：零依赖 Node http；Streamable HTTP 传输（POST /mcp·JSON-RPC 2.0）；密钥＝客户端 X-API-Key 透传门户网关
// 部署：docker node:24-alpine · 127.0.0.1:18090 · nginx 挂 info.timelibrary.net/mcp-server/
// 鉴权与额度：网关侧执掌（每用户自有 Key·日额度账号共享）——本服务无状态不留密钥
'use strict';
const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '18090', 10);
const GATEWAY = process.env.GATEWAY || 'https://info.timelibrary.net/api/v1';
const DEFAULT_PROTOCOL = '2025-06-18';
const SERVER_INFO = { name: 'datawhy-mcp-remote', version: '1.0.0' };

const TOOLS = [
  {
    name: 'query_daily',
    description: '查询 A 股指数/ETF/个股日线行情（开高低收、涨跌幅、成交量额、换手率）。代码带交易所后缀，如 000001.SH 上证指数、399006.SZ 创业板指、510300.SH 沪深300ETF、600519.SH 贵州茅台。返回按日期倒序（最新在前）。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的代码，6 位数字.两位后缀大写' },
        start_date: { type: 'string', description: '起始日期 YYYY-MM-DD（缺省＝不限）' },
        end_date: { type: 'string', description: '截止日期 YYYY-MM-DD（缺省＝今日）' },
        limit: { type: 'integer', description: '返回条数上限 1-500（缺省 60）' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'query_snapshot',
    description: '查询标的最新行情快照（最新价、昨收、涨跌幅、当日高低、量额）。快照数据集不含指数（指数用 query_daily）；一次最多 10 个代码。',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' }, description: '标的代码数组（1-10 个）' } },
      required: ['symbols']
    }
  },
  {
    name: 'get_calendar',
    description: '查询交易日历：日期区间内逐日标注交易日/休市（含节假日名称、半日市、前后交易日）。exchange 缺省 SSE；trading_only 缺省 true；单次至多 100 日。',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        end_date: { type: 'string', description: '截止日期 YYYY-MM-DD' },
        exchange: { type: 'string', description: 'SSE/SZSE/BSE（缺省 SSE）' },
        trading_only: { type: 'boolean', description: 'true＝只返回交易日（缺省 true）' }
      }
    }
  }
];

// ── 校验（与本地 S1 同尺）─────────────────────────────────────
const RE_SYMBOL = /^[0-9A-Z]{6}\.[A-Z]{2}$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
function normDate(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\//g, '-');
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return RE_DATE.test(t) ? t : null;
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function validate(name, a) {
  a = a && typeof a === 'object' ? a : {};
  const out = {};
  if (name === 'query_daily') {
    const sym = String(a.symbol || '').toUpperCase().trim();
    if (!RE_SYMBOL.test(sym)) throw new Error(`symbol 格式应为 6 位数字.两位交易所后缀（收到：${a.symbol}）`);
    out.symbol = sym;
    if (a.start_date != null) { out.start_date = normDate(a.start_date); if (!out.start_date) throw new Error('start_date 应为 YYYY-MM-DD'); }
    if (a.end_date != null) { out.end_date = normDate(a.end_date); if (!out.end_date) throw new Error('end_date 应为 YYYY-MM-DD'); }
    if (out.start_date && out.end_date && out.start_date > out.end_date) throw new Error('start_date 不得晚于 end_date');
    if (a.limit != null) { const n = Number(a.limit); if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('limit 应为 1-500 整数'); out.limit = n; }
  } else if (name === 'query_snapshot') {
    if (!Array.isArray(a.symbols) || a.symbols.length < 1 || a.symbols.length > 10) throw new Error('symbols 应为 1-10 个代码的数组');
    out.symbols = a.symbols.map(s => { const sym = String(s || '').toUpperCase().trim(); if (!RE_SYMBOL.test(sym)) throw new Error(`symbol 格式不合规（收到：${s}）`); return sym; });
  } else if (name === 'get_calendar') {
    const d = new Date(); const iso = x => x.toISOString().slice(0, 10);
    if (a.start_date != null) { out.start_date = normDate(a.start_date); if (!out.start_date) throw new Error('start_date 应为 YYYY-MM-DD'); }
    if (a.end_date != null) { out.end_date = normDate(a.end_date); if (!out.end_date) throw new Error('end_date 应为 YYYY-MM-DD'); }
    if (!out.start_date) { const x = new Date(d); x.setDate(x.getDate() - 30); out.start_date = iso(x); }
    if (!out.end_date) { const x = new Date(d); x.setDate(x.getDate() + 30); out.end_date = iso(x); }
    if (out.start_date > out.end_date) throw new Error('start_date 不得晚于 end_date');
    const ex = String(a.exchange || 'SSE').toUpperCase().trim();
    if (!/^(SSE|SZSE|BSE)$/.test(ex)) throw new Error('exchange 仅支持 SSE/SZSE/BSE');
    out.exchange = ex;
    out.trading_only = a.trading_only === undefined ? true : Boolean(a.trading_only);
  }
  return out;
}

// ── 网关调用（X-API-Key 透传·密钥不留存）───────────────────────
function gateway(dataset, params, apiKey) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const req = https.request(`${GATEWAY}/market/query/${dataset}?${qs}`, {
      method: 'GET', timeout: 15000,
      headers: { 'X-API-Key': apiKey, 'User-Agent': 'datawhy-mcp-remote/1.0' }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(buf); } catch (e) {}
        if (res.statusCode >= 400) {
          const err = (j && j.error) || {};
          return reject(new Error(`网关 ${res.statusCode}：${err.message || ''}（${err.code || ''}）`));
        }
        resolve(j);
      });
    });
    req.on('error', e => reject(new Error('网关不可达：' + e.message)));
    req.on('timeout', () => { req.destroy(new Error('网关超时（15s）')); });
    req.end();
  });
}
const rowsOf = j => Array.isArray(j) ? j : (j && (Array.isArray(j.items) ? j.items : Array.isArray(j.data) ? j.data : Array.isArray(j.rows) ? j.rows : null));

// ── 字段归一（与 S1 本地/api 后端同形）─────────────────────────
const MAP_DAILY = { trade_date: 'date', open_price: 'open', high_price: 'high', low_price: 'low', close_price: 'close', pre_close_price: 'pre_close', prev_close_price: 'pre_close', volume: 'volume', amount: 'amount', turnover_rate: 'turnover_rate', stock_code: 'symbol', etf_code: 'symbol', index_code: 'symbol', index_name: 'name', etf_name: 'name', stock_name: 'name' };
const MAP_CAL = { trade_date: 'date', is_trading_day: 'trading', is_half_day: 'half_day', holiday_name: 'holiday_name', prev_trade_date: 'prev_trade_date', next_trade_date: 'next_trade_date' };
const normalize = (rows, map) => (rows || []).map(r => { if (!r || typeof r !== 'object') return r; const d = {}; for (const [k, v] of Object.entries(r)) d[map[k] || k] = v; return d; });
function fillPct(rows) {
  rows.forEach((r, i) => {
    if (r.change_pct != null) return;
    const prev = r.pre_close || (rows[i + 1] && rows[i + 1].close);
    if (prev && r.close) r.change_pct = Math.round((r.close / prev - 1) * 10000) / 100;
  });
  return rows;
}

// ── 工具执行──────────────────────────────────────────────
async function exec(name, args, apiKey) {
  const a = validate(name, args);
  if (name === 'query_daily') {
    const p = { symbol: a.symbol, page_size: Math.min(a.limit || 60, 500) };
    if (a.start_date) p.start_date = a.start_date;
    if (a.end_date) p.end_date = a.end_date;
    const j = await gateway('stock_daily', p, apiKey);
    const rows = fillPct(normalize(rowsOf(j), MAP_DAILY));
    return { tool: 'query_daily', symbol: a.symbol, count: rows.length, rows, meta: j.meta || null, source: 'datawhy 门户' };
  }
  if (name === 'query_snapshot') {
    const out = [];
    for (const sym of a.symbols) {
      try {
        const j = await gateway('quote_snapshot', { symbol: sym, page_size: 1 }, apiKey);
        const rows = rowsOf(j);
        if (!rows || !rows.length) { out.push({ symbol: sym, error: '快照无此代码（数据集不含指数·指数可用 query_daily）' }); continue; }
        const d = normalize(rows, MAP_DAILY)[0];
        const last = d.last_price || d.close, prev = d.prev_close_price || d.pre_close;
        if (last && prev) d.change_pct = Math.round((last / prev - 1) * 10000) / 100;
        d.symbol = sym;
        out.push(d);
      } catch (e) { out.push({ symbol: sym, error: e.message }); }
    }
    return { tool: 'query_snapshot', count: out.length, snapshots: out, source: 'datawhy 门户' };
  }
  if (name === 'get_calendar') {
    const p = { page_size: 100 };
    if (a.start_date) p.start_date = a.start_date;
    if (a.end_date) p.end_date = a.end_date;
    const j = await gateway('exchange_calendar', p, apiKey);
    let rows = normalize(rowsOf(j), MAP_CAL);
    if (a.trading_only) rows = rows.filter(r => r.trading === 1);
    return { tool: 'get_calendar', exchange: a.exchange, trading_only: a.trading_only, count: rows.length, days: rows, source: 'datawhy 门户' };
  }
  throw new Error('未知工具：' + name);
}

// ── JSON-RPC 分发──────────────────────────────────────────
function rpc(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcErr(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMessage(msg, apiKey) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const pv = params && params.protocolVersion ? String(params.protocolVersion) : DEFAULT_PROTOCOL;
    return rpc(id, { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  }
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some(t => t.name === name)) return rpc(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
    if (!apiKey) return rpc(id, { content: [{ type: 'text', text: '缺少 X-API-Key（在 MCP 客户端配置请求头·Key 于 datawhy.cn 个人中心创建）' }], isError: true });
    try {
      const data = await exec(name, (params && params.arguments) || {}, apiKey);
      return rpc(id, { content: [{ type: 'text', text: JSON.stringify(data) }] });
    } catch (e) {
      return rpc(id, { content: [{ type: 'text', text: `查询失败：${e.message}` }], isError: true });
    }
  }
  return rpcErr(id, -32601, `method not found: ${method}`);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'MCP-Protocol-Version, Mcp-Session-Id'
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const apiKey = req.headers['x-api-key'] || (String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || '');

  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }); return res.end(JSON.stringify({ ok: true, server: SERVER_INFO, ts: new Date().toISOString() })); }
  if (u.pathname === '/mcp' && req.method === 'GET') { res.writeHead(405, { ...CORS, Allow: 'POST' }); return res.end('{"error":"GET /mcp 不支持（本服务无服务端推送流·用 POST）"}'); }
  if (u.pathname === '/mcp' && req.method === 'DELETE') { res.writeHead(405, { ...CORS, Allow: 'POST' }); return res.end(); }
  if (u.pathname !== '/mcp' || req.method !== 'POST') { res.writeHead(404, CORS); return res.end('{"error":"not found（端点：POST /mcp·GET /healthz）"}'); }

  let buf = '';
  req.on('data', c => { buf += c; if (buf.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    let msgs;
    try { msgs = JSON.parse(buf); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json', ...CORS }); return res.end(JSON.stringify(rpcErr(null, -32700, 'Parse error'))); }
    const batch = Array.isArray(msgs);
    const list = batch ? msgs : [msgs];
    const out = [];
    for (const m of list) {
      if (!m || typeof m.method !== 'string' || m.id === undefined) continue; // 通知不答
      try { out.push(await handleMessage(m, apiKey)); }
      catch (e) { out.push(rpcErr(m.id, -32603, 'Internal error: ' + e.message)); }
    }
    const body = batch ? out : (out[0] || null);
    if (body === null) { res.writeHead(202, CORS); return res.end(); } // 全通知
    res.writeHead(200, { 'Content-Type': 'application/json', 'MCP-Protocol-Version': DEFAULT_PROTOCOL, ...CORS });
    res.end(JSON.stringify(body));
  });
});
server.listen(PORT, () => process.stderr.write(`[datawhy-mcp-remote] 就绪 :${PORT}（POST /mcp·GET /healthz·网关 ${GATEWAY}）\n`));
