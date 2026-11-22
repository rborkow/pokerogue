/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Browser console entry point for the battle profiler (development builds only).
 *
 * Exposes `window.pokerogueProfiler`. Profiling can also be started automatically on load with the
 * `?profile=1` URL parameter or by setting `localStorage["pokerogue.profiler"] = "1"`.
 * See `docs/battle-profiling.md`.
 * @module
 */

import type { BattleScene } from "#app/battle-scene";
import { type BattleCapture, battleCapture, type CaptureStartOptions } from "#app/profiling/battle-capture";
import { battleProfiler } from "#app/profiling/battle-profiler";
import {
  buildChromeTrace,
  buildProfileSummary,
  type ChromeTrace,
  formatProfileReport,
  type ProfileMeta,
  type ProfileSummary,
} from "#app/profiling/profile-report";
import { type StartProfilingOptions, startProfiling, stopProfiling } from "#app/profiling/profiler-hooks";

const AUTOSTART_KEY = "pokerogue.profiler";

export interface PokerogueProfilerApi {
  /** Start (or restart) profiling. Clears previous data. */
  start(opts?: StartProfilingOptions): void;
  /** Stop profiling and remove hooks. Data is kept for export. */
  stop(): void;
  readonly enabled: boolean;
  /** Structured JSON summary of everything collected so far. */
  summary(meta?: ProfileMeta): ProfileSummary;
  /** Human-readable per-turn report (also printed to the console). */
  report(meta?: ProfileMeta): string;
  /** Chrome Trace Event Format document (open in https://ui.perfetto.dev or chrome://tracing). */
  trace(meta?: ProfileMeta): ChromeTrace;
  /** Download `<prefix>.summary.json`, `<prefix>.trace.json` and `<prefix>.report.txt`. */
  download(prefix?: string, meta?: ProfileMeta): void;
  /** Persistently auto-start profiling on page load (`true`) or turn that off (`false`). */
  autostart(on: boolean): void;
  capture: {
    /** Start a reproducible capture (call on turn 1 of a wave, ideally right after "Continue"). */
    start(opts?: CaptureStartOptions): Promise<void>;
    /** Stop the capture and keep it in `capture.last`. */
    stop(): BattleCapture | null;
    /** Download the last capture as JSON (replay with `pnpm profile:replay`). */
    download(name?: string): void;
    readonly last: BattleCapture | null;
  };
  help(): void;
}

function downloadText(filename: string, text: string, type = "application/json"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function environmentMeta(scene: BattleScene): ProfileMeta {
  return {
    gameVersion: String(scene.game?.config?.gameVersion ?? "unknown"),
    environment: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    buildMode: import.meta.env.MODE,
  };
}

function readAutostart(): boolean {
  try {
    if (new URLSearchParams(globalThis.location?.search ?? "").get("profile") === "1") {
      return true;
    }
    return globalThis.localStorage?.getItem(AUTOSTART_KEY) === "1";
  } catch {
    return false;
  }
}

const HELP = `pokerogueProfiler — opt-in battle profiler (dev builds only)
  pokerogueProfiler.start({ traceDetail: "phases" | "full" | "off" })
  pokerogueProfiler.stop()
  pokerogueProfiler.report()            // per-turn breakdown in the console
  pokerogueProfiler.download("late-endless")
  pokerogueProfiler.capture.start()      // on turn 1 of a wave, after "Continue"
  pokerogueProfiler.capture.stop(); pokerogueProfiler.capture.download()
  pokerogueProfiler.autostart(true)      // or load the page with ?profile=1`;

/** Install `window.pokerogueProfiler` and honour the auto-start flags. */
export function installProfilerConsole(scene: BattleScene): PokerogueProfilerApi {
  let lastCapture: BattleCapture | null = null;
  const meta = (extra?: ProfileMeta): ProfileMeta => ({ ...environmentMeta(scene), ...extra });

  const api: PokerogueProfilerApi = {
    start: opts => startProfiling(opts, scene),
    stop: () => stopProfiling(),
    get enabled() {
      return battleProfiler.enabled;
    },
    summary: m => buildProfileSummary(meta(m)),
    report: m => {
      const text = formatProfileReport(buildProfileSummary(meta(m)));
      console.log(text);
      return text;
    },
    trace: m => buildChromeTrace(meta(m)),
    download: (prefix = "pokerogue-battle-profile", m) => {
      const summary = buildProfileSummary(meta(m));
      downloadText(`${prefix}.summary.json`, JSON.stringify(summary, null, 2));
      downloadText(`${prefix}.trace.json`, JSON.stringify(buildChromeTrace(meta(m))));
      downloadText(`${prefix}.report.txt`, formatProfileReport(summary), "text/plain");
    },
    autostart: on => {
      try {
        if (on) {
          localStorage.setItem(AUTOSTART_KEY, "1");
        } else {
          localStorage.removeItem(AUTOSTART_KEY);
        }
      } catch (e) {
        console.warn("Could not persist profiler autostart flag", e);
      }
    },
    capture: {
      start: opts => battleCapture.start({ ...opts, profiler: { ...opts?.profiler } }),
      stop: () => {
        lastCapture = battleCapture.stop();
        return lastCapture;
      },
      download: (name = "pokerogue-battle-capture") => {
        if (lastCapture === null) {
          console.warn("No capture to download; call pokerogueProfiler.capture.stop() first.");
          return;
        }
        downloadText(`${name}.json`, JSON.stringify(lastCapture));
      },
      get last() {
        return lastCapture;
      },
    },
    help: () => console.log(HELP),
  };

  (globalThis as { pokerogueProfiler?: PokerogueProfilerApi }).pokerogueProfiler = api;
  if (readAutostart()) {
    api.start();
    console.info("Battle profiler auto-started. Type pokerogueProfiler.help() for commands.");
  }
  return api;
}
