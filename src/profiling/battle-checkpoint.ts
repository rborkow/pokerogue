/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Canonical battle-state checkpoints used to verify that two runs of the same scenario
 * (e.g. profiler on vs. off, or two replays of a capture) produced identical battle state.
 *
 * A checkpoint covers RNG state, both parties (HP, status, stat stages, abilities, PP, battler tags),
 * both modifier lists (type + stack count + holder) and arena state (weather, terrain, tags).
 * Reading the RNG state does not consume RNG.
 * @module
 */

import type { BattleScene } from "#app/battle-scene";
import { globalScene } from "#app/global-scene";
import type { Pokemon } from "#field/pokemon";
import type { PersistentModifier } from "#modifiers/modifier";
import Phaser from "phaser";

export interface BattleCheckpoint {
  waveIndex: number;
  turn: number;
  /** FNV-1a (32-bit, hex) of {@linkcode canonical}. */
  hash: string;
  /** Global RNG state string (`Phaser.Math.RND.state()`). */
  rngState: string;
  /** The canonical serialized state that was hashed (kept for diffing on divergence). */
  canonical: string;
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function pokemonState(p: Pokemon) {
  return {
    id: p.id,
    species: p.species.speciesId,
    form: p.formIndex,
    level: p.level,
    hp: p.hp,
    status: p.status?.effect ?? 0,
    ability: p.getAbility().id,
    passive: p.hasPassive() ? p.getPassiveAbility().id : null,
    stages: p.getStatStages().join(","),
    pp: p
      .getMoveset()
      .map(m => `${m.moveId}:${m.ppUsed}`)
      .join(","),
    tags: p.summonData.tags
      .map(t => `${t.tagType}:${t.turnCount}`)
      .sort()
      .join(","),
    active: p.isOnField(),
  };
}

function modifierState(mods: readonly PersistentModifier[]): string[] {
  return mods.map(m => `${m.type.id}x${m.stackCount}${"pokemonId" in m ? `@${m.pokemonId}` : ""}`).sort();
}

/** Capture a checkpoint of the current battle state. */
export function captureBattleCheckpoint(scene: BattleScene = globalScene): BattleCheckpoint {
  const battle = scene.currentBattle;
  const arena = scene.arena;
  const rngState = Phaser.Math.RND.state();
  const state = {
    wave: battle?.waveIndex ?? -1,
    turn: battle?.turn ?? -1,
    rng: rngState,
    battleRng: battle?.["battleSeedState"] ?? null,
    player: scene.getPlayerParty().map(pokemonState),
    enemy: scene.getEnemyParty().map(pokemonState),
    playerMods: modifierState(scene.modifiers),
    enemyMods: modifierState(scene["enemyModifiers"]),
    weather: arena?.weather ? `${arena.weather.weatherType}:${arena.weather.turnsLeft}` : null,
    terrain: arena?.terrain ? `${arena.terrain.terrainType}:${arena.terrain.turnsLeft}` : null,
    arenaTags: (arena?.tags ?? []).map(t => `${t.tagType}:${t.side}:${t.turnCount}`).sort(),
  };
  const canonical = JSON.stringify(state);
  return {
    waveIndex: state.wave,
    turn: state.turn,
    hash: fnv1a(canonical),
    rngState,
    canonical,
  };
}

/**
 * Describe the first difference between two checkpoints' canonical states.
 * @returns `null` when the checkpoints are identical
 */
export function diffCheckpoints(a: BattleCheckpoint, b: BattleCheckpoint): string | null {
  if (a.canonical === b.canonical) {
    return null;
  }
  const ja = JSON.parse(a.canonical) as Record<string, unknown>;
  const jb = JSON.parse(b.canonical) as Record<string, unknown>;
  const diffs: string[] = [];
  for (const key of new Set([...Object.keys(ja), ...Object.keys(jb)])) {
    const va = ja[key];
    const vb = jb[key];
    if (JSON.stringify(va) === JSON.stringify(vb)) {
      continue;
    }
    if (Array.isArray(va) && Array.isArray(vb)) {
      // Element-level diff keeps long lists (parties, modifiers) readable.
      const sa = va.map(e => JSON.stringify(e));
      const sb = vb.map(e => JSON.stringify(e));
      const onlyA = sa.filter(e => !sb.includes(e));
      const onlyB = sb.filter(e => !sa.includes(e));
      diffs.push(`${key}: only in first [${onlyA.join(", ")}]; only in second [${onlyB.join(", ")}]`);
    } else {
      diffs.push(`${key}: ${JSON.stringify(va)?.slice(0, 300)} ≠ ${JSON.stringify(vb)?.slice(0, 300)}`);
    }
  }
  return diffs.join("\n");
}
