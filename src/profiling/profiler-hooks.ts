/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Installs the profiler's non-invasive runtime hooks: RNG counting, presentation-wait tracking
 * (timers and tweens), game-loop frame timing, long-task / GC observers and the per-turn
 * run-state context provider.
 *
 * Every hook delegates to the original implementation with identical arguments and `this`,
 * so game behaviour (including RNG consumption and callback ordering) is unchanged.
 * All hooks are removed by {@linkcode battleProfiler.disable}.
 * @module
 */

import type { BattleScene } from "#app/battle-scene";
import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { battleProfiler, type ProfilerOptions, type TurnContext } from "#app/profiling/battle-profiler";
import { FixedInt } from "#utils/common";
import Phaser from "phaser";

type AnyFn = (...args: any[]) => any;

/** Resolve a declared duration the same way `initGameSpeed` does, without mutating anything. */
function effectiveMs(value: unknown): { ms: number; fixed: boolean } {
  if (value instanceof FixedInt) {
    return { ms: value.value, fixed: true };
  }
  if (typeof value === "number" && value > 0) {
    return { ms: Math.ceil(value / (settings.general.gameSpeed || 1)), fixed: false };
  }
  return { ms: 0, fixed: false };
}

function currentPhaseName(): string {
  return globalScene?.phaseManager?.getCurrentPhase?.()?.phaseName ?? "NoPhase";
}

interface TweenLike {
  delay?: unknown;
  duration?: unknown;
  hold?: unknown;
  repeat?: number;
  repeatDelay?: unknown;
  yoyo?: boolean;
  loop?: number;
  tweens?: TweenLike[];
  onComplete?: AnyFn;
}

/** Estimate the total duration of a tween (or tween chain) config. Returns `null` for infinite tweens. */
function tweenDeclared(cfg: TweenLike): { ms: number; fixedMs: number } | null {
  if (cfg.repeat === -1 || cfg.loop === -1) {
    return null;
  }
  let ms = 0;
  let fixedMs = 0;
  const add = (v: unknown, mult = 1) => {
    const e = effectiveMs(v);
    ms += e.ms * mult;
    if (e.fixed) {
      fixedMs += e.ms * mult;
    }
  };
  const reps = 1 + Math.max(0, cfg.repeat ?? 0);
  add(cfg.delay);
  add(cfg.duration, reps * (cfg.yoyo ? 2 : 1));
  add(cfg.hold, reps);
  add(cfg.repeatDelay, reps - 1);
  if (Array.isArray(cfg.tweens)) {
    for (const t of cfg.tweens) {
      const inner = tweenDeclared(t);
      if (inner === null) {
        return null;
      }
      ms += inner.ms;
      fixedMs += inner.fixedMs;
    }
  }
  return { ms, fixedMs };
}

/** Wrap a completion callback so its synchronous work is attributed to the scheduling phase. */
function wrapContinuation(
  cb: AnyFn,
  owner: string,
  scheduledAt: number,
  declaredMs: number,
  isFinal: () => boolean,
): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    if (!battleProfiler.enabled) {
      return cb.apply(this, args);
    }
    battleProfiler.begin(battleProfiler.stat("continuation", owner));
    try {
      return cb.apply(this, args);
    } finally {
      battleProfiler.end();
      if (isFinal()) {
        battleProfiler.onWaitCompleted(scheduledAt, declaredMs);
      }
    }
  };
}

function installPresentationHooks(scene: BattleScene): void {
  const time = scene.time;
  const origAddEvent = time.addEvent;
  time.addEvent = function (this: Phaser.Time.Clock, config) {
    if (!battleProfiler.enabled || config instanceof Phaser.Time.TimerEvent) {
      return origAddEvent.call(this, config);
    }
    const owner = currentPhaseName();
    const looping = config.loop === true || config.repeat === -1;
    if (looping) {
      battleProfiler.onLoopingScheduled();
      return origAddEvent.call(this, config);
    }
    const reps = 1 + Math.max(0, config.repeat ?? 0);
    const e = effectiveMs(config.delay);
    const declared = e.ms * reps;
    const scheduledAt = battleProfiler.now();
    battleProfiler.onWaitScheduled("timer", owner, declared, e.fixed ? declared : 0);
    let event: Phaser.Time.TimerEvent | undefined;
    if (typeof config.callback === "function") {
      config.callback = wrapContinuation(
        config.callback as AnyFn,
        owner,
        scheduledAt,
        declared,
        () => event === undefined || event.repeatCount === 0,
      );
    }
    event = origAddEvent.call(this, config);
    return event;
  } satisfies typeof origAddEvent;

  const tweens = scene.tweens;
  const wrapTweenMethod = <K extends "add" | "chain" | "addCounter">(key: K) => {
    const orig = tweens[key] as AnyFn;
    (tweens as unknown as Record<K, AnyFn>)[key] = function (this: unknown, config: TweenLike) {
      if (!battleProfiler.enabled || config == null || typeof config !== "object" || Array.isArray(config)) {
        return orig.call(this, config);
      }
      const declared = tweenDeclared(config);
      if (declared === null) {
        battleProfiler.onLoopingScheduled();
        return orig.call(this, config);
      }
      const owner = currentPhaseName();
      const scheduledAt = battleProfiler.now();
      battleProfiler.onWaitScheduled("tween", owner, declared.ms, declared.fixedMs);
      if (typeof config.onComplete === "function") {
        config.onComplete = wrapContinuation(config.onComplete, owner, scheduledAt, declared.ms, () => true);
      }
      return orig.call(this, config);
    };
    battleProfiler.onDisable(() => {
      (tweens as unknown as Record<K, AnyFn>)[key] = orig;
    });
  };

  wrapTweenMethod("add");
  wrapTweenMethod("chain");
  wrapTweenMethod("addCounter");
  battleProfiler.onDisable(() => {
    time.addEvent = origAddEvent;
  });
}

function installFrameHooks(scene: BattleScene): void {
  const events = scene.game?.events;
  if (events == null) {
    return;
  }
  const onPre = () => battleProfiler.onFrameStart();
  const onPost = () => battleProfiler.onFrameEnd();
  events.on(Phaser.Core.Events.PRE_STEP, onPre);
  events.on(Phaser.Core.Events.POST_RENDER, onPost);
  battleProfiler.onDisable(() => {
    events.off(Phaser.Core.Events.PRE_STEP, onPre);
    events.off(Phaser.Core.Events.POST_RENDER, onPost);
  });
}

/**
 * Count raw RNG draws and reseeds on Phaser's global generator.
 * `rnd()` is the underlying generator step that every other method calls, so counting it measures
 * exact RNG consumption without double counting. Wrappers are installed as own properties and removed
 * on disable, restoring the prototype methods.
 */
function installRngHooks(): void {
  const rng = Phaser.Math.RND as Phaser.Math.RandomDataGenerator & Record<string, AnyFn>;
  const proto = Object.getPrototypeOf(rng) as Record<string, AnyFn>;
  const wrap = (key: string, fn: (orig: AnyFn) => AnyFn) => {
    const hadOwn = Object.hasOwn(rng, key);
    const prev = rng[key];
    rng[key] = fn(prev ?? proto[key]);
    battleProfiler.onDisable(() => {
      if (hadOwn) {
        rng[key] = prev;
      } else {
        delete rng[key];
      }
    });
  };
  wrap(
    "rnd",
    orig =>
      function (this: unknown) {
        battleProfiler.countRngDraw();
        return orig.call(this);
      },
  );
  wrap(
    "sow",
    orig =>
      function (this: unknown, seeds: unknown) {
        battleProfiler.countRngReseed();
        return orig.call(this, seeds);
      },
  );
  wrap(
    "state",
    orig =>
      function (this: unknown, ...args: unknown[]) {
        if (args.length > 0 && args[0] != null) {
          battleProfiler.countRngRestore();
        }
        return orig.apply(this, args);
      },
  );
}

function installObservers(): void {
  const PO = globalThis.PerformanceObserver;
  const supported: readonly string[] = PO?.supportedEntryTypes ?? [];
  const observe = (type: string, cb: (e: PerformanceEntry) => void) => {
    if (!supported.includes(type)) {
      return;
    }
    try {
      const obs = new PO(list => {
        if (!battleProfiler.enabled) {
          return;
        }
        for (const entry of list.getEntries()) {
          cb(entry);
        }
      });
      obs.observe({ type, buffered: false });
      battleProfiler.onDisable(() => obs.disconnect());
    } catch {
      // Observer types are best-effort.
    }
  };
  observe("longtask", e => battleProfiler.onLongTask(e.startTime, e.duration));
  observe("gc", e => battleProfiler.onGc(e.startTime, e.duration));
}

/** Snapshot the run state that is expected to influence per-turn cost. */
export function captureTurnContext(scene: BattleScene = globalScene): TurnContext | null {
  if (scene?.currentBattle == null) {
    return null;
  }
  const sumStacks = (mods: readonly { stackCount: number }[], heldOnly: boolean) => {
    let total = 0;
    for (const m of mods) {
      if (!heldOnly || "pokemonId" in m) {
        total += m.stackCount;
      }
    }
    return total;
  };
  const field = scene.getField(true);
  // Bracket access avoids routing through `findModifiers`, which would itself be counted as a lookup.
  const enemyModifiers = scene["enemyModifiers"];
  return {
    waveIndex: scene.currentBattle.waveIndex,
    turn: scene.currentBattle.turn,
    gameMode: scene.gameMode?.modeId == null ? "unknown" : String(scene.gameMode.modeId),
    gameSpeed: settings.general.gameSpeed,
    playerModifiers: scene.modifiers.length,
    playerModifierStacks: sumStacks(scene.modifiers, false),
    enemyModifiers: enemyModifiers.length,
    enemyModifierStacks: sumStacks(enemyModifiers, false),
    playerHeldItemStacks: sumStacks(scene.modifiers, true),
    enemyHeldItemStacks: sumStacks(enemyModifiers, true),
    fieldPokemon: field.length,
    fieldPassives: field.filter(p => p.hasPassive()).length,
  };
}

export interface StartProfilingOptions extends ProfilerOptions {
  /** Track timers/tweens (presentation waits). Default `true`. */
  presentation?: boolean;
  /** Track game-loop frame timing. Default `true`. */
  frames?: boolean;
  /** Count RNG draws. Default `true`. */
  rng?: boolean;
}

/**
 * Enable the profiler and install all runtime hooks on the given scene.
 * @param scene - The battle scene; defaults to the global scene
 */
export function startProfiling(opts: StartProfilingOptions = {}, scene: BattleScene = globalScene): void {
  if (battleProfiler.enabled) {
    battleProfiler.disable();
  }
  battleProfiler.enable(opts);
  if (!battleProfiler.enabled) {
    return;
  }
  battleProfiler.contextProvider = () => captureTurnContext(scene);
  if (opts.rng !== false) {
    installRngHooks();
  }
  if (scene != null) {
    if (opts.presentation !== false) {
      installPresentationHooks(scene);
    }
    if (opts.frames !== false) {
      installFrameHooks(scene);
    }
  }
  installObservers();
}

/** Disable the profiler and remove all hooks. Collected data is kept for export. */
export function stopProfiling(): void {
  battleProfiler.disable();
}
