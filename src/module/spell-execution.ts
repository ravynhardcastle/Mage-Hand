import type { Activity, GuidingBoltFlag, MidiAttackWorkflow, MidiPreAttackWorkflow, MidiRollWorkflow, TokenLightSnapshot, UpdateData } from "./configuration";
import { CHARM_PERSON_FLAG_KEY, GUIDING_BOLT_FLAG_KEY, HOLD_PERSON_DC_FLAG_KEY, LIGHT_SPELL_FLAG_KEY, MODULE_ID, SANCTUARY_FLAG_KEY, TURNED_FLAG_KEY } from "./constants";
import { actorSys, asDnd5eActor, getDefaultTokenLight, getDnd5eApi, getItemActivities, getMidiQol, getModuleFlag, itemSys } from "./foundry-helpers";
import { chooseEdgeOrCornerAnchorForTarget, getTokenCenter } from "./grid";
import { actorHasStatusEffect, hasConditionImmunity, isActorAtZeroHp, isActorUnconscious, isConstructActor, isUndeadActor, rollAbilitySaveTotal, setActorStatusEffect } from "./actor-status";
import { allocateRepeatableSpellTargets, canRepeatTargetSelection, getAutoPlaceTemplateActivity, getCombatRoundTurn, getGuidingBoltExpiryForActor, getRestorableCondition, getSpellRange, getSpellTargetCount, getValidSpellTargets, isHealingSpell, isValidDirectUseBuffTarget } from "./spells";
import { asDamageRollArray } from "./combat";
import { destinationIsOccupied, getSceneGridInfo, gridToPixel, pixelToGrid, type GridRect } from "./grid";
import { getTemplateHighlightedGridPositions, getTokensInTemplate, getWalledTemplateFlagsFromItem, scheduleTemplateCleanup, waitForDrawMeasuredTemplate, withRangeTemplate } from "./templates";
import type { AttackResult, Entity } from "./entity";

export async function applyMistyStepTeleport(entity: Entity, spell: Item, scene: Scene): Promise<boolean> {
  if (!entity.id) return false;
  const token = scene.tokens.get(entity.id);
  if (!token) return false;
  const range = itemSys(spell).target?.affects?.count ?? 0;
  if (Number(range) <= 0) return false;
  const info = getSceneGridInfo(scene, true);
  if (!info) return false;

  const tokenW = Math.max(1, Math.ceil(token.width));
  const tokenH = Math.max(1, Math.ceil(token.height));
  const currentPos = pixelToGrid(token.x, token.y, scene, { silent: true });

  const pick = await withRangeTemplate<{ x: number; y: number } | null>(
    scene,
    entity,
    Number(range),
    (templateObj) => {
      const positions = getTemplateHighlightedGridPositions(templateObj, scene);
      const candidates = positions.filter(p => {
        if (currentPos && p.x === currentPos.x && p.y === currentPos.y) return false;
        if (p.x < 0 || p.y < 0) return false;
        if (p.x + tokenW > info.widthCells) return false;
        if (p.y + tokenH > info.heightCells) return false;
        const rect: GridRect = { x: p.x, y: p.y, width: tokenW, height: tokenH };
        return !destinationIsOccupied(scene, rect, token.id);
      });
      if (candidates.length === 0) return null;
      return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
    },
    spell,
    true,
  );

  if (!pick) return false;
  const pixelPos = gridToPixel(pick.x, pick.y, scene);
  if (!pixelPos) return false;

  await token.update({ x: pixelPos.x, y: pixelPos.y }, { animate: false });
  entity.x = token.x;
  entity.y = token.y;
  return true;
}

async function rollSleepHpPool(spell: Item, castLevel: number): Promise<number> {
  const baseLevel = Math.max(1, itemSys(spell).level ?? 0);
  const scaling = Math.max(0, castLevel - baseLevel);
  const activities = getItemActivities(spell);
  const sleepRollActivity = activities.find(a => typeof a.rollDamage === "function");
  if (sleepRollActivity?.rollDamage) {
    const rollResult = await sleepRollActivity.rollDamage({ scaling }, { configure: false });
    const rolls = asDamageRollArray(rollResult);
    const total = rolls.reduce((sum, r) => sum + r.total, 0);
    if (total > 0) return total;
  }
  return 0;
}

export async function applySleepEffect(
  spell: Item,
  selectedTargets: TokenDocument[],
  casterDisposition: number,
  castLevel: number,
): Promise<Set<string>> {
  const candidates = selectedTargets
    .filter((t): t is TokenDocument & { actor: Actor } => !!t.actor)
    .filter(t => t.disposition !== casterDisposition)
    .filter(t => !isActorAtZeroHp(t.actor))
    .filter(t => !isActorUnconscious(t.actor))
    .filter(t => !isUndeadActor(t.actor))
    .filter(t => !hasConditionImmunity(t.actor, "charmed"));

  const hpValue = (actor: Actor | null | undefined): number => {
    return actorSys(actor).attributes?.hp?.value ?? Number.POSITIVE_INFINITY;
  };

  candidates.sort((a, b) => hpValue(a.actor) - hpValue(b.actor));

  let remainingPool = await rollSleepHpPool(spell, castLevel);
  const affected = new Set<string>();

  for (const token of candidates) {
    const actor = token.actor;
    if (!token.id) continue;

    const currentHp = hpValue(actor);
    if (!Number.isFinite(currentHp) || currentHp <= 0) continue;
    if (currentHp > remainingPool) break;

    const applied = await setActorStatusEffect(actor, "unconscious", true);
    if (!applied) continue;

    affected.add(token.id);
    remainingPool -= currentHp;
    if (remainingPool <= 0) break;
  }

  return affected;
}

function getSavedTokenIdsFromWorkflow(activity: Activity | undefined): Set<string> {
  const saved = new Set<string>();
  const saves = activity?.workflow?.saves;
  if (!(saves instanceof Set)) return saved;

  for (const token of saves) {
    if (typeof token.id === "string") saved.add(token.id);
  }
  return saved;
}

export async function clearPreviousLightTargets(caster: Actor): Promise<void> {
  const scene = canvas?.scene;
  if (!scene) return;
  const casterId = caster.id;
  if (!casterId) return;

  for (const token of scene.tokens) {
    const flag = getModuleFlag(token, LIGHT_SPELL_FLAG_KEY) as { sourceActorId?: string; previousLight?: TokenLightSnapshot } | undefined;
    if (!flag || flag.sourceActorId !== casterId) continue;

    const clearLightUpdate: Record<string, unknown> = {
      light: flag.previousLight ?? getDefaultTokenLight(),
      "flags.dnd-model.lightSpell": null,
    };
    await token.update(clearLightUpdate);
  }
}

export async function applyLightCantripEffect(
  caster: Actor,
  selectedTargets: TokenDocument[],
  activity: Activity | undefined,
  casterDisposition: number,
): Promise<Set<string>> {
  await clearPreviousLightTargets(caster);

  const savedTokenIds = getSavedTokenIdsFromWorkflow(activity);
  const applied = new Set<string>();

  for (const target of selectedTargets) {
    if (!target.id || !target.actor) continue;

    let resisted = false;
    const isHostileTarget = target.disposition !== casterDisposition;
    if (isHostileTarget) resisted = savedTokenIds.has(target.id);

    if (resisted) continue;

    const previousLight = foundry.utils.deepClone(target.toObject().light);
    const lightUpdate: UpdateData = {
      "light.bright": 20,
      "light.dim": 40,
      "light.angle": 360,
      "light.alpha": 0.5,
      "flags.dnd-model.lightSpell": {
        sourceActorId: caster.id,
        previousLight,
      },
    };
    await target.update(lightUpdate);
    applied.add(target.id);
  }

  return applied;
}

export async function applyGuidingBoltEffect(
  caster: Actor,
  selectedTargets: TokenDocument[],
  damageApplied: Map<string, number>,
  casterDisposition: number,
): Promise<void> {
  const expiry = getGuidingBoltExpiryForActor(caster.id);

  for (const target of selectedTargets) {
    if (!target.id) continue;
    if (target.disposition === casterDisposition) continue;
    if ((damageApplied.get(target.id) ?? 0) <= 0) continue;

    const update: Record<string, unknown> = {
      "flags.dnd-model.guidingBoltNextAttack": {
        sourceActorId: caster.id,
        appliedRound: expiry.appliedRound,
        appliedTurn: expiry.appliedTurn,
        expiresRound: expiry.expiresRound,
        expiresTurn: expiry.expiresTurn,
      },
    };
    await target.update(update);
  }
}

export async function applyLesserRestorationEffect(targets: TokenDocument[]): Promise<void> {
  for (const target of targets) {
    if (!target.actor) continue;
    const condition = getRestorableCondition(target.actor);
    if (!condition) continue;
    await setActorStatusEffect(target.actor, condition, false);
  }
}

export async function applyHoldPersonParalysis(effectActivity: Activity, selectedTargets: TokenDocument[]): Promise<void> {
  const dc = effectActivity.save?.dc?.value;
  if (typeof dc !== "number") return;
  for (const t of selectedTargets) {
    if (!t.actor) continue;
    await t.setFlag(MODULE_ID, HOLD_PERSON_DC_FLAG_KEY, dc);
  }
}

export async function applyPreserveLife(clericActor: Actor, clericToken: TokenDocument, scene: Scene): Promise<boolean> {
  const preserveLifeItem = clericActor.items.find(i => i.name.trim().toLowerCase().includes("preserve life"));
  if (!preserveLifeItem) return false;

  const cdItem = clericActor.items.find(i => i.name.trim().toLowerCase() === "channel divinity");
  const cdUses = cdItem ? (itemSys(cdItem) as { uses?: { value?: number } }).uses : undefined;
  if (typeof cdUses?.value === "number" && cdUses.value <= 0) return false;

  const eligible = scene.tokens.filter(t => {
    if (!t.actor) return false;
    if (t.disposition !== clericToken.disposition) return false;
    if (isActorAtZeroHp(t.actor)) return false;
    if (isUndeadActor(t.actor)) return false;
    if (isConstructActor(t.actor)) return false;
    const hp = actorSys(t.actor).attributes?.hp;
    return typeof hp?.value === "number" && typeof hp.max === "number" && hp.value < hp.max / 2;
  }) as TokenDocument[];
  if (eligible.length === 0) return false;

  const activity = getAutoPlaceTemplateActivity(preserveLifeItem);
  const rangeUnits = Number((activity?.target?.template as Record<string, unknown> | undefined)?.["size"]) || 30;
  const inRange = await withRangeTemplate<TokenDocument[]>(
    scene, clericToken, rangeUnits,
    (templateObj) => getTokensInTemplate(templateObj, scene, eligible),
    preserveLifeItem, true,
  ) ?? [];
  if (inRange.length === 0) return false;

  const midiQol = getMidiQol();
  if (!midiQol?.completeItemUse) return false;

  await midiQol.completeItemUse(
    preserveLifeItem,
    { midiOptions: { fastForward: true, workflowOptions: { forceCompletion: true } } },
    { configure: false },
    {},
  );

  const clericLevel = actorSys(clericActor).details?.level ?? 1;
  const totalPool = 5 * clericLevel;

  // Build allocations with per-target caps, in a random order
  const allocations = [...inRange]
    .sort(() => Math.random() - 0.5)
    .flatMap(t => {
      if (!t.actor) return [];
      const hp = actorSys(t.actor).attributes?.hp;
      if (typeof hp?.value !== "number" || typeof hp.max !== "number") return [];
      const cap = Math.floor(hp.max / 2) - hp.value;
      return cap > 0 ? [{ actor: t.actor, cap }] : [];
    });

  // Clamp pool to what targets can actually absorb
  const totalCap = allocations.reduce((s, a) => s + a.cap, 0);
  let remaining = Math.min(totalPool, totalCap);
  let futureCap = totalCap;

  for (const a of allocations) {
    futureCap -= a.cap;
    const minHeal = Math.max(0, remaining - futureCap);
    const maxHeal = Math.min(a.cap, remaining);
    const heal = minHeal + Math.floor(Math.random() * (maxHeal - minHeal + 1));
    remaining -= heal;
    if (heal <= 0) continue;
    const healer = asDnd5eActor(a.actor);
    if (typeof healer.applyDamage !== "function") continue;
    await healer.applyDamage(heal, { multiplier: -1 });
    console.log(`[Preserve Life] Healed ${a.actor.name} for ${heal} HP`);
  }
  return true;
}

export async function applyTurnUndead(clericActor: Actor, clericToken: TokenDocument, scene: Scene, currentRound: number): Promise<boolean> {
  const turnUndeadItem = clericActor.items.find(i => i.name.trim().toLowerCase().includes("turn undead"));
  if (!turnUndeadItem) return false;

  const cdItem = clericActor.items.find(i => i.name.trim().toLowerCase() === "channel divinity");
  const cdUses = cdItem ? (itemSys(cdItem) as { uses?: { value?: number } }).uses : undefined;
  if (typeof cdUses?.value === "number" && cdUses.value <= 0) return false;

  const hostile = scene.tokens.filter(
    t => !!t.actor && isUndeadActor(t.actor) && t.disposition !== clericToken.disposition && !isActorAtZeroHp(t.actor)
  ) as TokenDocument[];
  if (hostile.length === 0) return false;

  const activity = getAutoPlaceTemplateActivity(turnUndeadItem);
  const rangeUnits = Number((activity?.target?.template as Record<string, unknown> | undefined)?.["size"]) || 30;
  const undeadInRange = await withRangeTemplate<TokenDocument[]>(
    scene, clericToken, rangeUnits,
    (templateObj) => getTokensInTemplate(templateObj, scene, hostile),
    turnUndeadItem, true,
  ) ?? [];
  if (undeadInRange.length === 0) return false;

  const midiQol = getMidiQol();
  if (!midiQol?.completeItemUse) return false;

  const workflow = await midiQol.completeItemUse(
    turnUndeadItem,
    { midiOptions: { targetUuids: undeadInRange.map(t => t.uuid), ignoreUserTargets: true, fastForward: true, workflowOptions: { forceCompletion: true } } },
    { configure: false },
    {},
  ) as { failedSaves?: Iterable<{ id?: string }> } | undefined;
  if (!workflow) return false;

  for (const token of workflow.failedSaves ?? []) {
    if (typeof token.id !== "string") continue;
    const doc = scene.tokens.get(token.id);
    if (doc?.actor) {
      console.log(`[Turn Undead] ${doc.actor.name} failed save, turned for 10 rounds`);
      await doc.setFlag(MODULE_ID, TURNED_FLAG_KEY, { sourceActorId: clericActor.id ?? "", round: currentRound + 10 });
    }
  }
  return true;
}

export async function tryHoldPersonEndOfTurnSave(token: TokenDocument): Promise<void> {
  const dc = token.getFlag(MODULE_ID, HOLD_PERSON_DC_FLAG_KEY);
  if (typeof dc !== "number") return;
  const actor = token.actor;
  if (!actor) return;
  if (!actorHasStatusEffect(actor, "paralyzed")) {
    await token.unsetFlag(MODULE_ID, HOLD_PERSON_DC_FLAG_KEY);
    return;
  }
  const total = await rollAbilitySaveTotal(actor, "wis", dc);
  if (total !== null && total >= dc) {
    const holdPersonEffects = actor.effects.filter(e => e.name.trim().toLowerCase() === "hold person");
    for (const e of holdPersonEffects) await e.delete();
    await token.unsetFlag(MODULE_ID, HOLD_PERSON_DC_FLAG_KEY);
  }
}

export async function applyActionSurge(actor: Actor): Promise<boolean> {
  const actionSurgeItem = actor.items.find(i => i.name.trim().toLowerCase() === "action surge");
  if (!actionSurgeItem) return false;

  const uses = (itemSys(actionSurgeItem) as { uses?: { value?: number } }).uses;
  if (typeof uses?.value === "number" && uses.value <= 0) return false;

  const midiQol = getMidiQol();
  if (!midiQol?.completeItemUse) return false;

  console.log(`[Action Surge] ${actor.name} uses Action Surge`);
  await midiQol.completeItemUse(
    actionSurgeItem,
    { midiOptions: { fastForward: true, workflowOptions: { forceCompletion: true } } },
    { configure: false },
    {},
  );
  return true;
}

export async function applySecondWind(actor: Actor): Promise<boolean> {
  const secondWindItem = actor.items.find(i => i.name.trim().toLowerCase() === "second wind");
  if (!secondWindItem) return false;

  const uses = (itemSys(secondWindItem) as { uses?: { value?: number } }).uses;
  if (typeof uses?.value === "number" && uses.value <= 0) return false;

  const hp = actorSys(actor).attributes?.hp;
  if (typeof hp?.value !== "number" || typeof hp.max !== "number") return false;
  if (hp.value >= hp.max / 2) return false;

  const midiQol = getMidiQol();
  if (!midiQol?.completeItemUse) return false;

  console.log(`[Second Wind] ${actor.name} uses Second Wind at ${hp.value}/${hp.max} HP`);
  await midiQol.completeItemUse(
    secondWindItem,
    { midiOptions: { fastForward: true, workflowOptions: { forceCompletion: true } } },
    { configure: false },
    {},
  );
  return true;
}

export async function getTargetsForDirectUseSpell(entity: Entity, spell: Item): Promise<TokenDocument[]> {
  if (!canvas?.scene) return [];
  const scene = canvas.scene;
  const isHealing = isHealingSpell(spell);

  const spellRangeUnits = (itemSys(spell).range?.units ?? "").toLowerCase();
  if (spellRangeUnits === "self") {
    const casterToken = scene.tokens.get(entity.id ?? "");
    if (casterToken && isValidDirectUseBuffTarget(casterToken, spell)) return [casterToken];
    return [];
  }

  const allies = scene.tokens.filter(t => {
    if (t.id === entity.id) return false;
    if (t.combatant?.defeated) return false;
    if (isActorAtZeroHp(t.actor ?? undefined) && !isHealing) return false;
    if (t.disposition !== entity.disposition) return false;
    return isValidDirectUseBuffTarget(t, spell);
  });
  if (allies.length === 0) return [];

  const range = Math.max(5, getSpellRange(spell));
  const inRange = await withRangeTemplate<TokenDocument[]>(scene, entity, range, (templateObj) => {
    return getTokensInTemplate(templateObj, scene, allies);
  }, spell, true);

  return inRange ?? [];
}

export async function getTargetsForRangeSpell(entity: Entity, spell: Item, castLevel?: number): Promise<TokenDocument[]> {
  if (!canvas?.scene) return [];
  const scene = canvas.scene;

  const valid = getValidSpellTargets(entity, scene, spell);
  if (valid.length === 0) return [];

  const range = Math.max(5, getSpellRange(spell));
  const inRange = await withRangeTemplate<TokenDocument[]>(scene, entity, range, (templateObj) => {
    return getTokensInTemplate(templateObj, scene, valid);
  }, spell, true);
  if (!inRange || inRange.length === 0) return [];

  const maxTargets = getSpellTargetCount(spell, castLevel);
  if (canRepeatTargetSelection(spell, maxTargets)) {
    return allocateRepeatableSpellTargets(inRange, maxTargets);
  }

  const cappedTargets = Math.min(inRange.length, maxTargets);
  const chosen: TokenDocument[] = [];
  const pool = [...inRange];
  while (chosen.length < cappedTargets && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    const pick = pool.splice(idx, 1)[0];
    if (pick) chosen.push(pick);
  }
  return chosen;
}

export async function getTargetsForNativeTemplateSpell(entity: Entity, scene: Scene, spell: Item): Promise<TokenDocument[]> {
  if (!entity.id) return [];

  const caster = scene.tokens.get(entity.id);
  if (!caster) return [];

  const activity = getAutoPlaceTemplateActivity(spell);
  if (!activity) return [];
  const templateType = activity.target?.template?.type?.toLowerCase();
  if (!templateType) return [];

  const directionalTemplateTypes = new Set(["cone", "ray", "line"]);
  const pointTemplateTypes = new Set(["circle", "rect", "sphere", "cylinder", "radius"]);

  const valid = getValidSpellTargets(entity, scene, spell);
  const affectsType = (activity.target?.affects?.type ?? "").toLowerCase();
  const isDirectionalTemplate = directionalTemplateTypes.has(templateType);
  const selfCentered = !isDirectionalTemplate && (affectsType === "self" || getSpellRange(spell) === 0);
  if (!selfCentered && valid.length === 0) return [];

  const casterCenter = getTokenCenter(caster, scene);

  let focus: TokenDocument | undefined;
  if (!selfCentered) {
    const rangeUnits = Math.max(0, getSpellRange(spell));
    const rangePx = rangeUnits > 0
      ? (rangeUnits / scene.grid.distance) * scene.grid.size
      : Number.POSITIVE_INFINITY;
    const inRange = valid.filter(token => {
      const tokenCenter = getTokenCenter(token, scene);
      const dist = Math.hypot(tokenCenter.x - casterCenter.x, tokenCenter.y - casterCenter.y);
      return dist <= rangePx;
    });
    if (inRange.length === 0) return [];
    const candidates = inRange;

    if (pointTemplateTypes.has(templateType)) {
      focus = candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0];
    } else {
      let nearestDistance = Number.POSITIVE_INFINITY;
      const nearest: TokenDocument[] = [];
      for (const token of candidates) {
        const tokenCenter = getTokenCenter(token, scene);
        const dist = Math.hypot(tokenCenter.x - casterCenter.x, tokenCenter.y - casterCenter.y);
        if (dist + 0.5 < nearestDistance) {
          nearestDistance = dist;
          nearest.length = 0;
          nearest.push(token);
        } else if (Math.abs(dist - nearestDistance) <= 0.5) {
          nearest.push(token);
        }
      }
      if (nearest.length === 0) return [];
      focus = nearest[Math.floor(Math.random() * nearest.length)] ?? nearest[0];
    }
    if (!focus) return [];
  }

  let templateX = casterCenter.x;
  let templateY = casterCenter.y;
  let templateDirection = 0;

  if (directionalTemplateTypes.has(templateType) && focus) {
    const anchor = chooseEdgeOrCornerAnchorForTarget(caster, focus, scene);
    templateX = anchor.x;
    templateY = anchor.y;
    templateDirection = anchor.direction;
  } else if (pointTemplateTypes.has(templateType) && focus && !selfCentered) {
    const targetCenter = getTokenCenter(focus, scene);
    templateX = targetCenter.x;
    templateY = targetCenter.y;
    const angle = Math.toDegrees(Math.atan2(targetCenter.y - casterCenter.y, targetCenter.x - casterCenter.x));
    const snapped = Math.round((angle + 360) % 360 / 45) * 45;
    templateDirection = ((snapped % 360) + 360) % 360;
  }

  const dnd5eApi = getDnd5eApi();
  const abilityTemplateClass = dnd5eApi?.canvas?.AbilityTemplate;
  if (!abilityTemplateClass || typeof abilityTemplateClass.fromActivity !== "function") return [];

  const templates = abilityTemplateClass.fromActivity(activity, {
    x: templateX,
    y: templateY,
    direction: templateDirection,
  });
  const template = templates?.[0];
  if (!template) return [];

  const templateCreateData = template.document.toObject();
  const walledFlags = getWalledTemplateFlagsFromItem(spell);
  if (walledFlags) {
    templateCreateData["flags"] = {
      ...(templateCreateData["flags"] ?? {}),
      walledtemplates: walledFlags,
    };
  }

  const [created] = await scene.createEmbeddedDocuments("MeasuredTemplate", [templateCreateData]);
  if (!created) return [];

  try {
    const templateObj = await waitForDrawMeasuredTemplate(created.id);
    if (!templateObj.shape) return [];
    return getTokensInTemplate(templateObj, scene, valid);
  } finally {
    scheduleTemplateCleanup(scene, created.id);
  }
}

export async function clearGuidingBoltFlag(token: TokenDocument): Promise<void> {
  await token.update({ "flags.dnd-model.guidingBoltNextAttack": null } as UpdateData);
}

export async function getActiveGuidingBoltTargetIds(scene: Scene): Promise<Set<string>> {
  const active = new Set<string>();

  for (const token of scene.tokens) {
    if (!token.id) continue;

    const flag = getModuleFlag(token, GUIDING_BOLT_FLAG_KEY) as GuidingBoltFlag | undefined;
    if (!flag) continue;
    const now = getCombatRoundTurn();
    if (!now) continue;
    if (!flag.expiresRound || !flag.expiresTurn) continue;
    if (now.round > flag.expiresRound || (now.round === flag.expiresRound && now.turn > flag.expiresTurn)) {
      await clearGuidingBoltFlag(token);
      continue;
    }

    active.add(token.id);
  }

  return active;
}

export function registerGuidingBoltAdvantageHook(): void {
  const hookId = Hooks.on("midi-qol.preAttackRollConfig", (workflow: MidiPreAttackWorkflow) => {
    Hooks.off("midi-qol.preAttackRollConfig", hookId);
    workflow.attackRollModifierTracker?.advantage?.add?.("guidingBolt", "Guiding Bolt");
  });
}

export function waitForMidiAttackHits(): Promise<Set<string> | null> {
  let hookId: number | undefined;
  let resolved = false;

  return new Promise<Set<string> | null>(resolve => {
    const finish = (result: Set<string> | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (hookId !== undefined) Hooks.off("midi-qol.AttackRollComplete", hookId);
      resolve(result);
    };

    const timeout = setTimeout(() => { finish(null); }, 10000);

    hookId = Hooks.on("midi-qol.AttackRollComplete", (workflow: MidiAttackWorkflow) => {
      const hitIds = new Set<string>();
      if (workflow.hitTargets instanceof Set) {
        for (const token of workflow.hitTargets) {
          if (typeof token.id === "string") hitIds.add(token.id);
        }
      }
      finish(hitIds);
    });
  });
}

type CharmPersonState = { dc: number; casterActorId: string; casterDisposition: number };

export function waitForMidiSaveFails(): Promise<Set<string>> {
  let hookId: number | undefined;
  let resolved = false;

  return new Promise<Set<string>>(resolve => {
    const finish = (result: Set<string>) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      if (hookId !== undefined) Hooks.off("midi-qol.RollComplete", hookId);
      resolve(result);
    };

    const timeout = setTimeout(() => { finish(new Set()); }, 10000);

    hookId = Hooks.on("midi-qol.RollComplete", (workflow: MidiRollWorkflow) => {
      const failedIds = new Set<string>();
      if (workflow.failedSaves instanceof Set) {
        for (const token of workflow.failedSaves) {
          if (typeof token.id === "string") failedIds.add(token.id);
        }
      }
      finish(failedIds);
    });
  });
}

export async function applyCharmPersonEffect(
  effectActivity: Activity,
  selectedTargets: TokenDocument[],
  casterActor: Actor,
  casterDisposition: number,
  failedSaveIds: Set<string>,
): Promise<void> {
  const dc = effectActivity.save?.dc?.value;
  if (typeof dc !== "number") return;
  const casterId = casterActor.id;
  if (!casterId) return;
  for (const t of selectedTargets) {
    if (!t.actor || !t.id) continue;
    if (!failedSaveIds.has(t.id)) continue;
    await setActorStatusEffect(t.actor, "charmed", true);
    await t.setFlag(MODULE_ID, CHARM_PERSON_FLAG_KEY, {
      dc, casterActorId: casterId, casterDisposition,
    } satisfies CharmPersonState);
  }
}

export function isCharmedByEnemy(token: TokenDocument): boolean {
  if (!token.actor) return false;
  if (!actorHasStatusEffect(token.actor, "charmed")) return false;
  const data = token.getFlag(MODULE_ID, CHARM_PERSON_FLAG_KEY) as CharmPersonState | undefined;
  if (!data) return false;
  return data.casterDisposition !== token.disposition;
}

export async function clearCharmPersonForDamaged(scene: Scene, events: AttackResult[]): Promise<void> {
  for (const event of events) {
    if (!event.attackerId) continue;
    const attackerToken = scene.tokens.get(event.attackerId);
    if (!attackerToken) continue;
    const attackerDisp = attackerToken.disposition;
    for (const target of event.targets) {
      if (target.damageDealt <= 0) continue;
      const targetToken = scene.tokens.get(target.tokenId);
      if (!targetToken) continue;
      const data = targetToken.getFlag(MODULE_ID, CHARM_PERSON_FLAG_KEY) as CharmPersonState | undefined;
      if (!data) continue;
      if (attackerDisp === data.casterDisposition) {
        await targetToken.unsetFlag(MODULE_ID, CHARM_PERSON_FLAG_KEY);
        if (targetToken.actor) await setActorStatusEffect(targetToken.actor, "charmed", false);
        console.log(`[Charm Person] Charm on ${targetToken.name} ended (damaged by charmer's side)`);
      }
    }
  }
}

export async function clearExpiredCharms(token: TokenDocument, scene: Scene): Promise<void> {
  if (!token.actor) return;
  const data = token.getFlag(MODULE_ID, CHARM_PERSON_FLAG_KEY) as CharmPersonState | undefined;
  if (!data) return;
  const casterToken = scene.tokens.find(t => t.actor?.id === data.casterActorId);
  if (!casterToken || isActorAtZeroHp(casterToken.actor)) {
    await token.unsetFlag(MODULE_ID, CHARM_PERSON_FLAG_KEY);
    await setActorStatusEffect(token.actor, "charmed", false);
    console.log(`[Charm Person] Charm on ${token.name} expired (caster gone or down)`);
  }
}

// ─── Sanctuary ────────────────────────────────────────────────────────────────

type SanctuaryState = { dc: number; casterActorId: string };

export async function applySanctuaryEffect(
  effectActivity: Activity,
  selectedTargets: TokenDocument[],
  casterActor: Actor,
): Promise<void> {
  const dc = effectActivity.save?.dc?.value;
  if (typeof dc !== "number") return;
  const casterId = casterActor.id;
  if (!casterId) return;
  for (const t of selectedTargets) {
    if (!t.id) continue;
    await t.setFlag(MODULE_ID, SANCTUARY_FLAG_KEY, { dc, casterActorId: casterId } satisfies SanctuaryState);
    console.log(`[Sanctuary] Applied to ${t.name} (DC ${dc})`);
  }
}

export function isUnderSanctuary(token: TokenDocument): boolean {
  return !!(token.getFlag(MODULE_ID, SANCTUARY_FLAG_KEY) as SanctuaryState | undefined);
}

/** Returns true if the attack is BLOCKED (attacker failed the WIS save). */
export async function checkSanctuaryBlocked(
  attackerActor: Actor,
  targetToken: TokenDocument,
): Promise<boolean> {
  const data = targetToken.getFlag(MODULE_ID, SANCTUARY_FLAG_KEY) as SanctuaryState | undefined;
  if (!data) return false;
  const total = await rollAbilitySaveTotal(attackerActor, "wis", data.dc);
  if (total === null) return false;
  if (total >= data.dc) return false;
  console.log(`[Sanctuary] ${attackerActor.name} failed WIS save (${total} vs DC ${data.dc}), attack blocked`);
  return true;
}

export async function clearSanctuaryOnOffensiveAct(token: TokenDocument): Promise<void> {
  const data = token.getFlag(MODULE_ID, SANCTUARY_FLAG_KEY) as SanctuaryState | undefined;
  if (!data) return;
  await token.unsetFlag(MODULE_ID, SANCTUARY_FLAG_KEY);
  console.log(`[Sanctuary] Sanctuary on ${token.name} ended (made offensive action)`);
}

export async function clearExpiredSanctuaries(token: TokenDocument, scene: Scene): Promise<void> {
  const data = token.getFlag(MODULE_ID, SANCTUARY_FLAG_KEY) as SanctuaryState | undefined;
  if (!data) return;
  const casterToken = scene.tokens.find(t => t.actor?.id === data.casterActorId);
  if (!casterToken || isActorAtZeroHp(casterToken.actor)) {
    await token.unsetFlag(MODULE_ID, SANCTUARY_FLAG_KEY);
    console.log(`[Sanctuary] Sanctuary on ${token.name} expired (caster gone or down)`);
  }
}
