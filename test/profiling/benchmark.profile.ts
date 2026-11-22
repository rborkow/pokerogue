/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Headless battle benchmark: runs scenarios A (early), B (late Endless) and C (pathological)
 * several times with the profiler off and on, then writes medians, variability and event counts.
 *
 * Usage: `pnpm profile:battle`
 * Environment variables:
 * - `PROFILE_RUNS` (default 5): measured runs per scenario and mode (plus one discarded warm-up run)
 * - `PROFILE_TURNS` (default 3): turns per run
 * - `PROFILE_SCENARIOS` (default `A-early,B-late-endless,C-pathological`)
 * - `PROFILE_OUT` (default `temp/profiles/<timestamp>`): output directory
 * - `PROFILE_KEEP_CONSOLE=1`: keep `console.log`/`console.debug` output. By default they are silenced, because
 *   production builds strip them (`manualPureFunctions` in `vite.config.ts`) and the test console mock is costly.
 *
 * Headless runs measure **simulation** cost only: the test harness resolves tweens immediately and
 * clamps timers, so presentation waits are reported as *declared* (estimated) durations. Measure
 * presentation in a real browser (see `docs/battle-profiling.md`).
 */

import { battleProfiler } from "#app/profiling/battle-profiler";
import { buildChromeTrace, buildProfileSummary, type TurnSummary } from "#app/profiling/profile-report";
import { startProfiling, stopProfiling } from "#app/profiling/profiler-hooks";
import { GameManager } from "#test/framework/game-manager";
import { runScenarioTurns, SCENARIOS, type ScenarioId, startScenario } from "#test/utils/profiling-scenarios";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Phaser from "phaser";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const RUNS = Number(process.env.PROFILE_RUNS ?? 5);
const TURNS = Number(process.env.PROFILE_TURNS ?? 3);
const SCENARIO_IDS = (process.env.PROFILE_SCENARIOS ?? "A-early,B-late-endless,C-pathological")
  .split(",")
  .map(s => s.trim()) as ScenarioId[];
const KEEP_CONSOLE = process.env.PROFILE_KEEP_CONSOLE === "1";
const OUT = process.env.PROFILE_OUT ?? join("temp", "profiles", new Date().toISOString().replace(/[:.]/g, "-"));

interface RunResult {
  scenario: ScenarioId;
  run: number;
  profiled: boolean;
  turnsPlayed: number;
  /** Process CPU time (user+system) per turn, measured around the turn loop. Includes harness work. */
  cpuMsPerTurn: number;
  turns: TurnSummary[];
}

const results: RunResult[] = [];
let overhead: Record<string, unknown> | null = null;
let hooksPerCall: Record<string, number> = {};

function sumCount(category: Parameters<typeof battleProfiler.allStats>[0]): number {
  return battleProfiler.allStats(category).reduce((a, s) => a + s.count, 0);
}

function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

function median(xs: number[]): number {
  if (xs.length === 0) {
    return Number.NaN;
  }
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const med = median(s);
  const mad = median(s.map(x => Math.abs(x - med)));
  return {
    median: round(med),
    min: round(s[0]),
    max: round(s.at(-1)!),
    /** Median absolute deviation relative to the median. */
    relMad: med ? round(mad / med, 3) : 0,
    n: s.length,
  };
}

function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
}

describe("Battle profiling benchmark", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    mkdirSync(OUT, { recursive: true });
    if (!KEEP_CONSOLE) {
      // Match production, where these calls are removed at build time.
      console.log = () => {};
      console.debug = () => {};
    }
  });

  afterEach(() => {
    stopProfiling();
  });

  for (const id of SCENARIO_IDS) {
    // Run 0 is a discarded warm-up; off/on runs are interleaved to reduce drift.
    for (let run = 0; run <= RUNS; run++) {
      for (const profiled of [false, true]) {
        it(`${id} run ${run}${run === 0 ? " (warm-up)" : ""} profiler ${profiled ? "on" : "off"}`, async () => {
          const scenario = SCENARIOS[id];
          const game = new GameManager(phaserGame);
          await startScenario(game, scenario);
          if (profiled) {
            startProfiling({ traceDetail: run === RUNS ? "full" : "phases" }, game.scene);
          }
          const before = cpuMs();
          const checkpoints = await runScenarioTurns(game, scenario, TURNS);
          const cpu = cpuMs() - before;
          stopProfiling();
          expect(checkpoints.length).toBeGreaterThan(0);

          const summary = profiled ? buildProfileSummary({ scenario: id, run }) : null;
          if (run > 0) {
            results.push({
              scenario: id,
              run,
              profiled,
              turnsPlayed: checkpoints.length,
              cpuMsPerTurn: cpu / checkpoints.length,
              turns: summary?.turns ?? [],
            });
          }
          if (profiled && run === RUNS) {
            writeFileSync(join(OUT, `${id}.summary.json`), JSON.stringify(summary, null, 2));
            writeFileSync(join(OUT, `${id}.trace.json`), JSON.stringify(buildChromeTrace({ scenario: id, run })));
          }
          battleProfiler.reset();
        });
      }
    }
  }

  it("instrumentation overhead on effect-heavy synchronous code (A/B, interleaved)", async () => {
    // Worst case: simulated damage calculations are 100% instrumented code (abilities, modifiers,
    // move attributes, damage). Compare wall time per call with the profiler off vs. on.
    const scenario = SCENARIOS["B-late-endless"];
    const game = new GameManager(phaserGame);
    await startScenario(game, scenario);
    const [attacker] = game.scene.getPlayerField();
    const [defender] = game.scene.getEnemyField();
    const move = attacker.getMoveset()[0].getMove();
    const CALLS = Number(process.env.PROFILE_OVERHEAD_CALLS ?? 2000);
    const runBatch = () => {
      const t0 = performance.now();
      for (let i = 0; i < CALLS; i++) {
        defender.getAttackDamage({ source: attacker, move, simulated: true });
      }
      return ((performance.now() - t0) / CALLS) * 1000; // µs per call
    };
    runBatch(); // warm-up
    const off: number[] = [];
    const on: number[] = [];
    for (let rep = 0; rep < 7; rep++) {
      off.push(runBatch());
      startProfiling({ traceDetail: "phases" }, game.scene);
      on.push(runBatch());
      const s = battleProfiler.stat("damage", "getAttackDamage");
      hooksPerCall = {
        abilityEvaluations: sumCount("ability") / CALLS,
        modifierApplyCalls: sumCount("modifier") / CALLS,
        moveAttrCalls: sumCount("moveAttr") / CALLS,
        modifierLookups: sumCount("modifierLookup") / CALLS,
        damageCalcs: s.count / CALLS,
      };
      stopProfiling();
    }
    overhead = { callsPerBatch: CALLS, usPerCallOff: stats(off), usPerCallOn: stats(on), hooksPerCall };
    expect(on.length).toBe(7);
  });

  afterAll(() => {
    const report = buildBenchmarkReport();
    writeFileSync(join(OUT, "benchmark.json"), JSON.stringify(report.json, null, 2));
    writeFileSync(join(OUT, "benchmark.md"), report.markdown);
    console.info(report.markdown);
    console.info(`\nBenchmark outputs written to ${OUT}`);
  });
});

function buildBenchmarkReport() {
  const json: Record<string, unknown> = {
    meta: { runs: RUNS, turnsPerRun: TURNS, node: process.version, createdAt: new Date().toISOString() },
    scenarios: {},
  };
  const md: string[] = [
    "# Headless battle benchmark",
    "",
    `${RUNS} measured runs per scenario and mode (one warm-up discarded), ${TURNS} turns per run, Node ${process.version}.`,
    `console.log/debug: ${KEEP_CONSOLE ? "kept (dev-like)" : "silenced (production-like; production builds strip them)"}.`,
    "Values are medians across runs of each run's per-turn mean; `relMAD` is median absolute deviation / median.",
    "Sync and effect times are **measured** by the profiler; declared waits are **estimates** from declared",
    "tween/timer durations (headless runs never actually wait).",
    "",
  ];

  for (const id of SCENARIO_IDS) {
    const on = results.filter(r => r.scenario === id && r.profiled);
    const off = results.filter(r => r.scenario === id && !r.profiled);
    const perRun = (f: (t: TurnSummary) => number) => on.map(r => mean(r.turns.map(f)));
    const metrics = {
      syncWorkMs: stats(perRun(t => t.breakdown.syncWorkMs)),
      effectEvaluationMs: stats(perRun(t => t.breakdown.effectEvaluationMs)),
      otherPhaseCodeMs: stats(perRun(t => t.breakdown.otherPhaseCodeMs)),
      declaredWaitMs: stats(perRun(t => t.breakdown.declaredWaitMs)),
      declaredFixedWaitMs: stats(perRun(t => t.breakdown.declaredFixedWaitMs)),
      phaseTransitions: stats(perRun(t => t.counts.phaseTransitions)),
      messagesQueued: stats(perRun(t => t.counts.messagesQueued)),
      hits: stats(perRun(t => t.counts.hits)),
      abilityEvaluations: stats(perRun(t => t.counts.abilityEvaluations)),
      abilitySimulatedCalls: stats(perRun(t => t.counts.abilitySimulatedCalls)),
      abilityActivations: stats(perRun(t => t.counts.abilityActivations)),
      modifierApplyCalls: stats(perRun(t => t.counts.modifierApplyCalls)),
      modifiersScanned: stats(perRun(t => t.counts.modifiersScanned)),
      modifiersTriggered: stats(perRun(t => t.counts.modifiersTriggered)),
      damageCalcs: stats(perRun(t => t.counts.damageCalcs)),
      rngDraws: stats(perRun(t => t.counts.rngDraws)),
      timersScheduled: stats(perRun(t => t.counts.timersScheduled)),
      tweensScheduled: stats(perRun(t => t.counts.tweensScheduled)),
    };
    const cpuOff = stats(off.map(r => r.cpuMsPerTurn));
    const cpuOn = stats(on.map(r => r.cpuMsPerTurn));
    const overheadPct = cpuOff.median ? round(((cpuOn.median - cpuOff.median) / cpuOff.median) * 100, 1) : null;

    // Aggregate top phases / abilities / modifiers across all profiled runs.
    const agg = (pick: (t: TurnSummary) => { name: string; exclMs: number; inclMs: number; count: number }[]) => {
      const m = new Map<string, { ms: number; count: number }>();
      for (const r of on) {
        for (const t of r.turns) {
          for (const s of pick(t)) {
            const e = m.get(s.name) ?? { ms: 0, count: 0 };
            e.ms += s.inclMs || s.exclMs;
            e.count += s.count;
            m.set(s.name, e);
          }
        }
      }
      const totalTurns = on.reduce((a, r) => a + r.turns.length, 0) || 1;
      return [...m.entries()]
        .map(([name, e]) => ({
          name,
          msPerTurn: round(e.ms / totalTurns, 3),
          countPerTurn: round(e.count / totalTurns, 1),
        }))
        .sort((a, b) => b.msPerTurn - a.msPerTurn)
        .slice(0, 8);
    };
    const topPhases = agg(t => t.topPhasesBySync.map(s => ({ ...s, inclMs: 0 })));
    const topAbilities = agg(t => t.topAbilities);
    const topModifiers = agg(t => t.topModifiers);
    const ctx = on[0]?.turns[0]?.context ?? null;

    (json.scenarios as Record<string, unknown>)[id] = {
      description: SCENARIOS[id].description,
      context: ctx,
      metrics,
      cpuMsPerTurn: { profilerOff: cpuOff, profilerOn: cpuOn, overheadPct },
      topPhases,
      topAbilities,
      topModifiers,
    };

    md.push(`## ${id}`, "", SCENARIOS[id].description, "");
    if (ctx) {
      md.push(
        `Run state: ${ctx.playerModifiers} player modifiers (${ctx.playerModifierStacks} stacks), ${ctx.enemyModifiers} enemy modifiers (${ctx.enemyModifierStacks} stacks), ${ctx.fieldPokemon} on field, ${ctx.fieldPassives} passives.`,
        "",
      );
    }
    md.push("| Metric (per turn) | Median | Min | Max | relMAD |", "|---|---:|---:|---:|---:|");
    for (const [k, v] of Object.entries(metrics)) {
      md.push(`| ${k} | ${v.median} | ${v.min} | ${v.max} | ${v.relMad} |`);
    }
    md.push(
      `| process CPU ms, profiler off | ${cpuOff.median} | ${cpuOff.min} | ${cpuOff.max} | ${cpuOff.relMad} |`,
      `| process CPU ms, profiler on | ${cpuOn.median} | ${cpuOn.min} | ${cpuOn.max} | ${cpuOn.relMad} |`,
      "",
      `Process CPU (includes GC, jsdom and harness polling; too noisy to estimate overhead): ${overheadPct ?? "n/a"}% difference.`,
      "",
      "Top phases by exclusive sync time: "
        + topPhases.map(p => `${p.name} ${p.msPerTurn} ms (×${p.countPerTurn})`).join(", "),
      "",
      "Top abilities by inclusive time: "
        + topAbilities.map(p => `${p.name} ${p.msPerTurn} ms (×${p.countPerTurn})`).join(", "),
      "",
      "Top modifiers by inclusive time: "
        + topModifiers.map(p => `${p.name} ${p.msPerTurn} ms (×${p.countPerTurn})`).join(", "),
      "",
    );
  }
  if (overhead !== null) {
    const o = overhead as {
      callsPerBatch: number;
      usPerCallOff: ReturnType<typeof stats>;
      usPerCallOn: ReturnType<typeof stats>;
      hooksPerCall: Record<string, number>;
    };
    const pct = round(((o.usPerCallOn.median - o.usPerCallOff.median) / o.usPerCallOff.median) * 100, 1);
    json.overhead = { ...o, overheadPct: pct };
    md.push(
      "## Instrumentation overhead",
      "",
      `A/B on simulated damage calculations (scenario B attacker/defender), ${o.callsPerBatch} calls per batch, 7 interleaved batches per mode.`,
      "This path is entirely instrumented code, so it is a worst case; whole turns contain uninstrumented work too.",
      "",
      "| Mode | Median µs/call | Min | Max | relMAD |",
      "|---|---:|---:|---:|---:|",
      `| profiler off | ${o.usPerCallOff.median} | ${o.usPerCallOff.min} | ${o.usPerCallOff.max} | ${o.usPerCallOff.relMad} |`,
      `| profiler on | ${o.usPerCallOn.median} | ${o.usPerCallOn.min} | ${o.usPerCallOn.max} | ${o.usPerCallOn.relMad} |`,
      "",
      `Overhead: **${pct}%** (instrumented events per call: ${Object.entries(o.hooksPerCall)
        .map(([k, v]) => `${k} ${round(v, 1)}`)
        .join(", ")}).`,
      "",
    );
  }
  return { json, markdown: md.join("\n") };
}
