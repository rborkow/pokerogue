<!--
SPDX-FileCopyrightText: 2026 Pagefault Games

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

# Late-Endless Turn Performance: Initial Findings

**Late-Endless turns are slow because they wait, not because they compute.** In browser runs that remove
rendering cost, about 95% of a late-Endless turn is spent idle while serialized presentation waits complete.
Effect evaluation (abilities, items, damage) accounts for under 0.2%. Turn time is almost exactly proportional
to the number of phases the turn queues (r = 0.997), at about 250 ms per phase transition at Turbo speed.
Late-game effects multiply those phases, especially messages and ability flyouts, which no acceleration
setting shortens.

How these numbers were produced, and how to reproduce them, is in [`battle-profiling.md`](./battle-profiling.md).

## What was measured, and how far it can be trusted

Three synthetic scenarios, constructed with overrides (no representative late-game save was available):

| Scenario | Setup |
|---|---|
| **A-early** | Classic wave 3, single wild battle, level 40 Snorlax mirror, no items or passives |
| **B-late-endless** | Endless wave 1005, double battle, 29 player / 28 enemy modifiers (105 / 84 stacks), passives on all four field Pokémon |
| **C-pathological** | B's loadout, but both player Pokémon use Population Bomb + Skill Link into enemies whose Stamina and Weak Armor trigger on every strike |

Two measurement modes:

- **Browser** (`scripts/battle-profiler/browser-profile.mjs`): the real game in headless Chromium, dev build with
  `console.log` silenced (as production strips it). This machine has no GPU, and software WebGL rendered about
  8 fps (one scenario A turn took 3.3 s, 98% of it blocked in rendering). The runs below therefore use
  `--no-render`, which keeps all game logic, timers and tweens but skips drawing, approximating a fast GPU.
  Rendering cost on real hardware is **not measured** here.
- **Headless** (`pnpm profile:battle`): the vitest harness. Measures simulation only (tweens resolve instantly),
  with fully deterministic battles and event counts.

Each browser configuration ran 3 times × 2–3 turns. Only turns that reached `TurnEndPhase` are counted; four turns
that stalled on post-faint prompts the driver does not answer were excluded. Browser battles were **not**
identical across page loads despite a fixed seed (pre-battle code consumes RNG), so B and C turns vary in how many
effects fire. The per-turn event counts make that variation explicable rather than noise (see the scaling section).

Confidence: high for the *shape* of the result (wait-dominated, linear in phase count, messages dominant), because it
holds in every run and both configurations. Moderate for absolute seconds, which depend on the scenario mix and on
text length. Unknown for rendering cost on real GPUs.

## Waiting dominates every turn, and its share grows with run state

Median per turn, browser, rendering disabled. `turbo` = game speed 5 only. `max` = game speed 5, HP bar skip,
move animations off, damage numbers off, moveset flyout off.

| | A turbo | A max | B turbo | B max | C turbo | C max |
|---|---:|---:|---:|---:|---:|---:|
| **Wall-clock** [M] | 0.84 s | 0.50 s | 13.2 s | 10.4 s | 48.4 s | 36.0 s |
| Idle, waiting on timers/tweens [D] | 0.79 s | 0.46 s | 12.6 s | 10.0 s | 46.6 s | 34.4 s |
| Sync CPU, all instrumented code [M] | 29 ms | 22 ms | 341 ms | 315 ms | 812 ms | 823 ms |
| … of which effect evaluation [M] | 1.3 ms | 1.1 ms | 20 ms | 11 ms | 38 ms | 49 ms |
| Engine work in frames (no drawing) [D] | 22 ms | 10 ms | 257 ms | 184 ms | 922 ms | 608 ms |
| Phase transitions [M] | 16 | 16 | 70 | 71 | 195 | 205 |
| Messages [M] | 2 | 2 | 18 | 18 | 46 | 49 |
| Wall relMAD across turns | 1% | 1.5% | 17% | 8% | 6% | 5% |

[M] measured, [D] derived. Idle is 94–96% of wall time in every configuration.

Late-game simulation is not free. Sync CPU grows about 12× from A to B and 28× from A to C. But at 0.3–0.8 s it is
2–3% of the turn. Removing *all* of it would leave a 12.8 s Turbo turn in scenario B.

The accelerations cut A's turn by 40%, but B's by only 21% and C's by 26%: they remove animation-driven waits
(stat-change and move animations), not the waits that late-game effects multiply.

## Messages and ability flyouts are the serialized cost per effect

The profiler attributes each phase's wall lifetime and the waits it schedules. Messages and ability flyouts
**block** for their declared duration: measured wall time matches declared time.

| Phase (browser, late game) | Wall per occurrence | Declared per occurrence | Affected by accelerations? |
|---|---:|---:|---|
| `MessagePhase` | ~450 ms (214 ms in A) | ~440 ms | No |
| `ShowAbilityPhase` | ~316 ms | ~300 ms | No |
| `HideAbilityPhase` | ~55–65 ms | 40 ms | No |
| `StatStageChangePhase` | ~330–450 ms at Turbo | ~290–400 ms | Removed with move animations off |
| `DamageAnimPhase` | ~20 ms | ~2,200 ms | Its waits do **not** block the phase |

Where B and C's time goes (wall per turn, browser):

| | Messages | Ability flyouts (show + hide) | Stat changes | Move effects / anims | Rest |
|---|---:|---:|---:|---:|---:|
| B turbo (13.2 s) | 8.3 s (63%) | 2.2 s (17%) | — | 1.5 s (11%) | ~1.2 s |
| B max (10.4 s) | 8.2 s (79%) | 2.3 s (22%) | ~0 | ~0 | ~0.3 s |
| C turbo (48.4 s) | 21.1 s (44%) | 12.8 s (26%) | 10.0 s (21%) | 3.3 s (7%) | ~1.2 s |
| C max (36.0 s) | 22.5 s (62%) | 13.1 s (36%) | ~0 | ~0.1 s | ~0.3 s |

(Phase wall times can overlap a little with each other, so rows can sum to slightly more than the turn.)

Late-game messages cost twice as much as early ones (450 vs 214 ms) because effect messages are longer: typing time
scales with text length on top of a fixed hold.

Two hypotheses from reading the code turned out wrong under measurement:

- *HP bar drains saturating at 5 s in late game.* The tween exists, but `DamageAnimPhase` ends in ~20 ms and its
  2.2 s of declared waits overlap later phases.
- *Excessive effect processing.* Abilities and items do run thousands of evaluations per turn, but that costs
  tens of milliseconds in total.

## Turn time scales with queued phases, not with modifiers directly

Per-turn wall time against per-turn event counts, browser, 20 Turbo turns across A and B (B varies run to run):

| Predictor | Pearson r (turbo) | Pearson r (max) |
|---|---:|---:|
| Phase transitions | 0.997 | 0.998 |
| Timers + tweens scheduled | 0.991 | 0.997 |
| Messages | 0.978 | 0.999 |
| Sync CPU | 0.950 | 0.988 |

Across C's six Turbo turns, which range from 45 s to 85 s, wall time per phase transition stays within 243–255 ms.
The chain is: accumulated run state (passives, held items) → more effects trigger per action → each effect queues
serialized phases (flyout, message, stat change) → each phase waits a fixed presentation budget. Modifier count raises
*evaluation* work (19,000 modifier entries scanned per turn in B, against 0 in A) but not the waits, unless an effect
actually triggers.

Frame alignment adds a measurable tax: completed waits overshot their declared duration by about one frame each
(B turbo: ~1.3 s per turn over 118 waits; C turbo: ~3.8 s over 350). Serialized waits each round up to the next frame.

## Repeated work exists, but it is not why turns are slow

Headless, deterministic counts per turn (`pnpm profile:battle`, 5 runs, relMAD ≤ 5% on times, counts identical):

| Per turn | A | B | C |
|---|---:|---:|---:|
| Ability evaluations (activations) | 155 (0) | 4,004 (6) | 5,396 (36) |
| … simulated (AI / previews) | 66 | 3,034 | 3,752 |
| Modifier apply calls → triggered | 74 → 0 | 673 → 44 | 898 → 70 |
| Modifier list entries scanned | 0 | 19,140 | 25,531 |
| Sync CPU [M] | see benchmark | 45 ms | 88 ms |

A V8 CPU profile of simulated damage calculations, about 330 µs each in late game, is dominated by ability plumbing:
`applySingleAbAttrs`, `getAbility` / `getPassiveAbility`, `canApplyAbility`, `hasPassive` and `Ability.getAttrs`, which
allocates a filtered array on every call. Each damage calculation performs about 128 ability evaluations. Linear
`instanceof` scans over the whole modifier list (`applyModifiers`) are the other repeated cost.

These are genuinely wasteful: 99.85% of B's ability evaluations activate nothing. But fixing them buys tens of
milliseconds per turn against seconds of waiting.

## Answers to the investigation questions

1. **Simulation, presentation waits, rendering or something else?** Presentation waits: 94–96% of turn time with
   drawing disabled. Simulation is 2–3%. Rendering is unmeasured on real GPUs; on this GPU-less machine it dominated.
2. **Largest share of measured time?** `MessagePhase` (44–79% of late turns), then ability flyouts (17–36%), then
   stat-change animations at Turbo (up to 21%). Among CPU work, ability evaluation plumbing and modifier scans.
3. **Does work scale with modifiers, triggered effects, hits or run state?** Wall time scales linearly with phase
   transitions (r = 0.997), which scale with *triggered* effects and hits. Modifier count drives evaluation work
   (scans grow with the modifier list) but not waiting.
4. **Unnecessary repeated checks or allocations?** Yes: thousands of no-op ability evaluations per turn, per-call
   `getAttrs` array allocation, and full modifier-list scans per application. Real but small (tens of ms per turn).
5. **Would moving simulation off the main thread help?** Not materially. At most it would hide the 0.3–0.8 s of sync
   CPU in a 10–48 s turn; the waits are deliberate pacing and would remain. It would also add serialization and
   ordering risk.
6. **Evidence that Rust/WASM would help?** None. The code Rust could accelerate is 2–3% of turn time; even an
   infinitely fast simulation would leave over 97% of a late turn in place. A rewrite's cost and regression risk are
   not justified by these measurements.
7. **What to test first?** Below.

## Recommendations, ranked

Ranked by expected benefit relative to effort and regression risk. Benefits are **estimates** derived from the
measured per-phase costs; each should be verified with the profiler before and after.

| # | Change to test | Expected benefit (late game) | Effort | Regression risk |
|---|---|---|---|---|
| 1 | **Shorten or batch effect messages at high speed.** E.g. a "fast battle messages" setting that scales message hold and typing beyond `gameSpeed`, or merging consecutive item/ability trigger messages into one. | Messages are 63–79% of B. Halving per-message time saves ~4 s of a 13 s Turbo turn (est.). | Low–medium | Low (presentation only; message *content and order* unchanged) |
| 2 | **Stop serializing ability flyouts.** Keep the bar visible across consecutive activations by the same Pokémon, and let the flyout overlap its message rather than run as separate Show/Hide phases. | 17–36% of late turns; ~370 ms per activation. | Medium | Low–medium (UI timing; tests that count phases) |
| 3 | **Aggregate per-strike feedback in multi-hit turns.** One "Sp. Def rose sharply ×N" message instead of one stat-change phase and message per strike. | Most of C's stat-change and per-strike message time (est. 10–20 s of a 48 s turn). | Medium | Medium (message text and order change for multi-hit moves) |
| 4 | **Remove the per-wait frame tax.** Phaser only inserts a new timer at the next frame's pre-update, so each serialized wait rounds up to a frame boundary. Chaining the next phase directly when a wait ends (where ordering allows) avoids the extra frame. | ~1 frame per serialized wait: ~1–4 s per late turn (measured overshoot). | Low–medium | Low |
| 5 | **Measure rendering on real GPUs** with `browser-profile.mjs` without `--no-render`, and on a captured real late-Endless save. | Closes the remaining unknown before optimizing rendering. | Low | None |
| 6 | **Cheap simulation fixes.** Cache `Ability.getAttrs(type)` results, skip passive lookups when there is no passive, and index modifiers by constructor. | 10–20 ms per late turn in the browser; worthwhile for AI previews, not for perceived speed. | Low | Low–medium (cache invalidation on form/ability changes) |
| 7 | Off-main-thread simulation or Rust/WASM. | ≤ 3% of turn time. | Very high | High |

**Not recommended** without new evidence: rewriting the battle engine, a worker-based simulation, or Rust/WASM.

## Reproducibility notes found along the way

- Headless runs are fully deterministic: profiler-off vs. profiler-on and repeated replays produce identical battle
  state and RNG, verified by checkpoint hashes, not just seeds.
- Browser runs with a fixed seed are **not** reproducible across page loads. Use save-based capture (start on turn 1
  after **Continue**) and `pnpm profile:replay` for exact reproduction.
- Loading a save does not re-apply some wave-start effects (Intimidate's stat drop was lost on reload), so a live run
  can differ from a reload of its own wave-start save. This looks like a pre-existing gameplay inconsistency and is
  outside this investigation's scope.
- The test harness's override spies record every call and, before they were materialized, made up most of headless
  CPU time (53% GC). Headless timings without that correction overstate simulation cost about 5×.

## Profiler overhead

Interleaved A/B on the most heavily instrumented path (simulated damage calculations), 7 batches × 2,000 calls:
**+15%** (330 → 380 µs per call; relMAD 1–6%). This is a worst case: whole turns contain uninstrumented work, and
browser `performance.now()` is cheaper than jsdom's. When disabled, each instrumentation site is a constant-false
check, and production builds cannot enable the profiler.
