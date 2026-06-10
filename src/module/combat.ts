import { MODULE_ID, RANGE_POSITIONS_CACHE_MAX_ENTRIES, TURNED_FLAG_KEY } from "./constants";
import type { Activity, UpdateData } from "./configuration";
import { actorSys, itemSys, asDnd5eActor, getItemsOfType, getItemActivities, getMidiQol, isRecord, getTokenLayer } from "./foundry-helpers";
import { isActorAtZeroHp, isActorUnableToAct, isUndeadActor, rollAbilitySaveTotal, setActorStatusEffect, setActorStabilized, getBlessBonusIfAny, applyDamageAtZeroHp } from "./actor-status";
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

async function tryUndeadFortitude(actor: Actor, damage: number, rolls: DamageRoll[], isCritical: boolean): Promise<boolean> {
  if (!isUndeadActor(actor) || actor.name.trim().toLowerCase() !== "zombie") return false;
  if (isCritical) return false;
  const isRadiant = rolls.some(r => (r.options?.type ?? r.options?.types?.[0] ?? "").toLowerCase() === "radiant");
  if (isRadiant) return false;
  const dc = 5 + damage;
  const total = await rollAbilitySaveTotal(actor, "con", dc);
  if (total !== null && total >= dc) {
    await actor.update({ "system.attributes.hp.value": 1 } as UpdateData);
    return true;
  }
  return false;
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

export async function rollAttack(entity: Entity, weaponName: string, ammunitionId?: string, usedReaction?: Set<string>, disadvantage?: boolean): Promise<AttackResult | null> {
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

  const ammoItem = ammunitionId ? actor.items.get(ammunitionId) : undefined;

  const guidingBoltTargets = await getActiveGuidingBoltTargetIds(scene);
  const currentTargetIds = new Set(Array.from(game.user?.targets ?? []).map(t => t.document.id));
  const targetHasGuidingBolt = [...guidingBoltTargets].some(id => currentTargetIds.has(id));

  const midiQol = getMidiQol();
  if (!midiQol?.completeItemUse) {
    console.error("midi-qol completeItemUse is unavailable, cannot roll attack via workflow.");
    return null;
  }

  const workflowOptions: Record<string, unknown> = {
    autoRollAttack: true,
    autoRollDamage: "always",
    autoFastDamage: true,
    autoApplyDamage: "noCard", // no bc we do it manually idk
    forceCompletion: true,
    noProvokeReaction: true, // we handle this bc tbh i didnt know this existed at the time. oops! oh well
  };
  if (targetHasGuidingBolt) workflowOptions["advantage"] = true;
  if (disadvantage) workflowOptions["disadvantage"] = true;

  const useConfig: Record<string, unknown> = {
    midiOptions: {
      fastForward: true,
      workflowOptions,
      ...(activity.id ? { activityId: activity.id } : {}),
    },
  };
  if (ammoItem?.id) useConfig["ammunition"] = ammoItem.id;

  type WeaponAttackWorkflow = {
    attackRoll?: AttackRollLike;
    damageRolls?: unknown;
    targets?: Set<{ id?: string; document?: TokenDocument }>;
  };

  // sometimes things will get chat messages to consume
  // NOTE: i think this might not matter at all :sob: because it might just work in combat
  // but this is needed for out of combat
  // please test this later idk this is so scrungled together
  type DeferredConsumption = {
    act: { consume: (usage: Record<string, unknown>, msgCfg: { data?: Record<string, unknown> }) => Promise<void>; consumption: { targets: { length: number } }; item: { actor: unknown } };
    msg: { id: string; update: (data: Record<string, unknown>) => Promise<void>; system?: { deltas?: unknown; scaling?: unknown; cause?: unknown } };
  };
  const deferredConsumptions: DeferredConsumption[] = [];

  const collectDeferred = (activity: unknown, card: unknown) => {
    const act = activity as {
      consume?: (usage: Record<string, unknown>, msgCfg: { data?: Record<string, unknown> }) => Promise<void>;
      consumption?: { targets?: { length?: number } };
      item?: { actor?: unknown };
    };
    if (!act.consume || !act.consumption?.targets?.length) return;
    if (act.item?.actor !== actor) return;
    const msg = card as { id?: string; update?: (data: Record<string, unknown>) => Promise<void>; system?: { deltas?: unknown; scaling?: unknown; cause?: unknown } } | null;
    if (!msg?.id || !msg.update) return;
    if (msg.system?.deltas) return; // already consumed
    deferredConsumptions.push({ act: act as DeferredConsumption["act"], msg: msg as DeferredConsumption["msg"] });
  };
  const hookId = Hooks.on("dnd5e.postCreateUsageMessage", collectDeferred);

  let workflow: WeaponAttackWorkflow | undefined;
  try {
    workflow = await midiQol.completeItemUse(
      item,
      useConfig,
      { configure: false },
      {},
    ) as WeaponAttackWorkflow | undefined;
  } finally {
    Hooks.off("dnd5e.postCreateUsageMessage", hookId);
  }

  // ok now its done so we can consume it now, if we dont do it now it screams at us even though it works anyways
  for (const { act, msg } of deferredConsumptions) {
    if (msg.system?.deltas) continue; // consumed by something else in the meantime
    const usageCfg: Record<string, unknown> = { consume: true };
    const msgCfg: { data?: Record<string, unknown> } = {};
    if (msg.system?.scaling !== undefined) usageCfg["scaling"] = msg.system.scaling;
    if (msg.system?.cause !== undefined) usageCfg["cause"] = msg.system.cause;
    await act.consume(usageCfg, msgCfg);
    if (msgCfg.data && Object.keys(msgCfg.data).length > 0) await msg.update(msgCfg.data);
  }

  const attack = workflow?.attackRoll;
  if (!attack || typeof attack.total !== "number") {
    console.error("No attack roll returned for item", weaponName, workflow);
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

  // Pull the intended targets from the workflow. Fall back to the user's
  // currently selected targets if the workflow object didn't expose them.
  const targetTokens: TokenDocument[] = [];
  const seenTargetIds = new Set<string>();
  const collectTargetToken = (tokenLike: { id?: string; document?: TokenDocument } | TokenDocument | undefined) => {
    if (!tokenLike) return;
    const doc = (tokenLike as { document?: TokenDocument }).document ?? (tokenLike as TokenDocument);
    if (!doc.id || seenTargetIds.has(doc.id)) return;
    seenTargetIds.add(doc.id);
    targetTokens.push(doc);
  };
  if (workflow?.targets) {
    for (const tokenObj of workflow.targets) collectTargetToken(tokenObj);
  }
  if (targetTokens.length === 0) {
    for (const t of (game.user?.targets ?? [])) collectTargetToken(t.document);
  }

  if (targetTokens.length === 0) {
    console.log("No targets for attack");
    return result;
  }

  const hitTargetIds = new Set<string>();
  for (const targetToken of targetTokens) {
    const isCritical = result.isCritical;
    const isFumble = result.isFumble;
    const targetTokenId = targetToken.id ?? "";
    const ac = (actorSys(targetToken.actor).attributes?.ac?.value) ?? 0;
    let hit = isCritical || (effectiveAttackTotal >= ac && !isFumble);
    if (hit) {
      const shieldUsed = await maybeUseShieldReaction(targetToken, effectiveAttackTotal, isCritical, usedReaction);
      if (shieldUsed) hit = false;
    }

    // Clear guiding bolt flag on any attack attempt
    if (targetTokenId && guidingBoltTargets.has(targetTokenId)) {
      await clearGuidingBoltFlag(targetToken);
    }

    if (!hit) {
      console.log(`Attack missed target with AC ${ac}`);
      if (targetToken.object) {
        targetToken.object.setTarget(false, { releaseOthers: false });
      }
      result.targets.push({ name: targetToken.name, tokenId: targetTokenId, ac, hit: false, damageDealt: 0 });
    } else {
      hitTargetIds.add(targetTokenId);
      result.targets.push({ name: targetToken.name, tokenId: targetTokenId, ac, hit: true, damageDealt: 0 });
    }
  }

  if (hitTargetIds.size > 0) {
    // Damage rolls were rolled inside the workflow and already include any
    // bonus damage CPR features pushed via WB.bonusDamage (e.g. Sneak Attack).
    const damageRolls = asDamageRollArray(workflow?.damageRolls);
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

      if (token.getFlag(MODULE_ID, TURNED_FLAG_KEY)) await token.unsetFlag(MODULE_ID, TURNED_FLAG_KEY);

      // If the target just dropped to 0 HP, mark them unconscious
      if (isActorAtZeroHp(token.actor)) {
        const survived = await tryUndeadFortitude(token.actor, totalDamage, damageRolls, result.isCritical);
        if (!survived) await setActorStatusEffect(token.actor, "unconscious", true);
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
  scaling: number = 0,
): Promise<Map<string, number>> {
  const damageApplied = new Map<string, number>();

  const isHealingActivity = effectActivity.type === "heal";

  if (!isHealingActivity && effectActivity.type === "attack" && attackHitTokenIds !== null && attackHitTokenIds.size === 0) {
    return damageApplied;
  }

  const rollConfig = scaling > 0 ? { scaling } : {};
  let damageResult: unknown;
  if (isHealingActivity) {
    if (typeof effectActivity.rollHealing === "function") {
      damageResult = await effectActivity.rollHealing(rollConfig, { configure: false });
    } else if (typeof effectActivity.rollDamage === "function") {
      damageResult = await effectActivity.rollDamage(rollConfig, { configure: false });
    }
  } else if (typeof effectActivity.rollDamage === "function") {
    damageResult = await effectActivity.rollDamage(rollConfig, { configure: false });
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
        if (token.getFlag(MODULE_ID, TURNED_FLAG_KEY)) await token.unsetFlag(MODULE_ID, TURNED_FLAG_KEY);
        if (!isHealingActivity && isActorAtZeroHp(token.actor)) {
          const survived = await tryUndeadFortitude(token.actor, tokenAmount, damageRolls, false);
          if (!survived) await setActorStatusEffect(token.actor, "unconscious", true);
        } else if (wasAtZeroHp && !isActorAtZeroHp(token.actor)) {
          await setActorStabilized(token, false);
        }
      }
    }
    damageApplied.set(token.id, (damageApplied.get(token.id) ?? 0) + tokenAmount);
  }

  return damageApplied;
}

