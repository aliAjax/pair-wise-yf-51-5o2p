/**
 * 跨标签页集成测试：两个独立 jiti 实例 = 两个浏览器标签页，共享同一份 localStorage。
 * 运行：node scripts/test-tabs.cjs
 */
const path = require("path");

// 共享 localStorage（两个标签页的“服务端”）
const backing = new Map();
globalThis.localStorage = {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
  clear: () => backing.clear()
};

const { createJiti } = require("jiti");
const mockEnv = path.resolve(__dirname, "mock-app-env.js");
const opts = { alias: { "$app/environment": mockEnv }, interopDefault: true };

function openTab() {
  const jiti = createJiti(__filename, { ...opts, moduleCache: false });
  return jiti("../src/lib/stores/subtitles.ts");
}
// svelte store 的 get：订阅后立即退订取值
const get = (store) => {
  let value;
  store.subscribe((v) => (value = v))();
  return value;
};

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}
const stored = () => JSON.parse(backing.get("pair-wise-yf-51/subtitles-v2"));

const tabA = openTab();
const tabB = openTab(); // 与 A 同时打开，二者内存都是种子状态

console.log("单标签页：顺延 + 审校失效");
{
  const r = tabA.retimeCue("c2", { end: 3.5 });
  check("改动生效", r.ok && r.shifted === 1, r);
  const cues = get(tabA.cues);
  check("c3 按原时长顺延到 3.5-6.8", cues.find((c) => c.id === "c3").start === 3.5 && cues.find((c) => c.id === "c3").end === 6.8);
  check("锁定的 c5 留在原位", cues.find((c) => c.id === "c5").start === 6.9);

  const blocked = tabA.retimeCue("c2", { end: 4 });
  check("撞上术语锁定条目不生效", !blocked.ok && /术语锁定/.test(blocked.reason), blocked);
  check("原时间码保持", get(tabA.cues).find((c) => c.id === "c2").end === 3.5);

  const over = tabA.retimeCue("c7", { end: 21 });
  check("越出整段时长不生效", !over.ok && /越出整段时长/.test(over.reason), over);

  const before = get(tabA.cues).find((c) => c.id === "c6");
  const revert = tabA.retimeCue("c6", { end: 13 });
  const after = get(tabA.cues).find((c) => c.id === "c6");
  check("已通过条目时间码可变", revert.ok && after.end === 13);
  check("审校结论失效退回重审", before.status === "已通过" && after.status === "退回" && /退回重审/.test(after.reviewerNote), after);
  const events = get(tabA.reviewEvents);
  const inv = events.find((e) => e.cueId === "c6" && e.action === "退回修改");
  check("审校记录与字幕同一版", !!inv && inv.cueRevision === after.revision, inv);
  tabA.createSnapshot("失效后快照");
  const snap = get(tabA.snapshots)[0];
  check("快照与审校记录取同一版结果", snap.cues.find((c) => c.id === "c6").revision === inv.cueRevision, snap.cues.find((c) => c.id === "c6"));
}

console.log("两个标签页：先保存的生效，后到的看到冲突");
{
  // 用末条 c7（无后续条目，不受顺延波及）测并发
  const a = tabA.retimeCue("c7", { end: 16 });
  check("A 先保存生效", a.ok, a);
  const aRev = get(tabA.cues).find((c) => c.id === "c7").revision;

  // B 内存还是旧版，保存 c7 → 冲突
  const b = tabB.retimeCue("c7", { end: 17 });
  check("B 后保存被拦下", !b.ok && /冲突/.test(b.reason), b);
  const bCue = get(tabB.cues).find((c) => c.id === "c7");
  check("B 本机回退到先保存的版本", bCue.end === 16 && bCue.revision === aRev, bCue);
  const pending = get(tabB.conflicts).filter((c) => c.status === "待处理");
  check("B 看到一条待处理冲突", pending.length === 1 && pending[0].cueId === "c7", pending);
  check("冲突记录两版时间码", pending[0].localEnd === 17 && pending[0].remoteEnd === 16, pending[0]);
  check("共享存储仍是先保存的版本", stored().cues.find((c) => c.id === "c7").end === 16);

  const blocked = tabB.retimeCue("c7", { end: 18 });
  check("冲突未处理前 B 的后续改动被拦", !blocked.ok && /冲突/.test(blocked.reason), blocked);

  // B 选择保留本机 → 以更高版本写回
  const take = tabB.resolveConflict(pending[0].id, "采用本地");
  check("B 保留本机成功", take.ok, take);
  check("共享存储变为 B 的版本", stored().cues.find((c) => c.id === "c7").end === 17, stored().cues.find((c) => c.id === "c7"));

  // A 再改 → 轮到 A 看到冲突
  const a2 = tabA.retimeCue("c7", { end: 19 });
  check("A 后到也看到冲突", !a2.ok && /冲突/.test(a2.reason), a2);
  const aPending = get(tabA.conflicts).find((c) => c.status === "待处理");
  const drop = tabA.resolveConflict(aPending.id, "采用协作版本");
  check("A 采用协作版本", drop.ok && get(tabA.cues).find((c) => c.id === "c7").end === 17);
}

console.log("两个标签页：改不同字幕互不丢失");
{
  // A 在前面已改过 c2（rev 2），B 的 c2 还是旧版 → B 改 c2 应被判冲突（同一条字幕先保存的生效）
  const stale = tabB.editCueContent("c2", { translated: "stale edit" });
  check("B 基于旧版改 c2 被判冲突", !stale.ok && /冲突/.test(stale.reason), stale);
  // 双方各改一条没碰过的字幕
  const a = tabA.editCueContent("c3", { translated: "Reinforce before the next tide." });
  const b = tabB.editCueContent("c5", { translated: "Survey boat cleared the reef." });
  check("A 改 c3 文本生效", a.ok, a);
  check("B 改 c5 文本生效", b.ok, b);
  const s = stored();
  check("存储里 c3 是 A 的改动", s.cues.find((c) => c.id === "c3").translated === "Reinforce before the next tide.");
  check("存储里 c5 是 B 的改动", s.cues.find((c) => c.id === "c5").translated === "Survey boat cleared the reef.");
  check("存储里 c7 仍是 17", s.cues.find((c) => c.id === "c7").end === 17);
}

if (failures) {
  console.error(`\n${failures} 个断言失败`);
  process.exit(1);
}
console.log("\n全部通过");
