import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from '../src/server.js';

const PORT = Number(process.env.TEST_PORT ?? 18099);
const base = `http://127.0.0.1:${PORT}`;

before(async () => {
  if (!server.listening) {
    server.listen(PORT, '127.0.0.1');
    await once(server, 'listening');
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function api(path, init) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('HTTP 接口：正常路径', () => {
  test('GET / 返回带 data-evidence-result 属性的页面', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('data-evidence-result'));
    assert.ok(html.includes('生成原能力预测'));
    assert.ok(html.includes('补录早期停用'));
    assert.ok(html.includes('查看回测和区间'));
  });

  test('POST /api/generate 生成原始数据集并给出台账', async () => {
    const { status, json } = await api('/api/generate', { method: 'POST', body: '{}' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const d = json.data;
    assert.ok(d.revisionId.startsWith('rev-'));
    assert.ok(d.lateRecordsPending >= 1);
    assert.equal(d.backfilled, false);
    assert.equal(d.recentLedger.length, 14);
    assert.ok(d.today.recordGap >= 1);
  });

  test('POST /api/backfill 补录后缺口清零、修订版变化', async () => {
    const before = await api('/api/state');
    assert.ok(before.json.data.lateRecordsPending >= 1);
    const revBefore = before.json.data.revisionId;

    const { status, json } = await api('/api/backfill', { method: 'POST', body: '{}' });
    assert.equal(status, 200);
    const d = json.data;
    assert.ok(d.applied >= 1);
    assert.equal(d.lateRecordsPending, 0);
    assert.equal(d.today.recordGap, 0);
    assert.notEqual(d.revisionId, revBefore);
    assert.equal(d.backfilled, true);
  });

  test('POST /api/forecast 两种方法同修订版并含未修好批次影响', async () => {
    const { status, json } = await api('/api/forecast', { method: 'POST', body: '{}' });
    assert.equal(status, 200);
    const d = json.data;
    assert.deepEqual(Object.keys(d.methods).sort(), ['byType', 'fixed']);
    assert.equal(d.methods.fixed.revisionId, d.methods.byType.revisionId);
    for (const m of Object.values(d.methods)) {
      assert.equal(m.forecast.length, 5);
      assert.ok(m.openImpact.extraWidthFromOpenBatch > 0);
      assert.ok(m.openBatch.length >= 1);
      for (const f of m.forecast) assert.ok(f.p10 <= f.p50 && f.p50 <= f.p90);
    }
  });

  test('GET /api/backtest 含两方法汇总、同修订版轨迹与异常基准日', async () => {
    const { status, json } = await api('/api/backtest');
    assert.equal(status, 200);
    const d = json.data;
    assert.equal(d.sameRevisionForBothMethods, true);
    assert.ok(d.methods.fixed.aggregate.mae > d.methods.byType.aggregate.mae);
    assert.ok(d.failures.some((f) => f.cutoff === '2026-09-01' && f.code === 'INSUFFICIENT_DATA'));
  });

  test('GET /api/state 反映当前会话状态', async () => {
    const { json } = await api('/api/state');
    assert.equal(json.data.backfilled, true);
    assert.equal(json.data.lateRecordsPending, 0);
  });
});

describe('HTTP 接口：异常路径', () => {
  test('未知路由返回 404 与 NOT_FOUND', async () => {
    const { status, json } = await api('/api/nope');
    assert.equal(status, 404);
    assert.equal(json.ok, false);
    assert.equal(json.error.code, 'NOT_FOUND');
  });

  test('POST 非法 JSON 返回 400 与 BAD_JSON', async () => {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.equal(json.error.code, 'BAD_JSON');
  });

  test('重新生成会重置补录状态', async () => {
    await api('/api/generate', { method: 'POST', body: '{}' });
    const { json } = await api('/api/state');
    assert.equal(json.data.backfilled, false);
    assert.ok(json.data.lateRecordsPending >= 1);
  });
});
