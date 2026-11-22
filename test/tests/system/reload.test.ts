import { pokerogueApi } from "#api/api";
import { AbilityId } from "#enums/ability-id";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { GameModes } from "#enums/game-modes";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import type { MockClock } from "#test/mocks/mock-clock";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

describe("Reload", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    vi.spyOn(pokerogueApi, "getGameTitleStats").mockResolvedValue({
      battleCount: -1,
      playerCount: -1,
    });
    vi.spyOn(pokerogueApi.daily, "getSeed").mockResolvedValue("test-seed");
  });

  it("should not have RNG inconsistencies in a Classic run", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not have RNG inconsistencies after a biome switch", async () => {
    game.override
      .startingWave(10)
      .battleStyle("single")
      .startingLevel(100) // Avoid levelling up
      .disableTrainerWaves()
      .moveset([MoveId.SPLASH])
      .enemyMoveset(MoveId.SPLASH);
    await game.dailyMode.startBattle();

    // Transition from Wave 10 to Wave 11 in order to trigger biome switch
    game.move.select(MoveId.SPLASH);
    await game.doKillOpponents();
    game.onNextPrompt("SelectBiomePhase", UiMode.OPTION_SELECT, () => {
      (game.scene.time as MockClock).overrideDelay = null;
      const optionSelectUiHandler = game.scene.ui.getHandler() as OptionSelectUiHandler;
      game.scene.time.delayedCall(1010, () => optionSelectUiHandler.processInput(Button.ACTION));
      game.endPhase();
      (game.scene.time as MockClock).overrideDelay = 1;
    });
    await game.toNextWave();
    expect(game.phaseInterceptor.phaseLog).toContain("NewBiomeEncounterPhase");

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not have weather inconsistencies after a biome switch", async () => {
    game.override
      .startingWave(10)
      .startingBiome(BiomeId.ICE_CAVE) // Will lead to Snowy Forest with randomly generated weather
      .battleStyle("single")
      .startingLevel(100) // Avoid levelling up
      .disableTrainerWaves()
      .moveset([MoveId.SPLASH])
      .enemyMoveset(MoveId.SPLASH);

    await game.classicMode.startBattle(SpeciesId.FEEBAS); // Apparently daily mode would override the biome

    // Transition from Wave 10 to Wave 11 in order to trigger biome switch
    game.move.select(MoveId.SPLASH);
    await game.doKillOpponents();
    await game.toNextWave();
    expect(game.phaseInterceptor.phaseLog).toContain("NewBiomeEncounterPhase");

    const preReloadWeather = game.scene.arena.weather;

    await game.reload.reloadSession();

    const postReloadWeather = game.scene.arena.weather;

    expect(postReloadWeather).toStrictEqual(preReloadWeather);
  });

  it("should not have RNG inconsistencies at a Daily run wild Pokemon fight", async () => {
    await game.dailyMode.startBattle();

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not have RNG inconsistencies at a Daily run double battle", async () => {
    game.override.battleStyle("double");
    await game.dailyMode.startBattle();

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not have RNG inconsistencies at a Daily run Gym Leader fight", async () => {
    game.override.battleStyle("single").startingWave(40);
    await game.dailyMode.startBattle();

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not have RNG inconsistencies at a Daily run regular trainer fight", async () => {
    game.override.battleStyle("single").startingWave(45);
    await game.dailyMode.startBattle();

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not have RNG inconsistencies at a Daily run wave 50 Boss fight", async () => {
    game.override.battleStyle("single").startingWave(50);
    await game.runToFinalBossEncounter([SpeciesId.BULBASAUR], GameModes.DAILY);

    const preReloadRngState = Phaser.Math.RND.state();

    await game.reload.reloadSession();

    const postReloadRngState = Phaser.Math.RND.state();

    expect(preReloadRngState).toBe(postReloadRngState);
  });

  it("should not duplicate enemy held items", async () => {
    game.override.battleStyle("single").enemyHeldItems([{ name: "SOUL_DEW", count: 3 }]);
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    expect(
      game.field
        .getEnemyPokemon()
        .getHeldItems()
        .map(m => m.getStackCount()),
    ).toEqual([3]);

    await game.reload.reloadSession();

    expect(
      game.field
        .getEnemyPokemon()
        .getHeldItems()
        .map(m => m.getStackCount()),
    ).toEqual([3]);
  });

  describe("Player entry abilities", () => {
    beforeEach(() => {
      game.override
        .battleStyle("single")
        .startingLevel(100) // Avoid levelling up
        .disableTrainerWaves()
        .ability(AbilityId.INTIMIDATE)
        .enemyAbility(AbilityId.BALL_FETCH)
        .moveset([MoveId.SPLASH])
        .enemyMoveset(MoveId.SPLASH);
    });

    // Endless biomes last 5 waves, so the player's Pokemon are recalled and sent out again on wave 6
    it("should re-apply on load when the wave starts a new Endless biome", async () => {
      game.override.startingWave(6);
      await game.runToFinalBossEncounter([SpeciesId.FEEBAS], GameModes.ENDLESS);
      await game.phaseInterceptor.to("CommandPhase");
      expect(game.field.getEnemyPokemon()).toHaveStatStage(Stat.ATK, -1);

      await game.reload.reloadSession();

      expect(game.field.getEnemyPokemon()).toHaveStatStage(Stat.ATK, -1);
    });

    it("should re-apply on load at the start of a new Classic biome", async () => {
      game.override.startingWave(11);
      await game.classicMode.startBattle(SpeciesId.FEEBAS);
      expect(game.field.getEnemyPokemon()).toHaveStatStage(Stat.ATK, -1);

      await game.reload.reloadSession();

      expect(game.field.getEnemyPokemon()).toHaveStatStage(Stat.ATK, -1);
    });

    // The player's Pokemon stay on the field between wild waves in the same biome, so entry abilities
    // do not activate when the next wave starts, and must not activate on load either
    it("should not apply on load when the player's Pokemon carried over from the previous wave", async () => {
      game.override.startingWave(3);
      await game.runToFinalBossEncounter([SpeciesId.FEEBAS], GameModes.ENDLESS);
      await game.phaseInterceptor.to("CommandPhase");

      game.move.select(MoveId.SPLASH);
      await game.doKillOpponents();
      await game.toNextWave();
      expect(game.scene.currentBattle.waveIndex).toBe(4);
      expect(game.field.getEnemyPokemon()).toHaveStatStage(Stat.ATK, 0);

      await game.reload.reloadSession();

      expect(game.field.getEnemyPokemon()).toHaveStatStage(Stat.ATK, 0);
    });
  });
});
