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
setting shortens. Prototyping the two main fixes (faster messages and a non-blocking ability flyout) cut wall time
per phase by 44–66% in late-game scenarios without changing battle outcomes.

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

Completed waits also overshoot their declared duration by about two-thirds of a frame each (B turbo: ~1.3 s per
turn over 118 waits; C turbo: ~3.8 s over 350). This is frame quantization: a timer or tween can only finish on a
frame boundary. Phaser does insert new timers at the next frame, but the first update then credits a whole frame's
delta, which compensates. So the overshoot cannot be removed by chaining phases differently. It only shrinks when
there are fewer serialized waits.

## Repeated work exists, but it is not why turns are slow

Headless, deterministic counts per turn (`pnpm profile:battle`, 5 runs, relMAD ≤ 5% on times, counts identical):

| Per turn | A | B | C |
|---|---:|---:|---:|
| Ability evaluations (activations) | 155 (0) | 4,004 (6) | 5,396 (36) |
| … simulated (AI / previews) | 66 | 3,034 | 3,752 |
| Modifier apply calls → triggered | 74 → 0 | 673 → 44 | 898 → 70 |
| Modifier list entries scanned | 0 | 19,140 | 25,531 |
| Sync CPU, headless [M] | 5.1 ms | 43 ms | 93 ms |

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
7. **What to test first?** The non-blocking ability flyout and faster messages; prototypes cut late-game time per phase by 44–66% (see below).

## Prototyped fixes and their measured impact

Each candidate fix was prototyped as a patch (in [`experiments/`](./experiments/)), measured with the same browser
setup, and then reverted, so the code under review is unchanged. All five patches leave battle state and RNG
**identical** to the baseline over three turns of scenarios B and C (`test/profiling/checkpoints.profile.ts`
compares checkpoint hashes). They change pacing, not outcomes.

| Patch | Change |
|---|---|
| **E1** faster messages | Default message hold 1,500 → 500 ms and typing 20 → 10 ms per character (both still divided by game speed) |
| **E2** non-blocking ability flyout | `ShowAbilityPhase` starts the fly-in tween and ends at once; the bar stays visible while the message shows, and `HideAbilityPhase` hides it |
| **E3** coalesced message runs | A message whose next queued phase is also a message gets a 500 ms hold instead of 1,500 ms |
| **E1+E2+E3** combined | All three, with holds of 500 ms (last message of a run) and 250 ms (followed by another message) |
| **E6** cached ability attributes | `Ability.getAttrs(type)` caches its filtered array per type instead of filtering on every call |

Browser runs (rendering disabled, as above) used a fresh dev server per patch and a baseline rerun under identical
conditions: B with 3 runs × 3 turns, C with 2 runs × 2 turns, at both Turbo and max acceleration. Because browser
battles differ between page loads, the comparison metric is **wall time per phase transition**, which the
baseline showed to be nearly constant within a configuration. Median turn times are shown for context.

| ms per phase transition (change vs. baseline) | E1 | E2 | E3 | **Combined** |
|---|---:|---:|---:|---:|
| B late Endless, Turbo (baseline 186) | 127 (−32%) | 164 (−12%) | 192 (+3%) | **104 (−44%)** |
| B late Endless, max (baseline 151) | 89 (−41%) | 125 (−17%) | 148 (−2%) | **64 (−58%)** |
| C pathological, Turbo (baseline 219) | 185 (−16%) | 178 (−18%) | 221 (+1%) | **121 (−45%)** |
| C pathological, max (baseline 174) | 105 (−40%) | 121 (−30%) | 165 (−5%) | **60 (−66%)** |

| Median turn time | Baseline | Combined |
|---|---:|---:|
| A early, Turbo / max | 0.84 s / 0.50 s | 0.74 s / 0.40 s |
| B late Endless, Turbo / max | 13.0 s / 11.3 s | 6.9 s / 4.3 s |
| C pathological, Turbo / max | ~32–48 s / 36.8 s | 17.3 s / 7.7 s |

C's turn times vary with how many strikes land, so use its per-phase figures.

What each result shows:

- **E1 works as predicted.** Message cost fell from ~435 ms to 196 ms. The effect is largest with max acceleration,
  where messages are a larger share of what is left.
- **E2 removes the flyout's blocking time entirely** (316 ms → 0 per activation) without changing message time.
  It matters most where activations are dense (C max: −30%).
- **E3 did nothing.** Message cost was unchanged (431–449 ms). Effect messages are almost never directly followed
  by another message: each is bracketed by its own flyout or stat-change phase, so the coalescing condition rarely
  held. Batching only pays off if the flyout and stat-change phases around each message are merged as well.
- **The effects compound.** Combined, late-Endless turns with every acceleration take 4.3 s instead of 11.3 s, and
  early turns get slightly faster rather than slower.
- **E6 helps simulation slightly, as the profile predicted.** Headless sync CPU per turn fell 6% in B
  (40.4 → 38.1 ms) and 7% in C (87.9 → 82.0 ms), 3 runs each; per simulated damage calculation the change was −1%,
  within noise. Against browser turns of 10–48 s, that is a few milliseconds, well under 1% of turn time.

What was **not** checked: whether messages remain readable at these speeds, and how the overlapping flyout looks.
Both are design decisions, not performance questions, and need a visual review. E1 at Turbo leaves about 100 ms of
hold after typing finishes, which is probably too fast to read as a default but plausible as an opt-in setting.

## Recommendations, ranked

Ranked using the measured results above.

| # | Change | Measured benefit | Effort | Regression risk |
|---|---|---|---|---|
| 1 | **Non-blocking ability flyout** (E2): let the bar fly in alongside the message instead of as its own blocking phase. | −12% to −30% per phase; no change to message text. | Low (a few lines in `ShowAbilityPhase`) | Low (presentation only; checkpoint-identical) |
| 2 | **Faster battle messages as an opt-in setting** (E1): a message speed option that shortens hold and typing beyond `gameSpeed`. | −16% to −41% per phase; −55% per message. | Low–medium (setting plus `MessagePhase`) | Low as opt-in; readability needs design review |
| 3 | **Ship 1 and 2 together.** | −44% to −66% per phase; late Endless at max acceleration 11.3 s → 4.3 s per turn. | Sum of the above | As above |
| 4 | **Merge per-effect phase groups**, not just consecutive messages: one combined flyout + message for an activation, and one aggregated stat-change message per multi-hit move. | Not measured. E3 shows that naive coalescing does nothing; gains require restructuring how effects queue phases. | Medium–high | Medium (message text and order change) |
| 5 | **Measure rendering on real GPUs** with `browser-profile.mjs` without `--no-render`, and on a captured real late-Endless save. | Closes the remaining unknown. | Low | None |
| 6 | **Simulation fixes** such as E6. | E6: −6% to −7% of headless sync CPU, under 1% of turn time. Worth doing for code health, not perceived speed. | Low | Low–medium (cache invalidation) |
| 7 | Off-main-thread simulation or Rust/WASM. | ≤ 3% of turn time. | Very high | High |

Dropped from the earlier list: "remove the per-wait frame tax". Investigating the mechanism showed the overshoot is
frame quantization, not an insertion delay that chaining could avoid (see the scaling section).

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
**+4% to +15%** across two benchmark runs (330 → 344 µs and 329 → 380 µs per call; per-run relMAD 1–6%). The
spread between runs is as large as the effect, so treat it as "low tens of percent at worst". This path is a worst
case: whole turns contain uninstrumented work, and browser `performance.now()` is cheaper than jsdom's. When disabled, each instrumentation site is a constant-false
check, and production builds cannot enable the profiler.
