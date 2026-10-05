/**
 * 时间轴纯逻辑：不依赖 svelte / 浏览器，方便单测。
 * 规则：
 * - 改动一条字幕后，同轨道后面的普通条目按原时长依次顺延（不留重叠）。
 * - 术语锁定或审校已通过的条目留在原位，顺延撞上它们时整次改动不生效。
 * - 越出整段时长（或上一条边界、最小时长）时整次改动不生效。
 */

export const MIN_DURATION = 0.5;

export interface TimedCue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  status: string;
  termLocked: boolean;
  source?: string;
}

export interface MovedCue {
  id: string;
  start: number;
  end: number;
}

export type RetimePlan = { ok: true; moved: MovedCue[] } | { ok: false; reason: string };

export const round1 = (value: number) => Math.round(value * 10) / 10;

/** 术语锁定或审校已通过的条目受保护：留在原位并拦住顺延。 */
export function isProtected(cue: Pick<TimedCue, "status" | "termLocked">): boolean {
  return cue.termLocked || cue.status === "已通过";
}

function label(cue: TimedCue): string {
  const text = cue.source?.trim();
  return text ? `「${text.length > 12 ? `${text.slice(0, 12)}…` : text}」` : cue.id;
}

/**
 * 计算一次时间码改动的顺延方案。返回失败原因时不应改动任何数据。
 * @param cues 全部字幕（任意顺序）
 * @param id 被改动的字幕
 * @param patch 新的开始/结束时间（缺省表示不变）
 * @param limit 整段时长（秒）
 */
export function planRetime<T extends TimedCue>(cues: T[], id: string, patch: { start?: number; end?: number }, limit: number): RetimePlan {
  const cue = cues.find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  const start = round1(patch.start ?? cue.start);
  const end = round1(patch.end ?? cue.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return { ok: false, reason: "时间码无效，改动未生效" };
  if (start < 0) return { ok: false, reason: "开始时间不能小于 0，改动未生效" };
  if (round1(end - start) < MIN_DURATION) return { ok: false, reason: `单条时长不能小于 ${MIN_DURATION} 秒，改动未生效` };
  if (end > limit) return { ok: false, reason: `越出整段时长 ${limit.toFixed(1)} 秒，改动未生效` };

  const ordered = cues
    .filter((item) => item.trackId === cue.trackId)
    .slice()
    .sort((a, b) => a.start - b.start);
  const index = ordered.findIndex((item) => item.id === id);
  const previous = ordered[index - 1];
  if (previous && start < previous.end) return { ok: false, reason: `与上一条 ${label(previous)} 重叠，改动未生效` };

  const moved: MovedCue[] = [];
  if (start !== cue.start || end !== cue.end) moved.push({ id, start, end });

  // 依次顺延：后续普通条目保持原时长，紧跟前一条的结束时间排开
  let cursor = end;
  for (let i = index + 1; i < ordered.length; i++) {
    const item = ordered[i];
    if (cursor <= item.start) break; // 没有压到它，顺延到此为止
    if (isProtected(item)) {
      const why = item.termLocked ? "术语锁定" : "审校已通过";
      return { ok: false, reason: `撞上被拦住的条目 ${label(item)}（${why}），改动未生效` };
    }
    const duration = round1(item.end - item.start);
    const next = { id: item.id, start: cursor, end: round1(cursor + duration) };
    if (next.end > limit) return { ok: false, reason: `后续条目顺延将越出整段时长 ${limit.toFixed(1)} 秒，改动未生效` };
    moved.push(next);
    cursor = next.end;
  }
  return { ok: true, moved };
}

/**
 * 应用顺延方案：提升版本号；时间码变化的「已通过」条目审校结论失效，退回重审。
 * 返回失效条目，调用方据此写审校记录（与字幕取同一版 revision）。
 */
export function applyRetimePlan<T extends TimedCue & { revision: number; reviewerNote: string }>(cues: T[], moved: MovedCue[]): { cues: T[]; invalidated: T[] } {
  const movedById = new Map(moved.map((item) => [item.id, item]));
  const invalidated: T[] = [];
  const next = cues.map((item) => {
    const move = movedById.get(item.id);
    if (!move) return item;
    const updated: T = { ...item, start: move.start, end: move.end, revision: item.revision + 1 };
    if (item.status === "已通过") {
      updated.status = "退回";
      updated.reviewerNote = "时间码变更，审校结论失效，退回重审";
      invalidated.push(updated);
    }
    return updated;
  });
  return { cues: next, invalidated };
}

/**
 * 跨标签页持久化合并：同一条字幕保留 revision 更高的一版（先保存的生效），
 * 被删除（含合并掉的）字幕按墓碑剔除，其余取并集。
 */
export function mergeCuesByRevision<T extends { id: string; revision: number }>(stored: T[], local: T[], deletedIds: string[] = []): T[] {
  const deleted = new Set(deletedIds);
  const merged = new Map<string, T>();
  for (const cue of stored) if (!deleted.has(cue.id)) merged.set(cue.id, cue);
  for (const cue of local) {
    if (deleted.has(cue.id)) continue;
    const prev = merged.get(cue.id);
    if (!prev || cue.revision >= prev.revision) merged.set(cue.id, cue);
  }
  return [...merged.values()];
}

/** 按 id 取并集（本地优先），用于审校记录、快照、术语等集合的跨标签页合并。 */
export function mergeById<T extends { id: string }>(stored: T[], local: T[]): T[] {
  const merged = new Map<string, T>(stored.map((item) => [item.id, item]));
  for (const item of local) merged.set(item.id, item);
  return [...merged.values()];
}
