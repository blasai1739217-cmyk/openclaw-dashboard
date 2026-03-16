/**
 * OpenClaw Agent Server
 *
 * A lightweight, read-only HTTP API server that exposes monitoring data
 * for remote OpenClaw instances. Designed to be deployed on remote machines
 * and proxied through the central dashboard.
 *
 * Usage:
 *   AGENT_TOKEN=your-secret-token AGENT_NAME=MyAgent node agent-server.js
 *
 * Environment variables:
 *   OPENCLAW_DIR      - OpenClaw config directory (default: ~/.openclaw)
 *   WORKSPACE_DIR     - OpenClaw workspace directory (default: cwd)
 *   OPENCLAW_AGENT    - Agent ID to monitor (default: main)
 *   AGENT_SERVER_PORT - Port to listen on (default: 7002)
 *   AGENT_NAME        - Display name for this agent
 *   AGENT_TOKEN       - Shared secret for authentication (required)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execSync } = require('child_process');

// Configuration
const PORT = parseInt(process.env.AGENT_SERVER_PORT || '7002');
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.OPENCLAW_WORKSPACE || process.cwd();
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';
const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const AGENT_TOKEN = process.env.AGENT_TOKEN;

// Paths
const sessDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'sessions');
const cronFile = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
const dataDir = path.join(WORKSPACE_DIR, 'data');
const memoryDir = path.join(WORKSPACE_DIR, 'memory');
const memoryMdPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
const heartbeatPath = path.join(WORKSPACE_DIR, 'HEARTBEAT.md');
const claudeUsageFile = path.join(dataDir, 'claude-usage.json');
const geminiUsageFile = path.join(dataDir, 'gemini-usage.json');
const pricingFile = path.join(WORKSPACE_DIR, 'data', 'model_pricing_usd_per_million.json');

// Model pricing
const DEFAULT_MODEL_PRICING = {
  'anthropic/claude-opus-4-6': { input: 15.00, output: 75.00, cacheRead: 1.875, cacheWrite: 18.75 },
  'anthropic/claude-opus-4-5': { input: 15.00, output: 75.00, cacheRead: 1.875, cacheWrite: 18.75 },
  'anthropic/claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-3-5-haiku-latest': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0.30 },
  'openai/gpt-4.1-mini': { input: 0.40, output: 1.60, cacheRead: 0.20, cacheWrite: 0.80 },
  'google/gemini-3-pro-preview': { input: 1.25, output: 10.00, cacheRead: 0.31, cacheWrite: 4.50 },
  'google/gemini-3-flash-preview': { input: 0.15, output: 0.60, cacheRead: 0.04, cacheWrite: 0.15 },
  'xai/grok-4-1-fast': { input: 0.20, output: 0.50, cacheRead: 0.05, cacheWrite: 0.20 }
};

// Utility functions
function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeProvider(provider) {
  return String(provider || 'unknown').trim().toLowerCase();
}

function normalizeModel(provider, model) {
  const p = normalizeProvider(provider);
  let m = String(model || 'unknown').trim();
  const pref = p + '/';
  if (m.toLowerCase().startsWith(pref)) m = m.slice(pref.length);
  const ml = m.toLowerCase();
  if (p === 'anthropic') {
    if (ml.startsWith('claude-opus-4-6')) return 'claude-opus-4-6';
    if (ml.startsWith('claude-opus-4-5')) return 'claude-opus-4-5';
    if (ml.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
    if (ml.startsWith('claude-sonnet-4-5')) return 'claude-sonnet-4-5';
    if (ml.startsWith('claude-3-5-haiku')) return 'claude-3-5-haiku-latest';
  }
  if (p === 'openai') {
    if (ml.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
    if (ml.startsWith('gpt-4.1-mini')) return 'gpt-4.1-mini';
  }
  if (p === 'google' && ml.startsWith('gemini-3-flash-preview')) return 'gemini-3-flash-preview';
  if (p === 'xai' && ml.startsWith('grok-4-1-fast')) return 'grok-4-1-fast';
  if (p === 'nvidia' && ml.includes('kimi-k2.5')) return 'moonshotai/kimi-k2.5';
  return m;
}

function loadModelPricing() {
  try {
    if (!fs.existsSync(pricingFile)) return { ...DEFAULT_MODEL_PRICING };
    const parsed = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
    const rates = parsed && parsed.rates_usd_per_million;
    if (!rates || typeof rates !== 'object') return { ...DEFAULT_MODEL_PRICING };
    const out = {};
    for (const [k, v] of Object.entries(rates)) {
      if (!k.includes('/') || !v || typeof v !== 'object') continue;
      out[String(k)] = {
        input: toNum(v.input),
        output: toNum(v.output),
        cacheRead: toNum(v.cacheRead),
        cacheWrite: toNum(v.cacheWrite)
      };
    }
    return Object.keys(out).length ? out : { ...DEFAULT_MODEL_PRICING };
  } catch {
    return { ...DEFAULT_MODEL_PRICING };
  }
}

const MODEL_PRICING = loadModelPricing();

function estimateMsgCost(msg) {
  const usage = msg && msg.usage ? msg.usage : {};
  const explicit = toNum(usage.cost && usage.cost.total);
  if (explicit > 0) return explicit;
  const provider = normalizeProvider(msg && msg.provider);
  const modelNorm = normalizeModel(provider, msg && msg.model);
  const rates = MODEL_PRICING[`${provider}/${modelNorm}`];
  if (!rates) return 0;
  const input = Math.max(0, toNum(usage.input)) / 1_000_000;
  const output = Math.max(0, toNum(usage.output)) / 1_000_000;
  const cacheRead = Math.max(0, toNum(usage.cacheRead)) / 1_000_000;
  const cacheWrite = Math.max(0, toNum(usage.cacheWrite)) / 1_000_000;
  return (
    input * toNum(rates.input) +
    output * toNum(rates.output) +
    cacheRead * toNum(rates.cacheRead) +
    cacheWrite * toNum(rates.cacheWrite)
  );
}

// Session helpers
function isSessionFile(f) { return f.endsWith('.jsonl') || f.includes('.jsonl.reset.'); }
function extractSessionId(f) { return f.replace(/\.jsonl(?:\.reset\.\d+)?$/, ''); }

function resolveName(key) {
  if (key.includes(':main:main')) return 'main';
  if (key.includes('teleg')) return 'telegram-group';
  if (key.includes('cron:')) {
    try {
      if (fs.existsSync(cronFile)) {
        const crons = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        const jobs = crons.jobs || [];
        const cronPart = key.split('cron:')[1] || '';
        const cronUuid = cronPart.split(':')[0];
        const job = jobs.find(j => j.id === cronUuid);
        if (job && job.name) return job.name;
      }
    } catch {}
    const cronPart = key.split('cron:')[1] || '';
    const cronUuid = cronPart.split(':')[0];
    return 'Cron: ' + cronUuid.substring(0, 8);
  }
  if (key.includes('subagent')) {
    const parts = key.split(':');
    return parts[parts.length - 1].substring(0, 12);
  }
  return key.split(':').pop().substring(0, 12);
}

function getLastMessage(sessionId) {
  try {
    const filePath = path.join(sessDir, sessionId + '.jsonl');
    if (!fs.existsSync(filePath)) return '';
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type !== 'message') continue;
        const msg = d.message;
        if (!msg) continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === 'text' && b.text) { text = b.text; break; }
          }
        }
        if (text) return text.replace(/\n/g, ' ').substring(0, 80);
      } catch {}
    }
    return '';
  } catch { return ''; }
}

// Cache for session costs
let sessionCostCache = {};
let sessionCostCacheTime = 0;

function getSessionCost(sessionId) {
  const now = Date.now();
  if (now - sessionCostCacheTime > 60000) {
    sessionCostCache = {};
    sessionCostCacheTime = now;
    try {
      const files = fs.readdirSync(sessDir).filter(f => isSessionFile(f));
      for (const file of files) {
        const sid = extractSessionId(file);
        let total = 0;
        const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const c = estimateMsgCost(d.message || {});
            if (c > 0) total += c;
          } catch {}
        }
        if (total > 0) sessionCostCache[sid] = Math.round(total * 100) / 100;
      }
    } catch {}
  }
  return sessionCostCache[sessionId] || 0;
}

// Data retrieval functions
function getSessionsJson() {
  try {
    const sFile = path.join(sessDir, 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sFile, 'utf8'));
    return Object.entries(data).map(([key, s]) => ({
      key,
      label: s.label || resolveName(key),
      model: s.modelOverride || s.model || '-',
      totalTokens: s.totalTokens || 0,
      contextTokens: s.contextTokens || 0,
      kind: s.kind || (key.includes('group') ? 'group' : 'direct'),
      updatedAt: s.updatedAt || 0,
      createdAt: s.createdAt || s.updatedAt || 0,
      aborted: s.abortedLastRun || false,
      thinkingLevel: s.thinkingLevel || null,
      channel: s.channel || '-',
      sessionId: s.sessionId || '-',
      lastMessage: getLastMessage(s.sessionId || key),
      cost: getSessionCost(s.sessionId || key)
    }));
  } catch { return []; }
}

function getUsageWindows() {
  try {
    const now = Date.now();
    const fiveHoursMs = 5 * 3600000;
    const oneWeekMs = 7 * 86400000;
    const files = fs.readdirSync(sessDir).filter(f => {
      if (!f.endsWith('.jsonl')) return false;
      try { return fs.statSync(path.join(sessDir, f)).mtimeMs > now - oneWeekMs; } catch { return false; }
    });

    const perModel5h = {};
    const perModelWeek = {};
    const recentMessages = [];

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const msg = d.message;
          if (!msg || !msg.usage) continue;
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
          if (!ts) continue;
          const provider = normalizeProvider(msg.provider);
          const model = normalizeModel(provider, msg.model);
          const modelKey = `${provider}/${model}`;
          const inTok = Math.max(0, toNum(msg.usage.input));
          const outTok = Math.max(0, toNum(msg.usage.output));
          const cacheReadTok = Math.max(0, toNum(msg.usage.cacheRead));
          const cacheWriteTok = Math.max(0, toNum(msg.usage.cacheWrite));
          const cost = estimateMsgCost(msg);

          if (now - ts < fiveHoursMs) {
            if (!perModel5h[modelKey]) perModel5h[modelKey] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
            perModel5h[modelKey].input += inTok;
            perModel5h[modelKey].output += outTok;
            perModel5h[modelKey].cacheRead += cacheReadTok;
            perModel5h[modelKey].cacheWrite += cacheWriteTok;
            perModel5h[modelKey].cost += cost;
            perModel5h[modelKey].calls++;
          }
          if (now - ts < oneWeekMs) {
            if (!perModelWeek[modelKey]) perModelWeek[modelKey] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
            perModelWeek[modelKey].input += inTok;
            perModelWeek[modelKey].output += outTok;
            perModelWeek[modelKey].cacheRead += cacheReadTok;
            perModelWeek[modelKey].cacheWrite += cacheWriteTok;
            perModelWeek[modelKey].cost += cost;
            perModelWeek[modelKey].calls++;
          }
          if (now - ts < fiveHoursMs) {
            recentMessages.push({ ts, model: modelKey, input: inTok, output: outTok, cacheRead: cacheReadTok, cacheWrite: cacheWriteTok, cost });
          }
        } catch {}
      }
    }

    recentMessages.sort((a, b) => b.ts - a.ts);

    const estimatedLimits = { opus: 88000, sonnet: 220000 };

    let windowStart = null;
    if (recentMessages.length > 0) {
      windowStart = recentMessages[recentMessages.length - 1].ts;
    }
    const windowResetIn = windowStart ? Math.max(0, (windowStart + fiveHoursMs) - now) : 0;

    const thirtyMinAgo = now - 30 * 60000;
    const recent30 = recentMessages.filter(m => m.ts >= thirtyMinAgo);
    let burnTokensPerMin = 0;
    let burnCostPerMin = 0;
    if (recent30.length > 0) {
      const totalOut30 = recent30.reduce((s, m) => s + m.output, 0);
      const totalCost30 = recent30.reduce((s, m) => s + m.cost, 0);
      const spanMs = Math.max(now - Math.min(...recent30.map(m => m.ts)), 60000);
      burnTokensPerMin = totalOut30 / (spanMs / 60000);
      burnCostPerMin = totalCost30 / (spanMs / 60000);
    }

    const opusKey = Object.keys(perModel5h).find(k => k.includes('opus')) || '';
    const opusOut = opusKey ? perModel5h[opusKey].output : 0;
    const sonnetKey = Object.keys(perModel5h).find(k => k.includes('sonnet')) || '';
    const sonnetOut = sonnetKey ? perModel5h[sonnetKey].output : 0;

    const opusRemaining = estimatedLimits.opus - opusOut;
    const timeToLimit = burnTokensPerMin > 0 ? (opusRemaining / burnTokensPerMin) * 60000 : null;

    const perModelCost5h = {};
    for (const [model, data] of Object.entries(perModel5h)) {
      const slash = model.indexOf('/');
      const provider = slash >= 0 ? model.slice(0, slash) : 'unknown';
      const modelName = slash >= 0 ? model.slice(slash + 1) : model;
      const rates = MODEL_PRICING[`${provider}/${modelName}`] || {};
      const inputCost = (data.input || 0) / 1000000 * toNum(rates.input);
      const outputCost = (data.output || 0) / 1000000 * toNum(rates.output);
      const cacheReadCost = (data.cacheRead || 0) / 1000000 * toNum(rates.cacheRead);
      const cacheWriteCost = (data.cacheWrite || 0) / 1000000 * toNum(rates.cacheWrite);
      perModelCost5h[model] = {
        inputCost,
        outputCost,
        cacheReadCost,
        cacheWriteCost,
        totalCost: data.cost || (inputCost + outputCost + cacheReadCost + cacheWriteCost)
      };
    }

    const totalCost5h = Object.values(perModel5h).reduce((s, m) => s + (m.cost || 0), 0);
    const totalCalls5h = Object.values(perModel5h).reduce((s, m) => s + (m.calls || 0), 0);
    const costLimit = 35.0;
    const messageLimit = 1000;

    return {
      fiveHour: {
        perModel: perModel5h,
        perModelCost: perModelCost5h,
        windowStart,
        windowResetIn,
        recentCalls: recentMessages.slice(0, 20).map(m => ({
          ...m,
          ago: Math.round((now - m.ts) / 60000) + 'm ago'
        }))
      },
      weekly: {
        perModel: perModelWeek
      },
      burnRate: { tokensPerMinute: Math.round(burnTokensPerMin * 100) / 100, costPerMinute: Math.round(burnCostPerMin * 10000) / 10000 },
      estimatedLimits,
      current: {
        opusOutput: opusOut,
        sonnetOutput: sonnetOut,
        totalCost: Math.round(totalCost5h * 100) / 100,
        totalCalls: totalCalls5h,
        opusPct: Math.round((opusOut / estimatedLimits.opus) * 100),
        sonnetPct: Math.round((sonnetOut / estimatedLimits.sonnet) * 100),
        costPct: Math.round((totalCost5h / costLimit) * 100),
        messagePct: Math.round((totalCalls5h / messageLimit) * 100),
        costLimit,
        messageLimit
      },
      predictions: { timeToLimit: timeToLimit ? Math.round(timeToLimit) : null, safe: !timeToLimit || timeToLimit > 3600000 }
    };
  } catch {
    return { fiveHour: { perModel: {} }, weekly: { perModel: {} } };
  }
}

function getCostData() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => isSessionFile(f));
    const perModel = {};
    const perDay = {};
    const perSession = {};
    let total = 0;

    for (const file of files) {
      const sid = extractSessionId(file);
      let scost = 0;
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const msg = d.message;
          if (!msg || !msg.usage) continue;
          const c = estimateMsgCost(msg);
          if (c <= 0) continue;
          const provider = normalizeProvider(msg.provider);
          const model = normalizeModel(provider, msg.model);
          if (model.includes('delivery-mirror')) continue;
          const ts = d.timestamp || '';
          const day = ts.substring(0, 10);
          const modelKey = `${provider}/${model}`;
          perModel[modelKey] = (perModel[modelKey] || 0) + c;
          perDay[day] = (perDay[day] || 0) + c;
          scost += c;
          total += c;
        } catch {}
      }
      if (scost > 0) perSession[sid] = scost;
    }

    const now = new Date();
    const todayKey = now.toISOString().substring(0, 10);
    const weekAgo = new Date(now - 7 * 86400000).toISOString().substring(0, 10);
    let weekCost = 0;
    for (const [d, c] of Object.entries(perDay)) {
      if (d >= weekAgo) weekCost += c;
    }

    return {
      total: Math.round(total * 100) / 100,
      today: Math.round((perDay[todayKey] || 0) * 100) / 100,
      week: Math.round(weekCost * 100) / 100,
      perModel,
      perDay: Object.fromEntries(Object.entries(perDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)),
      perSession: Object.fromEntries(
        Object.entries(perSession).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([sid, cost]) => {
          return [sid, { cost, label: 'session-' + sid.substring(0, 8) }];
        })
      )
    };
  } catch { return { total: 0, today: 0, week: 0, perModel: {}, perDay: {}, perSession: {} }; }
}

function getMemoryStats() {
  const totalMem = os.totalmem();
  if (process.platform !== 'darwin') {
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    return { total: totalMem, used: usedMem, free: freeMem, percent: Math.round((usedMem / totalMem) * 100) };
  }
  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 }).trim();
    let pageSize = 4096;
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    if (pageSizeMatch) pageSize = parseInt(pageSizeMatch[1], 10);
    const num = (name) => {
      const m = out.match(new RegExp(name + ':\\s*(\\d+)'));
      return m ? parseInt(m[1], 10) * pageSize : 0;
    };
    const free = num('Pages free');
    const active = num('Pages active');
    const wired = num('Pages wired');
    const compressed = num('Pages occupied by compressor');
    const usedMem = active + wired + (compressed || 0);
    const usedDisplay = Math.min(usedMem, totalMem - free);
    const memPercent = totalMem > 0 ? Math.min(100, Math.round((usedDisplay / totalMem) * 100)) : 0;
    return {
      total: totalMem,
      used: usedDisplay,
      free: free,
      percent: memPercent
    };
  } catch {
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    return { total: totalMem, used: usedMem, free: freeMem, percent: Math.round((usedMem / totalMem) * 100) };
  }
}

function getSystemStats() {
  try {
    const mem = getMemoryStats();

    let cpuTemp = null;
    if (process.platform === 'linux') {
      try {
        const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
        cpuTemp = parseInt(tempRaw, 10) / 1000;
      } catch {}
    } else if (process.platform === 'darwin') {
      try {
        const out = execSync('osx-cpu-temp 2>/dev/null || true', { encoding: 'utf8', timeout: 2000 }).trim();
        const match = out.match(/(\d+(?:\.\d+)?)/);
        if (match) cpuTemp = parseFloat(match[1]);
      } catch {}
    }

    const loadAvg = os.loadavg();
    const uptime = os.uptime();

    let cpuUsage = 0;
    try {
      const loadAvg1m = os.loadavg()[0];
      const numCpus = os.cpus().length;
      cpuUsage = Math.min(Math.round((loadAvg1m / numCpus) * 100), 100);
    } catch {
      cpuUsage = 0;
    }

    let diskPercent = 0, diskUsed = '', diskTotal = '';
    try {
      if (process.platform === 'darwin') {
        const df = execSync("df -g / | tail -1", { encoding: 'utf8' }).trim();
        const parts = df.split(/\s+/).filter(Boolean);
        if (parts.length >= 5) {
          const totalGB = parseInt(parts[1], 10) || 0;
          const usedGB = parseInt(parts[2], 10) || 0;
          const pctStr = parts[4].replace('%', '');
          diskPercent = parseInt(pctStr, 10) || 0;
          diskUsed = usedGB + 'G';
          diskTotal = totalGB + 'G';
        }
      } else {
        const df = execSync("df / --output=pcent,used,size -B1G | tail -1", { encoding: 'utf8' }).trim();
        const parts = df.split(/\s+/);
        diskPercent = parseInt(parts[0], 10) || 0;
        diskUsed = (parts[1] || '') + 'G';
        diskTotal = (parts[2] || '') + 'G';
      }
    } catch {}

    return {
      cpu: { usage: cpuUsage, temp: cpuTemp },
      disk: { percent: diskPercent, used: diskUsed, total: diskTotal },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        percent: mem.percent,
        totalGB: (mem.total / 1073741824).toFixed(1),
        usedGB: (mem.used / 1073741824).toFixed(1),
        freeGB: (mem.free / 1073741824).toFixed(1)
      },
      loadAvg: { '1m': loadAvg[0].toFixed(2), '5m': loadAvg[1].toFixed(2), '15m': loadAvg[2].toFixed(2) },
      uptime: uptime
    };
  } catch {
    return { cpu: { usage: 0, temp: null }, memory: { total: 0, used: 0, free: 0, percent: 0 }, loadAvg: { '1m': 0, '5m': 0, '15m': 0 }, uptime: 0 };
  }
}

function getMemoryFiles() {
  const files = [];
  try {
    if (fs.existsSync(memoryMdPath)) {
      const stat = fs.statSync(memoryMdPath);
      files.push({ name: 'MEMORY.md', modified: stat.mtimeMs, size: stat.size });
    }
  } catch {}
  try {
    if (fs.existsSync(heartbeatPath)) {
      const stat = fs.statSync(heartbeatPath);
      files.push({ name: 'HEARTBEAT.md', modified: stat.mtimeMs, size: stat.size });
    }
  } catch {}
  try {
    if (fs.existsSync(memoryDir)) {
      const entries = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort().reverse();
      entries.forEach(e => {
        try {
          const stat = fs.statSync(path.join(memoryDir, e));
          files.push({ name: 'memory/' + e, modified: stat.mtimeMs, size: stat.size });
        } catch {}
      });
    }
  } catch {}
  return files;
}

function getMemoryFileContent(fname) {
  let fpath = '';
  if (fname === 'MEMORY.md') fpath = memoryMdPath;
  else if (fname === 'HEARTBEAT.md') fpath = heartbeatPath;
  else if (fname.startsWith('memory/') && !fname.includes('..')) fpath = path.join(WORKSPACE_DIR, fname);
  else return null;

  if (fs.existsSync(fpath)) {
    return fs.readFileSync(fpath, 'utf8');
  }
  return null;
}

function getCronJobs() {
  try {
    if (!fs.existsSync(cronFile)) return [];
    const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
    return (data.jobs || []).map(j => {
      let humanSchedule = j.schedule?.expr || '';
      try {
        const parts = humanSchedule.split(' ');
        if (parts.length === 5) {
          const [min, hour, dom, mon, dow] = parts;
          const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          let readable = '';
          if (dow !== '*') readable = dowNames[parseInt(dow)] || dow;
          if (hour !== '*' && min !== '*') readable += (readable ? ' ' : '') + `${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
          if (j.schedule?.tz) readable += ` (${j.schedule.tz.split('/').pop()})`;
          if (readable) humanSchedule = readable;
        }
      } catch {}
      return {
        id: j.id,
        name: j.name || j.id.substring(0, 8),
        schedule: humanSchedule,
        enabled: j.enabled !== false,
        lastStatus: j.state?.lastStatus || 'unknown',
        lastRunAt: j.state?.lastRunAtMs || 0,
        nextRunAt: j.state?.nextRunAtMs || 0,
        lastDuration: j.state?.lastDurationMs || 0
      };
    });
  } catch { return []; }
}

function getLogs(service, lines) {
  const allowedServices = ['openclaw', 'agent-dashboard', 'tailscaled', 'sshd', 'nginx'];
  if (!allowedServices.includes(service)) {
    return { error: 'Invalid service name' };
  }

  if (process.platform !== 'linux') {
    return {
      logs: 'Logs (journalctl) are only available on Linux.\nOn macOS use Console.app or: log show --predicate \'processImagePath contains "openclaw"\' --last 1h'
    };
  }

  const lineCount = Math.min(Math.max(parseInt(lines) || 100, 1), 1000);
  const serviceUnitCandidates = {
    openclaw: ['openclaw', 'openclaw-gateway', 'openclaw-webhooks'],
    'agent-dashboard': ['agent-dashboard'],
    tailscaled: ['tailscaled'],
    sshd: ['sshd'],
    nginx: ['nginx']
  };
  const units = serviceUnitCandidates[service] || [service];
  const scopes = ['system', 'user'];
  const sourceLogs = [];

  for (const scope of scopes) {
    for (const unit of units) {
      try {
        const scopeFlag = scope === 'user' ? '--user ' : '';
        const out = execSync(`journalctl ${scopeFlag}-u ${unit} --no-pager -n ${lineCount} -o short 2>/dev/null`, { encoding: 'utf8', timeout: 10000 });
        if (out && out.trim() && !out.includes('-- No entries --')) {
          const linesArray = out.split('\n').filter(l => l.trim());
          const lastTimestamp = linesArray[linesArray.length - 1]?.substring(0, 15) || '';
          sourceLogs.push({
            scope,
            unit,
            logs: out,
            lastTimestamp,
            lineCount: linesArray.length
          });
        }
      } catch {}
    }
  }

  let logs = '';
  if (sourceLogs.length === 0) {
    logs = `No logs available for "${service}". Tried units: ${units.join(', ')} in system + user journal.`;
  } else if (sourceLogs.length === 1) {
    logs = `[source ${sourceLogs[0].scope}:${sourceLogs[0].unit}]\n${sourceLogs[0].logs}`;
  } else {
    sourceLogs.sort((a, b) => a.lastTimestamp.localeCompare(b.lastTimestamp));
    logs = `${sourceLogs.length} log sources found (chronological by latest entry):\n`;
    for (const entry of sourceLogs) {
      logs += `\n${'='.repeat(60)}\n`;
      logs += `[source ${entry.scope}:${entry.unit}] (${entry.lineCount} lines, latest: ${entry.lastTimestamp})\n`;
      logs += `${'='.repeat(60)}\n`;
      logs += entry.logs;
      if (!entry.logs.endsWith('\n')) logs += '\n';
    }
  }

  return { logs };
}

function getClaudeUsage() {
  try {
    return JSON.parse(fs.readFileSync(claudeUsageFile, 'utf8'));
  } catch {
    return { error: 'No usage data available' };
  }
}

function getGeminiUsage() {
  try {
    return JSON.parse(fs.readFileSync(geminiUsageFile, 'utf8'));
  } catch {
    return { error: 'No usage data available' };
  }
}

// Authentication middleware
function verifyToken(req) {
  if (!AGENT_TOKEN) return true; // No token required if not configured
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.substring(7);
  return token === AGENT_TOKEN;
}

// CORS headers
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Agent-Id');
}

// Cache
let usageCache = null;
let usageCacheTime = 0;
let costCache = null;
let costCacheTime = 0;

// HTTP Server
const server = http.createServer((req, res) => {
  setCORSHeaders(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check (no auth required)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, agent: AGENT_NAME }));
    return;
  }

  // All other endpoints require auth
  if (!verifyToken(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const url = new URL(req.url, 'http://localhost');

  try {
    // Sessions
    if (url.pathname === '/api/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSessionsJson()));
      return;
    }

    // Usage (with caching)
    if (url.pathname === '/api/usage') {
      const now = Date.now();
      if (!usageCache || now - usageCacheTime > 10000) {
        usageCache = getUsageWindows();
        usageCacheTime = now;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(usageCache));
      return;
    }

    // Costs (with caching)
    if (url.pathname === '/api/costs') {
      const now = Date.now();
      if (!costCache || now - costCacheTime > 60000) {
        costCache = getCostData();
        costCacheTime = now;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(costCache));
      return;
    }

    // System stats
    if (url.pathname === '/api/system') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getSystemStats()));
      return;
    }

    // Memory files list
    if (url.pathname === '/api/memory-files') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getMemoryFiles()));
      return;
    }

    // Memory file content
    if (url.pathname === '/api/memory-file') {
      const fname = url.searchParams.get('path') || '';
      const content = getMemoryFileContent(fname);
      if (content !== null) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      }
      return;
    }

    // Cron jobs
    if (url.pathname === '/api/crons') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getCronJobs()));
      return;
    }

    // Logs
    if (url.pathname === '/api/logs') {
      const service = url.searchParams.get('service') || 'openclaw';
      const lines = url.searchParams.get('lines') || '100';
      const result = getLogs(service, lines);
      if (result.error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(result.error);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(result.logs);
      }
      return;
    }

    // Claude usage
    if (url.pathname === '/api/claude-usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getClaudeUsage()));
      return;
    }

    // Gemini usage
    if (url.pathname === '/api/gemini-usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getGeminiUsage()));
      return;
    }

    // 404 for unknown endpoints
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Start server
server.listen(PORT, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  OpenClaw Agent Server');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  Agent:        ${AGENT_NAME}`);
  console.log(`  Port:         ${PORT}`);
  console.log(`  Agent ID:     ${AGENT_ID}`);
  console.log(`  Auth:         ${AGENT_TOKEN ? 'Enabled (token required)' : 'Disabled (no token set)'}`);
  console.log('');
  console.log('  Endpoints:');
  console.log('    GET /health          - Health check');
  console.log('    GET /api/sessions    - Sessions data');
  console.log('    GET /api/usage       - Usage data');
  console.log('    GET /api/costs       - Costs data');
  console.log('    GET /api/system      - System health');
  console.log('    GET /api/memory-files - Memory files list');
  console.log('    GET /api/memory-file - Memory file content');
  console.log('    GET /api/crons       - Cron jobs');
  console.log('    GET /api/logs        - Service logs');
  console.log('    GET /api/claude-usage - Claude usage');
  console.log('    GET /api/gemini-usage - Gemini usage');
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});
