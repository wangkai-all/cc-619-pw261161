// 合成数据：可复现地构造「维修工单记录晚到、但架已经停用」的场景。
//
// 一个 episode（维修片段）= 某架机一次故障到修复的完整记录：
//   id          工单号
//   airframeId  架号
//   faultType   故障类型（决定真实平均维修时长）
//   groundDate  实际停用日期（事件日，台账真值以此为准）
//   closedDate  实际修复/归还日期；生成器给出未来日期表示截至基准日仍未修好
//   recordedDate 工单录入日期；晚到时会晚于 groundDate
//   hidden      true 表示该单在基准日还完全没录入（补录入口）
import { addDays, diffDays, ordinal } from './dates.js';
import { gaussian, mulberry32, pick, randInt } from './rng.js';
import { DataValidationError } from './errors.js';

export const FAULT_TYPES = {
  AVIONICS: { base: 12, sigma: 1.8 },   // 航电：长
  HYDRAULIC: { base: 8, sigma: 1.5 },   // 液压：中
  STRUCTURAL: { base: 5, sigma: 1.0 },  // 结构：短
  SOFTWARE: { base: 3, sigma: 0.7 },    // 软件：最短
};

export const DEFAULT_AS_OF = '2026-11-20';
const HISTORY_FROM = '2026-09-01';
const FLEET_SIZE = 12;
const AIRFRAME_IDS = Array.from({ length: FLEET_SIZE }, (_, i) =>
  `A-${String(i + 1).padStart(2, '0')}`);

function clampDuration(d) {
  return Math.max(1, Math.round(d));
}

// 基准日仍未修好的一批架：固定在生成数据里，保证每次复现同样的「未归还批次」。
function anchorEpisodes(asOf) {
  const specs = [
    ['WO-ANCHOR-01', 'A-03', 'AVIONICS', 6, 4],
    ['WO-ANCHOR-02', 'A-05', 'HYDRAULIC', 4, 2],
    ['WO-ANCHOR-03', 'A-08', 'STRUCTURAL', 2, 1],
    ['WO-ANCHOR-04', 'A-11', 'SOFTWARE', 1, 0],
  ];
  return specs.map(([id, airframeId, faultType, daysBeforeAsOf, recordedLag]) => {
    const groundDate = addDays(asOf, -daysBeforeAsOf);
    const closedDate = addDays(asOf, randIntDeterministic(id, 6, 12)); // 落在未来 => 基准日未修好
    const candidateRecorded = addDays(groundDate, recordedLag);
    // 录入日晚于基准日 => 基准日还没录入；否则正常可见（仍保留晚到滞后）
    const recordedDate = ordinal(candidateRecorded) > ordinal(asOf) ? null : candidateRecorded;
    return {
      id, airframeId, faultType, groundDate, closedDate,
      recordedDate,
      hidden: false,
    };
  });
}

// 给固定锚点一个确定性的“未来修复日”，避免依赖全局随机序列。
function randIntDeterministic(tag, min, max) {
  let h = 2166136261;
  for (const ch of tag) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return min + (h >>> 0) % (max - min + 1);
}

export function validateEpisode(e) {
  const required = ['id', 'airframeId', 'faultType', 'groundDate'];
  for (const k of required) {
    if (e[k] === undefined || e[k] === null || e[k] === '') {
      throw new DataValidationError(`episode ${e.id ?? '<unknown>'} missing field ${k}`);
    }
  }
  if (!FAULT_TYPES[e.faultType]) {
    throw new DataValidationError(`episode ${e.id} has unknown faultType ${e.faultType}`);
  }
  try {
    const g = ordinal(e.groundDate);
    if (e.closedDate !== null && e.closedDate !== undefined && ordinal(e.closedDate) < g) {
      throw new DataValidationError(`episode ${e.id}: closedDate earlier than groundDate`);
    }
    if (e.recordedDate !== null && e.recordedDate !== undefined && ordinal(e.recordedDate) < g) {
      throw new DataValidationError(`episode ${e.id}: recordedDate earlier than groundDate`);
    }
  } catch (err) {
    if (err instanceof DataValidationError) throw err;
    throw new DataValidationError(`episode ${e.id}: unparseable date (${err.message})`);
  }
}

// 常规历史片段：保证每种故障类型都有足够已完成样本。
function routineEpisodes(rng, asOf, busy) {
  const types = Object.keys(FAULT_TYPES);
  const out = [];
  let seq = 1;
  const span = diffDays(HISTORY_FROM, asOf);

  for (const airframeId of AIRFRAME_IDS) {
    let cursor = ordinal(HISTORY_FROM) + randInt(rng, 0, 4);
    const endOrd = ordinal(asOf);
    while (cursor < endOrd - 2) {
      const faultType = pick(rng, types);
      const spec = FAULT_TYPES[faultType];
      const duration = clampDuration(spec.base + gaussian(rng) * spec.sigma);
      const groundDate = addDays(asOf, cursor - endOrd);
      const closedDate = addDays(groundDate, duration);
      // 晚到录入：30% 的工单录入滞后 2–6 天；部分跨过基准日变成 hidden
      let hidden = false;
      let recordedDate;
      if (rng() < 0.3) {
        const lag = randInt(rng, 2, 6);
        const rec = addDays(groundDate, lag);
        if (diffDays(rec, asOf) > 0) {
          hidden = true;
          recordedDate = null;
        } else {
          recordedDate = rec;
        }
      } else {
        recordedDate = groundDate;
      }
      const ep = {
        id: `WO-${String(seq).padStart(4, '0')}`,
        airframeId, faultType, groundDate, closedDate, recordedDate, hidden,
      };
      if (!overlaps(ep, busy.get(airframeId))) {
        out.push(ep);
        busy.get(airframeId).push({ ground: ordinal(groundDate), closed: ordinal(closedDate) });
        cursor = ordinal(closedDate) + randInt(rng, 1, 6);
      } else {
        cursor += randInt(rng, 2, 5);
      }
      seq += 1;
    }
  }
  return out;
}

function overlaps(ep, intervals) {
  const g = ordinal(ep.groundDate);
  const c = ordinal(ep.closedDate);
  return intervals.some((iv) => g < iv.closed && iv.ground < c);
}

// 一个明确的「记录晚到」锚点：A-07 基准日前 3 天已停用，工单完全未录入。
function hiddenAnchor(asOf) {
  const groundDate = addDays(asOf, -3);
  return {
    id: 'WO-HIDDEN-01',
    airframeId: 'A-07',
    faultType: 'HYDRAULIC',
    groundDate,
    closedDate: addDays(asOf, 5), // 基准日仍未修好
    recordedDate: null,
    hidden: true,
  };
}

export function generateDataset(options = {}) {
  const seed = options.seed ?? 20261120;
  const asOf = options.asOf ?? DEFAULT_AS_OF;
  const rng = mulberry32(seed);

  const busy = new Map(AIRFRAME_IDS.map((id) => [id, []]));
  const anchors = anchorEpisodes(asOf);
  const hidden = hiddenAnchor(asOf);
  // 锚点先占位，保证这批「基准日仍未修好」的架不会被常规片段挤掉
  for (const ep of [...anchors, hidden]) {
    busy.get(ep.airframeId).push({ ground: ordinal(ep.groundDate), closed: ordinal(ep.closedDate) });
  }

  const episodes = [
    ...anchors,
    hidden,
    ...routineEpisodes(rng, asOf, busy),
  ].sort((a, b) => ordinal(a.groundDate) - ordinal(b.groundDate) || a.id.localeCompare(b.id));

  episodes.forEach(validateEpisode);

  return {
    fleetSize: FLEET_SIZE,
    airframeIds: [...AIRFRAME_IDS],
    historyFrom: HISTORY_FROM,
    asOf,
    seed,
    episodes,
  };
}

// 补录：把所有「基准日前已停用但工单未录入」的片段录入系统（recordedDate=基准日）。
// 物理事件日期 groundDate 保持不变——台账对齐因此会重算，体现晚到单的影响。
export function backfillLateRecords(dataset, asOf = dataset.asOf) {
  let applied = 0;
  const episodes = dataset.episodes.map((ep) => {
    if (ep.hidden || ep.recordedDate === null || ordinal(ep.recordedDate) > ordinal(asOf)) {
      if (ordinal(ep.groundDate) <= ordinal(asOf)) {
        applied += 1;
        return { ...ep, hidden: false, recordedDate: asOf };
      }
    }
    return ep;
  });
  return { dataset: { ...dataset, episodes }, applied };
}

export function countLateRecords(dataset, asOf = dataset.asOf) {
  return dataset.episodes.reduce((n, ep) => {
    const physicallyDown = ordinal(ep.groundDate) <= ordinal(asOf);
    const notRecorded = ep.hidden || ep.recordedDate === null || ordinal(ep.recordedDate) > ordinal(asOf);
    return n + (physicallyDown && notRecorded ? 1 : 0);
  }, 0);
}
