<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

# Battle Profiling

An opt-in profiler for answering one question precisely: **where does the time in a battle turn go?**
It separates synchronous simulation work from presentation waits and rendering, counts effect evaluations
versus activations, and pairs every measurement with a battle-state checkpoint so results can be reproduced
without changing gameplay.

Findings from the initial investigation live in [`battle-performance-report.md`](./battle-performance-report.md).

## What it measures

| Category | Measured | Where |
|---|---|---|
| Turns | Wall-clock (`TurnStartPhase` start → `TurnEndPhase` end), phase transitions, run-state context | phase manager |
| Phases | Count, exclusive/inclusive **sync** time, wall lifetime (`start()` → `end()`), waits scheduled | `PhaseManager.shiftPhase` |
| Abilities and passives | Evaluations, attributes considered, activations, simulated calls, time; by ability and by attribute type | `applySingleAbAttrs` |
| Held items and modifiers | Apply calls, list entries scanned, matched, triggered, time; linear lookups | `BattleScene.applyModifiers*`, `findModifier(s)`, `getModifiers` |
| Move attributes | Calls, attributes considered, time | `applyMoveAttrs` |
| Damage | `getAttackDamage` calls (and how many were simulated), time, hits applied | `Pokemon.getAttackDamage`, `MoveEffectPhase.applyMove` |
| RNG | Raw generator draws, reseeds, state restores | wrapper on `Phaser.Math.RND` |
| Presentation | Timers/tweens scheduled, declared durations (and the `FixedInt` part that ignores game speed), completions, overshoot | wrappers on `scene.time.addEvent` and `scene.tweens.add/chain/addCounter` |
| Runtime | Frames and frame work, long tasks, GC (where the platform exposes them), heap delta per turn | game-loop events, `PerformanceObserver` |

Every reported number is labelled:

- **[M] measured**: timed with `performance.now()` or counted directly.
- **[D] derived**: arithmetic over measured values (e.g. idle = wall − frame work − sync work outside frames).
- **[E] estimated**: based on declared durations rather than observation. Declared waits include non-blocking
  animations (e.g. damage numbers), so they are an upper bound on presentation, not its critical path.

### How time is attributed

Synchronous work is timed with an explicit stack, so nested work (phase → ability → modifier → damage) yields
correct **exclusive** times and nothing is double-counted. Recursive regions only accumulate inclusive time at the
outermost frame. `abilityAttr` is an alternate *view* of ability time (grouped by attribute type) and must not be
summed with the other categories.

Asynchronous time is never labelled as CPU. A phase's **wall lifetime** spans from `start()` to `end()` and includes
waits. A turn's wall time is split into:

- **sync work**: root-level instrumented work (phase `start()`s plus timer/tween completion callbacks, which are
  attributed to the phase that scheduled them as `continuation`), further split into *effect evaluation*
  (abilities + modifiers + move attributes + damage, exclusive) and *other phase code*;
- **engine/render** (browser only): game-loop frame time not covered by instrumented code (rendering, tween
  updates, uninstrumented callbacks);
- **idle/waiting** (browser only): main thread outside frames and instrumented code, i.e. waiting on timers,
  tweens and vsync;
- **unattributed**: whatever is left. In headless runs this is the test harness's own polling.

Limitations: `onUpdate` tween callbacks and promise continuations that run outside a wrapped callback are counted
as engine time; `findModifier` reports list length as an upper bound because `find` can exit early; long tasks and
GC events are only available where the platform supports them (Chromium for long tasks, Node for GC).

## Design constraints it honours

- **Off by default.** Every instrumentation site is guarded by
  `PROFILING_SUPPORTED && battleProfiler.enabled`. `PROFILING_SUPPORTED` is `import.meta.env.MODE !== "production"`.
  In a production build (verified with `vite build`), the console entry point, hook installer and report code are
  not emitted; the small core module and the guards remain, and each guard short-circuits on a constant `false`.
- **No behaviour change.** Hooks call the original functions with the same `this` and arguments; RNG wrappers only
  count. `test/tests/profiling/battle-profiler.test.ts` checks that battle state *and* RNG state are identical with
  the profiler off and on at full trace detail.
- **Bounded memory.** Aggregates are allocated once per key; the trace is a fixed-size typed-array ring buffer
  (default 200 000 events, oldest overwritten, drops reported); per-turn breakdowns are computed from marks
  rather than per-event records.
- **No new dependencies.** The optional browser driver uses Playwright only if it is already installed.

## Usage

### 1. In the browser (presentation, rendering and frame pacing)

Run a development build (`pnpm start:dev`) and open the browser console:

```js
pokerogueProfiler.help();
pokerogueProfiler.start();               // { traceDetail: "phases" | "full" | "off" }
// …play some turns…
pokerogueProfiler.report();              // per-turn breakdown
pokerogueProfiler.download("late-endless");  // .summary.json, .trace.json, .report.txt
pokerogueProfiler.stop();
```

To profile from page load, open the game with `?profile=1` or call `pokerogueProfiler.autostart(true)`
(stored in `localStorage["pokerogue.profiler"]`; `autostart(false)` clears it).

Compare settings deliberately: the turn breakdown records the `gameSpeed` setting value (2–5, where 5 is Turbo).
HP bar speed, move animations and damage numbers also change presentation time.

### 2. Reproducible capture → headless replay (simulation)

1. Load the run to profile with **Continue** (so the live run starts from the save, exactly like the replay will).
2. On turn 1, in the console: `await pokerogueProfiler.capture.start()`.
3. Play the turns of interest, then `pokerogueProfiler.capture.stop(); pokerogueProfiler.capture.download()`.
4. Replay headlessly:

   ```sh
   POKEROGUE_CAPTURE=path/to/pokerogue-battle-capture.json PROFILE_RUNS=5 pnpm profile:replay
   ```

The capture embeds the game's own wave-start save (the data **Continue** loads; it contains no credentials or
tokens), each turn's commands for both sides and a battle checkpoint after every turn. The replay reports whether
its start state matches the capture, whether each turn matches, and whether the replays match each other.
Output goes to `temp/profiles/replay-<timestamp>/`.

Known limits:

- Captures must start on **turn 1** of a wave. Loading a save restarts the wave, so a mid-wave capture cannot
  match the live run (it still replays deterministically against itself).
- Loading a save does not re-apply some wave-start effects (for example, Intimidate's stat drop), so a live run
  that did *not* start from a load can differ from its replay from the very first turn. Starting from **Continue**
  avoids this.
- Replay supports Fight, Tera and switch commands. Item, ball and run commands are not replayed.
- Capture files saved from a different game version may not load.

To profile a real late-game save from production, export it from the game's data management menu, decrypt it with
`pnpm decrypt-save` if needed, import it into the development build, then follow the steps above.

### 3. Headless benchmark (scenarios A/B/C)

```sh
pnpm profile:battle                       # 5 measured runs + 1 warm-up per scenario and mode
PROFILE_RUNS=10 PROFILE_TURNS=5 PROFILE_SCENARIOS=B-late-endless pnpm profile:battle
```

Scenarios (defined in `test/utils/profiling-scenarios.ts`, constructed with overrides, **not** recordings):

- **A-early**: Classic wave 3, single wild battle, no items or passives.
- **B-late-endless**: Endless wave 1005, double battle, 14 held-item types per Pokémon, 15 party modifiers, passives.
- **C-pathological**: B's loadout with Population Bomb + Skill Link into enemies with Stamina and Weak Armor, so
  every strike triggers abilities, stat changes and messages.

Outputs (in `temp/profiles/<timestamp>/`): `benchmark.md`, `benchmark.json`, and per-scenario `*.summary.json` and
`*.trace.json`. The benchmark reports medians, min/max and relative MAD across runs, plus an interleaved A/B
measurement of profiler overhead on the most heavily instrumented path.

Headless numbers measure **simulation only**: the harness resolves tweens instantly and clamps timers to 1 ms. For
realism the benchmark silences `console.log`/`console.debug` (production strips them) and replaces the test
harness's override spies with plain values (spies record every call and otherwise dominate CPU and GC).

### 4. Driving a real browser automatically (optional)

`scripts/battle-profiler/browser-profile.mjs` runs the same scenarios in Chromium through Playwright, applying the
overrides at runtime and issuing commands only when the game waits for input:

```sh
VITE_BYPASS_TUTORIAL=1 pnpm start:dev &
NODE_PATH=$(npm root -g) node scripts/battle-profiler/browser-profile.mjs --runs 3 --turns 3 --configs turbo,max
```

`turbo` sets maximum game speed only; `max` also skips HP bar animation and disables move animations, damage
numbers and the moveset flyout. Use a machine with a GPU: software-rendered (GPU-less) Chromium makes rendering,
not the game, the bottleneck.

### 5. Function-level CPU profiles

The category profiler explains *which kinds* of work cost time. For function-level detail, wrap any of the above in
the existing V8 profiler script, for example:

```sh
pnpm test:profile --no-memory -o temp/cpuprofile test/profiling/benchmark.profile.ts \
  --config test/profiling/profiling.config.ts -t overhead
```

## Reading the trace

Load `*.trace.json` in [Perfetto](https://ui.perfetto.dev) or `chrome://tracing`. Lanes:

| Lane | Contents |
|---|---|
| Sync work (CPU) | Phase `start()`s and continuations; with `traceDetail: "full"`, nested ability/modifier/damage slices |
| Phase lifetime (wall) | One slice per phase from `start()` to `end()`, including waits |
| Turns | One slice per turn, named `Turn w<wave> t<turn>` |
| Frames / long tasks / GC | Game-loop frame work during turns, plus long tasks and GC where available |
| Declared presentation waits | Async slices for each timer/tween at its declared duration (**estimated**) |

A per-turn `effects` counter track shows ability evaluations, modifier calls, hits, messages and RNG draws.
Event names are stable (phase names, ability names, modifier class names, attribute types), so traces from early
and late encounters can be compared directly. `otherData` carries the schema version and metadata.

## Disabling

`pokerogueProfiler.stop()` (or `stopProfiling()`) removes every hook and restores the original methods; collected
data stays available until the next `start()`. `pokerogueProfiler.autostart(false)` clears the auto-start flag.
Production builds cannot enable the profiler at all.

## Files

| Path | Role |
|---|---|
| `src/profiling/battle-profiler.ts` | Dependency-free core: stack timing, aggregates, turns, ring buffer |
| `src/profiling/profiler-hooks.ts` | RNG, timer/tween, frame and observer hooks; `startProfiling` / `stopProfiling` |
| `src/profiling/profile-report.ts` | JSON summary, Chrome trace export, text report |
| `src/profiling/battle-checkpoint.ts` | Canonical battle-state hash and diff |
| `src/profiling/battle-capture.ts` | Capture recorder |
| `src/profiling/profiler-console.ts` | `window.pokerogueProfiler` (dev builds) |
| `test/tests/profiling/*.test.ts` | Profiler correctness, gameplay invariance, capture/replay determinism |
| `test/profiling/*.profile.ts` | Benchmark and replay workflows (`pnpm profile:battle`, `pnpm profile:replay`) |
| `test/utils/profiling-scenarios.ts`, `test/utils/battle-replay.ts` | Scenario definitions and replay helper |
| `scripts/battle-profiler/browser-profile.mjs` | Optional Playwright driver |
