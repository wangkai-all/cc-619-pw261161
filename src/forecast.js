// 可用架数区间预测。
// 不确定性来自两块：
//   1) 未来新故障的到达（泊松）与维修时长（经验重采样）；
//   2) 截至基准日「仍未修好」的那批架——它们的剩余维修时长只能估。
// openMode:
//   stochastic = 剩余时长按经验分布抽样（区间包含这批架的不确定性）
//   point      = 剩余时长直接取估算均值（剔除该不确定性，用于展示这批架如何撑大区间）
// 两种模式共享同一批预生成的「到达 + 故障类型」情景与同序 RNG，
// 差值才能干净归因于未修好批次。
import { addDays, mean, ordinal, quantile } from './dates.js';
import { mulberry32, poisson, pick } from './rng.js';

function openEpisodes(revision) {
  const now = ordinal(revision.asOf);
  return revision.episodes
    .filter((e) => ordinal(e.groundDate) <= now &&
      (e.closedDate === null || e.closedDate === undefined || ordinal(e.closedDate) > now))
    .map((e) => ({ ...e, elapsedDays: now - ordinal(e.groundDate) }));
}

function arrivalRate(revision) {
  const now = ordinal(revision.asOf);
  const grounds = revision.episodes.map((e) => ordinal(e.groundDate));
  const earliest = grounds.length ? Math.min(...grounds) : now;
  const span = Math.max(1, now - earliest + 1);
  return revision.episodes.length / span;
}

function typeWeights(revision, samples) {
  const source = samples.length ? samples : revision.episodes.map((e) => ({ faultType: e.faultType }));
  const counts = new Map();
  for (const s of source) counts.set(s.faultType, (counts.get(s.faultType) ?? 0) + 1);
  const total = source.length;
  return [...counts.entries()].map(([faultType, n]) => ({ faultType, weight: n / total }));
}

function buildResamplePools(estimator) {
  const all = estimator.samples.map((s) => s.duration);
  const byType = new Map();
  for (const s of estimator.samples) {
    if (!byType.has(s.faultType)) byType.set(s.faultType, []);
    byType.get(s.faultType).push(s.duration);
  }
  return { all, byType };
}

function drawDuration(rng, faultType, method, pools) {
  if (method === 'fixed') return pick(rng, pools.all); // 类型信息被抹平 => 系统性偏差
  return pick(rng, pools.byType.get(faultType) ?? pools.all);
}

function drawType(rng, weights) {
  let r = rng();
  for (const w of weights) {
    r -= w.weight;
    if (r <= 0) return w.faultType;
  }
  return weights[weights.length - 1].faultType;
}

// 预生成全部 run × horizon 的到达情景（只含故障类型，时长留给模拟阶段，
// 这样 fixed / byType 两种方法比较的是同一批到达事件）。
function generateScenarios(rng, runs, horizon, lambda, weights) {
  const scenarios = [];
  for (let r = 0; r < runs; r += 1) {
    const days = [];
    for (let h = 1; h <= horizon; h += 1) {
      const n = poisson(rng, lambda);
      const events = [];
      for (let k = 0; k < n; k += 1) events.push({ faultType: drawType(rng, weights) });
      days.push(events);
    }
    scenarios.push(days);
  }
  return scenarios;
}

function simulate({ revision, estimator, horizon, scenarios, openMode, rng, pools }) {
  const now = ordinal(revision.asOf);
  const open = openEpisodes(revision);
  const runs = scenarios.length;
  // paths[r][h-1] = 第 r 次模拟在未来第 h 天的可用架数
  const paths = Array.from({ length: runs }, () => new Array(horizon).fill(0));
  let blockedEvents = 0;

  for (let r = 0; r < runs; r += 1) {
    const downUntil = new Map(revision.airframeIds.map((id) => [id, 0]));

    for (const ep of open) {
      let totalDuration;
      if (openMode === 'point') {
        totalDuration = Math.max(1, Math.round(estimator.durationFor(ep.faultType)));
      } else {
        totalDuration = drawDuration(rng, ep.faultType, estimator.method, pools);
      }
      const remaining = Math.max(1, totalDuration - ep.elapsedDays);
      downUntil.set(ep.airframeId, now + remaining);
    }

    for (let h = 1; h <= horizon; h += 1) {
      const dayOrd = now + h;
      for (const ev of scenarios[r][h - 1]) {
        const candidate = revision.airframeIds.find((id) => downUntil.get(id) <= dayOrd);
        if (!candidate) {
          blockedEvents += 1; // 全员停用时新故障无法指派（极端尾部）
          continue;
        }
        const duration = drawDuration(rng, ev.faultType, estimator.method, pools);
        downUntil.set(candidate, dayOrd + duration);
      }
      paths[r][h - 1] = revision.airframeIds.filter((id) => downUntil.get(id) <= dayOrd).length;
    }
  }

  const series = [];
  for (let h = 1; h <= horizon; h += 1) {
    const col = paths.map((p) => p[h - 1]).sort((a, b) => a - b);
    series.push({
      date: addDays(revision.asOf, h),
      horizonDay: h,
      p10: Math.round(quantile(col, 0.1)),
      p50: Math.round(quantile(col, 0.5)),
      p90: Math.round(quantile(col, 0.9)),
      mean: Number(mean(col).toFixed(2)),
    });
  }
  return { series, blockedEvents, openCount: open.length };
}

export function forecastAvailability(options) {
  const {
    revision,
    estimator,
    horizon = 5,
    runs = 400,
    seed = 7701,
    compareOpenImpact = true,
  } = options;

  const lambda = arrivalRate(revision);
  const weights = typeWeights(revision, estimator.samples);
  const pools = buildResamplePools(estimator);
  const rngScenario = mulberry32(seed);
  const scenarios = generateScenarios(rngScenario, runs, horizon, lambda, weights);

  const stochastic = simulate({
    revision, estimator, horizon, scenarios,
    openMode: 'stochastic', rng: mulberry32(seed + 1), pools,
  });
  let point = null;
  let openImpact = null;
  if (compareOpenImpact) {
    // 独立但同种子的 RNG：新故障抽样序列完全一致，仅未修好批次处理不同
    point = simulate({
      revision, estimator, horizon, scenarios,
      openMode: 'point', rng: mulberry32(seed + 1), pools,
    });
    const stochasticWidth = stochastic.series.reduce((s, d) => s + (d.p90 - d.p10), 0);
    const pointWidth = point.series.reduce((s, d) => s + (d.p90 - d.p10), 0);
    openImpact = {
      openCount: stochastic.openCount,
      stochasticWidthSum: stochasticWidth,
      pointWidthSum: pointWidth,
      extraWidthFromOpenBatch: stochasticWidth - pointWidth,
    };
  }

  const openBatch = openEpisodes(revision).map((ep) => ({
    id: ep.id,
    airframeId: ep.airframeId,
    faultType: ep.faultType,
    groundDate: ep.groundDate,
    elapsedDays: ep.elapsedDays,
    estimatedRemainingDays: Math.max(
      1,
      Math.round(estimator.durationFor(ep.faultType)) - ep.elapsedDays,
    ),
  }));

  return {
    revisionId: revision.revisionId,
    asOf: revision.asOf,
    method: estimator.method,
    runs,
    horizon,
    seed,
    lambdaPerDay: Number(lambda.toFixed(4)),
    openBatch,
    forecast: stochastic.series,
    pointModeForecast: point ? point.series : null,
    openImpact,
  };
}
