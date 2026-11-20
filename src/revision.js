// 修订版（revision）：某个基准时点上「系统里看得到的全部数据」的不可变快照。
// 方案比较端必须读同一修订版——revisionId 即公平性的凭证。
import { createHash } from 'node:crypto';
import { ordinal } from './dates.js';
import { validateEpisode } from './synthetic-data.js';

export function buildRevision(dataset, asOf) {
  if (!asOf) throw new Error('buildRevision requires an asOf date');
  const cutoff = ordinal(asOf);
  const episodes = [];
  for (const ep of dataset.episodes) {
    validateEpisode(ep);
    if (ep.hidden) continue;
    if (ep.recordedDate === null || ep.recordedDate === undefined) continue;
    if (ordinal(ep.recordedDate) > cutoff) continue; // 工单尚未录入
    episodes.push(structuredClone(ep));
  }
  episodes.sort((a, b) => ordinal(a.groundDate) - ordinal(b.groundDate) || a.id.localeCompare(b.id));
  return {
    revisionId: hashRevision(episodes, asOf),
    asOf,
    fleetSize: dataset.fleetSize,
    airframeIds: [...dataset.airframeIds],
    episodes,
  };
}

export function hashRevision(episodes, asOf) {
  const payload = JSON.stringify({
    asOf,
    eps: episodes.map((e) => [e.id, e.groundDate, e.closedDate, e.recordedDate, e.faultType, e.airframeId]),
  });
  return `rev-${createHash('sha256').update(payload).digest('hex').slice(0, 12)}`;
}
