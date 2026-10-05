import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
  /** 整段时长（秒），时间码不得越出该长度 */
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
  /** 乐观锁版本号，多标签页保存时比对 */
  version: number;
  /** 术语锁定：锁定后该条目拦住时间轴改动 */
  locked: boolean;
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
  /** 与审校记录同一版结果的快照 id */
  snapshotId?: string;
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
  status: "待处理" | "采用本地" | "采用协作版本";
}

export interface TimecodeResult {
  ok: boolean;
  reason?: string;
  conflict?: TimelineConflict;
  version?: number;
}

const KEY = "pair-wise-yf-51/subtitles-v1";
export const TRACK_DURATION = 60;
const MIN_DURATION = 0.5;

const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过", duration: TRACK_DURATION },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中", duration: TRACK_DURATION },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿", duration: TRACK_DURATION }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "", version: 1, locked: false },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "", version: 1, locked: false },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "", version: 1, locked: false },
  { id: "c5", trackId: "en", start: 8, end: 10.8, source: "锁定术语的条目不得被时间轴改动越过。", translated: "Locked cues must not be overrun by timeline edits.", status: "已通过", translator: "林岚", reviewerNote: "", version: 1, locked: true },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "", version: 1, locked: false }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员" },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员" },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚" }
];
const initial = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者已将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");
export const notice = writable<string>("");

let suppressPersist = false;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function persist() {
  if (!browser || suppressPersist) return;
  localStorage.setItem(KEY, JSON.stringify({ tracks: get(tracks), cues: get(cues), terms: get(terms), events: get(reviewEvents), snapshots: get(snapshots) }));
}
[tracks, cues, terms, reviewEvents, snapshots].forEach((store) => store.subscribe(persist));

export function showNotice(message: string) {
  notice.set(message);
  if (browser) {
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.set(""), 3200);
  }
}

function round1(value: number): number {
  return Number(value.toFixed(1));
}

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string, snapshotId?: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: new Date().toISOString(), snapshotId }, ...items]);
}

/** 从共享存储读取最新版本的字幕，用于多标签页乐观锁比对 */
function latestCue(id: string): Cue | undefined {
  if (!browser) return get(cues).find((c) => c.id === id);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed.cues?.find((c: Cue) => c.id === id);
    }
  } catch {
    /* ignore */
  }
  return get(cues).find((c) => c.id === id);
}

/** 条目是否拦住时间轴改动：术语锁定或审校已通过 */
export function isBlocked(cue: Cue): boolean {
  return cue.locked || cue.status === "已通过";
}

function makeConflict(local: Cue, remote: Cue): TimelineConflict {
  return {
    id: crypto.randomUUID(),
    cueId: local.id,
    message: `协作者已将时间码改为 ${formatTime(remote.start)}–${formatTime(remote.end)}，与本机修改冲突，本机改动未生效。`,
    remoteStart: remote.start,
    remoteEnd: remote.end,
    status: "待处理"
  };
}

function formatTime(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

/**
 * 应用时间码改动，并让同轨道后续条目按原时长依次顺延。
 * - 后续普通条目顺延（保持时长与间隔），被锁定或已通过的条目留在原位并拦住改动
 * - 越出整段时长或撞上被拦条目时整次改动不生效，原时间码保持
 * - 多标签页：以共享存储中的最新版本为准，版本不一致则记冲突、后到的不生效
 * - 时间码变化后审校结论失效，退回重审
 */
export function applyTimecodeChange(id: string, newStartRaw: number, newEndRaw: number, baseVersion?: number): TimecodeResult {
  const list = get(cues);
  const cue = list.find((c) => c.id === id);
  if (!cue) return { ok: false, reason: "未找到字幕" };
  const track = get(tracks).find((t) => t.id === cue.trackId);
  if (!track) return { ok: false, reason: "未找到轨道" };

  // 乐观锁：以共享存储中的最新版本为准
  const latest = latestCue(id);
  const currentVersion = latest?.version ?? cue.version;
  if (baseVersion !== undefined && currentVersion !== baseVersion) {
    const conflict = makeConflict(cue, latest ?? cue);
    conflicts.update((items) => [conflict, ...items]);
    showNotice("保存失败：该字幕已被其他标签页修改，产生冲突。");
    return { ok: false, conflict, reason: "版本冲突" };
  }

  const duration = track.duration;
  const sorted = list.filter((c) => c.trackId === cue.trackId).sort((a, b) => a.start - b.start);
  const index = sorted.findIndex((c) => c.id === id);

  let newStart = round1(newStartRaw);
  let newEnd = round1(newEndRaw);

  if (newStart < 0) return { ok: false, reason: "开始时间不能为负" };
  if (newEnd > duration) return { ok: false, reason: "结束时间越出整段时长，改动未生效" };
  if (newEnd <= newStart) return { ok: false, reason: "结束时间必须晚于开始时间" };
  if (newEnd - newStart < MIN_DURATION) return { ok: false, reason: `时长不得短于 ${MIN_DURATION} 秒` };

  // 开始时间不得早于上一条结束
  if (index > 0 && newStart < sorted[index - 1].end) {
    return { ok: false, reason: "开始时间早于上一条结束，改动未生效" };
  }

  const delta = round1(newEnd - cue.end);

  // 构建顺延方案
  const proposed = sorted.map((c) => ({ ...c }));
  proposed[index].start = newStart;
  proposed[index].end = newEnd;

  for (let j = index + 1; j < proposed.length; j++) {
    const prev = proposed[j - 1];
    const cur = proposed[j];

    if (isBlocked(cur)) {
      // 被拦住的条目留在原位；若前一条顺延撞上它，则整次改动失败
      if (cur.start < prev.end || cur.end > duration) {
        showNotice("改动未生效：撞上被锁定或审校已通过的条目。");
        return { ok: false, reason: "撞上被锁定或已通过的条目" };
      }
      continue;
    }

    // 普通条目按原时长依次顺延（保持时长与间隔）
    cur.start = round1(cur.start + delta);
    cur.end = round1(cur.end + delta);

    if (cur.start < prev.end) {
      showNotice("改动未生效：顺延导致条目重叠。");
      return { ok: false, reason: "顺延导致条目重叠" };
    }
    if (cur.end > duration || cur.start < 0) {
      showNotice("改动未生效：顺延越出整段时长。");
      return { ok: false, reason: "顺延越出整段时长" };
    }
  }

  // 应用方案：时间码变化的条目版本号递增、审校结论失效退回重审
  const invalidated: Cue[] = [];
  proposed.forEach((p, idx) => {
    const origin = sorted[idx];
    if (p.start !== origin.start || p.end !== origin.end) {
      p.version = (origin.version ?? 1) + 1;
      if (p.status === "已通过" || p.status === "待审") {
        p.status = "退回";
        invalidated.push(p);
      }
    }
  });

  const proposedIds = new Set(proposed.map((p) => p.id));
  const others = list.filter((c) => !proposedIds.has(c.id));
  cues.set([...others, ...proposed]);

  invalidated.forEach((c) => event(c, "退回修改", "时间码变更，审校结论失效，退回重审"));

  showNotice("时间码已更新，后续条目按原时长顺延。");
  return { ok: true, version: proposed[index].version };
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, ...patch, version: (cue.version ?? 1) + 1 } : cue));
  if (log) event(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
}

export function nudgeCue(id: string, delta: number): TimecodeResult {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return { ok: false, reason: "未找到字幕" };
  const baseVersion = latestCue(id)?.version ?? cue.version;
  return applyTimecodeChange(id, round1(cue.start + delta), round1(cue.end + delta), baseVersion);
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const first = { ...cue, end: middle, status: "翻译中" as CueStatus, version: (cue.version ?? 1) + 1 };
  const second: Cue = { ...cue, id: crypto.randomUUID(), start: middle, end: cue.end, translated: "", status: "待译", version: 1, locked: false };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : [item]));
  selectedCueId.set(second.id);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中", version: (item.version ?? 1) + 1 } : item));
}

export function setCueStatus(id: string, status: CueStatus) {
  updateCue(id, { status });
  const cue = get(cues).find((item) => item.id === id);
  recordReview(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note });
  recordReview(cue, approved ? "审校通过" : "退回修改", note || cue.translated);
}

/** 审校记录与快照取同一版结果：记录审校动作的同时生成对应快照 */
function recordReview(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  const snapshotId = createSnapshot(`审校快照 · ${action}`);
  event(cue, action, detail, snapshotId);
}

export function lockTerm(id: string) {
  terms.update((items) => items.map((term) => term.id === id ? { ...term, status: "已锁定", owner: "术语管理员" } : term));
  const term = get(terms).find((item) => item.id === id);
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  if (cue) updateCue(cue.id, { locked: true });
  event(cue, "术语锁定", `${term?.source} → ${term?.target}`);
}

export function createSnapshot(name?: string): string {
  const id = crypto.randomUUID();
  const snapshotName = name ?? `时间轴快照 ${get(snapshots).length + 1}`;
  snapshots.update((items) => [{ id, name: snapshotName, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
  return id;
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) {
    suppressPersist = true;
    cues.set(structuredClone(snapshot.cues));
    suppressPersist = false;
  }
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: resolution } : item));
  if (resolution === "采用协作版本") {
    const conflict = get(conflicts).find((item) => item.id === id);
    if (conflict) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
  }
}

/** 多标签页存储同步：其他标签页写入后，本标签页同步为同一版数据 */
export function initStorageSync(): () => void {
  if (!browser) return () => {};
  const handler = (e: StorageEvent) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const raw = JSON.parse(e.newValue);
      suppressPersist = true;
      if (raw.tracks) tracks.set(raw.tracks);
      if (raw.cues) cues.set(raw.cues);
      if (raw.terms) terms.set(raw.terms);
      if (raw.events) reviewEvents.set(raw.events);
      if (raw.snapshots) snapshots.set(raw.snapshots);
      suppressPersist = false;
    } catch {
      suppressPersist = false;
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));
