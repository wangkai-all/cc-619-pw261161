// 仅用 Node.js 内置模块的本地 HTTP 服务。
// 启动：node server.js（或 npm start），读取 PORT，绑定 127.0.0.1。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { AppError, NotFoundError } from './errors.js';
import { generateDataset, backfillLateRecords, countLateRecords } from './synthetic-data.js';
import { buildRevision } from './revision.js';
import { recentLedger, summarizeGap } from './ledger.js';
import { fitEstimator, ESTIMATOR_METHODS } from './estimators.js';
import { forecastAvailability } from './forecast.js';
import { runBacktest } from './backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// 单用户本地会话：状态全部保存在内存，结果均由上面的模块实时算出。
const session = {
  dataset: null,
  backfilled: false,
  backfillHistory: [],
};

function ensureDataset() {
  if (!session.dataset) {
    session.dataset = generateDataset();
  }
  return session.dataset;
}

function revisionOverview(dataset, asOf) {
  const revision = buildRevision(dataset, asOf);
  const ledger = recentLedger(dataset, asOf, 14);
  const gap = summarizeGap(ledger);
  const today = ledger[ledger.length - 1];
  return {
    asOf,
    revisionId: revision.revisionId,
    visibleEpisodes: revision.episodes.length,
    totalEpisodes: dataset.episodes.length,
    lateRecordsPending: countLateRecords(dataset, asOf),
    backfilled: session.backfilled,
    backfillHistory: session.backfillHistory,
    today,
    recentLedger: ledger,
    gapSummary: gap,
  };
}

function buildForecast(dataset) {
  const asOf = dataset.asOf;
  const revision = buildRevision(dataset, asOf);
  const out = {
    asOf,
    revisionId: revision.revisionId,
    methods: {},
  };
  for (const method of ESTIMATOR_METHODS) {
    const estimator = fitEstimator(method, revision);
    out.methods[method] = forecastAvailability({ revision, estimator, horizon: 5, runs: 400, seed: 7701 });
  }
  return out;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('BAD_JSON', '请求体不是合法 JSON', 400);
  }
}

const routes = {
  'GET /api/state': async () => {
    const dataset = ensureDataset();
    return revisionOverview(dataset, dataset.asOf);
  },
  'POST /api/generate': async () => {
    session.dataset = generateDataset();
    session.backfilled = false;
    session.backfillHistory = [];
    return {
      action: 'generate',
      message: '已生成原能力预测所用的合成数据（含晚到工单与未修好批次）',
      ...revisionOverview(session.dataset, session.dataset.asOf),
    };
  },
  'POST /api/backfill': async () => {
    const dataset = ensureDataset();
    const before = countLateRecords(dataset, dataset.asOf);
    const { dataset: next, applied } = backfillLateRecords(dataset, dataset.asOf);
    session.dataset = next;
    session.backfilled = true;
    session.backfillHistory.push({
      at: new Date().toISOString(),
      applied,
      lateRecordsBefore: before,
      lateRecordsAfter: countLateRecords(next, next.asOf),
    });
    return {
      action: 'backfill',
      applied,
      message: `补录 ${applied} 张早期停用工单（groundDate 不变，recordedDate 记为基准日）`,
      ...revisionOverview(session.dataset, session.dataset.asOf),
    };
  },
  'POST /api/forecast': async () => {
    const dataset = ensureDataset();
    return buildForecast(dataset);
  },
  'GET /api/backtest': async () => {
    const dataset = ensureDataset();
    return runBacktest(dataset);
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (url.pathname === '/') {
      const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (!routes[key]) throw new NotFoundError(`没有该接口：${key}`);
    if (req.method === 'POST') await readJsonBody(req);
    const data = await routes[key]();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data }, null, 2));
  } catch (err) {
    const status = err instanceof AppError ? err.httpStatus : 500;
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    if (status === 500) console.error(err);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: false,
      error: { code, message: err.message ?? String(err) },
    }, null, 2));
  }
});

const port = Number(process.env.PORT ?? 8080);
const host = '127.0.0.1';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => {
    console.log(`airframe readiness server listening on http://${host}:${port}`);
  });
}

export { server, session };
