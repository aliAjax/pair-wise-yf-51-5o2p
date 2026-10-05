/**
 * 纯逻辑层测试：node_modules/.bin/jiti scripts/test-timeline.ts
 * 覆盖：顺延排开、受保护条目拦截、越出整段时长、审校失效、跨标签页版本合并。
 */
import { applyRetimePlan, mergeCuesByRevision, planRetime } from "../src/lib/stores/timeline";

interface TestCue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  status: string;
  termLocked: boolean;
  revision: number;
  reviewerNote: string;
  source?: string;
}

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

const cue = (id: string, start: number, end: number, status = "翻译中", termLocked = false): TestCue => ({ id, trackId: "en", start, end, status, termLocked, revision: 1, reviewerNote: "", source: id });

// en 轨道：c2 0-2.8 | c3 3.2-6.5 | c5 6.9-9.4(锁) | c6 9.8-12.2(已通过) | c7 12.6-15
const base: TestCue[] = [
  cue("c2", 0, 2.8, "待审"),
  cue("c3", 3.2, 6.5),
  cue("c5", 6.9, 9.4, "待审", true),
  cue("c6", 9.8, 12.2, "已通过"),
  cue("c7", 12.6, 15)
];
const LIMIT = 20;

console.log("顺延排开");
{
  // c2 结束 2.8 → 4.0：c3 被压，按原时长 3.3 顺延到 4.0-7.3，但会撞上锁定的 c5(6.9) → 不生效
  const plan = planRetime(base, "c2", { end: 4 }, LIMIT);
  check("撞上术语锁定条目时整次不生效", !plan.ok && /术语锁定/.test((plan as { reason: string }).reason), plan);

  // c2 结束 2.8 → 3.5：c3 顺延到 3.5-6.8，恰好不碰 c5(6.9) → 生效
  const ok = planRetime(base, "c2", { end: 3.5 }, LIMIT);
  check("小幅延长生效", ok.ok);
  if (ok.ok) {
    check("被改条目时间正确", ok.moved[0].id === "c2" && ok.moved[0].end === 3.5, ok.moved);
    const c3 = ok.moved.find((m) => m.id === "c3");
    check("后续条目按原时长顺延", !!c3 && c3.start === 3.5 && c3.end === 6.8, c3);
    check("未波及受保护条目", !ok.moved.some((m) => m.id === "c5" || m.id === "c6" || m.id === "c7"));
  }

  // 缩短 c2 结束 2.8 → 2.0：后面不动（只顺延不回拉）
  const shrink = planRetime(base, "c2", { end: 2 }, LIMIT);
  check("缩短不回拉后续条目", shrink.ok && shrink.moved.length === 1, shrink);

  // 结束时间恰好接上 c3 开始（3.2）：不算压上，不顺延
  const abut = planRetime(base, "c2", { end: 3.2 }, LIMIT);
  check("恰好相接不顺延", abut.ok && abut.moved.length === 1, abut);
}

console.log("拦截与边界");
{
  // 直接改 c7 撞已通过？c7 是最后一条，改 c6(已通过) 的结束到 13 → 压 c7，c7 顺延 13-15.4
  const pushLast = planRetime(base, "c6", { end: 13 }, LIMIT);
  check("已通过条目自身可直接改", pushLast.ok && pushLast.moved.some((m) => m.id === "c7" && m.start === 13), pushLast);

  // c7 结束改到 21 → 越出整段时长 20
  const over = planRetime(base, "c7", { end: 21 }, LIMIT);
  check("越出整段时长不生效", !over.ok && /越出整段时长/.test((over as { reason: string }).reason), over);

  // c6 结束改到 19 → c7 顺延 19-21.4 越界 → 不生效
  const cascadeOver = planRetime(base, "c6", { end: 19 }, LIMIT);
  check("顺延越出整段时长也不生效", !cascadeOver.ok && /越出整段时长/.test((cascadeOver as { reason: string }).reason), cascadeOver);

  // c3 开始改到 2.0 → 与 c2(0-2.8) 重叠
  const overlapPrev = planRetime(base, "c3", { start: 2 }, LIMIT);
  check("与上一条重叠不生效", !overlapPrev.ok && /重叠/.test((overlapPrev as { reason: string }).reason), overlapPrev);

  // 时长小于 0.5
  const tooShort = planRetime(base, "c3", { end: 3.5 }, LIMIT);
  check("单条时长过小不生效", !tooShort.ok && /0\.5/.test((tooShort as { reason: string }).reason), tooShort);

  // 开始小于 0
  const negative = planRetime(base, "c2", { start: -1, end: 2 }, LIMIT);
  check("开始时间小于 0 不生效", !negative.ok, negative);

  // 撞已通过条目：把 c5 解锁场景换成直接顺延到 c6 —— c3 结束改到 9.9 会压过锁定的 c5，先被 c5 拦
  // 用无锁轨道验证已通过拦截
  const noLock: TestCue[] = [cue("a", 0, 2), cue("b", 2.5, 4), cue("c", 4.5, 6, "已通过")];
  const hitApproved = planRetime(noLock, "a", { end: 3.2 }, LIMIT);
  check("撞上审校已通过条目不生效", !hitApproved.ok && /审校已通过/.test((hitApproved as { reason: string }).reason), hitApproved);
}

console.log("审校失效与版本");
{
  // c6(已通过) 结束 12.2 → 13：c6 退回重审，revision+1；c7 顺延但不是已通过，不失效
  const plan = planRetime(base, "c6", { end: 13 }, LIMIT);
  if (!plan.ok) throw new Error("plan should be ok");
  const { cues: next, invalidated } = applyRetimePlan(base, plan.moved);
  const c6 = next.find((c) => c.id === "c6")!;
  check("时间码一变审校结论失效退回", c6.status === "退回" && /退回重审/.test(c6.reviewerNote), c6);
  check("失效条目版本号 +1", c6.revision === 2, c6);
  check("失效名单与字幕同一版", invalidated.length === 1 && invalidated[0].id === "c6" && invalidated[0].revision === c6.revision);
  const c7 = next.find((c) => c.id === "c7")!;
  check("被顺延的普通条目不失效", c7.status === "翻译中" && c7.revision === 2, c7);
  const c2 = next.find((c) => c.id === "c2")!;
  check("未波及的条目版本不变", c2.revision === 1, c2);
}

console.log("跨标签页合并（先保存的生效）");
{
  const v1 = cue("x", 0, 2, "待审");
  const remoteV2 = { ...v1, end: 3, revision: 2 }; // 另一标签页先保存
  const localV1 = { ...v1 }; // 本机还是旧版
  // 本机持久化合并：存储里的高版本不能被本机旧版覆盖
  const merged = mergeCuesByRevision([remoteV2], [localV1]);
  check("旧版本机写入不覆盖先保存的版本", merged[0].revision === 2 && merged[0].end === 3, merged);
  // 本机采纳后提升到 v3，合并时胜出
  const localV3 = { ...v1, end: 4, revision: 3 };
  const merged2 = mergeCuesByRevision([remoteV2], [localV3]);
  check("本机更高版本合并时生效", merged2[0].revision === 3 && merged2[0].end === 4, merged2);
  // 墓碑：被合并掉的字幕不复活
  const merged3 = mergeCuesByRevision([remoteV2], [], ["x"]);
  check("删除墓碑生效", merged3.length === 0, merged3);
  // 另一标签页新增的字幕并集保留
  const merged4 = mergeCuesByRevision([remoteV2, { ...v1, id: "y", revision: 1 }], [localV1]);
  check("跨标签页新增取并集", merged4.length === 2, merged4);
}

if (failures) {
  console.error(`\n${failures} 个断言失败`);
  process.exit(1);
}
console.log("\n全部通过");
