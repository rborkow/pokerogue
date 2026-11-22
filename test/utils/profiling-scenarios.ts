/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Synthetic, deterministic battle scenarios used by the profiler tests and benchmark.
 *
 * These are **constructed** scenarios (via overrides), not recordings of real runs.
 * They approximate the run-state shape of early-game and late-Endless battles so that the cost of
 * effect evaluation can be compared under controlled conditions.
 */

import { getGameMode } from "#app/game-mode";
import { activeOverrides } from "#app/overrides";
import { type BattleCheckpoint, captureBattleCheckpoint } from "#app/profiling/battle-checkpoint";
import { AbilityId } from "#enums/ability-id";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { GameModes } from "#enums/game-modes";
import { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { ModifierOverride } from "#modifiers/modifier-type";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import type { GameManager } from "#test/framework/game-manager";
import { generateStarters } from "#test/utils/game-manager-utils";

export type ScenarioId = "A-early" | "B-late-endless" | "C-pathological";

export interface ScenarioDefinition {
  id: ScenarioId;
  description: string;
  mode: GameModes;
  wave: number;
  double: boolean;
  playerSpecies: SpeciesId[];
  playerMoves: MoveId[];
  /** Move selected by every player Pokémon each turn. */
  moveEachTurn: MoveId;
  playerItems: ModifierOverride[];
  playerModifiers: ModifierOverride[];
  enemyItems: ModifierOverride[];
  ability: AbilityId;
  passive: AbilityId | null;
  enemySpecies: SpeciesId;
  enemyAbility: AbilityId;
  enemyPassive: AbilityId | null;
  enemyMoves: MoveId[];
  level: number;
  enemyLevel: number;
  seed: string;
}

/** A broad late-game held-item loadout (counts chosen to resemble a long Endless run). */
const LATE_HELD_ITEMS: ModifierOverride[] = [
  { name: "LEFTOVERS", count: 4 },
  { name: "SHELL_BELL", count: 4 },
  { name: "MULTI_LENS", count: 2 },
  { name: "GRIP_CLAW", count: 3 },
  { name: "KINGS_ROCK", count: 3 },
  { name: "WIDE_LENS", count: 3 },
  { name: "SCOPE_LENS", count: 1 },
  { name: "QUICK_CLAW", count: 3 },
  { name: "FOCUS_BAND", count: 5 },
  { name: "SOUL_DEW", count: 5 },
  { name: "BATON", count: 1 },
  { name: "TOXIC_ORB", count: 1 },
  { name: "BERRY", count: 2 }, // Lum/Leppa/Sitrus/Enigma cap at 2; higher counts create states a save cannot hold
  { name: "GOLDEN_PUNCH", count: 5 },
];

const LATE_MODIFIERS: ModifierOverride[] = [
  { name: "EXP_SHARE", count: 5 },
  { name: "EXP_CHARM", count: 10 },
  { name: "GOLDEN_EXP_CHARM", count: 10 },
  { name: "HEALING_CHARM", count: 5 },
  { name: "SHINY_CHARM", count: 4 },
  { name: "ABILITY_CHARM", count: 1 },
  { name: "CANDY_JAR", count: 10 },
  { name: "BERRY_POUCH", count: 3 },
  { name: "LOCK_CAPSULE", count: 1 },
  { name: "MEGA_BRACELET", count: 1 },
  { name: "DYNAMAX_BAND", count: 1 },
  { name: "TERA_ORB", count: 1 },
  { name: "MAP", count: 1 },
  { name: "AMULET_COIN", count: 5 },
  { name: "OVAL_CHARM", count: 5 },
];

export const SCENARIOS: Readonly<Record<ScenarioId, ScenarioDefinition>> = {
  "A-early": {
    id: "A-early",
    description: "Classic wave 5, single battle, Snorlax mirror at level 40, no held items or modifiers, no passives",
    mode: GameModes.CLASSIC,
    wave: 5,
    double: false,
    playerSpecies: [SpeciesId.SNORLAX],
    playerMoves: [MoveId.TACKLE],
    moveEachTurn: MoveId.TACKLE,
    playerItems: [],
    playerModifiers: [],
    enemyItems: [],
    ability: AbilityId.BALL_FETCH,
    passive: null,
    enemySpecies: SpeciesId.SNORLAX,
    enemyAbility: AbilityId.BALL_FETCH,
    enemyPassive: null,
    enemyMoves: [MoveId.TACKLE],
    level: 40,
    enemyLevel: 40,
    seed: "profiling-scenario-a",
  },
  "B-late-endless": {
    id: "B-late-endless",
    description:
      "Endless wave 1005, double battle, 14 held-item types per party member, 15 party modifiers, passives on both sides",
    mode: GameModes.ENDLESS,
    wave: 1005,
    double: true,
    playerSpecies: [SpeciesId.GARCHOMP, SpeciesId.METAGROSS, SpeciesId.BLISSEY, SpeciesId.TOGEKISS],
    playerMoves: [MoveId.TACKLE],
    moveEachTurn: MoveId.TACKLE,
    playerItems: LATE_HELD_ITEMS,
    playerModifiers: LATE_MODIFIERS,
    enemyItems: LATE_HELD_ITEMS,
    ability: AbilityId.INTIMIDATE,
    passive: AbilityId.ROUGH_SKIN,
    enemySpecies: SpeciesId.BLISSEY,
    enemyAbility: AbilityId.NATURAL_CURE,
    enemyPassive: AbilityId.REGENERATOR,
    enemyMoves: [MoveId.TACKLE],
    level: 1000,
    enemyLevel: 3000,
    seed: "profiling-scenario-b",
  },
  "C-pathological": {
    id: "C-pathological",
    description:
      "Scenario B loadout, but both player Pokémon use Population Bomb with Skill Link (up to 10 strikes each) into enemies whose Stamina + Weak Armor trigger on every strike",
    mode: GameModes.ENDLESS,
    wave: 1005,
    double: true,
    playerSpecies: [SpeciesId.GARCHOMP, SpeciesId.METAGROSS, SpeciesId.BLISSEY, SpeciesId.TOGEKISS],
    playerMoves: [MoveId.POPULATION_BOMB],
    moveEachTurn: MoveId.POPULATION_BOMB,
    playerItems: LATE_HELD_ITEMS,
    playerModifiers: LATE_MODIFIERS,
    enemyItems: LATE_HELD_ITEMS,
    ability: AbilityId.SKILL_LINK,
    passive: AbilityId.ROUGH_SKIN,
    enemySpecies: SpeciesId.BLISSEY,
    enemyAbility: AbilityId.STAMINA,
    enemyPassive: AbilityId.WEAK_ARMOR,
    enemyMoves: [MoveId.TACKLE],
    level: 1000,
    enemyLevel: 3000,
    seed: "profiling-scenario-c",
  },
};

/** Apply a scenario's overrides to a fresh {@linkcode GameManager}. */
export function applyScenarioOverrides(game: GameManager, s: ScenarioDefinition): void {
  game.override
    .startingWave(s.wave)
    .startingBiome(s.mode === GameModes.CLASSIC ? BiomeId.TOWN : BiomeId.END)
    .battleStyle(s.double ? "double" : "single")
    .disableTrainerWaves()
    .mysteryEncounterChance(0)
    .moveset(s.playerMoves)
    .ability(s.ability)
    .startingHeldItems(s.playerItems)
    .startingModifier(s.playerModifiers)
    .startingLevel(s.level)
    .enemySpecies(s.enemySpecies)
    .enemyAbility(s.enemyAbility)
    .enemyMoveset(s.enemyMoves)
    .enemyLevel(s.enemyLevel)
    .enemyHeldItems(s.enemyItems)
    .criticalHits(false)
    .nature(Nature.HARDY)
    .enemyNature(Nature.HARDY);
  if (s.passive == null) {
    game.override.hasPassiveAbility(false);
  } else {
    game.override.passiveAbility(s.passive);
  }
  if (s.enemyPassive == null) {
    game.override.enemyHasPassiveAbility(false);
  } else {
    game.override.enemyPassiveAbility(s.enemyPassive);
  }
}

/**
 * Start a battle in an arbitrary game mode (the classic helper hard-codes Classic).
 * Mirrors `ClassicModeHelper.startBattle` for single and double battles without switch prompts.
 */
export async function startBattleInMode(game: GameManager, mode: GameModes, species: SpeciesId[]): Promise<void> {
  await game.runToTitle();
  game.onNextPrompt("TitlePhase", UiMode.TITLE, () => {
    game.scene.gameMode = getGameMode(mode);
    const starters = generateStarters(game.scene, species);
    const selectStarterPhase = new SelectStarterPhase();
    game.scene.phaseManager.pushNew("EncounterPhase", false);
    selectStarterPhase.initBattle(starters);
  });
  await game.phaseInterceptor.to("CommandPhase");
}

/**
 * Replace override getters installed by `vi.spyOn(..., "get")` with plain data properties holding the same values.
 *
 * @remarks
 * Vitest spies record every call (arguments, results, contexts). Game code reads overrides on hot paths
 * (e.g. every `getAbility()` call), so in profiling runs the spies dominate CPU time and GC, which does not
 * happen in the real game. Values are unchanged, and vitest's `restoreMocks` still restores the original
 * descriptors after the test.
 */
export function materializeOverrideSpies(): void {
  const target = activeOverrides as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc?.get !== undefined) {
      const value = target[key];
      Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
    }
  }
}

/**
 * Start the scenario's battle and seed RNG deterministically.
 * @param materialize - Replace override spies with plain values (see {@linkcode materializeOverrideSpies}); default `true`
 */
export async function startScenario(game: GameManager, s: ScenarioDefinition, materialize = true): Promise<void> {
  applyScenarioOverrides(game, s);
  game.override.seed(s.seed);
  if (materialize) {
    materializeOverrideSpies();
  }
  await startBattleInMode(game, s.mode, s.playerSpecies);
}

/** Queue each active player Pokémon's command for the turn, then run to the end of the turn. */
export async function playScenarioTurn(game: GameManager, s: ScenarioDefinition): Promise<void> {
  const field = game.scene.getPlayerField();
  const enemyTarget = s.double ? BattlerIndex.ENEMY : undefined;
  game.move.select(s.moveEachTurn, BattlerIndex.PLAYER, enemyTarget);
  if (s.double && field.length > 1) {
    game.move.select(s.moveEachTurn, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY_2);
  }
  await game.toEndOfTurn();
}

/**
 * Run `turns` turns of a started scenario, capturing a battle checkpoint after each `TurnEndPhase`.
 * Stops early if the battle ends.
 */
export async function runScenarioTurns(
  game: GameManager,
  s: ScenarioDefinition,
  turns: number,
  afterTurn?: (turn: number) => void,
): Promise<BattleCheckpoint[]> {
  const checkpoints: BattleCheckpoint[] = [];
  for (let t = 0; t < turns; t++) {
    if (game.scene.getEnemyField().every(p => !p.isActive(true))) {
      break;
    }
    await playScenarioTurn(game, s);
    checkpoints.push(captureBattleCheckpoint(game.scene));
    afterTurn?.(t);
    if (t < turns - 1) {
      if (game.scene.getEnemyField().every(p => !p.isActive(true)) || game.isVictory()) {
        break;
      }
      await game.toNextTurn();
    }
  }
  return checkpoints;
}
