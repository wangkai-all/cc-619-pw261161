import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDataset } from '../src/synthetic-data.js';
import { buildRevision } from '../src/revision.js';
import {
  fitEstimator, fitFixedEstimator, fitByTypeEstimator,
} from '../src/estimators.js';
import { InsufficientDataError } from '../src/errors.js';

const dataset = generateDataset();
const revision = buildRevision(dataset, dataset.asOf);

test('修订版：只包含基准日前已录入的工单，且有稳定哈希', () => {
  const again = buildRevision(dataset, dataset.asOf);
  assert.equal(again.revisionId, revision.revisionId);
  assert.ok(revision.episodes.every((e) => e.recordedDate <= dataset.asOf));
  assert.ok(revision.episodes.every((e) => e.hidden === false));
  assert.ok(revision.episodes.length < dataset.episodes.length, 'hidden/晚到工单被排除');
});

test('固定平均估算器：产出单一全局均值', () => {
  const fixed = fitFixedEstimator(revision);
  assert.equal(fixed.method, 'fixed');
  assert.ok(fixed.sampleSize >= 3);
  const expected = fixed.samples.reduce((s, x) => s + x.duration, 0) / fixed.sampleSize;
  assert.equal(Number(fixed.avgDuration.toFixed(10)), Number(expected.toFixed(10)));
  // 不区分类型：任何类型都返回同一个均值
  assert.equal(fixed.durationFor('AVIONICS'), fixed.avgDuration);
  assert.equal(fixed.durationFor('SOFTWARE'), fixed.avgDuration);
});

test('分类型估算器：各类均值随真实时长不同而拉开', () => {
  const byType = fitByTypeEstimator(revision);
  assert.equal(byType.method, 'byType');
  const t = byType.typeAverages;
  assert.ok(t.AVIONICS > t.SOFTWARE, '航电平均维修时长应显著长于软件');
  assert.ok(t.HYDRAULIC > t.STRUCTURAL);
  // 未知类型回退全局均值而不是崩溃
  assert.equal(byType.durationFor('UNKNOWN_TYPE'), byType.avgDuration);
});

test('两种估算器使用同一修订版（公平比较前提）', () => {
  const fixed = fitEstimator('fixed', revision);
  const byType = fitEstimator('byType', revision);
  assert.equal(fixed.revisionId, byType.revisionId);
  assert.equal(fixed.sampleSize, byType.sampleSize);
  assert.throws(() => fitEstimator('neural', revision), /unknown estimator/);
});

test('异常：历史样本不足时两个估算器都拒绝并给出 INSUFFICIENT_DATA', () => {
  const early = buildRevision(dataset, '2026-09-01');
  assert.ok(early.episodes.length <= 2);
  assert.throws(() => fitFixedEstimator(early), (err) => {
    assert.ok(err instanceof InsufficientDataError);
    assert.equal(err.code, 'INSUFFICIENT_DATA');
    return true;
  });
  assert.throws(() => fitByTypeEstimator(early), InsufficientDataError);
});
