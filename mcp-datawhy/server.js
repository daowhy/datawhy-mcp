#!/usr/bin/env node
// mcp-datawhy · S1 stdio MCP server MVP（工部 · 御批 2026-10-18 · GB MCP 评估§S1）
// 形态：stdio JSON-RPC 2.0（行分隔），零 npm 依赖；数据层经 dataquery.py（pymysql·stkinfo 库）
// 额度：免费 10 问/日（成功调用计数·落盘 quota 文件·DATAWHY_MCP_QUOTA_FILE 可指测试位）
'use strict';

const readline = require('readline');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_DIR = __dirname;
const DATAQUERY = path.join(PKG_DIR, 'dataquery.py');
const PYTHON = process.env.DATAWHY_MCP_PYTHON || 'python3';
const QUOTA_FILE = process.env.DATAWHY_MCP_QUOTA_FILE || path.join(PKG_DIR, 'quota.json');
const DAILY_LIMIT = parseInt(process.env.DATAWHY_MCP_DAILY_LIMIT || '10', 10);
const QUERY_TIMEOUT_MS = 15000;

const SERVER_INFO = { name: 'datawhy-mcp', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

// ── 工具定义（schema 即接入文档之机读面）────────────────────────────
const TOOLS = [
  {
    name: 'query_daily',
    description:
      '查询 A 股指数/ETF/个股日线行情（开高低收、涨跌幅、成交量额、换手率）。' +
      '代码带交易所后缀，如 000001.SH 上证指数、399006.SZ 创业板指、510300.SH 沪深300ETF、600519.SH 贵州茅台。' +
      '返回按交易日期倒序（最新在前）。日线为 T+1 入库，当日盘中未收。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的代码，如 000001.SH（6 位数字.SS 后缀大写）' },
        start_date: { type: 'string', description: '起始日期 YYYY-MM-DD（缺省＝不限，配合 limit 取最近）' },
        end_date: { type: 'string', description: '截止日期 YYYY-MM-DD（缺省＝今日）' },
        limit: { type: 'integer', description: '返回条数上限 1-500（缺省 60）' }
      },
      required: ['symbol']
    }
  },
  {
    name: 'query_snapshot',
    description:
      '查询标的最新行情快照（最新价、昨收、涨跌幅、当日高低、成交量额）。' +
      '快照表缺该标的时自动回退最近收盘价并标注 fallback=daily_close。一次最多 10 个代码。',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: '标的代码数组（1-10 个），如 ["000001.SH","510300.SH"]'
        }
      },
      required: ['symbols']
    }
  },
  {
    name: 'get_calendar',
    description:
      '查询交易日历：某交易所日期区间内逐日标注交易日/休市（含节假日名称、半日市、前后交易日）。' +
      'exchange 缺省 SSE（上交所）；可选 SSE/SZSE/BSE。',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: '起始日期 YYYY-MM-DD（缺省＝今日往前 30 天）' },
        end_date: { type: 'string', description: '截止日期 YYYY-MM-DD（缺省＝今日往后 30 天）' },
        exchange: { type: 'string', description: '交易所代码 SSE/SZSE/BSE（缺省 SSE）' },
        trading_only: { type: 'boolean', description: 'true＝只返回交易日（缺省 true）' }
      }
    }
  }
];
const TOOL_NAMES = TOOLS.map(t => t.name);

// ── 入参校验（python 侧再验一道·纵深防御）──────────────────────────
const RE_SYMBOL = /^[0-9A-Za-z]{6}\.[A-Za-z]{2}$/;
function normDate(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/\//g, '-');
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}
function validateArgs(name, a) {
  a = typeof a === 'object' && a !== null ? a : {};
  const out = {};
  if (name === 'query_daily') {
    const sym = String(a.symbol || '').toUpperCase().trim();
    if (!RE_SYMBOL.test(sym)) throw new Error(`symbol 格式应为 6 位数字.两位交易所后缀，如 000001.SH（收到：${a.symbol}）`);
    out.symbol = sym;
    if (a.start_date != null) { out.start_date = normDate(a.start_date); if (!out.start_date) throw new Error('start_date 应为 YYYY-MM-DD'); }
    if (a.end_date != null) { out.end_date = normDate(a.end_date); if (!out.end_date) throw new Error('end_date 应为 YYYY-MM-DD'); }
    if (a.start_date && a.end_date && out.start_date > out.end_date) throw new Error('start_date 不得晚于 end_date');
    if (a.limit != null) {
      const n = Number(a.limit);
      if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error('limit 应为 1-500 整数');
      out.limit = n;
    }
  } else if (name === 'query_snapshot') {
    if (!Array.isArray(a.symbols) || a.symbols.length < 1 || a.symbols.length > 10)
      throw new Error('symbols 应为 1-10 个代码的数组');
    out.symbols = a.symbols.map(s => {
      const sym = String(s || '').toUpperCase().trim();
      if (!RE_SYMBOL.test(sym)) throw new Error(`symbol 格式应为 6 位数字.两位交易所后缀（收到：${s}）`);
      return sym;
    });
  } else if (name === 'get_calendar') {
    const now = new Date();
    const iso = d => d.toISOString().slice(0, 10);
    if (a.start_date != null) { out.start_date = normDate(a.start_date); if (!out.start_date) throw new Error('start_date 应为 YYYY-MM-DD'); }
    if (a.end_date != null) { out.end_date = normDate(a.end_date); if (!out.end_date) throw new Error('end_date 应为 YYYY-MM-DD'); }
    if (!out.start_date) { const d = new Date(now); d.setDate(d.getDate() - 30); out.start_date = iso(d); }
    if (!out.end_date) { const d = new Date(now); d.setDate(d.getDate() + 30); out.end_date = iso(d); }
    if (out.start_date > out.end_date) throw new Error('start_date 不得晚于 end_date');
    const ex = String(a.exchange || 'SSE').toUpperCase().trim();
    if (!/^(SSE|SZSE|BSE)$/.test(ex)) throw new Error('exchange 仅支持 SSE/SZSE/BSE');
    out.exchange = ex;
    out.trading_only = a.trading_only === undefined ? true : Boolean(a.trading_only);
  }
  return out;
}

// ── 额度器（免费 10 问/日·成功调用才计数）──────────────────────────
function todayStr() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function readQuota() {
  try {
    const q = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    if (q && q.date === todayStr() && Number.isInteger(q.used)) return { date: q.date, used: q.used };
  } catch (e) { /* 首跑/损坏皆归零重起 */ }
  return { date: todayStr(), used: 0 };
}
function writeQuota(q) {
  const tmp = QUOTA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(q) + '\n');
  fs.renameSync(tmp, QUOTA_FILE);
}

// ── 数据层调用（python 子进程·stdin 请求 stdout JSON·凭据不出 config）──
function callDataquery(tool, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [DATAQUERY], { cwd: PKG_DIR });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('数据查询超时（15s）')); }, QUERY_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`数据层启动失败（${PYTHON}）：${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`数据层退出码 ${code}${err ? '：' + err.trim().slice(0, 200) : ''}`)); return; }
      try {
        const r = JSON.parse(out);
        if (r.ok) resolve(r.data); else reject(new Error(r.error || '数据层未知错误'));
      } catch (e) { reject(new Error(`数据层返回不可解析：${out.slice(0, 200)}`)); }
    });
    child.stdin.write(JSON.stringify({ tool, args }) + '\n');
    child.stdin.end();
  });
}

// ── JSON-RPC 分发（stdout 只走协议·日志一律 stderr）─────────────────
function rpcResult(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
function rpcError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n'); }

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const pv = params && params.protocolVersion ? String(params.protocolVersion) : DEFAULT_PROTOCOL;
    rpcResult(id, { protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
  } else if (method === 'ping') {
    rpcResult(id, {});
  } else if (method === 'tools/list') {
    rpcResult(id, { tools: TOOLS });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOL_NAMES.includes(name)) { rpcResult(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }); return; }
    let args;
    try { args = validateArgs(name, params.arguments); }
    catch (e) { rpcResult(id, { content: [{ type: 'text', text: `参数不合规：${e.message}` }], isError: true }); return; }

    const q = readQuota();
    if (q.used >= DAILY_LIMIT) {
      rpcResult(id, {
        content: [{ type: 'text', text: `免费额度已用尽：每日 ${DAILY_LIMIT} 问（今日已用 ${q.used}）。` +
          `额度口径（免费/付费档映射）属产品侧设计，归 PM V2.1 定档。` }],
        isError: true
      });
      return;
    }
    q.used += 1; writeQuota(q); // 预扣：读-验-写三步同步完成（单线程无竞态），查询失败再退
    try {
      const data = await callDataquery(name, args);
      rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(data) }] });
    } catch (e) {
      const q2 = readQuota(); q2.used = Math.max(0, q2.used - 1); writeQuota(q2); // 失败退款
      rpcResult(id, { content: [{ type: 'text', text: `查询失败：${e.message}` }], isError: true });
    }
  } else {
    rpcError(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
let inFlight = 0, stdinClosed = false;
function maybeExit() { if (stdinClosed && inFlight === 0) process.exit(0); }
rl.on('line', line => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (e) { process.stderr.write(`[mcp-datawhy] 非法 JSON 行已忽略：${line.slice(0, 80)}\n`); return; }
  if (msg && msg.id === undefined && String(msg.method || '').startsWith('notifications/')) return; // 通知不答
  if (!msg || typeof msg.method !== 'string') return;
  inFlight += 1;
  handleRequest(msg).catch(e => process.stderr.write(`[mcp-datawhy] 处理异常：${e.message}\n`))
    .then(() => { inFlight -= 1; maybeExit(); });
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
process.stderr.write(`[mcp-datawhy] stdio server 就绪（tools=${TOOL_NAMES.join(',')}·quota=${DAILY_LIMIT}/日@${path.basename(QUOTA_FILE)}）\n`);
