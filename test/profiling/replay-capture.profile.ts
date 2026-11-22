/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Replays a browser-recorded battle capture headlessly, several times, with the profiler on.
 *
 * Usage: `POKEROGUE_CAPTURE=path/to/capture.json pnpm profile:replay`
 * Environment variables:
 * - `POKEROGUE_CAPTURE` (required): capture JSON written by `pokerogueProfiler.capture.download()`
 * - `PROFILE_RUNS` (default 5): number of replays
 * - `PROFILE_OUT` (default `temp/profiles/replay-<timestamp>`): output directory
 *
 * Each replay is checked against the capture's recorded checkpoints, and replays are checked against
 * each other, so the measurement is only trusted when the battle state is reproduced.
 */

import { assertBattleCapture, type BattleCapture } from "#app/profiling/battle-capture";
import { diffCheckpoints } from "#app/profiling/battle-checkpoint";
import {
  buildChromeTrace,
  buildProfileSummary,
  formatProfileReport,
  type TurnSummary,
} from "#app/profiling/profile-report";
import { startProfiling, stopProfiling } from "#app/profiling/profiler-hooks";
import { GameManager } from "#test/framework/game-manager";
import { loadCaptureSession, type ReplayResult, replayCapture } from "#test/utils/battle-replay";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Phaser from "phaser";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const CAPTURE_PATH = process.env.POKEROGUE_CAPTURE;
const RUNS = Number(process.env.PROFILE_RUNS ?? 5);
const OUT =
  process.env.PROFILE_OUT ?? join("temp", "profiles", `replay-${new Date().toISOString().replace(/[:.]/g, "-")}`);

describe.skipIf(!CAPTURE_PATH)("Replay a captured battle", () => {
  let phaserGame: Phaser.Game;
  let capture: BattleCapture;
  const replays: { result: ReplayResult; turns: TurnSummary[] }[] = [];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    const parsed: unknown = JSON.parse(readFileSync(CAPTURE_PATH!, "utf8"));
    assertBattleCapture(parsed);
    capture = parsed;
    mkdirSync(OUT, { recursive: true });
    if (capture.sessionSource === "liveSnapshot") {
      console.warn("Capture was made from a live snapshot, not a save; replays may not match the live run.");
    }
  });

  afterEach(() => {
    stopProfiling();
  });

  for (let run = 1; run <= RUNS; run++) {
    it(`replay ${run}`, async () => {
      const game = new GameManager(phaserGame);
      await loadCaptureSession(game, capture);
      startProfiling({ traceDetail: run === RUNS ? "full" : "phases" }, game.scene);
      const result = await replayCapture(game, capture);
      stopProfiling();
      const summary = buildProfileSummary({ scenario: `replay of ${CAPTURE_PATH}`, run });
      replays.push({ result, turns: summary.turns });
      if (run === RUNS) {
        writeFileSync(join(OUT, "replay.summary.json"), JSON.stringify(summary, null, 2));
        writeFileSync(join(OUT, "replay.trace.json"), JSON.stringify(buildChromeTrace({ capture: CAPTURE_PATH })));
        writeFileSync(join(OUT, "replay.report.txt"), formatProfileReport(summary));
      }
      expect(result.turns.length).toBe(capture.turns.length);
    });
  }

  afterAll(() => {
    if (replays.length === 0) {
      return;
    }
    const lines: string[] = [`Replay of ${CAPTURE_PATH} (${replays.length} runs, ${capture.turns.length} turns)`];
    const first = replays[0].result;
    lines.push(
      first.startMatchesCapture
        ? "Start state matches the capture."
        : `Start state differs from the capture (live and replay will diverge):\n${first.startDiff}`,
    );
    const replayDeterministic = replays.every(r =>
      r.result.turns.every((t, i) => diffCheckpoints(t.checkpoint, first.turns[i].checkpoint) === null),
    );
    lines.push(`Replays identical to each other: ${replayDeterministic ? "yes" : "NO"}`);
    const matchesCapture = first.turns.map(t => t.diffFromCapture);
    lines.push(
      `Turns matching the live capture: ${matchesCapture.filter(d => d === null).length}/${matchesCapture.length}`,
    );
    for (let i = 0; i < capture.turns.length; i++) {
      const sync = replays.map(r => r.turns[i]?.breakdown.syncWorkMs ?? Number.NaN).sort((a, b) => a - b);
      const med = sync[sync.length >> 1];
      lines.push(
        `turn ${i + 1}: median sync work ${med?.toFixed(2)} ms (min ${sync[0]?.toFixed(2)}, max ${sync.at(-1)?.toFixed(2)})`,
      );
    }
    const text = lines.join("\n");
    writeFileSync(join(OUT, "replay-verification.txt"), text);
    console.info(text);
    console.info(`Outputs written to ${OUT}`);
  });
});
