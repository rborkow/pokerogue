/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Writes battle-state checkpoint hashes for the profiling scenarios.
 *
 * Used to verify that an experimental change (e.g. a presentation timing patch) does not alter battle
 * outcomes: run once on the baseline and once with the change applied, then compare the two files.
 *
 * Usage: `PROFILE_OUT=temp/checkpoints/baseline pnpm vitest run --config test/profiling/profiling.config.ts test/profiling/checkpoints.profile.ts`
 * - `PROFILE_TURNS` (default 3), `PROFILE_SCENARIOS` (default `B-late-endless,C-pathological`)
 */

import { GameManager } from "#test/framework/game-manager";
import { runScenarioTurns, SCENARIOS, type ScenarioId, startScenario } from "#test/utils/profiling-scenarios";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Phaser from "phaser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TURNS = Number(process.env.PROFILE_TURNS ?? 3);
const SCENARIO_IDS = (process.env.PROFILE_SCENARIOS ?? "B-late-endless,C-pathological").split(",") as ScenarioId[];
const OUT = process.env.PROFILE_OUT ?? join("temp", "checkpoints", "latest");

describe("Scenario checkpoints", () => {
  let phaserGame: Phaser.Game;
  const hashes: Record<string, { turn: number; hash: string; rng: string }[]> = {};

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  for (const id of SCENARIO_IDS) {
    it(id, async () => {
      const game = new GameManager(phaserGame);
      await startScenario(game, SCENARIOS[id]);
      const checkpoints = await runScenarioTurns(game, SCENARIOS[id], TURNS);
      expect(checkpoints.length).toBeGreaterThan(0);
      hashes[id] = checkpoints.map(c => ({ turn: c.turn, hash: c.hash, rng: c.rngState }));
    });
  }

  afterAll(() => {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "checkpoints.json"), JSON.stringify(hashes, null, 2));
  });
});
