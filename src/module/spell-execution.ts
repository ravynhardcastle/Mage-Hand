import type { Activity, GuidingBoltFlag, MidiAttackWorkflow, MidiPreAttackWorkflow, TokenLightSnapshot, UpdateData } from "./configuration";
import { GUIDING_BOLT_FLAG_KEY, LIGHT_SPELL_FLAG_KEY } from "./constants";
import { actorSys, getDefaultTokenLight, getDnd5eApi, getItemActivities, getModuleFlag, itemSys } from "./foundry-helpers";
import { chooseEdgeOrCornerAnchorForTarget, getTokenCenter } from "./grid";
import { hasConditionImmunity, isActorAtZeroHp, isActorUnconscious, isUndeadActor, setActorStatusEffect } from "./actor-status";
import { allocateRepeatableSpellTargets, canRepeatTargetSelection, getAutoPlaceTemplateActivity, getCombatRoundTurn, getGuidingBoltExpiryForActor, getSpellLevel, getSpellRange, getSpellTargetCount, getValidSpellTargets, isHealingSpell, isValidDirectUseBuffTarget } from "./spells";
import { asDamageRollArray } from "./combat";
import { getTokensInTemplate, getWalledTemplateFlagsFromItem, scheduleTemplateCleanup, waitForDrawMeasuredTemplate, withRangeTemplate } from "./templates";
import type { Entity } from "./entity";

async function rollSleepHpPool(spell: Item): Promise<number> {
  const activities = getItemActivities(spell);
  const sleepRollActivity = activities.find(a => typeof a.rollDamage === "function");
  if (sleepRollActivity?.rollDamage) {
    const rollResult = await sleepRollActivity.rollDamage({}, { configure: false });
    const rolls = asDamageRollArray(rollResult);
    const total = rolls.reduce((sum, r) => sum + r.total, 0);
    if (total > 0) return total;
  }

  const baseLevel = Math.max(1, getSpellLevel(spell));
  const diceCount = 5 + Math.max(0, baseLevel - 1) * 2;
  const fallbackRoll = await new Roll(`${diceCount}d8`).evaluate();
  return Math.max(0, Math.floor(fallbackRoll.total));
}

export async function applySleepEffect(
  spell: Item,
  selectedTargets: TokenDocument[],
  casterDisposition: number,
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

  let remainingPool = await rollSleepHpPool(spell);
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

export async function getTargetsForRangeSpell(entity: Entity, spell: Item): Promise<TokenDocument[]> {
  if (!canvas?.scene) return [];
  const scene = canvas.scene;

  const valid = getValidSpellTargets(entity, scene, spell);
  if (valid.length === 0) return [];

  const range = Math.max(5, getSpellRange(spell));
  const inRange = await withRangeTemplate<TokenDocument[]>(scene, entity, range, (templateObj) => {
    return getTokensInTemplate(templateObj, scene, valid);
  }, spell, true);
  if (!inRange || inRange.length === 0) return [];

  const maxTargets = await getSpellTargetCount(spell);
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
