import { RANGE_POSITIONS_CACHE_MAX_ENTRIES } from "./constants";
import type { Activity } from "./configuration";
import { actorSys, itemSys, asDnd5eActor, getItemsOfType, getItemActivities, isRecord, getTokenLayer } from "./foundry-helpers";
import { isActorAtZeroHp, isActorUnableToAct, setActorStatusEffect, setActorStabilized, getBlessBonusIfAny, applyDamageAtZeroHp } from "./actor-status";
import { pixelToGrid, toGridRect } from "./grid";
import { withRangeTemplate, getTemplateHighlightedGridPositions, getTokensInTemplate } from "./templates";
import { canCastSpell, type ItemWithUse } from "./spells";
import { clearGuidingBoltFlag, getActiveGuidingBoltTargetIds } from "./spell-execution";
import type { Entity, AttackResult } from "./entity";

export type DamageRoll = {
  total: number;
  options?: {
    type?: string;
    types?: string[];
    properties?: string[];
    rollType?: string;
    isCritical?: boolean;
  }
}

export type AttackRollLike = {
  total: number;
  isCritical?: boolean;
  isFumble?: boolean;
  parent?: {
    flags?: {
      dnd5e?: {
        targets?: unknown;
      }
    }
  };
};

export type TargetDescriptorLike = {
  ac: number;
  uuid: string;
};

export type WeaponInfo = { name: string; reach: number };

export type AmmunitionOption = { value: string; disabled?: boolean };

export type RangeZoneState = "None" | "Inside" | "Exited";
export type WeaponRangeZone = {
  enemyTokenId: string;
  weaponName: string;
  reach: number;
  positions: { x: number; y: number }[];
  state: RangeZoneState;
  lastInsidePos?: { x: number; y: number };
}

const rangePositionsCache = new Map<string, { x: number; y: number }[]>();

export function clearRangePositionsCache(): void {
  rangePositionsCache.clear();
}

export function getTargetsFromAttackRoll(attack: AttackRollLike): TargetDescriptorLike[] {
  const targets = attack.parent?.flags?.dnd5e?.targets;
  if (!Array.isArray(targets)) return [];
  return targets.filter((value: unknown): value is TargetDescriptorLike => {
    return isRecord(value) && typeof value["ac"] === "number" && typeof value["uuid"] === "string";
  });
}

export function asDamageRollArray(value: unknown): DamageRoll[] {
  const isDamageRoll = (value: unknown): value is DamageRoll => {
    return isRecord(value) && typeof value["total"] === "number";
  };
  if (Array.isArray(value)) return value.filter(isDamageRoll);
  if (isDamageRoll(value)) return [value];
  return [];
}

export function buildDamageApplicationData(rolls: DamageRoll[]): Record<string, unknown> {
  const parts = rolls.map(r => ({
    amount: r.total,
    type: r.options?.type ?? r.options?.types?.[0] ?? "none"
  }));

  const types = Array.from(new Set(parts.map(p => p.type).filter(t => t && t !== "none")));
  const properties = Array.from(new Set(rolls.flatMap(r => r.options?.properties ?? [])));

  return {
    parts,
    types,
    type: types[0],
    properties
  };
}

export function getUsableAmmunitionIdOrNull(weapon: Item): string | undefined | null {
  const ammoOptions = itemSys(weapon).ammunitionOptions;
  if (!Array.isArray(ammoOptions) || ammoOptions.length === 0) return undefined;
  const usable = ammoOptions.find((o): o is AmmunitionOption => {
    if (typeof o !== "object") return false;
    const rec = o as Record<string, unknown>;
    const value = rec["value"];
    const disabled = rec["disabled"];
    return typeof value === "string" && value.length > 0 && disabled !== true;
  });
  return usable?.value ?? null;
}

export function getEquippedWeaponsWithReach(token: TokenDocument): WeaponInfo[] {
  const actor = token.actor;
  if (!actor) return [];
  const allWeapons = getItemsOfType(actor.items, "weapon")
    .filter(i => itemSys(i).attackType !== "ranged")
    .filter(i => (itemSys(i).quantity ?? 1) > 0);
  const equipped = allWeapons.filter(i => itemSys(i).equipped);
  if (equipped.length === 0) return [{ name: "Unarmed Strike", reach: 5 }];
  return equipped.map(w => {
    const range = itemSys(w).range;
    return { name: w.name, reach: range?.reach ?? range?.value ?? 5 };
  });
}

export function getRangeZoneIntersection(
  path: { x: number; y: number }[],
  zone: WeaponRangeZone,
  moverWidth: number = 1,
  moverHeight: number = 1
): RangeZoneState {
  for (const step of path) {
    // Check if any cell of the moving token's footprint overlaps with the range zone
    let overlaps = false;
    for (let dx = 0; dx < moverWidth && !overlaps; dx++) {
      for (let dy = 0; dy < moverHeight && !overlaps; dy++) {
        const cellX = step.x + dx;
        const cellY = step.y + dy;
        if (zone.positions.some(pos => pos.x === cellX && pos.y === cellY)) {
          overlaps = true;
        }
      }
    }
    if (overlaps) {
      if (zone.state === "None") {
        zone.state = "Inside";
      }
      zone.lastInsidePos = step;
    } else {
      if (zone.state === "Inside") {
        zone.state = "Exited";
        return zone.state;
      }
    }
  }
  return zone.state;
}

export async function getPositionsInRange(
  token: TokenDocument,
  rangeUnits: number,
  scene: Scene,
): Promise<{ x: number; y: number }[]> {
  const cacheKey = [scene.id, token.id, token.x, token.y, token.width, token.height, token.elevation, rangeUnits].join(":");
  const cached = rangePositionsCache.get(cacheKey);
  if (cached) return cached;

  const setCache = (positions: { x: number; y: number }[]) => {
    if (rangePositionsCache.size >= RANGE_POSITIONS_CACHE_MAX_ENTRIES) rangePositionsCache.clear();
    rangePositionsCache.set(cacheKey, positions);
    return positions;
  };

  const highlighted = await withRangeTemplate<{ x: number; y: number }[]>(scene, token, rangeUnits, (templateObj) => {
    return getTemplateHighlightedGridPositions(templateObj, scene);
  });

  if (!highlighted) return [];

  const topLeft = pixelToGrid(token.x, token.y, scene);
  if (!topLeft) return setCache(highlighted);

  const tokenWidth = token.width;
  const tokenHeight = token.height;
  return setCache(highlighted.filter(position => !(
    position.x >= topLeft.x &&
    position.x < topLeft.x + tokenWidth &&
    position.y >= topLeft.y &&
    position.y < topLeft.y + tokenHeight
  )));
}

// consolidate this eventually, this is lame
export async function hasEnemyInMeleeRange(token: TokenDocument, scene: Scene): Promise<boolean> {
  const enemies = scene.tokens.filter(t => {
    if (t.id === token.id) return false;
    if (t.combatant?.defeated) return false;
    if (isActorAtZeroHp(t.actor ?? undefined)) return false;
    return t.disposition !== token.disposition;
  });
  if (enemies.length === 0) return false;

  const inMelee = await withRangeTemplate<TokenDocument[]>(scene, token, 5, (templateObj) => {
    return getTokensInTemplate(templateObj, scene, enemies);
  });

  return (inMelee?.length ?? 0) > 0;
}

// Only use it if it's good, but even then, only use it 50% of the time, because random agents are dumb
// Should they use it everytime? Like. Probably. But. Whatever
export async function maybeUseShieldReaction(
  targetToken: TokenDocument,
  attackTotal: number,
  isCritical: boolean,
  usedReaction?: Set<string>
): Promise<boolean> {
  if (!targetToken.id || !targetToken.actor) return false;
  if (usedReaction?.has(targetToken.id)) return false;
  if (isCritical) return false;
  if (attackTotal >= ((actorSys(targetToken.actor).attributes?.ac?.value) ?? 0) + 5) return false;
  if (Math.random() >= 0.5) return false;

  const shieldSpell = targetToken.actor.items.getName("Shield") ?? targetToken.actor.items.getName("shield");
  if (!shieldSpell) return false;
  if (!canCastSpell(targetToken.actor, shieldSpell)) return false;

  const useSpell = shieldSpell as ItemWithUse;
  if (typeof useSpell.use !== "function") return false;

  const oldTargets = game.user?.targets;
  if (!canvas) return false;
  const tokensLayer = getTokenLayer();
  let useResult: unknown;
  try {
    tokensLayer?.setTargets?.([]);
    if (targetToken.object) {
      targetToken.object.setTarget(true, { releaseOthers: false });
    }
    useResult = await useSpell.use(
      { create: { measuredTemplate: false }, midiOptions: { autoRollDamage: "none", autoFastDamage: true } },
      { configure: false },
      {},
    );
  } finally {
    tokensLayer?.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
  }
  if (useResult === false || useResult == null) return false;

  usedReaction?.add(targetToken.id);
  return true;
}

export async function rollAttack(entity: Entity, weaponName: string, ammunitionId?: string, usedReaction?: Set<string>): Promise<AttackResult | null> {
  const scene = canvas?.scene;
  if (!scene) return null;

  const actor = scene.tokens.get(entity.id ?? "")?.actor;
  if (!actor) return null;

  const item = actor.items.getName(weaponName) ?? actor.items.find(i => i.name === weaponName);
  if (!item) {
    console.error(`Actor ${actor.name} does not have item ${weaponName}`);
    return null;
  }

  const activities = getItemActivities(item);
  const activity = activities.find(a => a.type === "attack");

  if (!activity) {
    console.error(`Item ${weaponName} does not have an attack activity`);
    return null;
  }

  if (!activity.rollAttack) {
    console.error(`Item ${weaponName} does not have an attack roll defined`);
    return null;
  }

  if (!activity.rollDamage) {
    console.error(`Item ${weaponName} does not have a damage roll defined`);
    return null;
  }

  const ammoItem = ammunitionId ? actor.items.get(ammunitionId) : undefined;

  const guidingBoltTargets = await getActiveGuidingBoltTargetIds(scene);

  const attackConfig: Record<string, unknown> = {};
  if (ammoItem?.id) attackConfig["ammunition"] = ammoItem.id;

  if (guidingBoltTargets.size > 0) {
    attackConfig["advantage"] = true;
  }

  const attackResult = await activity.rollAttack(attackConfig, { configure: false });
  const attackRolls = Array.isArray(attackResult) ? attackResult.filter((value: unknown): value is AttackRollLike => {
    return isRecord(value) && typeof value["total"] === "number";
  }) : [];
  const attack = attackRolls[0];
  if (!attack) {
    console.error("No attack rolls returned for item", weaponName, attackResult);
    return null;
  }

  const blessBonus = await getBlessBonusIfAny(actor);
  const effectiveAttackTotal = attack.total + blessBonus;

  const result: AttackResult = {
    attacker: entity.name,
    attackerId: entity.id ?? "",
    weapon: weaponName,
    attackTotal: effectiveAttackTotal,
    isCritical: attack.isCritical === true,
    isFumble: attack.isFumble === true,
    kind: "action",
    targets: []
  };

  const targets = getTargetsFromAttackRoll(attack);
  if (targets.length === 0) {
    console.log("No targets for attack");
    return result;
  }
  const hitTargetIds = new Set<string>();
  for (const target of targets) {
    const isCritical = attack.isCritical === true;
    const isFumble = attack.isFumble === true;
    let targetTokenId = "";
    const beforeActor = target.uuid.split(".Actor")[0] ?? "";
    const fromTokenSegment = beforeActor.split("Token.")[1] ?? "";
    if (fromTokenSegment) {
      targetTokenId = fromTokenSegment;
    } else {
      const actorId = target.uuid.split(".").pop() ?? "";
      const tokenForActor = scene.tokens.find(t => t.actorId === actorId);
      targetTokenId = tokenForActor?.id ?? "";
    }
    const targetToken = targetTokenId ? scene.tokens.get(targetTokenId) : undefined;
    let hit = isCritical || (effectiveAttackTotal >= target.ac && !isFumble);
    if (hit && targetToken) {
      const shieldUsed = await maybeUseShieldReaction(targetToken, effectiveAttackTotal, isCritical, usedReaction);
      if (shieldUsed) {
        hit = false;
      }
    }

    // Clear guiding bolt flag on any attack attempt
    if (targetTokenId && guidingBoltTargets.has(targetTokenId)) {
      const token = scene.tokens.get(targetTokenId);
      if (token) await clearGuidingBoltFlag(token);
    }

    if (!hit) {
      console.log(`Attack missed target with AC ${target.ac}`);
      if (targetToken?.object) {
        targetToken.object.setTarget(false, { releaseOthers: false });
      }
      result.targets.push({ name: targetToken?.name ?? "Unknown", tokenId: targetTokenId, ac: target.ac, hit: false, damageDealt: 0 });
    } else {
      hitTargetIds.add(targetTokenId);
      result.targets.push({ name: targetToken?.name ?? "Unknown", tokenId: targetTokenId, ac: target.ac, hit: true, damageDealt: 0 });
    }
  }

  if (hitTargetIds.size > 0) {
    const damageConfig: Record<string, unknown> = { isCritical: !!attack.isCritical };
    if (ammoItem) {
      damageConfig["ammunition"] = ammoItem;
    }
    const damageResult = await activity.rollDamage(damageConfig, { configure: false });
    const damageRolls = asDamageRollArray(damageResult);
    if (damageRolls.length === 0) {
      console.error(`No damage rolls returned for item ${weaponName}`);
      return result;
    }
    const multiplier: number = 1;
    const totalDamage = damageRolls.reduce((sum, dr) => sum + dr.total, 0);
    const damageData = buildDamageApplicationData(damageRolls);
    for (const target of result.targets) {
      if (!target.hit || !target.tokenId) continue;
      target.damageDealt = totalDamage;
    }

    for (const target of result.targets.filter(t => t.hit && t.tokenId)) {
      const token = scene.tokens.get(target.tokenId);
      if (!token?.actor) continue;

      if (isActorAtZeroHp(token.actor)) {
        if (token.disposition !== 1) continue; // enemies already dead at 0 HP
        // Damage to a 0 HP friendly: add death save failures
        const failCount = result.isCritical ? 2 : 1;
        await applyDamageAtZeroHp(token.actor, token.name, totalDamage, failCount, "damage");
        continue;
      }

      await setActorStatusEffect(token.actor, "unconscious", false);

      const damageActor = asDnd5eActor(token.actor);
      if (typeof damageActor.applyDamage !== "function") {
        console.warn("applyDamage is not available on this actor; skipping damage application.", damageActor);
        continue;
      }

      await damageActor.applyDamage(totalDamage, { multiplier: multiplier, damage: damageData });

      // If the target just dropped to 0 HP, mark them unconscious
      if (isActorAtZeroHp(token.actor)) {
        await setActorStatusEffect(token.actor, "unconscious", true);
      }
    }

  }
  return result;
}

export async function checkNearbyReactions(scene: Scene, entity: Entity, usedReaction: Set<string>): Promise<boolean> {
  for (const token of scene.tokens) {
    if (token.disposition === entity.disposition) continue;
    if (usedReaction.has(token.id)) continue;
    if (token.actor && isActorUnableToAct(token.actor)) continue;
    const weapons = getEquippedWeaponsWithReach(token);
    const reachValues = [...new Set(weapons.map(w => w.reach))];
    for (const reach of reachValues) {
      const rangePositions = await getPositionsInRange(token, reach, scene);
      const entityRect = toGridRect(entity, scene);
      if (!entityRect) continue;
      if (rangePositions.some(pos => {
        return pos.x >= entityRect.x &&
          pos.x < entityRect.x + entityRect.width &&
          pos.y >= entityRect.y &&
          pos.y < entityRect.y + entityRect.height;
      })) {
        return true;
      }
    }
  }
  return false;
}

// Rolls damage/healing for a spell effect activity, handles save DC reduction, and applies
// the resulting damage to selectedTargets. Returns a map of tokenId -> signed amount applied
// (negative = healing). attackHitTokenIds: when provided (attack roll spells), only tokens in
// the set receive damage; pass null for non-attack spells.
export async function applySpellEffectDamage(
  effectActivity: Activity,
  selectedTargets: TokenDocument[],
  attackHitTokenIds: Set<string> | null,
): Promise<Map<string, number>> {
  const damageApplied = new Map<string, number>();

  const isHealingActivity = effectActivity.type === "heal";

  if (!isHealingActivity && effectActivity.type === "attack" && attackHitTokenIds !== null && attackHitTokenIds.size === 0) {
    return damageApplied;
  }

  let damageResult: unknown;
  if (isHealingActivity) {
    if (typeof effectActivity.rollHealing === "function") {
      damageResult = await effectActivity.rollHealing({}, { configure: false });
    } else if (typeof effectActivity.rollDamage === "function") {
      damageResult = await effectActivity.rollDamage({}, { configure: false });
    }
  } else if (typeof effectActivity.rollDamage === "function") {
    damageResult = await effectActivity.rollDamage({}, { configure: false });
  }

  const damageRolls = asDamageRollArray(damageResult);
  if (damageRolls.length === 0) return damageApplied;

  const totalAmount = damageRolls.reduce((sum, dr) => sum + dr.total, 0);
  const appliedAmount = isHealingActivity ? -totalAmount : totalAmount;
  const damageData = buildDamageApplicationData(damageRolls);

  const extractRollTotal = (rollResult: unknown): number | undefined => {
    if (typeof rollResult === "object" && rollResult !== null) {
      const rec = rollResult as Record<string, unknown>;
      if (typeof rec["total"] === "number" && Number.isFinite(rec["total"])) return rec["total"];
      if (typeof rec["_total"] === "number" && Number.isFinite(rec["_total"])) return rec["_total"];
    }
    if (Array.isArray(rollResult)) {
      for (const entry of rollResult) {
        const nested = extractRollTotal(entry);
        if (typeof nested === "number") return nested;
      }
    }
    return undefined;
  };

  const getSaveOutcome = async (token: TokenDocument): Promise<boolean | undefined> => {
    if (effectActivity.type !== "save") return undefined;
    const saveData = effectActivity.save;
    const abilitySet = saveData?.ability;
    const ability = abilitySet instanceof Set
      ? abilitySet.values().next().value
      : (Array.isArray(abilitySet) ? abilitySet[0] : undefined);
    const dc = saveData?.dc?.value;
    if (!ability || typeof dc !== "number" || !token.actor) return undefined;

    const saveActor = asDnd5eActor(token.actor);
    if (typeof saveActor.rollSavingThrow !== "function") return undefined;
    const speaker = ChatMessage.getSpeaker({ actor: token.actor, scene: canvas?.scene, token });
    const saveRoll = await saveActor.rollSavingThrow(
      { ability, target: dc },
      { configure: false },
      { data: { speaker } }
    );
    const total = extractRollTotal(saveRoll);
    if (typeof total !== "number") return undefined;
    const blessBonus = await getBlessBonusIfAny(token.actor);
    return (total + blessBonus) >= dc;
  };

  const savedByTokenId = new Map<string, boolean>();
  if (!isHealingActivity && effectActivity.type === "save") {
    for (const token of selectedTargets) {
      if (!token.id || !token.actor) continue;
      const saved = await getSaveOutcome(token);
      if (typeof saved === "boolean") savedByTokenId.set(token.id, saved);
    }
  }

  for (const token of selectedTargets) {
    if (!token.id || !token.actor) continue;
    const damageActor = asDnd5eActor(token.actor);
    if (typeof damageActor.applyDamage !== "function") continue;

    if (!isHealingActivity && effectActivity.type === "attack" && attackHitTokenIds !== null) {
      if (!attackHitTokenIds.has(token.id) && !(token.actor.id && attackHitTokenIds.has(token.actor.id))) continue;
    }

    let tokenAmount = appliedAmount;
    if (!isHealingActivity && effectActivity.type === "save") {
      const saved = savedByTokenId.get(token.id);
      const onSave = (effectActivity.damage?.onSave ?? "half").toLowerCase();
      const saveMultiplier = saved
        ? (onSave === "none" ? 0 : onSave === "half" ? 0.5 : 1)
        : 1;
      tokenAmount = saveMultiplier === 1
        ? appliedAmount
        : (appliedAmount >= 0
          ? Math.floor(appliedAmount * saveMultiplier)
          : Math.ceil(appliedAmount * saveMultiplier));
    }

    if (tokenAmount !== 0) {
      if (!isHealingActivity && isActorAtZeroHp(token.actor) && tokenAmount > 0 && token.disposition === 1) {
        await applyDamageAtZeroHp(token.actor, token.name, tokenAmount, 1, "spell damage");
      } else {
        const wasAtZeroHp = isActorAtZeroHp(token.actor);
        await setActorStatusEffect(token.actor, "unconscious", false);
        await damageActor.applyDamage(tokenAmount, { multiplier: 1, damage: damageData });
        if (!isHealingActivity && isActorAtZeroHp(token.actor)) {
          await setActorStatusEffect(token.actor, "unconscious", true);
        } else if (wasAtZeroHp && !isActorAtZeroHp(token.actor)) {
          await setActorStabilized(token.actor, false);
        }
      }
    }
    damageApplied.set(token.id, (damageApplied.get(token.id) ?? 0) + tokenAmount);
  }

  return damageApplied;
}

