/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Headless replay of a {@linkcode BattleCapture} using the existing session save/load path.
 */

import type { BattleCapture, CapturedCommand } from "#app/profiling/battle-capture";
import { type BattleCheckpoint, captureBattleCheckpoint, diffCheckpoints } from "#app/profiling/battle-checkpoint";
import { allMoves } from "#data/data-lists";
import { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import type { GameManager } from "#test/framework/game-manager";

export interface ReplayTurnResult {
  turn: number;
  checkpoint: BattleCheckpoint;
  /** Difference against the capture's recorded checkpoint (`null` = identical, `undefined` = none recorded). */
  diffFromCapture: string | null | undefined;
}

export interface ReplayResult {
  startCheckpoint: BattleCheckpoint;
  /** Whether the replay began from the same state as the live capture. */
  startMatchesCapture: boolean;
  startDiff: string | null;
  turns: ReplayTurnResult[];
}

/**
 * Load a capture's session into a fresh {@linkcode GameManager} via the reload helper
 * (the same code path the game uses to continue a saved run).
 * @param beforeLoad - Called after the bootstrap battle and before the session is loaded
 */
export async function loadCaptureSession(
  game: GameManager,
  capture: BattleCapture,
  beforeLoad?: () => void,
): Promise<void> {
  // The reload helper needs a running battle to tear down; start a trivial one first.
  await game.classicMode.startBattle(SpeciesId.MAGIKARP);
  // The bootstrap battle normalizes IVs/natures/shininess through runtime overrides, which would
  // otherwise alter the loaded party's stats. Clear them so the save's own values are used.
  game.override.playerIVs(null).enemyIVs(null).nature(null).enemyNature(null).shiny(null).enemyShiny(null);
  // Runtime-only configuration (e.g. test overrides) must be applied after the bootstrap battle.
  beforeLoad?.();
  const session = game.scene.gameData.parseSessionData(JSON.stringify(capture.session));
  game.reload["sessionData"] = session;
  await game.reload.reloadSession();
}

function queuePlayerCommand(game: GameManager, cmd: CapturedCommand): void {
  if (cmd.skip || cmd.battlerIndex >= BattlerIndex.ENEMY) {
    return;
  }
  const battlerIndex = cmd.battlerIndex as BattlerIndex.PLAYER | BattlerIndex.PLAYER_2;
  switch (cmd.command) {
    case Command.FIGHT:
    case Command.TERA: {
      const moveId = cmd.move?.move as MoveId;
      const isDouble = game.scene.currentBattle.double;
      // Player-selected targets are stored on the command itself (`SelectTargetPhase`), while targets
      // computed automatically are stored on the move.
      const chosen = cmd.targets?.length ? cmd.targets : cmd.move?.targets;
      const target =
        isDouble && !allMoves[moveId].isMultiTarget() && chosen?.length === 1 ? (chosen[0] as BattlerIndex) : undefined;
      if (cmd.command === Command.TERA) {
        game.move.selectWithTera(moveId, battlerIndex, target);
      } else {
        game.move.select(moveId, battlerIndex, target);
      }
      return;
    }
    case Command.POKEMON:
      game.doSwitchPokemon(cmd.cursor ?? 0);
      return;
    default:
      throw new Error(`Replay of command type ${Command[cmd.command]} is not supported.`);
  }
}

/** Replay every captured turn, collecting checkpoints and comparing them with the capture. */
export async function replayCapture(
  game: GameManager,
  capture: BattleCapture,
  hooks: { beforeTurn?: (turn: number) => void; afterTurn?: (turn: number) => void } = {},
): Promise<ReplayResult> {
  const startCheckpoint = captureBattleCheckpoint(game.scene);
  const startDiff = diffCheckpoints(capture.startCheckpoint, startCheckpoint);
  const turns: ReplayTurnResult[] = [];

  for (let i = 0; i < capture.turns.length; i++) {
    const turn = capture.turns[i];
    hooks.beforeTurn?.(i);
    for (const cmd of [...turn.commands].sort((a, b) => a.battlerIndex - b.battlerIndex)) {
      queuePlayerCommand(game, cmd);
    }
    await game.toEndOfTurn();
    const checkpoint = captureBattleCheckpoint(game.scene);
    turns.push({
      turn: turn.turn,
      checkpoint,
      diffFromCapture: turn.checkpoint ? diffCheckpoints(turn.checkpoint, checkpoint) : undefined,
    });
    hooks.afterTurn?.(i);
    if (i < capture.turns.length - 1) {
      await game.toNextTurn();
    }
  }

  return { startCheckpoint, startMatchesCapture: startDiff === null, startDiff, turns };
}
