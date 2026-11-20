// 历史回放：在一系列历史基准日上，只用当时可见的修订版数据做预测，再与真值对账。
// 两种估算方法在每个基准日读同一个 revision（revisionId 相同），比较才公平。
import { addDays, ordinal } from './dates.js';
import { dailyLedger } from './ledger.js';
import { buildRevision } from './revision.js';
import { fitEstimator, ESTIMATOR_METHODS } from './estimators.js';
import { forecastAvailability } from './forecast.js';
import { InsufficientDataError } from './errors.js';

export const DEFAULT_CUTOFFS = [
  '2026-09-01', // 过早：数据不足，走异常路径
  '2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29',
  '2026-11-05', '2026-11-12',
];

function scoreAgainstTruth(forecastSeries, truthRows) {
  let absErr = 0;
  let bias = 0;
  let covered = 0;
  let width = 0;
  forecastSeries.forEach((f, i) => {
    const actual = truthRows[i].actualAvailable;
    absErr += Math.abs(f.p50 - actual);
    bias += f.p50 - actual;
    if (actual >= f.p10 && actual <= f.p90) covered += 1;
    width += f.p90 - f.p10;
  });
  const n = forecastSeries.length;
  return {
    mae: Number((absErr / n).toFixed(3)),
    bias: Number((bias / n).toFixed(3)),
    coverage: Number((covered / n).toFixed(3)),
    avgWidth: Number((width / n).toFixed(3)),
  };
}

export function runBacktest(dataset, options = {}) {
  const cutoffs = options.cutoffs ?? DEFAULT_CUTOFFS;
  const horizon = options.horizon ?? 5;
  const runs = options.runs ?? 250;
  const seed = options.seed ?? 9102;

  const perMethod = Object.fromEntries(ESTIMATOR_METHODS.map((m) => [m, { rows: [] }]));
  const failures = [];
  const revisionTrace = [];

  for (const cutoff of cutoffs) {
    const revision = buildRevision(dataset, cutoff); // 同一修订版供两种方法使用
    revisionTrace.push({
      cutoff,
      revisionId: revision.revisionId,
      visibleEpisodes: revision.episodes.length,
    });

    const truthRows = dailyLedger(dataset, addDays(cutoff, 1), addDays(cutoff, horizon), { truth: true });

    for (const method of ESTIMATOR_METHODS) {
      try {
        const estimator = fitEstimator(method, revision);
        const fc = forecastAvailability({
          revision, estimator, horizon, runs, seed, compareOpenImpact: false,
        });
        const scores = scoreAgainstTruth(fc.forecast, truthRows);
        perMethod[method].rows.push({ cutoff, revisionId: revision.revisionId, ...scores });
      } catch (err) {
        if (err instanceof InsufficientDataError) {
          failures.push({
            cutoff, method, code: err.code, message: err.message,
            visibleEpisodes: revision.episodes.length,
          });
        } else {
          throw err;
        }
      }
    }
  }

  const aggregate = (rows) => {
    if (!rows.length) return null;
    const n = rows.length;
    const avg = (k) => Number((rows.reduce((s, r) => s + r[k], 0) / n).toFixed(3));
    return {
      evaluatedCutoffs: n,
      mae: avg('mae'),
      bias: avg('bias'),
      coverage: avg('coverage'),
      avgWidth: avg('avgWidth'),
    };
  };

  return {
    horizon,
    runs,
    cutoffs,
    revisionTrace,
    sameRevisionForBothMethods: new Set(revisionTrace.map((t) => t.revisionId)).size === revisionTrace.length,
    methods: Object.fromEntries(
      ESTIMATOR_METHODS.map((m) => [m, { rows: perMethod[m].rows, aggregate: aggregate(perMethod[m].rows) }]),
    ),
    failures,
    truthNote: '真值按 groundDate/closedDate 物理事件统计，与工单录入日期无关',
  };
}
