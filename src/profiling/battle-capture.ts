/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Minimal reproducible battle capture built on the game's existing session save format.
 *
 * A capture contains:
 * - the session save data at capture start (the same data the game writes to a save slot; it contains
 *   no credentials or tokens),
 * - every turn's committed commands for both sides (player commands are replayed; enemy commands are
 *   recorded only to detect AI divergence),
 * - a {@linkcode BattleCheckpoint} at capture start and after every `TurnEndPhase`.
 *
 * Determinism relies on the existing guarantee that loading a session re-seeds RNG from the run seed
 * and wave index. A capture therefore replays deterministically **when started at the beginning of a
 * wave** (turn 1 `CommandPhase`, e.g. right after loading a save). Captures started mid-wave still
 * replay deterministically against themselves, but will not match the live run, and the replay
 * reports this through the start-checkpoint comparison rather than hiding it.
 * @module
 */

import { globalScene } from "#app/global-scene";
import type { Phase } from "#app/phase";
import { type BattleCheckpoint, captureBattleCheckpoint } from "#app/profiling/battle-checkpoint";
import { battleProfiler } from "#app/profiling/battle-profiler";
import { buildProfileSummary, type TurnSummary } from "#app/profiling/profile-report";
import { type StartProfilingOptions, startProfiling } from "#app/profiling/profiler-hooks";
import type { SessionSaveData } from "#types/save-data";

export const CAPTURE_SCHEMA_VERSION = 1;

/** JSON-safe subset of a `TurnCommand`. */
export interface CapturedCommand {
  battlerIndex: number;
  command: number;
  cursor?: number;
  move?: { move: number; targets: number[]; useMode?: number };
  targets?: number[];
  skip?: boolean;
}

export interface CapturedTurn {
  waveIndex: number;
  turn: number;
  commands: CapturedCommand[];
  /** Checkpoint after this turn's `TurnEndPhase` (absent if the turn was interrupted, e.g. by a KO). */
  checkpoint: BattleCheckpoint | null;
}

/**
 * Where the capture's session data came from.
 * - `"provided"`: passed in explicitly by the caller.
 * - `"saveSlot"`: the game's own save for the current wave (what "Continue" would load). Faithful.
 * - `"liveSnapshot"`: serialized from live state because no matching save was found. Loading it re-runs
 *   wave-start effects (summons, entry abilities) on top of an already-affected state, so replays will
 *   usually diverge from the live run.
 */
export type CaptureSessionSource = "provided" | "saveSlot" | "liveSnapshot";

export interface CaptureStartOptions {
  /** Session data to embed instead of looking up the current save slot. */
  session?: SessionSaveData;
  /** Options for the profiler that runs alongside the capture. */
  profiler?: StartProfilingOptions;
}

export interface BattleCapture {
  kind: "pokerogue-battle-capture";
  schemaVersion: number;
  createdAt: string;
  gameVersion: string;
  /** Plain-JSON session save data (normally the wave-start save point). */
  session: SessionSaveData;
  sessionSource: CaptureSessionSource;
  startCheckpoint: BattleCheckpoint;
  turns: CapturedTurn[];
  /** Optional per-turn profiling summaries from the live run (for comparison with replays). */
  liveProfile?: TurnSummary[];
}

function toJsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as T;
}

function serializeCommands(): CapturedCommand[] {
  const out: CapturedCommand[] = [];
  const commands = globalScene.currentBattle?.turnCommands ?? {};
  for (const [key, cmd] of Object.entries(commands)) {
    if (cmd == null) {
      continue;
    }
    const entry: CapturedCommand = { battlerIndex: Number(key), command: cmd.command };
    if (cmd.cursor != null) {
      entry.cursor = cmd.cursor;
    }
    if (cmd.move != null) {
      entry.move = { move: cmd.move.move, targets: [...(cmd.move.targets ?? [])], useMode: cmd.move.useMode };
    }
    if (cmd.targets != null) {
      entry.targets = [...cmd.targets];
    }
    if (cmd.skip) {
      entry.skip = true;
    }
    out.push(entry);
  }
  return out;
}

/** Records a {@linkcode BattleCapture} while the profiler runs. */
export class BattleCaptureRecorder {
  private capture: BattleCapture | null = null;
  private pending: CapturedTurn | null = null;

  public get active(): boolean {
    return this.capture !== null && battleProfiler.phaseListener === this.listener;
  }

  /**
   * Start capturing. Call while the game waits for commands on **turn 1** of a wave
   * (e.g. right after continuing a saved run). Also (re)starts the profiler so the live run is profiled.
   */
  public async start(opts: CaptureStartOptions = {}): Promise<void> {
    const battle = globalScene.currentBattle;
    if (battle == null) {
      throw new Error("Battle capture can only start during a battle.");
    }
    if (battle.turn !== 1) {
      console.warn(
        `Battle capture started on turn ${battle.turn}; replays restart the wave, so live and replay states will differ. Start on turn 1 for a faithful reproduction.`,
      );
    }
    let session: SessionSaveData | undefined = opts.session;
    let sessionSource: CaptureSessionSource = "provided";
    if (session == null) {
      session = await this.findWaveStartSave(battle.waveIndex);
      sessionSource = "saveSlot";
    }
    if (session == null) {
      console.warn("No save found for the current wave; falling back to a live snapshot (replays may diverge).");
      session = globalScene.gameData.getSessionSaveData();
      sessionSource = "liveSnapshot";
    }
    startProfiling(opts.profiler ?? {});
    this.capture = {
      kind: "pokerogue-battle-capture",
      schemaVersion: CAPTURE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      gameVersion: String(globalScene.game?.config?.gameVersion ?? "unknown"),
      session: toJsonSafe(session),
      sessionSource,
      startCheckpoint: captureBattleCheckpoint(),
      turns: [],
    };
    this.pending = null;
    battleProfiler.phaseListener = this.listener;
  }

  /** The game's own save for this wave (the state "Continue" would load), if available. */
  private async findWaveStartSave(waveIndex: number): Promise<SessionSaveData | undefined> {
    try {
      const saved = await globalScene.gameData.getSession(globalScene.sessionSlotId);
      return saved?.waveIndex === waveIndex ? saved : undefined;
    } catch (e) {
      console.warn("Could not read the current save slot", e);
      return;
    }
  }

  private readonly listener = (kind: "start" | "end", phase: Phase): void => {
    if (this.capture === null) {
      return;
    }
    if (kind === "start" && phase.phaseName === "TurnStartPhase") {
      const battle = globalScene.currentBattle;
      this.pending = {
        waveIndex: battle.waveIndex,
        turn: battle.turn,
        commands: serializeCommands(),
        checkpoint: null,
      };
      this.capture.turns.push(this.pending);
    } else if (kind === "end" && phase.phaseName === "TurnEndPhase" && this.pending !== null) {
      this.pending.checkpoint = captureBattleCheckpoint();
      this.pending = null;
    }
  };

  /** Stop capturing (and profiling) and return the capture. */
  public stop(): BattleCapture | null {
    const capture = this.capture;
    if (battleProfiler.phaseListener === this.listener) {
      battleProfiler.phaseListener = null;
    }
    battleProfiler.disable();
    if (capture !== null) {
      capture.liveProfile = buildProfileSummary().turns;
    }
    this.capture = null;
    this.pending = null;
    return capture;
  }
}

/** Validate the basic shape of a parsed capture file. */
export function assertBattleCapture(value: unknown): asserts value is BattleCapture {
  const v = value as Partial<BattleCapture> | null;
  if (v?.kind !== "pokerogue-battle-capture" || typeof v.schemaVersion !== "number" || v.session == null) {
    throw new Error("Not a PokéRogue battle capture file.");
  }
  if (v.schemaVersion > CAPTURE_SCHEMA_VERSION) {
    throw new Error(`Capture schema v${v.schemaVersion} is newer than supported v${CAPTURE_SCHEMA_VERSION}.`);
  }
}

export const battleCapture = new BattleCaptureRecorder();
