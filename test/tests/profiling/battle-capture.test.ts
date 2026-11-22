/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { assertBattleCapture, type BattleCapture, battleCapture } from "#app/profiling/battle-capture";
import { diffCheckpoints } from "#app/profiling/battle-checkpoint";
import { battleProfiler } from "#app/profiling/battle-profiler";
import { startProfiling, stopProfiling } from "#app/profiling/profiler-hooks";
import { GameManager } from "#test/framework/game-manager";
import { loadCaptureSession, type ReplayResult, replayCapture } from "#test/utils/battle-replay";
import { applyScenarioOverrides, runScenarioTurns, SCENARIOS, startScenario } from "#test/utils/profiling-scenarios";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Verifies the capture → save → load → replay workflow by comparing *battle state* checkpoints,
 * not just RNG seeds. Tests share state and must run in order (one GameManager per test).
 */
describe("Battle capture and replay", () => {
  let phaserGame: Phaser.Game;
  const scenario = SCENARIOS["B-late-endless"];
  const TURNS = 3;
  let captureJson: string | undefined;
  const replays: ReplayResult[] = [];

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    stopProfiling();
  });

  it("captures session data, commands and per-turn checkpoints from a live battle", async () => {
    const game = new GameManager(phaserGame);
    await startScenario(game, scenario);
    // Recommended workflow: continue the saved run first, then capture. Loading a save does not re-apply
    // some wave-start effects (e.g. Intimidate's stat drop), so a capture only reproduces the live run
    // when the live run itself began from the same save.
    // The test reload helper only clears *player* modifiers before loading (see its TODO); clear enemy
    // modifiers too so the load matches the game's real "Continue" flow, which starts from a clean scene.
    game.scene.clearEnemyModifiers();
    await game.reload.reloadSession();

    // Use the game's own wave-start save (captured by the reload helper's `saveAll` spy),
    // exactly as `battleCapture` would read it from the save slot in the browser.
    await battleCapture.start({ session: game.reload["sessionData"] });
    expect(battleCapture.active).toBe(true);
    await runScenarioTurns(game, scenario, TURNS);
    const capture = battleCapture.stop();

    expect(capture).not.toBeNull();
    expect(capture!.turns).toHaveLength(TURNS);
    expect(capture!.session.waveIndex).toBe(scenario.wave);
    for (const turn of capture!.turns) {
      expect(turn.commands.some(c => c.battlerIndex < 2)).toBe(true);
      expect(turn.checkpoint).not.toBeNull();
    }
    expect(capture!.liveProfile?.length).toBe(TURNS);
    // No credential-like fields may leak into captures.
    expect(JSON.stringify(capture)).not.toMatch(/token|password|authorization|clientSessionId/i);

    captureJson = JSON.stringify(capture);
  }, 180_000);

  for (const run of [1, 2]) {
    it(`replay #${run} reproduces the captured battle state`, async () => {
      expect(captureJson, "capture test must run first").toBeDefined();
      const capture: unknown = JSON.parse(captureJson!);
      assertBattleCapture(capture);

      const game = new GameManager(phaserGame);
      // Runtime overrides (movesets, abilities) are not part of save data, so re-apply the scenario's.
      await loadCaptureSession(game, capture as BattleCapture, () => applyScenarioOverrides(game, scenario));
      startProfiling({}, game.scene);
      const result = await replayCapture(game, capture as BattleCapture);
      stopProfiling();

      expect(result.startDiff, `replay start differs from capture start:\n${result.startDiff}`).toBeNull();
      expect(result.turns).toHaveLength(TURNS);
      for (const t of result.turns) {
        expect(t.diffFromCapture, `turn ${t.turn} diverged from capture:\n${t.diffFromCapture}`).toBeNull();
      }
      expect(battleProfiler.turns.length).toBe(TURNS);
      replays.push(result);
    }, 180_000);
  }

  it("independent replays produce identical checkpoints", () => {
    expect(replays).toHaveLength(2);
    const [a, b] = replays;
    for (let i = 0; i < a.turns.length; i++) {
      expect(diffCheckpoints(a.turns[i].checkpoint, b.turns[i].checkpoint)).toBeNull();
    }
  });
});
