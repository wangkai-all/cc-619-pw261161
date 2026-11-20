// 每日台账对齐：待修（停用未还）、归还、实际可用架数。
// 物理真相按 groundDate/closedDate 统计；系统视角按 recordedDate 可见性统计。
// 两者之差即「架已经停用、维修工单记录晚到」造成的口径缺口。
import { addDays, diffDays, eachDay, ordinal } from './dates.js';
import { validateEpisode } from './synthetic-data.js';

function isPhysicallyDown(ep, dayOrd) {
  return ordinal(ep.groundDate) <= dayOrd &&
    (ep.closedDate === null || ep.closedDate === undefined || ordinal(ep.closedDate) > dayOrd);
}

function isVisible(ep, dayOrd) {
  return ep.recordedDate !== null && ep.recordedDate !== undefined && ordinal(ep.recordedDate) <= dayOrd;
}

export function dailyLedger(dataset, fromDate, toDate, { truth = false } = {}) {
  dataset.episodes.forEach(validateEpisode);
  return eachDay(fromDate, toDate).map((date) => {
    const day = ordinal(date);
    let pendingRepair = 0;       // 当日处于停用/维修中的架数
    let returnedToday = 0;       // 当日修复归还的架数
    let recordGap = 0;           // 物理已停用但系统看不到的架数（晚到/未录入）
    const pendingIds = [];
    const lateIds = [];

    for (const ep of dataset.episodes) {
      if (ordinal(ep.groundDate) > day) continue;
      const down = isPhysicallyDown(ep, day);
      const visible = truth || isVisible(ep, day);

      if (down) {
        if (visible) {
          pendingRepair += 1;
          pendingIds.push(ep.airframeId);
        } else {
          recordGap += 1;
          lateIds.push(ep.airframeId);
        }
      }
      if (ep.closedDate !== null && ep.closedDate !== undefined &&
          ordinal(ep.closedDate) === day && visible) {
        returnedToday += 1;
      }
    }

    const recordedAvailable = dataset.fleetSize - pendingRepair;
    const actualAvailable = dataset.fleetSize - pendingRepair - recordGap;
    return {
      date,
      pendingRepair,
      returnedToday,
      recordedAvailable,
      actualAvailable,
      recordGap,
      pendingAirframeIds: pendingIds.sort(),
      lateAirframeIds: lateIds.sort(),
    };
  });
}

// 只给最近 windowDays 天，页面默认展示用。
export function recentLedger(dataset, toDate, windowDays = 14) {
  return dailyLedger(dataset, addDays(toDate, -(windowDays - 1)), toDate);
}

// 汇总区间内的晚到缺口强度，供页面/测试断言。
export function summarizeGap(ledger) {
  const gapDays = ledger.filter((r) => r.recordGap > 0).length;
  const maxGap = ledger.reduce((m, r) => Math.max(m, r.recordGap), 0);
  const totalGapFrameDays = ledger.reduce((s, r) => s + r.recordGap, 0);
  return { gapDays, maxGap, totalGapFrameDays };
}

export function asOfSnapshot(dataset, asOf) {
  const [row] = dailyLedger(dataset, asOf, asOf);
  const horizon = diffDays(dataset.historyFrom ?? asOf, asOf);
  return { ...row, horizonDays: horizon };
}
