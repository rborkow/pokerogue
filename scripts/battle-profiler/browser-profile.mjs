/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Optional helper: drive the real game in a browser and collect battle profiles, so presentation waits,
 * rendering and frame pacing are measured (headless vitest runs only measure simulation).
 *
 * Requirements (not repo dependencies):
 * - Playwright with a Chromium build, resolvable from this directory or via `NODE_PATH`
 *   (e.g. `npm i -g playwright && npx playwright install chromium`, then `NODE_PATH=$(npm root -g)`).
 * - A running dev server: `VITE_BYPASS_TUTORIAL=1 pnpm start:dev` (development mode bypasses login).
 *
 * Usage:
 *   node scripts/battle-profiler/browser-profile.mjs [--url http://localhost:8000] [--runs 3] [--turns 3]
 *     [--scenarios A-early,B-late-endless,C-pathological] [--configs turbo,max] [--out temp/profiles/browser]
 *     [--headed]
 *
 * The scenarios mirror `test/utils/profiling-scenarios.ts` and are applied through runtime overrides
 * (no source edits). Commands are issued only while the game waits for input, so message and animation
 * pacing is never skipped.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8000" },
    runs: { type: "string", default: "3" },
    turns: { type: "string", default: "3" },
    scenarios: { type: "string", default: "A-early,B-late-endless,C-pathological" },
    configs: { type: "string", default: "turbo,max" },
    out: { type: "string", default: join("temp", "profiles", "browser") },
    headed: { type: "boolean", default: false },
  },
});

const LATE_HELD = [
  ["LEFTOVERS", 4],
  ["SHELL_BELL", 4],
  ["MULTI_LENS", 2],
  ["GRIP_CLAW", 3],
  ["KINGS_ROCK", 3],
  ["WIDE_LENS", 3],
  ["SCOPE_LENS", 1],
  ["QUICK_CLAW", 3],
  ["FOCUS_BAND", 5],
  ["SOUL_DEW", 5],
  ["BATON", 1],
  ["TOXIC_ORB", 1],
  ["BERRY", 2],
  ["GOLDEN_PUNCH", 5],
].map(([name, count]) => ({ name, count }));
const LATE_MODS = [
  ["EXP_SHARE", 5],
  ["EXP_CHARM", 10],
  ["GOLDEN_EXP_CHARM", 10],
  ["HEALING_CHARM", 5],
  ["SHINY_CHARM", 4],
  ["ABILITY_CHARM", 1],
  ["CANDY_JAR", 10],
  ["BERRY_POUCH", 3],
  ["LOCK_CAPSULE", 1],
  ["MEGA_BRACELET", 1],
  ["DYNAMAX_BAND", 1],
  ["TERA_ORB", 1],
  ["MAP", 1],
  ["AMULET_COIN", 5],
  ["OVAL_CHARM", 5],
].map(([name, count]) => ({ name, count }));

/** Scenario definitions, mirroring test/utils/profiling-scenarios.ts. Enum values are given by name. */
const SCENARIOS = {
  "A-early": {
    mode: "CLASSIC",
    party: ["SNORLAX"],
    overrides: {
      STARTING_WAVE_OVERRIDE: 5,
      STARTING_BIOME_OVERRIDE: "biome:TOWN",
      FIELD_SIZE_OVERRIDE: "single",
      MOVESET_OVERRIDE: ["move:TACKLE"],
      ABILITY_OVERRIDE: "ability:BALL_FETCH",
      HAS_PASSIVE_ABILITY_OVERRIDE: false,
      STARTING_LEVEL_OVERRIDE: 40,
      ENEMY_SPECIES_OVERRIDE: "species:SNORLAX",
      ENEMY_ABILITY_OVERRIDE: "ability:BALL_FETCH",
      ENEMY_HAS_PASSIVE_ABILITY_OVERRIDE: false,
      ENEMY_MOVESET_OVERRIDE: ["move:TACKLE"],
      ENEMY_LEVEL_OVERRIDE: 40,
      SEED_OVERRIDE: "profiling-scenario-a",
    },
  },
  "B-late-endless": {
    mode: "ENDLESS",
    party: ["GARCHOMP", "METAGROSS", "BLISSEY", "TOGEKISS"],
    overrides: {
      STARTING_WAVE_OVERRIDE: 1005,
      STARTING_BIOME_OVERRIDE: "biome:END",
      FIELD_SIZE_OVERRIDE: "double",
      MOVESET_OVERRIDE: ["move:TACKLE"],
      ABILITY_OVERRIDE: "ability:INTIMIDATE",
      PASSIVE_ABILITY_OVERRIDE: "ability:ROUGH_SKIN",
      HAS_PASSIVE_ABILITY_OVERRIDE: true,
      STARTING_HELD_ITEMS_OVERRIDE: LATE_HELD,
      STARTING_MODIFIER_OVERRIDE: LATE_MODS,
      STARTING_LEVEL_OVERRIDE: 1000,
      ENEMY_SPECIES_OVERRIDE: "species:BLISSEY",
      ENEMY_ABILITY_OVERRIDE: "ability:NATURAL_CURE",
      ENEMY_PASSIVE_ABILITY_OVERRIDE: "ability:REGENERATOR",
      ENEMY_HAS_PASSIVE_ABILITY_OVERRIDE: true,
      ENEMY_MOVESET_OVERRIDE: ["move:TACKLE"],
      ENEMY_LEVEL_OVERRIDE: 3000,
      ENEMY_HELD_ITEMS_OVERRIDE: LATE_HELD,
      SEED_OVERRIDE: "profiling-scenario-b",
    },
  },
  "C-pathological": {
    mode: "ENDLESS",
    party: ["GARCHOMP", "METAGROSS", "BLISSEY", "TOGEKISS"],
    overrides: {
      STARTING_WAVE_OVERRIDE: 1005,
      STARTING_BIOME_OVERRIDE: "biome:END",
      FIELD_SIZE_OVERRIDE: "double",
      MOVESET_OVERRIDE: ["move:POPULATION_BOMB"],
      ABILITY_OVERRIDE: "ability:SKILL_LINK",
      PASSIVE_ABILITY_OVERRIDE: "ability:ROUGH_SKIN",
      HAS_PASSIVE_ABILITY_OVERRIDE: true,
      STARTING_HELD_ITEMS_OVERRIDE: LATE_HELD,
      STARTING_MODIFIER_OVERRIDE: LATE_MODS,
      STARTING_LEVEL_OVERRIDE: 1000,
      ENEMY_SPECIES_OVERRIDE: "species:BLISSEY",
      ENEMY_ABILITY_OVERRIDE: "ability:STAMINA",
      ENEMY_PASSIVE_ABILITY_OVERRIDE: "ability:WEAK_ARMOR",
      ENEMY_HAS_PASSIVE_ABILITY_OVERRIDE: true,
      ENEMY_MOVESET_OVERRIDE: ["move:TACKLE"],
      ENEMY_LEVEL_OVERRIDE: 3000,
      ENEMY_HELD_ITEMS_OVERRIDE: LATE_HELD,
      SEED_OVERRIDE: "profiling-scenario-c",
    },
  },
};

const COMMON_OVERRIDES = {
  DISABLE_STANDARD_TRAINERS_OVERRIDE: true,
  MYSTERY_ENCOUNTER_RATE_OVERRIDE: 0,
  CRITICAL_HIT_OVERRIDE: false,
  NATURE_OVERRIDE: "nature:HARDY",
  ENEMY_NATURE_OVERRIDE: "nature:HARDY",
};

/** Settings applied per configuration (values are enum numbers; see src/enums). */
const CONFIGS = {
  /** Maximum game speed, everything else default. */
  turbo: { general: { gameSpeed: 5 }, display: {} },
  /** Maximum game speed plus every animation acceleration the settings offer. */
  max: {
    general: { gameSpeed: 5, hpBarSpeed: 3, expGainsSpeed: 3 },
    display: { enableMoveAnimations: false, damageNumbersMode: 0, showMovesetFlyout: false },
  },
};

/** Runs in the page: wait for the title screen, configure, start the battle. */
async function setupInPage({ scenario, config }) {
  const imp = p => import(/* @vite-ignore */ p);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { globalScene } = await imp("/src/globals/global-scene.ts");
  const { settings } = await imp("/src/globals/global-settings-manager.ts");
  const { activeOverrides } = await imp("/src/overrides.ts");
  const { getGameMode } = await imp("/src/game-mode.ts");
  const { speciesDataRegistry } = await imp("/src/globals/global-species-data-registry.ts");
  const { PlayerPokemon } = await imp("/src/field/pokemon.ts");
  const { SelectStarterPhase } = await imp("/src/phases/select-starter-phase.ts");
  const enums = {
    species: (await imp("/src/enums/species-id.ts")).SpeciesId,
    move: (await imp("/src/enums/move-id.ts")).MoveId,
    ability: (await imp("/src/enums/ability-id.ts")).AbilityId,
    nature: (await imp("/src/enums/nature.ts")).Nature,
    biome: (await imp("/src/enums/biome-id.ts")).BiomeId,
  };
  const { GameModes } = await imp("/src/enums/game-modes.ts");
  const { BattleStyle } = await imp("/src/enums/battle-style.ts");
  const { UiMode } = await imp("/src/enums/ui-mode.ts");

  const resolve = v => {
    if (typeof v === "string" && v.includes(":")) {
      const [kind, name] = v.split(":");
      if (enums[kind]?.[name] === undefined) {
        throw new Error(`Unknown ${kind} ${name}`);
      }
      return enums[kind][name];
    }
    if (Array.isArray(v)) {
      return v.map(resolve);
    }
    return v;
  };

  for (let i = 0; i < 600; i++) {
    const phase = globalScene?.phaseManager?.getCurrentPhase?.();
    if (phase?.phaseName === "SelectGenderPhase" && globalScene.ui.mode === UiMode.OPTION_SELECT) {
      globalScene.ui.getHandler().config.options[0].handler();
    }
    if (phase?.phaseName === "TitlePhase" && globalScene.ui.mode === UiMode.TITLE) {
      break;
    }
    await sleep(250);
  }

  settings.update("general", "battleStyle", BattleStyle.SET);
  for (const [cat, entries] of Object.entries(config)) {
    for (const [key, value] of Object.entries(entries)) {
      settings.update(cat, key, value);
    }
  }
  for (const [key, value] of Object.entries(scenario.overrides)) {
    activeOverrides[key] = resolve(value);
  }

  globalScene.gameMode = getGameMode(GameModes[scenario.mode]);
  const starters = scenario.party.map(name => {
    const speciesId = enums.species[name];
    const species = speciesDataRegistry.getSpecies(speciesId);
    const p = new PlayerPokemon(species, 5, undefined, 0);
    return {
      speciesId,
      shiny: false,
      variant: 0,
      formIndex: 0,
      ivs: p.ivs,
      abilityIndex: p.abilityIndex,
      passive: false,
      nature: p.getNature(),
      pokerus: false,
      moveset: p.moveset.map(m => m.moveId),
    };
  });
  globalScene.phaseManager.pushNew("EncounterPhase", false);
  new SelectStarterPhase().initBattle(starters);
  return true;
}

/** Runs in the page: profile `turns` turns, issuing commands only when the game waits for input. */
async function playTurnsInPage({ turns, label }) {
  const imp = p => import(/* @vite-ignore */ p);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { globalScene } = await imp("/src/globals/global-scene.ts");
  const { battleProfiler } = await imp("/src/profiling/battle-profiler.ts");
  const { UiMode } = await imp("/src/enums/ui-mode.ts");
  const { Command } = await imp("/src/enums/command.ts");
  const { MoveUseMode } = await imp("/src/enums/move-use-mode.ts");
  const { Button } = await imp("/src/enums/buttons.ts");
  const api = window.pokerogueProfiler;
  const pm = globalScene.phaseManager;
  const now = () => pm.getCurrentPhase()?.phaseName;

  for (let i = 0; i < 2400 && !(now() === "CommandPhase" && globalScene.ui.mode === UiMode.COMMAND); i++) {
    await sleep(50);
  }
  api.start({ traceDetail: "phases" });
  const deadline = performance.now() + 240_000 * turns;
  while (battleProfiler.turns.length < turns && performance.now() < deadline) {
    const name = now();
    const mode = globalScene.ui.mode;
    if (name === "CommandPhase" && mode === UiMode.COMMAND) {
      const phase = pm.getCurrentPhase();
      await globalScene.ui.setMode(UiMode.FIGHT, phase.getFieldIndex());
      phase.handleCommand(Command.FIGHT, 0, MoveUseMode.NORMAL);
    } else if (name === "SelectTargetPhase" && mode === UiMode.TARGET_SELECT) {
      globalScene.ui.getHandler().processInput(Button.ACTION);
    } else if (["SelectModifierPhase", "GameOverPhase", "VictoryPhase"].includes(name)) {
      break;
    }
    await sleep(50);
  }
  api.stop();
  const meta = { scenario: label };
  return {
    summary: api.summary(meta),
    trace: api.trace(meta),
    report: api.report(meta),
  };
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    try {
      // CommonJS resolution honours NODE_PATH (e.g. a global Playwright install).
      ({ chromium } = createRequire(import.meta.url)("playwright"));
    } catch {
      console.error("Playwright is required for this optional script (it is not a repo dependency).");
      process.exit(1);
    }
  }
  mkdirSync(args.out, { recursive: true });
  const browser = await chromium.launch({
    headless: !args.headed,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const results = [];
  for (const scenarioId of args.scenarios.split(",")) {
    for (const configId of args.configs.split(",")) {
      for (let run = 1; run <= Number(args.runs); run++) {
        const label = `${scenarioId}/${configId}/run${run}`;
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const page = await context.newPage();
        page.on("pageerror", e => console.warn(`[${label}] page error: ${e.message.slice(0, 160)}`));
        const t0 = Date.now();
        await page.goto(args.url, { timeout: 600_000 });
        await page.waitForFunction(() => !!window.pokerogueProfiler, null, { timeout: 600_000 });
        const scenario = {
          ...SCENARIOS[scenarioId],
          overrides: { ...COMMON_OVERRIDES, ...SCENARIOS[scenarioId].overrides },
        };
        console.info(`[${label}] game loaded after ${((Date.now() - t0) / 1000).toFixed(0)} s; starting battle`);
        await page.evaluate(setupInPage, { scenario, config: CONFIGS[configId] });
        console.info(`[${label}] battle started after ${((Date.now() - t0) / 1000).toFixed(0)} s; profiling turns`);
        const out = await page.evaluate(playTurnsInPage, { turns: Number(args.turns), label });
        const base = join(args.out, `${scenarioId}.${configId}.run${run}`);
        writeFileSync(`${base}.summary.json`, JSON.stringify(out.summary, null, 2));
        writeFileSync(`${base}.trace.json`, JSON.stringify(out.trace));
        writeFileSync(`${base}.report.txt`, out.report);
        const walls = out.summary.turns.map(t => t.breakdown.wallMs.toFixed(0)).join(", ");
        console.info(
          `${label}: ${out.summary.turns.length} turns, wall ms [${walls}] (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
        );
        results.push({ scenarioId, configId, run, turns: out.summary.turns });
        await context.close();
      }
    }
  }
  await browser.close();
  writeFileSync(join(args.out, "browser-runs.json"), JSON.stringify(results, null, 2));
  console.info(`Wrote ${results.length} runs to ${args.out}`);
}

await main();
