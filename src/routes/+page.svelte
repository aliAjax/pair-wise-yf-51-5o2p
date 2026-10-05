<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { activeCues, activeTrackId, conflicts, createSnapshot, cues, editCueContent, lockTerm, mergeNext, nudgeCue, resolveConflict, restoreSnapshot, retimeCue, reviewCue, reviewEvents, selectedCueId, setCueStatus, snapshots, splitCue, terms, toggleCueTermLock, tracks } from "$lib/stores/subtitles";
  import { isProtected, round1 } from "$lib/stores/timeline";
  import type { Cue, EditResult } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  let formNotice = $state("");
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const end = round1(start + Number(formData.get("duration") ?? 2.5));
      const trackId = get(activeTrackId);
      const limit = get(tracks).find((track) => track.id === trackId)?.duration ?? Number.POSITIVE_INFINITY;
      if (end > limit) { formNotice = `越出整段时长 ${limit.toFixed(1)} 秒，未添加`; return; }
      const clash = get(cues).some((item) => item.trackId === trackId && start < item.end && end > item.start);
      if (clash) { formNotice = "与现有字幕时间重叠，未添加"; return; }
      const item: Cue = { id: crypto.randomUUID(), trackId, start, end, source: String(formData.get("source") ?? ""), translated: String(formData.get("translated") ?? ""), status: "翻译中", translator: "当前译者", reviewerNote: "", termLocked: false, revision: 1 };
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
      formNotice = "";
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  const selectedConflict = $derived($conflicts.find((item) => item.cueId === selected?.id && item.status === "待处理"));
  let reviewNote = $state("");
  let notice = $state<{ text: string; ok: boolean } | null>(null);

  function report(result: EditResult) {
    notice = result.ok
      ? { text: result.shifted ? `已保存，后续 ${result.shifted} 条普通字幕按原时长顺延` : "已保存", ok: true }
      : { text: result.reason ?? "修改未生效", ok: false };
  }

  function applyRetime(id: string, patch: { start?: number; end?: number }, input?: HTMLInputElement, original?: number) {
    const result = retimeCue(id, patch);
    report(result);
    if (!result.ok && input && original !== undefined) input.value = String(original);
  }

  function applyContent(id: string, patch: Partial<Cue>) {
    const result = editCueContent(id, patch);
    if (!result.ok) notice = { text: result.reason ?? "修改未生效", ok: false };
  }

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); return; }
      if (event.metaKey || event.ctrlKey) return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") report(splitCue($selectedCueId));
      if (event.key.toLowerCase() === "m") report(mergeNext($selectedCueId));
      if (event.key === ",") report(nudgeCue($selectedCueId, -0.2));
      if (event.key === ".") report(nudgeCue($selectedCueId, 0.2));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>, / . 微调 0.2 秒</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>多语种轨道、术语锁定与审校反馈在同一时间轴协作。</p></div><div class="header-actions"><select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>整段时长 {formatTime(activeTrack?.duration ?? 0)} · 改动一条后，后续普通条目按原时长顺延，锁定/已通过条目会拦住改动</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if notice}<p class="notice" class:ok={notice.ok}>{notice.text}</p>{/if}
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => { selectedCueId.set(cue.id); notice = null; }} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>{#if cue.termLocked}<span class="chip lock">🔒 术语锁定</span>{/if}</div>
                <span class={`chip ${cue.status}`}>{cue.status}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); report(nudgeCue(cue.id, -0.2)); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); report(nudgeCue(cue.id, 0.2)); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status} · v{selected.revision}</span>{/if}</div>
          {#if selected}
            {#if selectedConflict}<p class="notice">该字幕存在未处理的协作冲突，请先在下方「协作冲突」面板选择保留哪一版。</p>{/if}
            {#if isProtected(selected)}<p class="hint">🔒 受保护条目（{selected.termLocked ? "术语锁定" : "审校已通过"}）：其他字幕顺延到此处会被拦下{#if selected.status === "已通过"}；直接修改时间码会使审校结论失效并退回重审{/if}。</p>{/if}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => applyContent(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => applyContent(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} onchange={(event) => applyRetime(selected.id, { start: Number(event.currentTarget.value) }, event.currentTarget, selected.start)} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} onchange={(event) => applyRetime(selected.id, { end: Number(event.currentTarget.value) }, event.currentTarget, selected.end)} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button><button class="btn" onclick={() => toggleCueTermLock(selected.id)}>{selected.termLocked ? "解除术语锁定" : "锁定本条术语"}</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定术语不会被普通翻译直接覆盖</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {term.target}</span><button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2><small>两个标签页同时改一条字幕时，先保存的生效</small></div>
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>本机尝试 {formatTime(conflict.localStart)}–{formatTime(conflict.localEnd)} · 协作版本 {formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => report(resolveConflict(conflict.id, "采用本地"))}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
          {#if !$conflicts.length}<p>暂无冲突。</p>{/if}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
          {#if formNotice}<p class="notice">{formNotice}</p>{/if}
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}{item.cueRevision ? ` · 版本 v${item.cueRevision}` : ""}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2></div><div class="events">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · 最高版本 v{Math.max(0, ...item.cues.map((cue) => cue.revision))} · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>
  </main>
</div>
