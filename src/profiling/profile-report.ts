/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Converts collected profiler data into
 * 1. a structured JSON summary ({@linkcode buildProfileSummary}),
 * 2. a Chrome Trace Event Format document loadable in `chrome://tracing` or https://ui.perfetto.dev
 *    ({@linkcode buildChromeTrace}), and
 * 3. a human-readable text report ({@linkcode formatProfileReport}).
 *
 * Every number is labelled as **measured** (directly timed or counted), **derived** (arithmetic over
 * measured values) or **estimated** (based on declared durations rather than observation).
 * @module
 */

import {
  type BattleProfiler,
  battleProfiler,
  COUNTER_LABELS,
  type Counters,
  Lane,
  PROFILE_SCHEMA_VERSION,
  type ProfileCategory,
  type ProfileStat,
  SECONDARY_CATEGORIES,
  type StatDelta,
  TracePh,
  type TurnContext,
  type TurnRecord,
} from "#app/profiling/battle-profiler";

/** Free-form metadata attached to exports (game version, scenario label, environment). */
export interface ProfileMeta {
  scenario?: string;
  gameVersion?: string;
  environment?: string;
  [key: string]: unknown;
}

export interface StatSummary {
  name: string;
  category: ProfileCategory;
  count: number;
  inclMs: number;
  exclMs: number;
  wallMs: number;
  counters: Record<string, number>;
}

/** Time decomposition for one turn. See the module docs for the meaning of each label. */
export interface TurnBreakdown {
  /** Measured: turn wall-clock (TurnStartPhase start → TurnEndPhase end). */
  wallMs: number;
  /** Measured: root-level synchronous instrumented work (phase `start()`s and timer/tween continuations). */
  syncWorkMs: number;
  /** Measured: exclusive time inside ability / modifier / move-attribute / damage evaluation. */
  effectEvaluationMs: number;
  /** Derived: `syncWorkMs − effectEvaluationMs` (other phase logic plus synchronous UI setup). */
  otherPhaseCodeMs: number;
  /** Measured (browser only): time inside game-loop steps. `null` when no frames were observed. */
  frameWorkMs: number | null;
  /** Derived (browser only): frame work not attributed to instrumented code (rendering, tween updates, etc.). */
  engineAndRenderMs: number | null;
  /**
   * Derived (browser only): main-thread time outside frame steps that long-task entries show was busy
   * (typically GPU presentation/compositing, or other tasks). `null` when no frames were observed.
   */
  blockedOutsideFramesMs: number | null;
  /** Derived (browser only): time the main thread spent outside frames, instrumented code and long tasks (waiting on timers/tweens/vsync). */
  idleWaitMs: number | null;
  /** Derived: wall time not covered by any of the above buckets. In headless runs this is the harness's own overhead. */
  unattributedMs: number;
  /** Estimated: sum of declared (post game-speed) durations of finite timers/tweens scheduled during the turn. */
  declaredWaitMs: number;
  /** Estimated: part of `declaredWaitMs` declared as `FixedInt` (does not scale with game speed). */
  declaredFixedWaitMs: number;
  /** Measured: Σ(actual − declared) over completed waits; positive values are frame-alignment latency. */
  waitOvershootMs: number;
}

export interface TurnSummary {
  index: number;
  endReason: string;
  context: TurnContext | null;
  breakdown: TurnBreakdown;
  counts: {
    frames: number;
    phaseTransitions: number;
    messagesQueued: number;
    hits: number;
    timersScheduled: number;
    tweensScheduled: number;
    abilityEvaluations: number;
    abilityAttrsConsidered: number;
    abilityActivations: number;
    abilitySimulatedCalls: number;
    modifierApplyCalls: number;
    modifiersScanned: number;
    modifiersMatched: number;
    modifiersTriggered: number;
    modifierLookups: number;
    modifierLookupScanned: number;
    moveAttrCalls: number;
    damageCalcs: number;
    damageCalcsSimulated: number;
    rngDraws: number;
    rngReseeds: number;
    rngStateRestores: number;
    longTasks: number;
    longTaskMs: number;
    gcCount: number;
    gcMs: number;
  };
  phaseCounts: Record<string, number>;
  topPhasesBySync: StatSummary[];
  topPhasesByWall: StatSummary[];
  topAbilities: StatSummary[];
  topModifiers: StatSummary[];
  topMoveAttrs: StatSummary[];
  heapDeltaBytes: number | null;
}

export interface ProfileSummary {
  schemaVersion: number;
  meta: ProfileMeta & {
    exportedAt: string;
    sessionDurationMs: number;
    traceEvents: number;
    traceEventsDropped: number;
  };
  turns: TurnSummary[];
  totals: {
    counters: Record<string, number>;
    stats: Record<string, StatSummary[]>;
  };
}

const EFFECT_CATEGORIES: readonly ProfileCategory[] = ["ability", "modifier", "moveAttr", "damage"];

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function counterRecord(category: ProfileCategory, a: number, b: number, c: number): Record<string, number> {
  const [la, lb, lc] = COUNTER_LABELS[category];
  const out: Record<string, number> = {};
  if (la) {
    out[la] = round(a);
  }
  if (lb) {
    out[lb] = round(b);
  }
  if (lc) {
    out[lc] = round(c);
  }
  return out;
}

function summarizeDelta(d: StatDelta | ProfileStat): StatSummary {
  return {
    name: d.name,
    category: d.category,
    count: d.count,
    inclMs: round(d.inclMs),
    exclMs: round(d.exclMs),
    wallMs: round(d.wallMs),
    counters: counterRecord(d.category, d.a, d.b, d.c),
  };
}

function top<T>(items: T[], key: (t: T) => number, n: number): T[] {
  return [...items].sort((x, y) => key(y) - key(x)).slice(0, n);
}

function sumBy(stats: StatDelta[], cat: ProfileCategory, f: (s: StatDelta) => number): number {
  let total = 0;
  for (const s of stats) {
    if (s.category === cat) {
      total += f(s);
    }
  }
  return total;
}

/** Compute the time decomposition for one turn's counters. */
export function computeBreakdown(wallMs: number, c: Counters, stats: StatDelta[]): TurnBreakdown {
  let effect = 0;
  for (const cat of EFFECT_CATEGORIES) {
    effect += sumBy(stats, cat, s => s.exclMs);
  }
  const hasFrames = c.frames > 0;
  const syncOutsideFrames = Math.max(0, c.syncMs - c.syncInFramesMs);
  const frameWork = hasFrames ? c.frameWorkMs : null;
  const engine = hasFrames ? Math.max(0, c.frameWorkMs - c.syncInFramesMs) : null;
  const rawIdle = hasFrames ? Math.max(0, wallMs - c.frameWorkMs - syncOutsideFrames) : null;
  // Long-task entries cover whole tasks (including the frame step); the remainder is busy time outside the step.
  const blocked =
    rawIdle === null ? null : Math.min(rawIdle, Math.max(0, c.longTaskMs - c.frameWorkMs - syncOutsideFrames));
  const idle = rawIdle === null ? null : rawIdle - (blocked ?? 0);
  const covered = c.syncMs + (engine ?? 0) + (blocked ?? 0) + (idle ?? 0);
  return {
    wallMs: round(wallMs),
    syncWorkMs: round(c.syncMs),
    effectEvaluationMs: round(effect),
    otherPhaseCodeMs: round(Math.max(0, c.syncMs - effect)),
    frameWorkMs: frameWork === null ? null : round(frameWork),
    engineAndRenderMs: engine === null ? null : round(engine),
    blockedOutsideFramesMs: blocked === null ? null : round(blocked),
    idleWaitMs: idle === null ? null : round(idle),
    unattributedMs: round(Math.max(0, wallMs - covered)),
    declaredWaitMs: round(c.declaredWaitMs),
    declaredFixedWaitMs: round(c.declaredFixedWaitMs),
    // Overshoot is only meaningful when real frames drive timers (not under mocked clocks).
    waitOvershootMs: hasFrames ? round(c.waitOvershootMs) : 0,
  };
}

function summarizeTurn(t: TurnRecord, topN: number): TurnSummary {
  const s = t.stats;
  const c = t.counters;
  const byCat = (cat: ProfileCategory) => s.filter(x => x.category === cat);
  const phases = byCat("phase");
  const phaseCounts: Record<string, number> = {};
  for (const p of phases) {
    if (p.count > 0) {
      phaseCounts[p.name] = p.count;
    }
  }
  return {
    index: t.index,
    endReason: t.endReason,
    context: t.context,
    breakdown: computeBreakdown(t.wallMs, c, s),
    counts: {
      frames: c.frames,
      phaseTransitions: c.phaseTransitions,
      messagesQueued: c.messagesQueued,
      hits: c.hits,
      timersScheduled: c.timersScheduled,
      tweensScheduled: c.tweensScheduled,
      abilityEvaluations: sumBy(s, "ability", x => x.count),
      abilityAttrsConsidered: sumBy(s, "ability", x => x.a),
      abilityActivations: sumBy(s, "ability", x => x.b),
      abilitySimulatedCalls: sumBy(s, "ability", x => x.c),
      modifierApplyCalls: sumBy(s, "modifier", x => x.count),
      modifiersScanned: sumBy(s, "modifier", x => x.a),
      modifiersMatched: sumBy(s, "modifier", x => x.b),
      modifiersTriggered: sumBy(s, "modifier", x => x.c),
      modifierLookups: sumBy(s, "modifierLookup", x => x.count),
      modifierLookupScanned: sumBy(s, "modifierLookup", x => x.a),
      moveAttrCalls: sumBy(s, "moveAttr", x => x.count),
      damageCalcs: sumBy(s, "damage", x => x.count),
      damageCalcsSimulated: sumBy(s, "damage", x => x.a),
      rngDraws: c.rngDraws,
      rngReseeds: c.rngReseeds,
      rngStateRestores: c.rngStateRestores,
      longTasks: c.longTasks,
      longTaskMs: round(c.longTaskMs),
      gcCount: c.gcCount,
      gcMs: round(c.gcMs),
    },
    phaseCounts,
    topPhasesBySync: top(phases, x => x.exclMs, topN).map(summarizeDelta),
    topPhasesByWall: top(phases, x => x.wallMs, topN).map(summarizeDelta),
    topAbilities: top(byCat("ability"), x => x.inclMs, topN).map(summarizeDelta),
    topModifiers: top(byCat("modifier"), x => x.inclMs, topN).map(summarizeDelta),
    topMoveAttrs: top(byCat("moveAttr"), x => x.inclMs, topN).map(summarizeDelta),
    heapDeltaBytes: t.heapStartBytes != null && t.heapEndBytes != null ? t.heapEndBytes - t.heapStartBytes : null,
  };
}

/** Build the structured JSON summary. */
export function buildProfileSummary(
  meta: ProfileMeta = {},
  profiler: BattleProfiler = battleProfiler,
  topN = 10,
): ProfileSummary {
  const end = profiler.sessionEndTs || profiler.now();
  const stats: Record<string, StatSummary[]> = {};
  for (const s of profiler.allStats()) {
    (stats[s.category] ??= []).push(summarizeDelta(s));
  }
  for (const list of Object.values(stats)) {
    list.sort((x, y) => y.inclMs - x.inclMs || y.count - x.count);
  }
  const counters: Record<string, number> = {};
  for (const [k, v] of Object.entries(profiler.totals)) {
    counters[k] = round(v as number);
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    meta: {
      ...meta,
      exportedAt: new Date().toISOString(),
      sessionDurationMs: round(end - profiler.sessionStartTs),
      traceEvents: profiler.trace.length,
      traceEventsDropped: profiler.trace.dropped,
    },
    turns: profiler.turns.map(t => summarizeTurn(t, topN)),
    totals: { counters, stats },
  };
}

const LANE_NAMES: Record<Lane, string> = {
  [Lane.SYNC]: "Sync work (CPU)",
  [Lane.PHASE_LIFETIME]: "Phase lifetime (wall)",
  [Lane.TURN]: "Turns",
  [Lane.FRAME]: "Frames / long tasks / GC",
  [Lane.PRESENTATION]: "Declared presentation waits (estimated)",
};

/** A Chrome Trace Event Format "JSON Object" document. */
export interface ChromeTrace {
  traceEvents: Record<string, unknown>[];
  displayTimeUnit: "ms";
  otherData: Record<string, string>;
}

/**
 * Build a Chrome Trace Event Format document.
 * Timestamps are microseconds relative to the profiling session start.
 * Lanes (`tid`) separate synchronous CPU work from asynchronous phase lifetimes so that wall time is
 * never displayed as CPU time. Declared presentation waits overlap, so they are emitted as
 * async (`b`/`e`) events.
 */
export function buildChromeTrace(meta: ProfileMeta = {}, profiler: BattleProfiler = battleProfiler): ChromeTrace {
  const origin = profiler.sessionStartTs;
  const us = (ms: number) => Math.round((ms - origin) * 1000);
  const events: Record<string, unknown>[] = [
    { name: "process_name", ph: "M", pid: 1, tid: 0, args: { name: "PokéRogue battle profiler" } },
  ];
  for (const [lane, name] of Object.entries(LANE_NAMES)) {
    events.push({ name: "thread_name", ph: "M", pid: 1, tid: Number(lane), args: { name } });
    events.push({ name: "thread_sort_index", ph: "M", pid: 1, tid: Number(lane), args: { sort_index: Number(lane) } });
  }
  let asyncId = 0;
  for (const e of profiler.trace.events()) {
    if (e.ph === TracePh.COMPLETE && e.lane === Lane.PRESENTATION) {
      const id = ++asyncId;
      const common = { name: e.name, cat: "presentation", pid: 1, tid: Lane.PRESENTATION, id };
      events.push({
        ...common,
        ph: "b",
        ts: us(e.ts),
        args: { ownerPhase: e.cat, declaredMs: e.dur, estimated: true },
      });
      events.push({ ...common, ph: "e", ts: us(e.ts + e.dur) });
      continue;
    }
    if (e.ph === TracePh.COMPLETE) {
      events.push({
        name: e.name,
        cat: e.cat,
        ph: "X",
        pid: 1,
        tid: e.lane,
        ts: us(e.ts),
        dur: Math.max(0, Math.round(e.dur * 1000)),
        ...(e.lane === Lane.TURN ? { args: { turnIndex: e.arg } } : {}),
      });
    }
  }
  // Per-turn counters make it easy to see effect volume next to the timeline.
  for (const t of profiler.turns) {
    const s = summarizeTurn(t, 0);
    events.push({
      name: "effects",
      ph: "C",
      pid: 1,
      ts: us(t.endTs),
      args: {
        abilityEvaluations: s.counts.abilityEvaluations,
        modifierApplyCalls: s.counts.modifierApplyCalls,
        hits: s.counts.hits,
        messages: s.counts.messagesQueued,
        rngDraws: s.counts.rngDraws,
      },
    });
  }
  const otherData: Record<string, string> = { schemaVersion: String(PROFILE_SCHEMA_VERSION) };
  for (const [k, v] of Object.entries(meta)) {
    otherData[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  otherData.traceEventsDropped = String(profiler.trace.dropped);
  return { traceEvents: events, displayTimeUnit: "ms", otherData };
}

function pad(s: string | number, n: number, right = false): string {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

function ms(n: number | null): string {
  return n === null ? "n/a" : `${n.toFixed(2)} ms`;
}

/** Render a concise human-readable report for every captured turn. */
export function formatProfileReport(summary: ProfileSummary, maxTurns = 50): string {
  const lines: string[] = [];
  const m = summary.meta;
  lines.push(`PokéRogue battle profile — ${m.scenario ?? "unnamed scenario"}`);
  lines.push(
    `schema v${summary.schemaVersion} | ${summary.turns.length} turn(s) | session ${m.sessionDurationMs.toFixed(0)} ms | exported ${m.exportedAt}`,
  );
  lines.push("Legend: [M] measured, [D] derived from measurements, [E] estimated from declared durations.");
  lines.push("");
  const turns = summary.turns.slice(-maxTurns);
  for (const t of turns) {
    const b = t.breakdown;
    const c = t.counts;
    const ctx = t.context;
    lines.push(
      `── Turn #${t.index}${ctx ? ` (wave ${ctx.waveIndex}, battle turn ${ctx.turn}, mode ${ctx.gameMode}, gameSpeed setting ${ctx.gameSpeed})` : ""} — ended by ${t.endReason}`,
    );
    if (ctx) {
      lines.push(
        `   run state: player mods ${ctx.playerModifiers} (${ctx.playerModifierStacks} stacks, ${ctx.playerHeldItemStacks} held), enemy mods ${ctx.enemyModifiers} (${ctx.enemyModifierStacks} stacks), field ${ctx.fieldPokemon} (${ctx.fieldPassives} passives)`,
      );
    }
    lines.push(`   wall-clock            [M] ${ms(b.wallMs)}`);
    lines.push(
      `   sync work (CPU)       [M] ${ms(b.syncWorkMs)}  = effect evaluation [M] ${ms(b.effectEvaluationMs)} + other phase code [D] ${ms(b.otherPhaseCodeMs)}`,
    );
    lines.push(
      `   engine/render         [D] ${ms(b.engineAndRenderMs)}   (frame work [M] ${ms(b.frameWorkMs)}, ${c.frames} frames)`,
    );
    lines.push(`   blocked outside frame [D] ${ms(b.blockedOutsideFramesMs)}   (long tasks; e.g. GPU presentation)`);
    lines.push(`   idle / waiting        [D] ${ms(b.idleWaitMs)}`);
    lines.push(`   unattributed          [D] ${ms(b.unattributedMs)}`);
    lines.push(
      `   declared waits        [E] ${ms(b.declaredWaitMs)} (${c.timersScheduled} timers, ${c.tweensScheduled} tweens; ${ms(b.declaredFixedWaitMs)} fixed/unscaled); overshoot [M] ${c.frames > 0 ? ms(b.waitOvershootMs) : "n/a"}`,
    );
    lines.push(
      `   counts [M]: ${c.phaseTransitions} phase transitions, ${c.messagesQueued} messages, ${c.hits} hits, ${c.damageCalcs} damage calcs (${c.damageCalcsSimulated} simulated), ${c.rngDraws} RNG draws, ${c.rngReseeds} reseeds`,
    );
    lines.push(
      `   abilities [M]: ${c.abilityEvaluations} evaluations (${c.abilitySimulatedCalls} simulated), ${c.abilityAttrsConsidered} attrs considered → ${c.abilityActivations} activations`,
    );
    lines.push(
      `   modifiers [M]: ${c.modifierApplyCalls} apply calls scanning ${c.modifiersScanned} entries → ${c.modifiersMatched} matched → ${c.modifiersTriggered} triggered; ${c.modifierLookups} lookups scanning ${c.modifierLookupScanned} entries`,
    );
    if (c.longTasks > 0 || c.gcCount > 0) {
      lines.push(`   runtime [M]: ${c.longTasks} long tasks (${ms(c.longTaskMs)}), ${c.gcCount} GCs (${ms(c.gcMs)})`);
    }
    if (t.heapDeltaBytes !== null) {
      lines.push(`   heap delta [M]: ${(t.heapDeltaBytes / 1024).toFixed(0)} KiB`);
    }
    const fmtList = (title: string, list: StatSummary[], val: (s: StatSummary) => string) => {
      if (list.length === 0) {
        return;
      }
      lines.push(`   ${title}`);
      for (const s of list.slice(0, 5)) {
        lines.push(`     ${pad(s.name, 40)} ${pad(`×${s.count}`, 7, true)}  ${val(s)}`);
      }
    };
    fmtList("top phases by sync CPU (exclusive):", t.topPhasesBySync, s => `${s.exclMs.toFixed(2)} ms`);
    fmtList(
      "top phases by wall lifetime:",
      t.topPhasesByWall,
      s =>
        `${s.wallMs.toFixed(2)} ms wall; ${s.counters.waitsScheduled ?? 0} waits, ${s.counters.declaredWaitMs ?? 0} ms declared`,
    );
    fmtList(
      "top abilities (inclusive):",
      t.topAbilities,
      s => `${s.inclMs.toFixed(2)} ms; ${s.counters.activations}/${s.counters.attrsConsidered} activations/attrs`,
    );
    fmtList(
      "top modifiers (inclusive):",
      t.topModifiers,
      s => `${s.inclMs.toFixed(2)} ms; ${s.counters.triggered}/${s.counters.matched} triggered/matched`,
    );
    lines.push("");
  }
  if (summary.turns.length > maxTurns) {
    lines.push(`(${summary.turns.length - maxTurns} earlier turn(s) omitted)`);
  }
  return lines.join("\n");
}

/** Whether a category's time is an alternate view (and must not be summed with others). */
export function isSecondaryCategory(cat: ProfileCategory): boolean {
  return SECONDARY_CATEGORIES.has(cat);
}
