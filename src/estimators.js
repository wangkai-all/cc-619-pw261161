// 两种维修时长估算器：
//   fixed   —— 全局固定平均维修时长（不区分故障类型）
//   byType  —— 按故障类型分别估算平均时长
// 二者只使用修订版中「已完成」的历史片段，保证方案比较端读同一份数据。
import { diffDays, mean, ordinal } from './dates.js';
import { InsufficientDataError } from './errors.js';

export const ESTIMATOR_METHODS = ['fixed', 'byType'];

function completedDurations(revision) {
  return revision.episodes
    .filter((e) => e.closedDate !== null && e.closedDate !== undefined &&
      ordinal(e.closedDate) <= ordinal(revision.asOf))
    .map((e) => ({
      id: e.id,
      faultType: e.faultType,
      duration: diffDays(e.groundDate, e.closedDate),
    }));
}

// 固定平均：所有故障类型混在一起。类型构成一旦漂移，均值就有偏。
export function fitFixedEstimator(revision) {
  const samples = completedDurations(revision);
  if (samples.length < 3) {
    throw new InsufficientDataError(
      `fixed estimator needs >=3 completed episodes, got ${samples.length} in ${revision.revisionId}`);
  }
  const avg = mean(samples.map((s) => s.duration));
  return {
    method: 'fixed',
    revisionId: revision.revisionId,
    sampleSize: samples.length,
    avgDuration: avg,
    durationFor() {
      return avg;
    },
    samples,
  };
}

// 分类型平均：每类各自求均值；未知类型回退全局均值并标记。
export function fitByTypeEstimator(revision) {
  const samples = completedDurations(revision);
  if (samples.length < 4) {
    throw new InsufficientDataError(
      `byType estimator needs >=4 completed episodes, got ${samples.length} in ${revision.revisionId}`);
  }
  const byType = new Map();
  for (const s of samples) {
    if (!byType.has(s.faultType)) byType.set(s.faultType, []);
    byType.get(s.faultType).push(s.duration);
  }
  const globalAvg = mean(samples.map((s) => s.duration));
  const typeAverages = {};
  for (const [type, ds] of byType) {
    typeAverages[type] = mean(ds);
  }
  return {
    method: 'byType',
    revisionId: revision.revisionId,
    sampleSize: samples.length,
    avgDuration: globalAvg,
    typeAverages,
    unknownTypesUsed: [],
    durationFor(faultType) {
      if (Object.prototype.hasOwnProperty.call(typeAverages, faultType)) {
        return typeAverages[faultType];
      }
      return globalAvg;
    },
    samples,
  };
}

export function fitEstimator(method, revision) {
  if (method === 'fixed') return fitFixedEstimator(revision);
  if (method === 'byType') return fitByTypeEstimator(revision);
  throw new Error(`unknown estimator method: ${method}`);
}
