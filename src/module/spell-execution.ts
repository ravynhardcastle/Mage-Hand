import type { Activity, FaerieFireState, FlamingSphereState, GuidingBoltFlag, MidiAttackWorkflow, MidiPreAttackWorkflow, MidiRollWorkflow, SpiritualWeaponState, TokenLightSnapshot, UpdateData, WebState } from "./configuration";
import { CHARM_PERSON_FLAG_KEY, FAERIE_FIRE_FLAG_KEY, FLAMING_SPHERE_FLAG_KEY, GUIDING_BOLT_FLAG_KEY, HOLD_PERSON_DC_FLAG_KEY, LIGHT_SPELL_FLAG_KEY, MODULE_ID, PARALYSIS_SAVE_FLAG_KEY, SANCTUARY_FLAG_KEY, SPIRITUAL_WEAPON_FLAG_KEY, TURNED_FLAG_KEY, WEB_FLAG_KEY } from "./constants";
import { actorSys, asDnd5eActor, getDefaultTokenLight, getDnd5eApi, getItemActivities, getMidiQol, getModuleFlag, itemSys } from "./foundry-helpers";
import { chooseEdgeOrCornerAnchorForTarget, getTokenCenter } from "./grid";
import { actorHasBlur, actorHasStatusEffect, applyDamageAtZeroHp, attackerIgnoresBlur, hasConditionImmunity, hasFeyAncestry, hasMagicResistance, isActorAtZeroHp, isActorUnconscious, isConstructActor, isUndeadActor, rollAbilityCheckTotal, rollAbilitySaveTotal, setActorStabilized, setActorStatusEffect, tokenHidden } from "./actor-status";
import { allocateRepeatableSpellTargets, canRepeatTargetSelection, getAutoPlaceTemplateActivity, getCombatRoundTurn, getGuidingBoltExpiryForActor, getRestorableCondition, getSpellRange, getSpellTargetCount, getValidSpellTargets, isFlamingSphereSpell, isHealingSpell, isSpiritualWeaponSpell, isValidDirectUseBuffTarget } from "./spells";
import { asDamageRollArray, buildDamageApplicationData } from "./combat";
import { destinationIsOccupied, getSceneGridInfo, gridToPixel, pixelToGrid, type GridRect } from "./grid";
import { getTemplateHighlightedGridPositions, getTokensInTemplate, getWalledTemplateFlagsFromItem, scheduleTemplateCleanup, waitForDrawMeasuredTemplate, withRangeTemplate, type TemplateRangeSource } from "./templates";
import type { AttackResult, Entity } from "./entity";

const ADVANTAGE_GRANTING_CONDITIONS = ["blinded", "paralyzed", "petrified", "prone", "restrained", "stunned", "unconscious"];

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

  const constrainOptions = {
    ignoreWalls: true,
    ignoreCost: true,
    ignoreTokens: true,
  } satisfies Record<string, boolean>;
  await token.move(
    { x: pixelPos.x, y: pixelPos.y, action: "displace", snapped: true },
    { animate: false, constrainOptions },
  );
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
    .filter(t => !hasConditionImmunity(t.actor, "charmed"))
    .filter(t => !hasFeyAncestry(t.actor));

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
  if (cdItem && !Number((itemSys(cdItem) as { uses?: { value?: number } }).uses?.value)) return false;

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
  if (cdItem && !Number((itemSys(cdItem) as { uses?: { value?: number } }).uses?.value)) return false;

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
  const mrHookId = registerMagicResistanceSaveAdvantageHook();
  let total: number | null;
  try {
    total = await rollAbilitySaveTotal(actor, "wis", dc);
  } finally {
    Hooks.off("dnd5e.preRollSavingThrow", mrHookId);
  }
  if (total !== null && total >= dc) {
    const holdPersonEffects = actor.effects.filter(e => e.name.trim().toLowerCase() === "hold person");
    for (const e of holdPersonEffects) {
      try { await e.delete(); } catch { /* already gone */ }
    }
    await token.unsetFlag(MODULE_ID, HOLD_PERSON_DC_FLAG_KEY);
  }
}

export async function tryParalysisEndOfTurnSave(token: TokenDocument): Promise<void> {
  const state = token.getFlag(MODULE_ID, PARALYSIS_SAVE_FLAG_KEY);
  if (!state) return;
  const actor = token.actor;
  if (!actor) return;
  if (!actorHasStatusEffect(actor, "paralyzed")) {
    await token.unsetFlag(MODULE_ID, PARALYSIS_SAVE_FLAG_KEY);
    return;
  }
  const total = await rollAbilitySaveTotal(actor, state.ability, state.dc);
  if (total !== null && total >= state.dc) {
    await setActorStatusEffect(actor, "paralyzed", false);
    await token.unsetFlag(MODULE_ID, PARALYSIS_SAVE_FLAG_KEY);
    console.log(`[Ghoul Claws] ${token.name} shook off the paralysis (${total} vs DC ${state.dc})`);
  }
}

export async function breakInvisibilityOnAttack(actor: Actor | null | undefined): Promise<void> {
  if (!actor) return;
  const isInvisEffect = (e: ActiveEffect): boolean => !e.disabled && e.name.trim().toLowerCase() === "invisibility";
  if (!actor.effects.some(isInvisEffect)) return;

  const concActor = actor as Actor & {
    concentration?: { effects: Set<ActiveEffect> };
    endConcentration?: (effect: ActiveEffect) => Promise<unknown>;
  };
  const concEffect = concActor.concentration
    ? [...concActor.concentration.effects].find(e => {
        const data = (e.flags as { dnd5e?: { item?: { id?: string; data?: { name?: string } } } } | undefined)?.dnd5e?.item;
        const name = (data?.data?.name ?? actor.items.get(data?.id ?? "")?.name ?? "").trim().toLowerCase();
        return name === "invisibility";
      })
    : undefined;
  if (concEffect && concActor.endConcentration) await concActor.endConcentration(concEffect);

  // Remove any leftover Invisibility effect (e.g. cast by an ally, so concentration is elsewhere).
  for (const e of actor.effects.filter(isInvisEffect)) {
    try { await e.delete(); } catch { /* already gone */ }
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
  // Spiritual Weapon and Flaming Sphere are summoned and driven manually
  // the rollouts completely freeze otherwise
  if (spellRangeUnits === "self" || isSpiritualWeaponSpell(spell) || isFlamingSphereSpell(spell)) {
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
  const rectTemplateTypes = new Set(["rect", "cube", "square"]);
  const pointTemplateTypes = new Set(["circle", "rect", "sphere", "cylinder", "radius", "cube", "square"]);

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
      // find good candidates, not optimal but doesnt have to be
      const templateSizeUnits = (activity.target?.template?.size ?? 0);
      const isRect = rectTemplateTypes.has(templateType);
      const footprintPx = templateSizeUnits > 0
        ? ((isRect ? templateSizeUnits / 2 : templateSizeUnits) / scene.grid.distance) * scene.grid.size
        : 0;
      const withinFootprint = (tc: { x: number; y: number }, center: { x: number; y: number }): boolean =>
        isRect
          ? Math.abs(tc.x - center.x) <= footprintPx && Math.abs(tc.y - center.y) <= footprintPx
          : Math.hypot(tc.x - center.x, tc.y - center.y) <= footprintPx;

      if (footprintPx > 0) {
        const allLiveTokens = [...scene.tokens].filter(t =>
          t.actor && !isActorAtZeroHp(t.actor)
        );

        let bestScore = -Infinity;
        let bestCandidates: TokenDocument[] = [];

        for (const candidate of candidates) {
          const center = getTokenCenter(candidate, scene);
          let enemies = 0;
          let allies = 0;
          for (const t of allLiveTokens) {
            if (!withinFootprint(getTokenCenter(t, scene), center)) continue;
            if (t.disposition === caster.disposition) {
              allies++;
            } else {
              enemies++;
            }
          }
          const score = enemies - 2 * allies;
          if (score > bestScore) {
            bestScore = score;
            bestCandidates = [candidate];
          } else if (score === bestScore) {
            bestCandidates.push(candidate);
          }
        }

         // only cast if you hit atleast one enemy
        if (bestScore <= 0) return [];
        focus = bestCandidates[Math.floor(Math.random() * bestCandidates.length)] ?? candidates[0];
      } else {
        // this is the fallback for just attacking randomly
        focus = candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0];
      }
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
    if (rectTemplateTypes.has(templateType)) {
      const sizeUnits = activity.target?.template?.size ?? 0;
      const halfSizePx = sizeUnits > 0 ? (sizeUnits / 2 / scene.grid.distance) * scene.grid.size : 0;
      templateX = targetCenter.x - halfSizePx;
      templateY = targetCenter.y - halfSizePx;
      templateDirection = 45;
    } else {
      templateX = targetCenter.x;
      templateY = targetCenter.y;
      const angle = Math.toDegrees(Math.atan2(targetCenter.y - casterCenter.y, targetCenter.x - casterCenter.x));
      const snapped = Math.round((angle + 360) % 360 / 45) * 45;
      templateDirection = ((snapped % 360) + 360) % 360;
    }
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

export function getActiveSimpleFlagTargetIds(scene: Scene, flagKey: string): Set<string> {
  const active = new Set<string>();
  for (const token of scene.tokens) {
    if (!token.id) continue;
    const flag = getModuleFlag(token, flagKey);
    if (flag) active.add(token.id);
  }
  return active;
}

export function registerAdvantageHook(source: string, label: string): void {
  const hookId = Hooks.on("midi-qol.preAttackRollConfig", (workflow: MidiPreAttackWorkflow) => {
    Hooks.off("midi-qol.preAttackRollConfig", hookId);
    workflow.attackRollModifierTracker?.advantage?.add?.(source, label);
  });
}

export function registerFeyAncestrySaveAdvantageHook(saveAbilities: Set<string> | string[] | undefined): number {
  const abilities = saveAbilities instanceof Set ? saveAbilities : new Set(saveAbilities ?? []);
  return Hooks.on("dnd5e.preRollSavingThrow", (config) => {
    const actor = config.subject;
    if (!actor || !hasFeyAncestry(actor)) return undefined;
    if (abilities.size > 0 && config.ability && !abilities.has(config.ability)) return undefined;
    const rollConfig = config.rolls?.[0];
    if (!rollConfig) return undefined;
    rollConfig.options ??= {};
    rollConfig.options.advantage = true;
    console.log(`[Fey Ancestry] ${actor.name} has advantage on this save`);
    return undefined;
  });
}

export function registerMagicResistanceSaveAdvantageHook(): number {
  return Hooks.on("dnd5e.preRollSavingThrow", (config) => {
    const actor = config.subject;
    if (!actor || !hasMagicResistance(actor)) return undefined;
    const rollConfig = config.rolls?.[0];
    if (!rollConfig) return undefined;
    rollConfig.options ??= {};
    rollConfig.options.advantage = true;
    console.log(`[Magic Resistance] ${actor.name} has advantage on this save`);
    return undefined;
  });
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
  registerAdvantageHook("guidingBolt", "Guiding Bolt");
}

export async function applyFaerieFireEffect(
  effectActivity: Activity,
  selectedTargets: TokenDocument[],
  casterActor: Actor,
  casterDisposition: number,
  failedSaveIds: Set<string>,
): Promise<void> {
  if (!effectActivity.save?.dc?.value) return;
  const casterActorId = casterActor.id;
  if (!casterActorId) return;
  for (const t of selectedTargets) {
    if (!t.actor || !t.id) continue;
    if (!failedSaveIds.has(t.id)) continue;
    await t.setFlag(MODULE_ID, FAERIE_FIRE_FLAG_KEY, {
      casterDisposition, casterActorId,
    } satisfies FaerieFireState);
    console.log(`[Faerie Fire] ${t.name} is outlined (failed save)`);
  }
}

// True if `actor` currently has a concentration marker linked to the named spell. Scans effects
// directly (rather than actor.concentration) so it works even when concentration limit is 0.
function isConcentratingOn(actor: Actor, spellNameLower: string): boolean {
  for (const e of actor.effects) {
    if (e.disabled) continue;
    const item = (e.flags as { dnd5e?: { item?: { id?: string; data?: { name?: string } } } } | undefined)?.dnd5e?.item;
    if (!item) continue;
    const name = (item.data?.name ?? actor.items.get(item.id ?? "")?.name ?? "").trim().toLowerCase();
    if (name === spellNameLower) return true;
  }
  return false;
}

// Faerie Fire is concentration: clear the outline once the caster stops concentrating (Foundry
// removes the concentration effect itself, e.g. on damage or casting another concentration spell).
export async function clearExpiredFaerieFire(token: TokenDocument, scene: Scene): Promise<void> {
  const data = token.getFlag(MODULE_ID, FAERIE_FIRE_FLAG_KEY);
  if (!data) return;
  const caster = data.casterActorId ? scene.tokens.find(t => t.actor?.id === data.casterActorId)?.actor : undefined;
  if (caster && !isActorAtZeroHp(caster) && isConcentratingOn(caster, "faerie fire")) return;
  await token.unsetFlag(MODULE_ID, FAERIE_FIRE_FLAG_KEY);
  console.log(`[Faerie Fire] Outline on ${token.name} ended (concentration lost)`);
}

export async function applySpareTheDyingEffect(selectedTargets: TokenDocument[]): Promise<Set<string>> {
  const stabilized = new Set<string>();
  for (const t of selectedTargets) {
    if (!t.id || !t.actor) continue;
    if (!isActorAtZeroHp(t.actor)) continue;
    await setActorStabilized(t, true);
    stabilized.add(t.id);
    console.log(`[Spare the Dying] Stabilized ${t.name}`);
  }
  return stabilized;
}

export async function applyWebEffect(
  effectActivity: Activity,
  selectedTargets: TokenDocument[],
  casterDisposition: number,
  failedSaveIds: Set<string>,
): Promise<void> {
  const dc = effectActivity.save?.dc?.value ?? 12;
  for (const t of selectedTargets) {
    if (!t.actor || !t.id) continue;
    if (t.disposition === casterDisposition) continue; // don't web allies
    if (!failedSaveIds.has(t.id)) continue;
    await setActorStatusEffect(t.actor, "restrained", true);
    await t.setFlag(MODULE_ID, WEB_FLAG_KEY, { dc } satisfies WebState);
    console.log(`[Web] ${t.name} is restrained (DC ${dc})`);
  }
}

export async function tryWebEscape(token: TokenDocument, actor: Actor): Promise<boolean> {
  const state = token.getFlag(MODULE_ID, WEB_FLAG_KEY);
  if (!state) return false;
  if (!actorHasStatusEffect(actor, "restrained")) {
    await token.unsetFlag(MODULE_ID, WEB_FLAG_KEY);
    return false;
  }
  const dc = state.dc;
  const total = await rollAbilityCheckTotal(actor, "str", dc);
  console.log(`[Web] ${token.name} STR check vs DC ${dc}: ${total ?? "(failed to roll)"}`);
  if (total !== null && total >= dc) {
    await setActorStatusEffect(actor, "restrained", false);
    await token.unsetFlag(MODULE_ID, WEB_FLAG_KEY);
    console.log(`[Web] ${token.name} broke free!`);
    return true;
  }
  console.log(`[Web] ${token.name} failed to break free.`);
  return false;
}

function findNearestEnemyToken(casterToken: TokenDocument, scene: Scene): TokenDocument | undefined {
  const casterCenter = getTokenCenter(casterToken, scene);
  let nearest: TokenDocument | undefined;
  let nearestDist = Infinity;
  for (const token of scene.tokens) {
    if (token.id === casterToken.id) continue;
    if (token.disposition === casterToken.disposition) continue;
    if (!token.actor || isActorAtZeroHp(token.actor)) continue;
    if (token.combatant?.defeated) continue;
    if (tokenHidden(token, casterToken)) continue;
    const center = getTokenCenter(token, scene);
    const dist = Math.hypot(center.x - casterCenter.x, center.y - casterCenter.y);
    if (dist < nearestDist) { nearestDist = dist; nearest = token; }
  }
  return nearest;
}

function clampOriginToScene(x: number, y: number, scene: Scene): { x: number; y: number } {
  const d = scene.dimensions;
  return {
    x: Math.min(Math.max(x, d.sceneX), d.sceneX + d.sceneWidth),
    y: Math.min(Math.max(y, d.sceneY), d.sceneY + d.sceneHeight),
  };
}

export async function applySpiritualWeaponEffect(
  casterToken: TokenDocument,
  scene: Scene,
  castLevel: number,
): Promise<void> {
  const enemy = findNearestEnemyToken(casterToken, scene);
  const center = cellCenterPx(getTokenCenter(enemy ?? casterToken, scene), scene);
  const templateData: Record<string, unknown> = {
    t: "circle",
    distance: scene.grid.distance / 2,
    x: center.x,
    y: center.y,
    elevation: casterToken.elevation,
    borderColor: "#4444ff",
    fillColor: "#8888ff",
    fillAlpha: 0.2,
    flags: { walledtemplates: { wallsBlock: "unwalled", noAutotarget: true } },
  };

  const created = (await scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]))[0];
  if (!created?.id) return;

  await casterToken.setFlag(MODULE_ID, SPIRITUAL_WEAPON_FLAG_KEY, {
    templateId: created.id,
    castLevel,
  } satisfies SpiritualWeaponState);
  console.log(`[Spiritual Weapon] Created template ${created.id} at cast level ${castLevel} for ${casterToken.name}`);
}

export async function performSpiritualWeaponAttack(entity: Entity, casterToken: TokenDocument, scene: Scene): Promise<void> {
  const state = casterToken.getFlag(MODULE_ID, SPIRITUAL_WEAPON_FLAG_KEY);
  if (!state) return;

  // If the template was externally deleted
  if (!scene.templates.has(state.templateId)) {
    await casterToken.unsetFlag(MODULE_ID, SPIRITUAL_WEAPON_FLAG_KEY);
    console.log(`[Spiritual Weapon] Template gone, cleaned up flag for ${casterToken.name}`);
    return;
  }

  const enemy = findNearestEnemyToken(casterToken, scene);
  if (!enemy?.id) {
    console.log(`[Spiritual Weapon] No enemies to attack for ${casterToken.name}`);
    return;
  }

  const template = scene.templates.get(state.templateId);
  if (!template) return;

  const info = getSceneGridInfo(scene, true);
  const cellPx = info?.sizeX ?? scene.grid.size;

  const casterActor = casterToken.actor;
  const targetActor = enemy.actor;
  if (!casterActor || !targetActor) return;
  const swItem = casterActor.items.find(i => isSpiritualWeaponSpell(i));

  // Move the weapon up to 20 ft (bonus-action move) toward the enemy, then attack only if a target
  // is within 5 ft of it. Draw a template for this
  const weaponCenter = { x: template.x, y: template.y };
  const enemyCenter = getTokenCenter(enemy, scene);
  const destinations = await reachableSummonCells(scene, weaponCenter, cellPx, template.elevation, 20, swItem);
  const newCenter = destinations.reduce((a, b) =>
    (Math.hypot(b.x - enemyCenter.x, b.y - enemyCenter.y) < Math.hypot(a.x - enemyCenter.x, a.y - enemyCenter.y) ? b : a));
  await template.update({ x: newCenter.x, y: newCenter.y });

  if (!await tokenWithinCellReach(scene, newCenter, cellPx, template.elevation, scene.grid.distance, enemy, swItem)) {
    console.log(`[Spiritual Weapon] ${casterToken.name}: moved toward ${enemy.name}, not in reach this turn`);
    return;
  }

  const attackBonus = actorSys(casterActor).attributes?.spell?.attack ?? 0;
  const damageMod = actorSys(casterActor).attributes?.spell?.mod ?? 0;
  const ac = actorSys(targetActor).attributes?.ac?.value ?? 10;

  // manual roll because it freezes otherwise
  const guidingBoltIds = await getActiveGuidingBoltTargetIds(scene);
  const faerieFireIds = getActiveSimpleFlagTargetIds(scene, FAERIE_FIRE_FLAG_KEY);
  const targetHasFlagAdvantage = !!enemy.id && (guidingBoltIds.has(enemy.id) || faerieFireIds.has(enemy.id));
  const targetHasConditionAdvantage = ADVANTAGE_GRANTING_CONDITIONS.some(c => actorHasStatusEffect(targetActor, c));
  let advantage = targetHasFlagAdvantage || targetHasConditionAdvantage;
  let disadvantage = actorHasBlur(targetActor) && !attackerIgnoresBlur(casterActor);
  if (advantage && disadvantage) { advantage = false; disadvantage = false; } // they cancel out

  const d20 = advantage ? "2d20kh1" : disadvantage ? "2d20kl1" : "1d20";
  const attackRoll = await new Roll(`${d20} + ${attackBonus}`).evaluate();
  const natural = attackRoll.dice[0]?.total ?? (attackRoll.total - attackBonus);
  const isFumble = natural === 1;
  let isCritical = natural === 20;
  const hit = isCritical || (!isFumble && attackRoll.total >= ac);
  if (hit && (actorHasStatusEffect(targetActor, "paralyzed") || actorHasStatusEffect(targetActor, "unconscious"))) {
    isCritical = true;
  }
  if (enemy.id && guidingBoltIds.has(enemy.id)) await clearGuidingBoltFlag(enemy);

  // 1d8 + spellcasting mod, +1d8 per two slot levels above 2nd; double dice on a crit.
  const numDice = 1 + Math.max(0, Math.floor((state.castLevel - 2) / 2));
  const damageRoll = hit ? await new Roll(`${isCritical ? numDice * 2 : numDice}d8 + ${damageMod}`).evaluate() : undefined;
  const totalDamage = damageRoll ? Math.max(0, damageRoll.total) : 0;

  const outcome = hit ? `Hit${isCritical ? " (crit)" : ""} for ${totalDamage} force` : "Miss";
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: casterToken, actor: casterActor }),
    flavor: `Spiritual Weapon → ${enemy.name} (AC ${ac}): ${outcome}`,
    rolls: damageRoll ? [attackRoll, damageRoll] : [attackRoll],
  });

  if (!hit) return;

  if (isActorAtZeroHp(targetActor)) {
    if (enemy.disposition === 1) await applyDamageAtZeroHp(targetActor, enemy.name, totalDamage, isCritical ? 2 : 1, "damage");
    return;
  }

  const damageActor = asDnd5eActor(targetActor);
  if (typeof damageActor.applyDamage === "function") {
    await damageActor.applyDamage(totalDamage, { damage: buildDamageApplicationData([{ total: totalDamage, options: { type: "force" } }]) });
  }
  if (isActorAtZeroHp(targetActor)) await setActorStatusEffect(targetActor, "unconscious", true);
}

async function tokenWithinCellReach(
  scene: Scene,
  center: { x: number; y: number },
  cellPx: number,
  elevation: number,
  reachFt: number,
  target: TokenDocument,
  sourceItem: Item | undefined,
): Promise<boolean> {
  const source: TemplateRangeSource = { x: center.x - cellPx / 2, y: center.y - cellPx / 2, width: 1, height: 1, elevation };
  const hits = await withRangeTemplate(
    scene, source, reachFt,
    (tpl) => getTokensInTemplate(tpl, scene, [target]),
    sourceItem, false,
  );
  return !!hits && hits.length > 0;
}

async function reachableSummonCells(
  scene: Scene,
  fromCenter: { x: number; y: number },
  cellPx: number,
  elevation: number,
  moveFt: number,
  sourceItem: Item | undefined,
): Promise<{ x: number; y: number }[]> {
  const source: TemplateRangeSource = { x: fromCenter.x - cellPx / 2, y: fromCenter.y - cellPx / 2, width: 1, height: 1, elevation };
  const cells = await withRangeTemplate(
    scene, source, moveFt,
    (tpl) => getTemplateHighlightedGridPositions(tpl, scene),
    sourceItem, false,
  ) ?? [];
  const centers: { x: number; y: number }[] = [];
  for (const c of cells) {
    const topLeft = gridToPixel(c.x, c.y, scene);
    if (topLeft) centers.push({ x: topLeft.x + cellPx / 2, y: topLeft.y + cellPx / 2 });
  }
  return centers.length > 0 ? centers : [fromCenter];
}

function scoreSphereThreat(
  center: { x: number; y: number },
  casterDisposition: number,
  live: TokenDocument[],
  scene: Scene,
): number {
  const sphereCell = pixelToGrid(center.x, center.y, scene, { silent: true });
  if (!sphereCell) return -Infinity;
  let enemies = 0;
  let allies = 0;
  for (const t of live) {
    const tc = getTokenCenter(t, scene);
    const cell = pixelToGrid(tc.x, tc.y, scene, { silent: true });
    if (!cell) continue;
    if (Math.max(Math.abs(cell.x - sphereCell.x), Math.abs(cell.y - sphereCell.y)) > 1) continue;
    if (t.disposition === casterDisposition) allies++;
    else enemies++;
  }
  return enemies - 2 * allies;
}

function cellCenterPx(pt: { x: number; y: number }, scene: Scene): { x: number; y: number } {
  const info = getSceneGridInfo(scene, true);
  const sizeX = info?.sizeX ?? scene.grid.size;
  const sizeY = info?.sizeY ?? scene.grid.size;
  const padX = info?.paddingX ?? 0;
  const padY = info?.paddingY ?? 0;
  const cellX = Math.floor((pt.x - padX) / sizeX);
  const cellY = Math.floor((pt.y - padY) / sizeY);
  return clampOriginToScene(padX + (cellX + 0.5) * sizeX, padY + (cellY + 0.5) * sizeY, scene);
}

async function rollFlamingSphereSaveDamage(
  token: TokenDocument,
  actor: Actor,
  dc: number,
  castLevel: number,
  flavorPrefix: string,
): Promise<void> {
  const autoFailsDexSave = ["paralyzed", "stunned", "unconscious", "petrified"].some(c => actorHasStatusEffect(actor, c));
  let saved: boolean;
  if (autoFailsDexSave) {
    saved = false;
  } else {
    const mrHookId = registerMagicResistanceSaveAdvantageHook();
    const restrainedHookId = Hooks.on("dnd5e.preRollSavingThrow", (config) => {
      const subject = config.subject;
      if (!subject || !actorHasStatusEffect(subject, "restrained")) return undefined;
      const rollConfig = config.rolls?.[0];
      if (!rollConfig) return undefined;
      rollConfig.options ??= {};
      rollConfig.options.disadvantage = true;
      return undefined;
    });
    let saveTotal: number | null;
    try {
      saveTotal = await rollAbilitySaveTotal(actor, "dex", dc);
    } finally {
      Hooks.off("dnd5e.preRollSavingThrow", mrHookId);
      Hooks.off("dnd5e.preRollSavingThrow", restrainedHookId);
    }
    saved = saveTotal !== null && saveTotal >= dc;
  }

  // 2d6, +1d6 per slot level above 2nd
  const numDice = 2 + Math.max(0, castLevel - 2);
  const roll = await new Roll(`${numDice}d6`).evaluate();
  const damage = Math.max(0, saved ? Math.floor(roll.total / 2) : roll.total);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token, actor }),
    flavor: `${flavorPrefix} (DC ${dc} Dex): ${saved ? "save" : "fail"} for ${damage} fire`,
    rolls: [roll],
  });

  if (damage <= 0) return;
  if (isActorAtZeroHp(actor)) {
    if (token.disposition === 1) await applyDamageAtZeroHp(actor, token.name, damage, 1, "fire");
    return;
  }
  const damageActor = asDnd5eActor(actor);
  if (typeof damageActor.applyDamage === "function") {
    await damageActor.applyDamage(damage, { damage: buildDamageApplicationData([{ total: damage, options: { type: "fire" } }]) });
  }
  if (isActorAtZeroHp(actor)) await setActorStatusEffect(actor, "unconscious", true);
}

export async function applyFlamingSphereEffect(
  casterToken: TokenDocument,
  scene: Scene,
  castLevel: number,
  spell: Item,
): Promise<void> {
  const info = getSceneGridInfo(scene, true);
  const cellPx = info?.sizeX ?? scene.grid.size;
  const templateSize = getItemActivities(spell).map(a => Number(a.target?.template?.size)).find(s => Number.isFinite(s) && s > 0);
  const sphereRadiusFt = (templateSize ?? scene.grid.distance) / 2;
  const live = [...scene.tokens].filter(t => t.actor && !isActorAtZeroHp(t.actor)) as TokenDocument[];

  const casterCenter = getTokenCenter(casterToken, scene);
  // only place in good spots and make a template to make sure its within bounds
  // so technically flaming sphere can go over pits and stuff, but rn i don't model pits properly
  // i could do this with the wall height module
  // but frankly for simplicity i just ignore it here
  // the encounter that flaming skull is in is mildly easier than it should be bc of this
  // bc line of sight and big pit in the ground are technically different things,
  // but in vanilla foundry you can only really represent it with a wall
  const enemies = live.filter(t =>
    t.id !== casterToken.id && t.disposition !== casterToken.disposition && !tokenHidden(t, casterToken));
  const reachable = await reachableSummonCells(scene, casterCenter, cellPx, casterToken.elevation, getSpellRange(spell) || 60, spell);

  let center = cellCenterPx(casterCenter, scene);
  if (enemies.length > 0) {
    const enemyCenters = enemies.map(e => getTokenCenter(e, scene));
    let best: { center: { x: number; y: number }; score: number; dist: number } | undefined;
    for (const candidate of reachable) {
      const score = scoreSphereThreat(candidate, casterToken.disposition, live, scene);
      const dist = Math.min(...enemyCenters.map(ec => Math.hypot(ec.x - candidate.x, ec.y - candidate.y)));
      if (!best || score > best.score || (score === best.score && dist < best.dist)) {
        best = { center: candidate, score, dist };
      }
    }
    if (best) center = best.center;
  }

  const templateData: Record<string, unknown> = {
    t: "circle",
    distance: sphereRadiusFt,
    x: center.x,
    y: center.y,
    elevation: casterToken.elevation,
    borderColor: "#ff7a00",
    fillColor: "#ff4500",
    fillAlpha: 0.25,
    flags: { walledtemplates: { wallsBlock: "unwalled", noAutotarget: true } },
  };

  const created = (await scene.createEmbeddedDocuments("MeasuredTemplate", [templateData]))[0];
  if (!created?.id) return;

  await casterToken.setFlag(MODULE_ID, FLAMING_SPHERE_FLAG_KEY, {
    templateId: created.id,
    castLevel,
  } satisfies FlamingSphereState);
  console.log(`[Flaming Sphere] Created sphere ${created.id} at cast level ${castLevel} for ${casterToken.name}`);
}

export async function performFlamingSphereMove(entity: Entity, casterToken: TokenDocument, scene: Scene): Promise<void> {
  void entity;
  const state = casterToken.getFlag(MODULE_ID, FLAMING_SPHERE_FLAG_KEY);
  if (!state) return;

  if (!scene.templates.has(state.templateId)) {
    await casterToken.unsetFlag(MODULE_ID, FLAMING_SPHERE_FLAG_KEY);
    console.log(`[Flaming Sphere] Template gone, cleaned up flag for ${casterToken.name}`);
    return;
  }
  const template = scene.templates.get(state.templateId);
  const casterActor = casterToken.actor;
  if (!template || !casterActor) return;

  const info = getSceneGridInfo(scene, true);
  const cellPx = info?.sizeX ?? scene.grid.size;
  const ftToPx = cellPx / scene.grid.distance;
  const sphereCenter = { x: template.x, y: template.y };
  const spell = casterActor.items.find(i => isFlamingSphereSpell(i));
  const moveFt = ((spell ? getSpellRange(spell) : 0) || 60) / 2; // half the casting range

  const live = [...scene.tokens].filter(t => t.actor && !isActorAtZeroHp(t.actor)) as TokenDocument[];
  const enemies = live.filter(t =>
    t.id !== casterToken.id && t.disposition !== casterToken.disposition && !tokenHidden(t, casterToken));
  if (enemies.length === 0) {
    console.log(`[Flaming Sphere] No reachable enemies for ${casterToken.name}`);
    return;
  }
  const enemyIds = new Set(enemies.map(e => e.id));

  const destinations = await reachableSummonCells(scene, sphereCenter, cellPx, template.elevation, moveFt, spell);
  const destInfo = destinations
    .map(center => {
      const g = pixelToGrid(center.x, center.y, scene, { silent: true });
      return g ? { center, key: `${g.x},${g.y}`, score: 0 } : null;
    })
    .filter((d): d is { center: { x: number; y: number }; key: string; score: number } => d !== null);

  const relevantPx = (moveFt + 2 * scene.grid.distance) * ftToPx;
  for (const t of live) {
    if (t.id === casterToken.id) continue;
    const isEnemy = t.disposition !== casterToken.disposition;
    if (isEnemy && !enemyIds.has(t.id)) continue; // not visible to the caster
    const tc = getTokenCenter(t, scene);
    if (Math.hypot(tc.x - sphereCenter.x, tc.y - sphereCenter.y) > relevantPx) continue;
    // we draw a template so that it gets stopped by walls (requires walled tempaltes)
    // and then check which places are valid with that in mind
    // migrating to v14 is going to be so hard dawg we use templates for everything (it uses regions now)
    const adjCells = await withRangeTemplate(scene, t, scene.grid.distance,
      (tpl) => getTemplateHighlightedGridPositions(tpl, scene), spell, false) ?? [];
    const adjKeys = new Set(adjCells.map(c => `${c.x},${c.y}`));
    const delta = isEnemy ? 1 : -2;
    for (const d of destInfo) if (adjKeys.has(d.key)) d.score += delta;
  }

  const enemyCenters = enemies.map(e => getTokenCenter(e, scene));
  let best: { center: { x: number; y: number }; score: number; dist: number } | undefined;
  for (const d of destInfo) {
    const dist = Math.min(...enemyCenters.map(ec => Math.hypot(ec.x - d.center.x, ec.y - d.center.y)));
    if (!best || d.score > best.score || (d.score === best.score && dist < best.dist)) {
      best = { center: d.center, score: d.score, dist };
    }
  }
  if (!best) return;

  await template.update({ x: best.center.x, y: best.center.y });

  const ramSource: TemplateRangeSource = { x: best.center.x - cellPx / 2, y: best.center.y - cellPx / 2, width: 1, height: 1, elevation: template.elevation };
  const adjacentEnemies = await withRangeTemplate(
    scene, ramSource, scene.grid.distance,
    (tpl) => getTokensInTemplate(tpl, scene, enemies),
    spell, false,
  ) ?? [];
  const rammed = adjacentEnemies.find(e => e.actor);
  if (!rammed?.actor) {
    console.log(`[Flaming Sphere] ${casterToken.name}: rolled sphere, no ram this turn`);
    return;
  }
  const dc = actorSys(casterActor).attributes?.spell?.dc ?? 10;
  await rollFlamingSphereSaveDamage(rammed, rammed.actor, dc, state.castLevel, `Flaming Sphere rams ${rammed.name}`);
}

export async function applyFlamingSphereEndOfTurnDamage(token: TokenDocument, scene: Scene): Promise<void> {
  const actor = token.actor;
  if (!actor || isActorAtZeroHp(actor)) return;

  const info = getSceneGridInfo(scene, true);
  const cellPx = info?.sizeX ?? scene.grid.size;

  for (const owner of scene.tokens) {
    const state = owner.getFlag(MODULE_ID, FLAMING_SPHERE_FLAG_KEY);
    if (!state) continue;
    const template = scene.templates.get(state.templateId);
    if (!template) continue;
    const spell = owner.actor?.items.find(i => isFlamingSphereSpell(i));
    if (!await tokenWithinCellReach(scene, { x: template.x, y: template.y }, cellPx, template.elevation, scene.grid.distance, token, spell)) continue;
    const dc = actorSys(owner.actor).attributes?.spell?.dc ?? 10;
    await rollFlamingSphereSaveDamage(token, actor, dc, state.castLevel, `${token.name} ends turn near Flaming Sphere`);
    if (isActorAtZeroHp(actor)) return;
  }
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

export async function rollSaveFailures(
  targets: TokenDocument[],
  ability: string,
  dc: number,
  casterDisposition: number,
): Promise<Set<string>> {
  const failed = new Set<string>();
  for (const t of targets) {
    if (!t.actor || !t.id) continue;
    if (t.disposition === casterDisposition) continue; // allies aren't affected by these spells
    const total = await rollAbilitySaveTotal(t.actor, ability, dc);
    if (total === null || total < dc) failed.add(t.id);
  }
  return failed;
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
