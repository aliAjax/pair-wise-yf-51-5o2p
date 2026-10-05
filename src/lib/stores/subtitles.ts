import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import { applyRetimePlan, isProtected, mergeById, mergeCuesByRevision, planRetime, round1 } from "./timeline";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
  /** 整段时长（秒），时间码不允许越出 */
  duration: number;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
  /** 术语锁定：留在原位并拦住后续顺延 */
  termLocked: boolean;
  /** 版本号：跨标签页冲突判定、快照与审校记录对齐用 */
  revision: number;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定";
  detail: string;
  actor: string;
  time: string;
  /** 记录对应的字幕版本，快照与审校记录取同一版结果 */
  cueRevision?: number;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
}

export interface TimelineConflict {
  id: string;
  cueId: string;
  message: string;
  remoteStart: number;
  remoteEnd: number;
  localStart: number;
  localEnd: number;
  /** 被拦下的本机修改，「保留本机」时重新应用 */
  attempt: Partial<Cue>;
  status: "待处理" | "采用本地" | "采用协作版本";
}

export interface EditResult {
  ok: boolean;
  reason?: string;
  /** 本次改动顺延了多少条后续字幕 */
  shifted?: number;
}

const KEY = "pair-wise-yf-51/subtitles-v2";

const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过", duration: 20 },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中", duration: 20 },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿", duration: 20 }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c9", trackId: "zh", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "修复组必须在下一场潮水到来前完成加固。", status: "已通过", translator: "系统", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c5", trackId: "en", start: 6.9, end: 9.4, source: "监测船已绕过东侧暗礁。", translated: "The survey boat has cleared the eastern reef.", status: "待审", translator: "林岚", reviewerNote: "", termLocked: true, revision: 1 },
  { id: "c6", trackId: "en", start: 9.8, end: 12.2, source: "潮间带的样方需要重新标记。", translated: "The quadrats on the intertidal zone must be re-marked.", status: "已通过", translator: "林岚", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c7", trackId: "en", start: 12.6, end: 15, source: "下个月满潮时再核对一次数据。", translated: "We will verify the data again at next month's spring tide.", status: "翻译中", translator: "周野", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", termLocked: false, revision: 1 },
  { id: "c8", trackId: "ja", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "", status: "待译", translator: "周野", reviewerNote: "", termLocked: false, revision: 1 }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];

interface Persisted {
  tracks: Track[];
  cues: Cue[];
  terms: GlossaryTerm[];
  events: ReviewEvent[];
  snapshots: Snapshot[];
  deleted: string[];
}

function readStored(): Persisted | null {
  if (!browser) return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Persisted) : null;
  } catch {
    return null;
  }
}

const initial = readStored();
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
/** 删除墓碑：合并字幕时被并走的条目，防止持久化合并时复活 */
export const deletedCueIds = writable<string[]>(initial?.deleted ?? []);
export const conflicts = writable<TimelineConflict[]>([]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

/**
 * 持久化：localStorage 是各标签页共享的“服务端”。
 * 每次写入都与已存版本合并——字幕按 revision 取高（先保存的生效），
 * 审校记录/快照按 id 取并集，保证两个标签页互写不丢数据。
 */
function persist() {
  if (!browser) return;
  const stored = readStored();
  const state: Persisted = {
    tracks: mergeById(stored?.tracks ?? [], get(tracks)),
    cues: mergeCuesByRevision(stored?.cues ?? [], get(cues), get(deletedCueIds)),
    terms: mergeById(stored?.terms ?? [], get(terms)),
    events: mergeById(stored?.events ?? [], get(reviewEvents))
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 200),
    snapshots: mergeById(stored?.snapshots ?? [], get(snapshots))
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 12),
    deleted: get(deletedCueIds)
  };
  localStorage.setItem(KEY, JSON.stringify(state));
}
[tracks, cues, terms, reviewEvents, snapshots, deletedCueIds].forEach((store) => store.subscribe(persist));

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string, cueRevision = cue?.revision) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: new Date().toISOString(), cueRevision }, ...items]);
}

/** 内部直接修改（状态流转等系统操作），版本号 +1 */
function patchCue(id: string, patch: Partial<Cue>) {
  cues.update((items) => items.map((item) => (item.id === id ? { ...item, ...patch, revision: item.revision + 1 } : item)));
}

function storedCue(id: string): Cue | undefined {
  return readStored()?.cues?.find((item) => item.id === id);
}

export function pendingConflictFor(cueId: string): TimelineConflict | undefined {
  return get(conflicts).find((item) => item.cueId === cueId && item.status === "待处理");
}

/** 后到的修改让位：本机内存回退到先保存的协作版本，并登记冲突 */
function registerConflict(local: Cue, remote: Cue, attempt: Partial<Cue>): EditResult {
  cues.update((items) => items.map((item) => (item.id === local.id ? { ...remote } : item)));
  const record: TimelineConflict = {
    id: crypto.randomUUID(),
    cueId: local.id,
    message: `另一标签页已先保存该字幕（v${remote.revision}），本机基于 v${local.revision} 的修改未生效`,
    remoteStart: remote.start,
    remoteEnd: remote.end,
    localStart: round1(Number(attempt.start ?? local.start)),
    localEnd: round1(Number(attempt.end ?? local.end)),
    attempt,
    status: "待处理"
  };
  conflicts.update((items) => [record, ...items.filter((item) => !(item.cueId === local.id && item.status === "待处理"))]);
  return { ok: false, reason: "检测到协作冲突：另一标签页已先保存，本次修改未生效" };
}

/** 用户编辑前的并发护栏：有未处理冲突或共享存储里已有更新版本时拦下 */
function guardConcurrency(id: string, attempt: Partial<Cue>): EditResult | null {
  if (pendingConflictFor(id)) return { ok: false, reason: "该字幕存在未处理的协作冲突，请先在「协作冲突」面板处理" };
  const local = get(cues).find((item) => item.id === id);
  if (!local) return { ok: false, reason: "字幕不存在" };
  const remote = storedCue(id);
  if (remote && remote.revision > local.revision) return registerConflict(local, remote, attempt);
  return null;
}

/**
 * 修改时间码（核心入口）：同轨道时间码始终按先后排开。
 * 后面的普通条目按原时长依次顺延；术语锁定/已通过的条目留在原位并拦住改动；
 * 越出整段时长或撞上被拦住的条目时整次改动不生效。
 * 时间码一变，「已通过」的审校结论失效并退回重审，审校记录与字幕取同一版 revision。
 */
export function retimeCue(id: string, patch: { start?: number; end?: number }, opts: { force?: boolean } = {}): EditResult {
  const all = get(cues);
  const cue = all.find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  if (!opts.force) {
    const blocked = guardConcurrency(id, patch);
    if (blocked) return blocked;
  }
  const track = get(tracks).find((item) => item.id === cue.trackId);
  const plan = planRetime(all, id, patch, track?.duration ?? Number.POSITIVE_INFINITY);
  if (!plan.ok) return plan;
  if (!plan.moved.length) return { ok: true, shifted: 0 };
  const { cues: next, invalidated } = applyRetimePlan(all, plan.moved);
  cues.set(next);
  for (const item of invalidated) {
    event(item, "退回修改", `时间码调整为 ${item.start.toFixed(1)}s–${item.end.toFixed(1)}s，审校结论失效，退回重审`, item.revision);
  }
  return { ok: true, shifted: plan.moved.length - 1 };
}

/** 修改字幕文本内容（带并发护栏） */
export function editCueContent(id: string, patch: Partial<Cue>, opts: { force?: boolean } = {}): EditResult {
  if (!opts.force) {
    const blocked = guardConcurrency(id, patch);
    if (blocked) return blocked;
  }
  if (!get(cues).some((item) => item.id === id)) return { ok: false, reason: "字幕不存在" };
  patchCue(id, patch);
  return { ok: true };
}

export function nudgeCue(id: string, delta: number): EditResult {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  return retimeCue(id, { start: cue.start + delta, end: cue.end + delta });
}

export function splitCue(id: string): EditResult {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "字幕不存在" };
  if (cue.end - cue.start < 1) return { ok: false, reason: "时长不足 1 秒，无法拆分" };
  const middle = round1((cue.start + cue.end) / 2);
  const first: Cue = { ...cue, end: middle, status: "翻译中", revision: cue.revision + 1 };
  const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译", termLocked: false, revision: 1 };
  cues.set(list.flatMap((item) => (item.id === id ? [first, second] : [item])));
  selectedCueId.set(second.id);
  return { ok: true };
}

export function mergeNext(id: string): EditResult {
  const list = get(cues)
    .filter((item) => item.trackId === get(activeTrackId))
    .sort((a, b) => a.start - b.start);
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return { ok: false, reason: "没有可合并的下一条字幕" };
  if (isProtected(next)) return { ok: false, reason: `下一条已被${next.termLocked ? "术语锁定" : "审校通过"}，留在原位，不能并走` };
  const wasApproved = current.status === "已通过";
  deletedCueIds.update((ids) => [...ids, next.id]);
  cues.update((items) =>
    items
      .filter((item) => item.id !== next.id)
      .map((item) => (item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中" as CueStatus, revision: item.revision + 1 } : item))
  );
  if (wasApproved) {
    const updated = get(cues).find((item) => item.id === id);
    event(updated, "退回修改", "合并字幕导致时间码变更，审校结论失效，退回重审", updated?.revision);
  }
  return { ok: true };
}

export function setCueStatus(id: string, status: CueStatus) {
  patchCue(id, { status });
  const cue = get(cues).find((item) => item.id === id);
  event(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "", cue?.revision);
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  patchCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note });
  const updated = get(cues).find((item) => item.id === id);
  event(updated, approved ? "审校通过" : "退回修改", note || cue.translated, updated?.revision);
}

export function lockTerm(id: string) {
  terms.update((items) => items.map((term) => (term.id === id ? { ...term, status: "已锁定", owner: "术语管理员" } : term)));
  const term = get(terms).find((item) => item.id === id);
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term?.source} → ${term?.target}`, cue?.revision);
}

/** 切换单条字幕的术语锁定：锁定后留在原位并拦住后续顺延 */
export function toggleCueTermLock(id: string) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  patchCue(id, { termLocked: !cue.termLocked });
  const updated = get(cues).find((item) => item.id === id);
  event(updated, "术语锁定", updated?.termLocked ? "本条字幕术语已锁定，后续顺延到此为止" : "本条字幕术语解除锁定", updated?.revision);
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (!snapshot) return;
  // 恢复到高于共享存储的版本号，确保恢复结果在跨标签页合并时生效
  const base = Math.max(0, ...get(cues).map((cue) => cue.revision), ...(readStored()?.cues ?? []).map((cue) => cue.revision)) + 1;
  const keep = new Set(snapshot.cues.map((cue) => cue.id));
  deletedCueIds.set(get(cues).filter((cue) => !keep.has(cue.id)).map((cue) => cue.id));
  cues.set(structuredClone(snapshot.cues).map((cue) => ({ ...cue, revision: base })));
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]): EditResult {
  const conflict = get(conflicts).find((item) => item.id === id);
  if (!conflict || conflict.status !== "待处理") return { ok: false, reason: "冲突不存在或已处理" };
  if (resolution === "采用协作版本") {
    const remote = storedCue(conflict.cueId);
    if (remote) cues.update((items) => items.map((item) => (item.id === conflict.cueId ? { ...remote } : item)));
  } else {
    const attempt = conflict.attempt;
    const hasTime = attempt.start !== undefined || attempt.end !== undefined;
    const result = hasTime ? retimeCue(conflict.cueId, { start: attempt.start, end: attempt.end }, { force: true }) : editCueContent(conflict.cueId, attempt, { force: true });
    if (!result.ok) return result;
  }
  conflicts.update((items) => items.map((item) => (item.id === id ? { ...item, status: resolution } : item)));
  return { ok: true };
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) =>
  $cues
    .filter((cue) => cue.trackId === $activeTrackId)
    .sort((a, b) => a.start - b.start)
    .map((cue) => ({ ...cue, selected: cue.id === $selectedCueId }))
);
