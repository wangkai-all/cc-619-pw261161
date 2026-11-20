import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../src/dates.js';
import {
  generateDataset, backfillLateRecords, countLateRecords, FAULT_TYPES,
} from '../src/synthetic-data.js';
import { dailyLedger, summarizeGap, asOfSnapshot } from '../src/ledger.js';
import { DataValidationError } from '../src/errors.js';

const dataset = generateDataset();
const asOf = dataset.asOf;

test('合成数据：确定性复现且结构完整', () => {
  const again = generateDataset();
  assert.deepEqual(again.episodes, dataset.episodes);
  assert.equal(dataset.fleetSize, 12);
  assert.ok(dataset.episodes.length >= 40, '应生成足量历史维修片段');
  for (const ep of dataset.episodes) {
    assert.ok(FAULT_TYPES[ep.faultType], `${ep.id} 故障类型合法`);
    assert.ok(ep.groundDate <= (ep.closedDate ?? addDays(asOf, 1)));
  }
});

test('合成数据：存在“架已停用但工单未录入”的晚到记录', () => {
  const late = countLateRecords(dataset, asOf);
  assert.ok(late >= 1, `至少 1 单晚到，实际 ${late}`);
  const hidden = dataset.episodes.find((e) => e.id === 'WO-HIDDEN-01');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.recordedDate, null);
  assert.ok(hidden.groundDate < asOf);
  assert.ok(hidden.closedDate > asOf, '该架在基准日仍未修好');
});

test('台账对齐：实际可用 = 总架数 − 待修 − 晚到缺口', () => {
  const snap = asOfSnapshot(dataset, asOf);
  assert.equal(
    snap.actualAvailable,
    dataset.fleetSize - snap.pendingRepair - snap.recordGap,
  );
  assert.ok(snap.recordGap >= 1, '基准日台账必须体现晚到缺口');
  assert.ok(snap.recordedAvailable > snap.actualAvailable);
});

test('台账对齐：晚到缺口架号与 hidden 工单对应', () => {
  const snap = asOfSnapshot(dataset, asOf);
  assert.ok(snap.lateAirframeIds.includes('A-07'));
  assert.ok(!snap.pendingAirframeIds.includes('A-07'), '未录入的架不应出现在系统待修里');
});

test('台账对齐：区间内出现过非零缺口且可汇总', () => {
  const ledger = dailyLedger(dataset, addDays(asOf, -20), asOf);
  const summary = summarizeGap(ledger);
  assert.ok(summary.gapDays >= 1);
  assert.ok(summary.maxGap >= 1);
  assert.ok(summary.totalGapFrameDays >= summary.maxGap);
  for (const row of ledger) {
    assert.equal(
      row.recordedAvailable,
      dataset.fleetSize - row.pendingRepair,
    );
  }
});

test('台账真值视角：hidden 工单也计入待修，缺口为 0', () => {
  const ledger = dailyLedger(dataset, asOf, asOf, { truth: true });
  const row = ledger[0];
  assert.equal(row.recordGap, 0);
  assert.ok(row.pendingAirframeIds.includes('A-07'));
});

test('补录早期停用：物理日期与真值不变，缺口转入系统待修', () => {
  const before = asOfSnapshot(dataset, asOf);
  const { dataset: next, applied } = backfillLateRecords(dataset, asOf);
  assert.ok(applied >= 1);
  assert.equal(countLateRecords(next, asOf), 0);

  const after = asOfSnapshot(next, asOf);
  assert.equal(after.recordGap, 0);
  // 基准日当天的缺口整额转入系统待修（历史各天补录的单子已修复，不影响当天待修）
  assert.equal(after.pendingRepair, before.pendingRepair + before.recordGap);
  // 物理真值（实际可用架数）不因录入动作改变；改变的只是系统可见的待修/缺口拆分
  assert.equal(after.actualAvailable, before.actualAvailable);
  // 补录只改录入日，不改物理事件日
  const beforeHidden = dataset.episodes.find((e) => e.id === 'WO-HIDDEN-01');
  const afterHidden = next.episodes.find((e) => e.id === 'WO-HIDDEN-01');
  assert.equal(afterHidden.groundDate, beforeHidden.groundDate);
  assert.equal(afterHidden.closedDate, beforeHidden.closedDate);
  assert.equal(afterHidden.recordedDate, asOf);
  assert.equal(afterHidden.hidden, false);
});

test('异常：非法 episode（未知故障类型 / 日期倒置）被拒绝', () => {
  assert.throws(() => {
    const bad = generateDataset();
    bad.episodes.push({
      id: 'WO-BAD-1', airframeId: 'A-01', faultType: 'PLASMA',
      groundDate: asOf, closedDate: asOf, recordedDate: asOf, hidden: false,
    });
    dailyLedger(bad, asOf, asOf);
  }, DataValidationError);

  assert.throws(() => {
    const bad = generateDataset();
    bad.episodes.push({
      id: 'WO-BAD-2', airframeId: 'A-01', faultType: 'SOFTWARE',
      groundDate: asOf, closedDate: addDays(asOf, -1), recordedDate: asOf, hidden: false,
    });
    dailyLedger(bad, asOf, asOf);
  }, DataValidationError);
});
