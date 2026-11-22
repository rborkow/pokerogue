/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Opt-in, development-only battle profiler.
 *
 * @remarks
 * The profiler is **disabled by default**. While disabled, every instrumentation site costs one
 * boolean check (and in production builds, {@linkcode PROFILING_SUPPORTED} is a compile-time `false`,
 * so the bundler removes the instrumentation entirely).
 *
 * Design notes:
 * - Timing uses `performance.now()` (monotonic, high resolution).
 * - **Synchronous** work is timed with an explicit stack, which yields correct *exclusive* times for
 *   nested operations (phase → ability → modifier → damage calc) without double-counting.
 *   Inclusive time for a recursive stat is only accumulated at its outermost frame.
 * - **Asynchronous** phase lifetimes (from `start()` until `end()`) are tracked separately as wall time
 *   and are never reported as CPU time.
 * - All per-event bookkeeping writes into pre-allocated aggregates or a fixed-size typed-array ring
 *   buffer; no objects are allocated per instrumented call once a stat key has been seen.
 * - Per-turn breakdowns are computed as deltas against "marks" taken at turn start, so no
 *   per-turn maps need to be maintained on the hot path.
 *
 * This module intentionally has **no runtime imports** so that it can be imported from anywhere
 * (phase manager, ability code, battle scene) without introducing import cycles.
 * @module
 */

import type { Phase } from "#app/phase";

/** `false` in production builds; lets the bundler strip instrumentation. */
export const PROFILING_SUPPORTED: boolean = import.meta.env.MODE !== "production";

/** Bumped whenever the shape of exported summaries changes in a backwards-incompatible way. */
export const PROFILE_SCHEMA_VERSION = 1;

/** Categories of synchronously-timed work. */
/** Categories whose time is an alternate view of another category's time (never summed with others). */
export const SECONDARY_CATEGORIES: ReadonlySet<ProfileCategory> = new Set<ProfileCategory>(["abilityAttr"]);

export type ProfileCategory =
  | "phase"
  | "continuation"
  | "ability"
  | "abilityAttr"
  | "modifier"
  | "modifierLookup"
  | "moveAttr"
  | "damage";

/** How much detail is written to the trace ring buffer. */
export type TraceDetail = "off" | "phases" | "full";

export interface ProfilerOptions {
  /**
   * `"phases"` (default) records one slice per phase start, phase lifetime, turn and frame.
   * `"full"` additionally records every nested ability/modifier/damage slice (much larger traces).
   */
  traceDetail?: TraceDetail;
  /** Capacity of the trace ring buffer, in events. Oldest events are overwritten. Default 200 000. */
  traceCapacity?: number;
  /** Maximum number of per-turn records retained (oldest dropped). Default 500. */
  maxTurns?: number;
}

/**
 * A mutable aggregate for one named unit of work.
 * Counter meanings `a`/`b`/`c` depend on the category; see {@linkcode COUNTER_LABELS}.
 */
export class ProfileStat {
  public count = 0;
  public inclMs = 0;
  public exclMs = 0;
  public maxInclMs = 0;
  /** Wall-clock lifetime (phases only): from `start()` to `end()`, including async waits. */
  public wallMs = 0;
  public maxWallMs = 0;
  public a = 0;
  public b = 0;
  public c = 0;
  /** Current recursion depth (used to avoid double-counting inclusive time). */
  public depth = 0;

  // Marks taken at the start of the current turn, used to compute per-turn deltas.
  public mCount = 0;
  public mIncl = 0;
  public mExcl = 0;
  public mWall = 0;
  public mA = 0;
  public mB = 0;
  public mC = 0;

  constructor(
    public readonly name: string,
    public readonly category: ProfileCategory,
  ) {}

  public mark(): void {
    this.mCount = this.count;
    this.mIncl = this.inclMs;
    this.mExcl = this.exclMs;
    this.mWall = this.wallMs;
    this.mA = this.a;
    this.mB = this.b;
    this.mC = this.c;
  }

  public reset(): void {
    this.count = 0;
    this.inclMs = 0;
    this.exclMs = 0;
    this.maxInclMs = 0;
    this.wallMs = 0;
    this.maxWallMs = 0;
    this.a = 0;
    this.b = 0;
    this.c = 0;
    this.depth = 0;
    this.mark();
  }
}

/** Human-readable meaning of the generic counters for each category. */
export const COUNTER_LABELS: Readonly<Record<ProfileCategory, readonly [string, string, string]>> = {
  phase: ["waitsScheduled", "declaredWaitMs", ""],
  continuation: ["", "", ""],
  ability: ["attrsConsidered", "activations", "simulatedCalls"],
  abilityAttr: ["attrsConsidered", "activations", "simulatedCalls"],
  modifier: ["modifiersScanned", "matched", "triggered"],
  modifierLookup: ["modifiersScanned", "", ""],
  moveAttr: ["attrsConsidered", "", ""],
  damage: ["simulatedCalls", "", ""],
};

/** Plain counters that are not tied to a timed stat. */
export class Counters {
  public rngDraws = 0;
  public rngReseeds = 0;
  public rngStateRestores = 0;
  public hits = 0;
  public messagesQueued = 0;
  public phaseTransitions = 0;
  public timersScheduled = 0;
  public tweensScheduled = 0;
  public loopingScheduled = 0;
  /** Sum of declared (post game-speed) durations of finite timers/tweens (an estimate). */
  public declaredWaitMs = 0;
  /** Portion of {@linkcode declaredWaitMs} that was declared as `FixedInt` (immune to game speed). */
  public declaredFixedWaitMs = 0;
  /** Completions observed for wrapped timers/tweens. */
  public waitsCompleted = 0;
  /** Sum over completed waits of (actual elapsed − declared duration). Measured. */
  public waitOvershootMs = 0;
  public frames = 0;
  /** Sum of time inside game-loop steps (pre-step → post-render). Measured. */
  public frameWorkMs = 0;
  /** Synchronous instrumented work that happened inside a game-loop step. */
  public syncInFramesMs = 0;
  /** Total root-level synchronous instrumented work. */
  public syncMs = 0;
  public longTasks = 0;
  public longTaskMs = 0;
  public gcCount = 0;
  public gcMs = 0;

  public copyFrom(o: Counters): void {
    Object.assign(this, o);
  }
}

/** Trace ring buffer phase codes. */
export enum TracePh {
  COMPLETE = 0,
  INSTANT = 1,
  COUNTER = 2,
  ASYNC_BEGIN = 3,
  ASYNC_END = 4,
}

/** Trace "thread" lanes. */
export enum Lane {
  SYNC = 1,
  PHASE_LIFETIME = 2,
  TURN = 3,
  FRAME = 4,
  PRESENTATION = 5,
}

/**
 * Fixed-capacity ring buffer of trace events backed by typed arrays.
 * Strings are interned into a small table so that recording an event never allocates.
 */
export class TraceBuffer {
  private readonly ts: Float64Array;
  private readonly dur: Float64Array;
  private readonly name: Int32Array;
  private readonly cat: Int32Array;
  private readonly lane: Int8Array;
  private readonly ph: Int8Array;
  private readonly arg: Float64Array;
  private head = 0;
  private size = 0;
  public dropped = 0;
  private readonly strings: string[] = [];
  private readonly stringIds = new Map<string, number>();

  constructor(public readonly capacity: number) {
    this.ts = new Float64Array(capacity);
    this.dur = new Float64Array(capacity);
    this.name = new Int32Array(capacity);
    this.cat = new Int32Array(capacity);
    this.lane = new Int8Array(capacity);
    this.ph = new Int8Array(capacity);
    this.arg = new Float64Array(capacity);
  }

  public intern(s: string): number {
    let id = this.stringIds.get(s);
    if (id === undefined) {
      id = this.strings.length;
      this.strings.push(s);
      this.stringIds.set(s, id);
    }
    return id;
  }

  public push(ph: TracePh, lane: Lane, name: string, cat: string, ts: number, dur: number, arg = 0): void {
    if (this.capacity === 0) {
      return;
    }
    const i = this.head;
    this.ts[i] = ts;
    this.dur[i] = dur;
    this.name[i] = this.intern(name);
    this.cat[i] = this.intern(cat);
    this.lane[i] = lane;
    this.ph[i] = ph;
    this.arg[i] = arg;
    this.head = (i + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.dropped++;
    }
  }

  public clear(): void {
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
  }

  public get length(): number {
    return this.size;
  }

  /** Iterate events oldest → newest. Allocates; only used at export time. */
  public *events(): Generator<TraceEventView> {
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let k = 0; k < this.size; k++) {
      const i = (start + k) % this.capacity;
      yield {
        ph: this.ph[i] as TracePh,
        lane: this.lane[i] as Lane,
        name: this.strings[this.name[i]],
        cat: this.strings[this.cat[i]],
        ts: this.ts[i],
        dur: this.dur[i],
        arg: this.arg[i],
      };
    }
  }
}

export interface TraceEventView {
  ph: TracePh;
  lane: Lane;
  name: string;
  cat: string;
  ts: number;
  dur: number;
  arg: number;
}

/** Snapshot of one stat's activity during a turn. */
export interface StatDelta {
  name: string;
  category: ProfileCategory;
  count: number;
  inclMs: number;
  exclMs: number;
  wallMs: number;
  a: number;
  b: number;
  c: number;
}

/** Contextual run-state captured at the start of each turn (used to correlate cost with run state). */
export interface TurnContext {
  waveIndex: number;
  turn: number;
  gameMode: string;
  gameSpeed: number;
  playerModifiers: number;
  playerModifierStacks: number;
  enemyModifiers: number;
  enemyModifierStacks: number;
  playerHeldItemStacks: number;
  enemyHeldItemStacks: number;
  fieldPokemon: number;
  fieldPassives: number;
}

export interface TurnRecord {
  index: number;
  context: TurnContext | null;
  startTs: number;
  endTs: number;
  /** Why the turn was closed (`TurnEndPhase`, or the phase that interrupted it). */
  endReason: string;
  wallMs: number;
  counters: Counters;
  stats: StatDelta[];
  heapStartBytes: number | null;
  heapEndBytes: number | null;
}

type ContextProvider = () => TurnContext | null;
type HeapProvider = () => number | null;

const now: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

/**
 * The profiler singleton. Import {@linkcode battleProfiler} rather than constructing this directly.
 */
export class BattleProfiler {
  /** Hot-path flag. Instrumentation sites must check `PROFILING_SUPPORTED && battleProfiler.enabled`. */
  public enabled = false;

  public traceDetail: TraceDetail = "phases";
  public trace: TraceBuffer = new TraceBuffer(0);
  public maxTurns = 500;

  /** Session-wide totals. */
  public readonly totals = new Counters();
  private readonly turnMark = new Counters();
  private readonly statsByCategory = new Map<ProfileCategory, Map<string, ProfileStat>>();
  public readonly turns: TurnRecord[] = [];
  private turnIndex = 0;
  public sessionStartTs = 0;
  public sessionEndTs = 0;

  // #region Sync stack
  private stackStat: ProfileStat[] = [];
  private stackStart: number[] = [];
  private stackChild: number[] = [];
  private depth = 0;
  // #endregion

  // #region Phase lifetime
  private readonly phaseStartTs = new WeakMap<Phase, number>();
  private readonly wrappedPhases = new WeakSet<Phase>();
  // #endregion

  // #region Turn state
  private turnOpen = false;
  private turnStartTs = 0;
  private turnContext: TurnContext | null = null;
  private turnHeapStart: number | null = null;
  // #endregion

  // #region Frame state
  private frameStartTs = -1;
  // #endregion

  public contextProvider: ContextProvider | null = null;
  /** Optional observer of phase starts/ends (used by battle capture). Called outside timed regions. */
  public phaseListener: ((kind: "start" | "end", phase: Phase) => void) | null = null;
  public heapProvider: HeapProvider = defaultHeapProvider;

  /** Teardown callbacks registered by installers (presentation hooks, RNG hooks, observers). */
  private readonly teardowns: (() => void)[] = [];

  /** Start profiling. Clears any previously collected data. */
  public enable(opts: ProfilerOptions = {}): void {
    if (!PROFILING_SUPPORTED) {
      console.warn("Battle profiler is not available in production builds.");
      return;
    }
    this.reset();
    this.traceDetail = opts.traceDetail ?? "phases";
    const capacity = this.traceDetail === "off" ? 0 : (opts.traceCapacity ?? 200_000);
    if (this.trace.capacity !== capacity) {
      this.trace = new TraceBuffer(capacity);
    }
    this.maxTurns = opts.maxTurns ?? 500;
    this.sessionStartTs = now();
    this.enabled = true;
  }

  /** Stop profiling and remove all installed hooks. Collected data is retained until the next `enable()`. */
  public disable(): void {
    if (this.turnOpen) {
      this.closeTurn("profilerDisabled");
    }
    this.enabled = false;
    this.sessionEndTs = now();
    while (this.teardowns.length > 0) {
      try {
        this.teardowns.pop()!();
      } catch (e) {
        console.error("Battle profiler teardown failed", e);
      }
    }
  }

  /** Register a teardown callback to be run on {@linkcode disable}. */
  public onDisable(fn: () => void): void {
    this.teardowns.push(fn);
  }

  public reset(): void {
    for (const map of this.statsByCategory.values()) {
      for (const s of map.values()) {
        s.reset();
      }
    }
    this.statsByCategory.clear();
    this.abilityStats.clear();
    this.passiveAbilityStats.clear();
    this.totals.copyFrom(new Counters());
    this.turnMark.copyFrom(new Counters());
    this.turns.length = 0;
    this.turnIndex = 0;
    this.trace.clear();
    this.depth = 0;
    this.turnOpen = false;
    this.frameStartTs = -1;
    this.sessionEndTs = 0;
    this.phaseListener = null;
  }

  public now(): number {
    return now();
  }

  // #region Stats

  /** Get (or lazily create) the aggregate for a key. Allocates only the first time a key is seen. */
  public stat(category: ProfileCategory, name: string): ProfileStat {
    let map = this.statsByCategory.get(category);
    if (map === undefined) {
      map = new Map();
      this.statsByCategory.set(category, map);
    }
    let s = map.get(name);
    if (s === undefined) {
      s = new ProfileStat(name, category);
      map.set(name, s);
    }
    return s;
  }

  private readonly abilityStats = new Map<number, ProfileStat>();
  private readonly passiveAbilityStats = new Map<number, ProfileStat>();

  /**
   * Stat for an ability evaluation, keyed by ability ID; passives are tracked separately.
   * The (localized, comparatively expensive) name is only read the first time an ability is seen.
   */
  public abilityStat(ability: { readonly id: number; readonly name: string }, passive: boolean): ProfileStat {
    const map = passive ? this.passiveAbilityStats : this.abilityStats;
    let s = map.get(ability.id);
    if (s === undefined) {
      const name = passive ? `${ability.name} (passive)` : ability.name;
      s = this.stat("ability", name);
      map.set(ability.id, s);
    }
    return s;
  }

  /** Begin timing a modifier application call. `scanned` is the size of the list being filtered. */
  public beginModifier(modifierTypeName: string, scanned: number): ProfileStat {
    const s = this.stat("modifier", modifierTypeName);
    s.a += scanned;
    this.begin(s);
    return s;
  }

  /** Count (without timing) a linear modifier lookup over `scanned` modifiers. */
  public countModifierLookup(key: string, scanned: number): void {
    const s = this.stat("modifierLookup", key);
    s.count++;
    s.a += scanned;
  }

  public allStats(category?: ProfileCategory): ProfileStat[] {
    if (category) {
      return [...(this.statsByCategory.get(category)?.values() ?? [])];
    }
    return [...this.statsByCategory.values()].flatMap(m => [...m.values()]);
  }

  // #endregion Stats

  // #region Synchronous timing

  /**
   * Begin a synchronous timed region. **Must** be paired with {@linkcode end} (use `try/finally`).
   * @returns The start timestamp (opaque; pass nothing back, `end` uses the stack).
   */
  public begin(s: ProfileStat): void {
    const d = this.depth++;
    this.stackStat[d] = s;
    this.stackStart[d] = now();
    this.stackChild[d] = 0;
    s.count++;
    s.depth++;
  }

  /**
   * End the innermost synchronous region started by {@linkcode begin}.
   * @param secondary - An optional second stat that receives the same inclusive/exclusive time and a count.
   * Secondary stats are an *alternate view* of time already attributed to the primary stat (e.g. the same
   * ability evaluation viewed by attribute type rather than by ability), so they must not be summed with
   * primary categories.
   */
  public end(secondary?: ProfileStat): void {
    if (this.depth === 0) {
      return; // Unbalanced (e.g. profiler enabled mid-region); ignore safely.
    }
    const t = now();
    const d = --this.depth;
    const s = this.stackStat[d];
    const start = this.stackStart[d];
    const dur = t - start;
    const excl = dur - this.stackChild[d];
    s.exclMs += excl;
    s.depth--;
    if (s.depth === 0) {
      s.inclMs += dur;
      if (dur > s.maxInclMs) {
        s.maxInclMs = dur;
      }
    }
    if (secondary !== undefined) {
      secondary.count++;
      secondary.inclMs += dur;
      secondary.exclMs += excl;
    }
    if (d > 0) {
      this.stackChild[d - 1] += dur;
      if (this.traceDetail === "full") {
        this.trace.push(TracePh.COMPLETE, Lane.SYNC, s.name, s.category, start, dur);
      }
    } else {
      // Root-level region: counts toward total synchronous (simulation) time.
      this.totals.syncMs += dur;
      if (this.frameStartTs >= 0) {
        this.totals.syncInFramesMs += dur;
      }
      if (this.traceDetail !== "off") {
        this.trace.push(TracePh.COMPLETE, Lane.SYNC, s.name, s.category, start, dur);
      }
    }
    this.stackStat[d] = undefined!; // release reference
  }

  /** Current synchronous nesting depth (exposed for tests). */
  public get syncDepth(): number {
    return this.depth;
  }

  // #endregion Synchronous timing

  // #region Phases

  /**
   * Called by the phase manager whenever a phase becomes the current phase, before it is started.
   * Wraps the instance's `start` method so that both the real phase manager and the test
   * harness's phase interceptor (which calls `start()` directly) are measured.
   */
  public onPhaseSelected(phase: Phase): void {
    if (this.wrappedPhases.has(phase)) {
      return;
    }
    this.wrappedPhases.add(phase);
    const original = phase.start;
    const profiler = this;
    phase.start = function (this: Phase): void {
      if (!profiler.enabled) {
        original.call(this);
        return;
      }
      profiler.onPhaseStart(this);
      profiler.begin(profiler.stat("phase", this.phaseName));
      try {
        original.call(this);
      } finally {
        profiler.end();
      }
    };
  }

  private onPhaseStart(phase: Phase): void {
    this.phaseListener?.("start", phase);
    const t = now();
    this.phaseStartTs.set(phase, t);
    this.totals.phaseTransitions++;
    const name = phase.phaseName;
    if (name === "TurnStartPhase") {
      this.openTurn(t);
    } else if (
      this.turnOpen
      && (name === "TurnInitPhase"
        || name === "CommandPhase"
        || name === "EncounterPhase"
        || name === "SelectModifierPhase"
        || name === "GameOverPhase"
        || name === "TitlePhase")
    ) {
      this.closeTurn(name, t);
    }
  }

  /** Called by the phase manager when the current phase ends (i.e. `shiftPhase` is invoked). */
  public onPhaseEnd(phase: Phase | undefined): void {
    if (phase === undefined) {
      return;
    }
    const start = this.phaseStartTs.get(phase);
    if (start === undefined) {
      return;
    }
    this.phaseStartTs.delete(phase);
    const t = now();
    const wall = t - start;
    const s = this.stat("phase", phase.phaseName);
    s.wallMs += wall;
    if (wall > s.maxWallMs) {
      s.maxWallMs = wall;
    }
    if (this.traceDetail !== "off") {
      this.trace.push(TracePh.COMPLETE, Lane.PHASE_LIFETIME, phase.phaseName, "phaseLifetime", start, wall);
    }
    if (phase.phaseName === "TurnEndPhase" && this.turnOpen) {
      this.closeTurn("TurnEndPhase", t);
    }
    this.phaseListener?.("end", phase);
  }

  // #endregion Phases

  // #region Turns

  private openTurn(t: number): void {
    if (this.turnOpen) {
      this.closeTurn("TurnStartPhase", t);
    }
    this.turnOpen = true;
    this.turnStartTs = t;
    this.turnHeapStart = this.heapProvider();
    try {
      this.turnContext = this.contextProvider?.() ?? null;
    } catch {
      this.turnContext = null;
    }
    this.turnMark.copyFrom(this.totals);
    for (const map of this.statsByCategory.values()) {
      for (const s of map.values()) {
        s.mark();
      }
    }
  }

  private closeTurn(reason: string, t = now()): void {
    this.turnOpen = false;
    const counters = new Counters();
    for (const key of Object.keys(counters) as (keyof Counters)[]) {
      (counters[key] as number) = (this.totals[key] as number) - (this.turnMark[key] as number);
    }
    const stats: StatDelta[] = [];
    for (const map of this.statsByCategory.values()) {
      for (const s of map.values()) {
        const count = s.count - s.mCount;
        const wallMs = s.wallMs - s.mWall;
        if (count === 0 && wallMs === 0) {
          continue;
        }
        stats.push({
          name: s.name,
          category: s.category,
          count,
          inclMs: s.inclMs - s.mIncl,
          exclMs: s.exclMs - s.mExcl,
          wallMs,
          a: s.a - s.mA,
          b: s.b - s.mB,
          c: s.c - s.mC,
        });
      }
    }
    const record: TurnRecord = {
      index: this.turnIndex++,
      context: this.turnContext,
      startTs: this.turnStartTs,
      endTs: t,
      endReason: reason,
      wallMs: t - this.turnStartTs,
      counters,
      stats,
      heapStartBytes: this.turnHeapStart,
      heapEndBytes: this.heapProvider(),
    };
    this.turns.push(record);
    if (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
    if (this.traceDetail !== "off") {
      const label = this.turnContext ? `Turn w${this.turnContext.waveIndex} t${this.turnContext.turn}` : "Turn";
      this.trace.push(TracePh.COMPLETE, Lane.TURN, label, "turn", this.turnStartTs, record.wallMs, record.index);
    }
  }

  public get isTurnOpen(): boolean {
    return this.turnOpen;
  }

  // #endregion Turns

  // #region Frames

  /** Called at the start of a game-loop step. */
  public onFrameStart(): void {
    this.frameStartTs = now();
  }

  /** Called after the game-loop step has rendered. */
  public onFrameEnd(): void {
    if (this.frameStartTs < 0) {
      return;
    }
    const t = now();
    const dur = t - this.frameStartTs;
    this.totals.frames++;
    this.totals.frameWorkMs += dur;
    if (this.traceDetail !== "off" && this.turnOpen) {
      this.trace.push(TracePh.COMPLETE, Lane.FRAME, "Frame", "frame", this.frameStartTs, dur);
    }
    this.frameStartTs = -1;
  }

  // #endregion Frames

  // #region Presentation & runtime

  /** Record that a finite presentation wait (timer/tween) was scheduled. */
  public onWaitScheduled(kind: "timer" | "tween", ownerPhase: string, declaredMs: number, fixedMs: number): void {
    if (kind === "timer") {
      this.totals.timersScheduled++;
    } else {
      this.totals.tweensScheduled++;
    }
    this.totals.declaredWaitMs += declaredMs;
    this.totals.declaredFixedWaitMs += fixedMs;
    // Attribute declared wait to the phase that scheduled it ("a" counter = waits, "b" = declared ms)
    const s = this.stat("phase", ownerPhase);
    s.a++;
    s.b += declaredMs;
    if (this.traceDetail !== "off" && declaredMs > 0) {
      this.trace.push(TracePh.COMPLETE, Lane.PRESENTATION, kind, ownerPhase, now(), declaredMs, 1);
    }
  }

  public onLoopingScheduled(): void {
    this.totals.loopingScheduled++;
  }

  /** Record the completion of a wait, with the measured elapsed time. */
  public onWaitCompleted(scheduledAt: number, declaredMs: number): void {
    this.totals.waitsCompleted++;
    this.totals.waitOvershootMs += now() - scheduledAt - declaredMs;
  }

  public onLongTask(startTime: number, duration: number): void {
    this.totals.longTasks++;
    this.totals.longTaskMs += duration;
    if (this.traceDetail !== "off") {
      this.trace.push(TracePh.COMPLETE, Lane.FRAME, "LongTask", "longtask", startTime, duration);
    }
  }

  public onGc(startTime: number, duration: number): void {
    this.totals.gcCount++;
    this.totals.gcMs += duration;
    if (this.traceDetail !== "off") {
      this.trace.push(TracePh.COMPLETE, Lane.FRAME, "GC", "gc", startTime, duration);
    }
  }

  // #endregion Presentation & runtime

  // #region Simple counters (called from instrumentation sites)

  public countHit(): void {
    this.totals.hits++;
  }

  public countMessage(): void {
    this.totals.messagesQueued++;
  }

  public countRngDraw(): void {
    this.totals.rngDraws++;
  }

  public countRngReseed(): void {
    this.totals.rngReseeds++;
  }

  public countRngRestore(): void {
    this.totals.rngStateRestores++;
  }

  // #endregion
}

function defaultHeapProvider(): number | null {
  const perfMemory = (globalThis.performance as { memory?: { usedJSHeapSize?: number } } | undefined)?.memory;
  if (perfMemory?.usedJSHeapSize != null) {
    return perfMemory.usedJSHeapSize;
  }
  const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  if (typeof proc?.memoryUsage === "function") {
    return proc.memoryUsage().heapUsed;
  }
  return null;
}

/** The global profiler instance. */
export const battleProfiler = new BattleProfiler();
