/*
 * Module holding functions to apply move attributes.
 * Must not import anything that is not a type
 * (the dependency-free profiler module is the sole exception).
 */

import { battleProfiler, PROFILING_SUPPORTED } from "#app/profiling/battle-profiler";
import type { Pokemon } from "#field/pokemon";
import type { Move, MoveAttr } from "#moves/move";
import type { ChargingMove, MoveAttrFilter, MoveAttrString } from "#types/move-types";

function applyMoveAttrsInternal(
  attrFilter: MoveAttrFilter,
  user: Pokemon | null,
  target: Pokemon | null,
  move: Move,
  args: any[],
): void {
  move.attrs.filter(attr => attrFilter(attr)).forEach(attr => attr.apply(user, target, move, args));
}

function applyMoveChargeAttrsInternal(
  attrFilter: MoveAttrFilter,
  user: Pokemon | null,
  target: Pokemon | null,
  move: ChargingMove,
  args: any[],
): void {
  move.chargeAttrs.filter(attr => attrFilter(attr)).forEach(attr => attr.apply(user, target, move, args));
}

export function applyMoveAttrs(
  attrType: MoveAttrString,
  user: Pokemon | null,
  target: Pokemon | null,
  move: Move,
  ...args: any[]
): void {
  if (!(PROFILING_SUPPORTED && battleProfiler.enabled)) {
    applyMoveAttrsInternal((attr: MoveAttr) => attr.is(attrType), user, target, move, args);
    return;
  }
  const profStat = battleProfiler.stat("moveAttr", attrType);
  profStat.a += move.attrs.length;
  battleProfiler.begin(profStat);
  try {
    applyMoveAttrsInternal((attr: MoveAttr) => attr.is(attrType), user, target, move, args);
  } finally {
    battleProfiler.end();
  }
}

export function applyFilteredMoveAttrs(
  attrFilter: MoveAttrFilter,
  user: Pokemon,
  target: Pokemon | null,
  move: Move,
  ...args: any[]
): void {
  applyMoveAttrsInternal(attrFilter, user, target, move, args);
}

export function applyMoveChargeAttrs(
  attrType: MoveAttrString,
  user: Pokemon | null,
  target: Pokemon | null,
  move: ChargingMove,
  ...args: any[]
): void {
  applyMoveChargeAttrsInternal((attr: MoveAttr) => attr.is(attrType), user, target, move, args);
}
