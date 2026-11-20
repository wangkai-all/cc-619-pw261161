import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/dates.js';
import {
  generateDataset, backfillLateRecords, FAULT_TYPES,
} from '../src/synthetic-data.js';
import { buildRevision } from '../src/revision.js';
import { fitEstimator } from '../src/estimators.js';
import { forecastAvailability } from '../src/forecast.js';
import { runBacktest } from '../src/backtest.js';
import { dailyLedger } from '../src/ledger.js';

const dataset = generateDataset();
const revision = buildRevision(dataset, dataset.asOf);
const estimator = fitEstimator('byType', revision);

test('预测：输出未来 5 天 P10/P50/P90 且区间合法', () => {
  const fc = forecastAvailability({ revision, estimator, horizon: 5, runs: 200, seed: 42 });
  assert.equal(fc.forecast.length, 5);
  assert.equal(fc.forecast[0].date, addDays(dataset.asOf, 1));
  for (const d of fc.forecast) {
    assert.ok(d.p10 <= d.p50);
    assert.ok(d.p50 <= d.p90);
    assert.ok(d.p10 >= 0 && d.p90 <= dataset.fleetSize);
  }
});

test('预测：同一修订版、同一随机种子 => 结果可复现', () => {
  const a = forecastAvailability({ revision, estimator, runs: 200, seed: 42 });
  const b = forecastAvailability({ revision, estimator, runs: 200, seed: 42 });
  assert.deepEqual(a.forecast, b.forecast);
});

test('预测：仍未修好的批次会撑大区间（stochastic 比 point 更宽）', () => {
  const fc = forecastAvailability({
    revision, estimator, runs: 300, seed: 42, compareOpenImpact: true,
  });
  assert.ok(fc.openBatch.length >= 4, '合成数据在基准日保留一批未修好的架');
  assert.ok(fc.openImpact.openCount === fc.openBatch.length);
  assert.ok(
    fc.openImpact.extraWidthFromOpenBatch >= 0,
    `随机模式不应比点模式更窄，实际差值 ${fc.openImpact.extraWidthFromOpenBatch}`,
  );
  assert.ok(fc.openImpact.stochasticWidthSum >= fc.openImpact.pointWidthSum);
  for (let i = 0; i < fc.forecast.length; i += 1) {
    const s = fc.forecast[i];
    const p = fc.pointModeForecast[i];
    assert.ok((s.p90 - s.p10) >= (p.p90 - p.p10));
  }
});

test('预测：openBatch 的估计剩余天数来自对应故障类型均值', () => {
  const fc = forecastAvailability({ revision, estimator, runs: 100, seed: 7 });
  const anchor = fc.openBatch.find((o) => o.id === 'WO-ANCHOR-01');
  assert.equal(anchor.faultType, 'AVIONICS');
  assert.ok(anchor.estimatedRemainingDays >= 1);
  assert.ok(FAULT_TYPES.AVIONICS.base > FAULT_TYPES.SOFTWARE.base);
});

test('历史回放：两种方法读同一修订版，且分类型 MAE 优于固定平均', () => {
  const bt = runBacktest(dataset, { runs: 200 });
  assert.equal(bt.sameRevisionForBothMethods, true);
  for (const t of bt.revisionTrace) {
    const fixedRow = bt.methods.fixed.rows.find((r) => r.cutoff === t.cutoff);
    const typeRow = bt.methods.byType.rows.find((r) => r.cutoff === t.cutoff);
    if (fixedRow && typeRow) {
      assert.equal(fixedRow.revisionId, typeRow.revisionId);
      assert.equal(fixedRow.revisionId, t.revisionId);
    }
  }
  assert.ok(bt.methods.fixed.aggregate.mae > bt.methods.byType.aggregate.mae,
    `固定均值 MAE=${bt.methods.fixed.aggregate.mae} 应大于分类型 MAE=${bt.methods.byType.aggregate.mae}`);
  for (const method of Object.values(bt.methods)) {
    for (const row of method.rows) {
      assert.ok(row.coverage >= 0 && row.coverage <= 1);
      assert.ok(row.avgWidth >= 0);
    }
  }
});

test('历史回放：覆盖率检验——真值落在回测预测区间附近（区间不系统性失真）', () => {
  const bt = runBacktest(dataset, { runs: 200 });
  assert.ok(bt.methods.byType.aggregate.coverage >= 0.5,
    `P10–P90 名义覆盖 0.8，实测 ${bt.methods.byType.aggregate.coverage} 不应过低`);
});

test('历史回放：过早基准日记录 INSUFFICIENT_DATA 失败而不是崩溃', () => {
  const bt = runBacktest(dataset, { runs: 100 });
  const early = bt.failures.filter((f) => f.cutoff === '2026-09-01');
  assert.equal(early.length, 2, 'fixed 与 byType 都应在该基准日失败');
  assert.ok(early.every((f) => f.code === 'INSUFFICIENT_DATA'));
  assert.ok(bt.methods.fixed.aggregate.evaluatedCutoffs < bt.cutoffs.length);
});

test('补录后重算：修订版改变、区间预测随晚到单纳入而变化', () => {
  const before = forecastAvailability({
    revision, estimator, runs: 200, seed: 42, compareOpenImpact: false,
  });
  const { dataset: filled } = backfillLateRecords(dataset, dataset.asOf);
  const rev2 = buildRevision(filled, dataset.asOf);
  assert.notEqual(rev2.revisionId, revision.revisionId);
  assert.ok(rev2.episodes.length > revision.episodes.length);

  const est2 = fitEstimator('byType', rev2);
  const after = forecastAvailability({
    revision: rev2, estimator: est2, runs: 200, seed: 42, compareOpenImpact: false,
  });
  assert.notDeepEqual(after.forecast, before.forecast);
  // 补录把隐藏停用纳入，首日中位数可用架数应不高于补录前
  assert.ok(after.forecast[0].p50 <= before.forecast[0].p50);

  // 真值视角下实际可用架数与预测量级一致（预测围绕真值波动）
  const truth = dailyLedger(filled, addDays(dataset.asOf, 1), addDays(dataset.asOf, 1), { truth: true })[0];
  const p = after.forecast[0];
  assert.ok(Math.abs(p.p50 - truth.actualAvailable) <= 3,
    `中位数 ${p.p50} 与真值 ${truth.actualAvailable} 偏差过大`);
});
