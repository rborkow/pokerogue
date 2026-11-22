/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { type BattleCheckpoint, diffCheckpoints } from "#app/profiling/battle-checkpoint";
import { BattleProfiler, battleProfiler } from "#app/profiling/battle-profiler";
import { buildChromeTrace, buildProfileSummary, formatProfileReport } from "#app/profiling/profile-report";
import { startProfiling, stopProfiling } from "#app/profiling/profiler-hooks";
import { GameManager } from "#test/framework/game-manager";
import { runScenarioTurns, SCENARIOS, startScenario } from "#test/utils/profiling-scenarios";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("BattleProfiler - timing core", () => {
  /** Drive `performance.now()` deterministically. */
  function withFakeClock(fn: (advance: (ms: number) => void) => void) {
    let t = 1000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => t);
    try {
      fn(ms => {
        t += ms;
      });
    } finally {
      spy.mockRestore();
    }
  }

  it("attributes exclusive time correctly for nested regions", () => {
    const p = new BattleProfiler();
    withFakeClock(advance => {
      p.enable();
      const outer = p.stat("phase", "Outer");
      const inner = p.stat("ability", "Inner");
      p.begin(outer);
      advance(2);
      p.begin(inner);
      advance(3);
      p.end();
      advance(5);
      p.end();
      p.disable();

      expect(outer.inclMs).toBe(10);
      expect(outer.exclMs).toBe(7);
      expect(inner.inclMs).toBe(3);
      expect(inner.exclMs).toBe(3);
      expect(p.totals.syncMs).toBe(10); // only root regions count toward total sync time
    });
  });

  it("does not double-count inclusive time for recursive regions", () => {
    const p = new BattleProfiler();
    withFakeClock(advance => {
      p.enable();
      const s = p.stat("ability", "Recursive");
      p.begin(s);
      advance(1);
      p.begin(s);
      advance(4);
      p.end();
      advance(1);
      p.end();
      p.disable();

      expect(s.count).toBe(2);
      expect(s.inclMs).toBe(6);
      expect(s.exclMs).toBe(6);
    });
  });

  it("credits secondary stats without affecting the stack", () => {
    const p = new BattleProfiler();
    withFakeClock(advance => {
      p.enable();
      const primary = p.stat("ability", "Intimidate");
      const secondary = p.stat("abilityAttr", "PostSummonAbAttr");
      p.begin(primary);
      advance(2);
      p.end(secondary);
      p.disable();
      expect(secondary.count).toBe(1);
      expect(secondary.inclMs).toBe(2);
      expect(p.totals.syncMs).toBe(2);
    });
  });

  it("ignores unbalanced end() calls", () => {
    const p = new BattleProfiler();
    p.enable();
    expect(() => p.end()).not.toThrow();
    expect(p.syncDepth).toBe(0);
    p.disable();
  });

  it("bounds the trace ring buffer", () => {
    const p = new BattleProfiler();
    p.enable({ traceCapacity: 4 });
    const s = p.stat("phase", "X");
    for (let i = 0; i < 10; i++) {
      p.begin(s);
      p.end();
    }
    expect(p.trace.length).toBe(4);
    expect(p.trace.dropped).toBe(6);
    p.disable();
  });
});

describe("BattleProfiler - battle integration", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    stopProfiling();
  });

  it("records turns, phases, abilities, modifiers, damage, hits and RNG", async () => {
    const game = new GameManager(phaserGame);
    const scenario = SCENARIOS["C-pathological"];
    await startScenario(game, scenario);
    startProfiling({ traceDetail: "phases" }, game.scene);

    await runScenarioTurns(game, scenario, 1);
    stopProfiling();

    const summary = buildProfileSummary({ scenario: scenario.id });
    expect(summary.turns.length).toBeGreaterThanOrEqual(1);
    const turn = summary.turns[0];
    expect(turn.context?.waveIndex).toBe(scenario.wave);
    expect(turn.phaseCounts.MoveEffectPhase).toBeGreaterThan(1);
    expect(turn.counts.hits).toBeGreaterThan(5); // Population Bomb with Skill Link (accuracy is rolled per strike)
    expect(turn.counts.abilityEvaluations).toBeGreaterThan(0);
    expect(turn.counts.abilityActivations).toBeLessThanOrEqual(turn.counts.abilityAttrsConsidered);
    expect(turn.counts.modifierApplyCalls).toBeGreaterThan(0);
    expect(turn.counts.modifiersTriggered).toBeLessThanOrEqual(turn.counts.modifiersMatched);
    expect(turn.counts.damageCalcs).toBeGreaterThan(0);
    expect(turn.counts.rngDraws).toBeGreaterThan(0);
    expect(turn.breakdown.syncWorkMs).toBeGreaterThan(0);
    expect(turn.breakdown.effectEvaluationMs).toBeLessThanOrEqual(turn.breakdown.syncWorkMs + 1e-6);

    const trace = buildChromeTrace({ scenario: scenario.id });
    expect(trace.traceEvents.some(e => e.ph === "X" && e.cat === "phase")).toBe(true);
    expect(trace.traceEvents.some(e => e.ph === "X" && e.cat === "turn")).toBe(true);
    // Must be valid JSON
    expect(() => JSON.parse(JSON.stringify(trace))).not.toThrow();

    const report = formatProfileReport(summary);
    expect(report).toContain("Turn #0");
    console.log(report);
  }, 120_000);

  it("removes all hooks when disabled", async () => {
    const game = new GameManager(phaserGame);
    const originalAddEvent = game.scene.time.addEvent;
    const originalTweenAdd = game.scene.tweens.add;
    startProfiling({}, game.scene);
    expect(game.scene.time.addEvent).not.toBe(originalAddEvent);
    expect(Object.hasOwn(Phaser.Math.RND, "rnd")).toBe(true);
    stopProfiling();
    expect(game.scene.time.addEvent).toBe(originalAddEvent);
    expect(game.scene.tweens.add).toBe(originalTweenAdd);
    expect(Object.hasOwn(Phaser.Math.RND, "rnd")).toBe(false);
    expect(battleProfiler.enabled).toBe(false);
  });
});

describe("BattleProfiler - gameplay invariance", () => {
  let phaserGame: Phaser.Game;
  /** Checkpoints from the profiler-off baseline run, keyed by scenario. */
  const baselines = new Map<string, BattleCheckpoint[]>();
  const TURNS = 3;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    stopProfiling();
  });

  // The test harness allows one GameManager per test, so each comparison is split into a
  // baseline test (profiler off) followed by a profiled test that compares against it.
  for (const id of ["B-late-endless", "C-pathological"] as const) {
    it(`${id}: baseline run with the profiler off`, async () => {
      const scenario = SCENARIOS[id];
      const game = new GameManager(phaserGame);
      await startScenario(game, scenario);
      const off = await runScenarioTurns(game, scenario, TURNS);
      expect(off.length).toBeGreaterThan(0);
      baselines.set(id, off);
    }, 180_000);

    it(`${id}: battle state and RNG are identical with the profiler on (full detail)`, async () => {
      const scenario = SCENARIOS[id];
      const off = baselines.get(id);
      expect(off, "baseline test must run first").toBeDefined();

      const game = new GameManager(phaserGame);
      await startScenario(game, scenario);
      startProfiling({ traceDetail: "full" }, game.scene);
      const on = await runScenarioTurns(game, scenario, TURNS);
      stopProfiling();

      expect(on.length).toBe(off!.length);
      for (let i = 0; i < off!.length; i++) {
        const diff = diffCheckpoints(off![i], on[i]);
        expect(diff, `turn ${i} diverged:\n${diff}`).toBeNull();
        expect(on[i].rngState).toBe(off![i].rngState);
      }
      // Sanity: the profiler actually observed the turns it was compared over.
      expect(battleProfiler.turns.length).toBeGreaterThanOrEqual(on.length);
    }, 180_000);
  }
});
