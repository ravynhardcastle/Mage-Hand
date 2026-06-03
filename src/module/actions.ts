import type { Activity, UpdateData } from "./configuration";
import { actorSys, delayMs, getItemActivities, getItemsOfType, getTokenLayer, itemSys } from "./foundry-helpers";
import { actorHasStatusEffect, actorNeedsHealing, isActorAtZeroHp, isActorUnableToAct, setActorStatusEffect, tokenHidden } from "./actor-status";
import { gridToPixel, gridRectChebyshevDistance, pixelToGrid, getSceneGridInfo, getMovementGridPositions, destinationIsOccupied, toGridRect, tokenOverlapsToken, type GridRect } from "./grid";
import { getTokensInTemplate, getWalledTemplateFlagsFromItem, withRangeTemplate } from "./templates";
import { allocateRepeatableSpellTargets, canRepeatTargetSelection, evaluateSpellEligibilityForRandomAction, getAutoPlaceTemplateActivity, getCastableBonusActionSpells, getCastableSpellsForRandomAction, getRandomSpellSupportProfile, getSpellRange, getSpellTargetCount, getValidSpellTargets, isAidSpell, isCharmPersonSpell, isConcentrationSpell, isGuidingBoltSpell, isHealingSpell, isHoldPersonSpell, isLesserRestorationSpell, isLightCantrip, isMistyStepSpell, isSanctuarySpell, isSleepSpell, isValidDirectUseBuffTarget, pickCastSlot, type CastSlot, type ItemWithUse } from "./spells";
import { Entity, type AttackResult, type AttackResultTarget } from "./entity";
import { applySpellEffectDamage, asDamageRollArray, getEquippedWeaponsWithReach, getPositionsInRange, getRangeZoneIntersection, getUsableAmmunitionIdOrNull, rollAttack, type WeaponRangeZone } from "./combat";
import { applyCharmPersonEffect, applyGuidingBoltEffect, applyHoldPersonParalysis, applyLesserRestorationEffect, applyLightCantripEffect, applyMistyStepTeleport, applySanctuaryEffect, applySleepEffect, checkSanctuaryBlocked, clearGuidingBoltFlag, clearSanctuaryOnOffensiveAct, getActiveGuidingBoltTargetIds, getTargetsForDirectUseSpell, getTargetsForNativeTemplateSpell, getTargetsForRangeSpell, isUnderSanctuary, registerGuidingBoltAdvantageHook, waitForMidiAttackHits, waitForMidiSaveFails } from "./spell-execution";

export type TriggeredReaction = {
  weaponExitPositions: Record<string, { x: number; y: number }>;
  eligibleWeapons: string[];
}

export class Action {
  entity: Entity;
  triggeredReactions: Record<string, TriggeredReaction> = {};
  events: AttackResult[] = [];
  usedReaction?: Set<string>;

  constructor(entity: Entity) {
    this.entity = entity;
  }
  async act() {
    // Implemented by subclasses
  }
}

export class MoveAction extends Action {
  targetX: number;
  targetY: number;

  constructor(entity: Entity, targetX: number, targetY: number) {
    super(entity);
    this.targetX = targetX;
    this.targetY = targetY;
  }

  override async act() {
    // Move to targetX, targetY
    const activeScene = canvas?.scene ?? game.scenes?.active;
    if (!activeScene) return;
    const entityToken = activeScene.tokens.get(this.entity.id || "");
    if (!entityToken) return;
    const gridSize = activeScene.grid.size;
    if (!gridSize) return;
    // cap to scene bounds
    const width = Math.floor(activeScene.dimensions.sceneWidth / activeScene.grid.sizeX);
    const height = Math.floor(activeScene.dimensions.sceneHeight / activeScene.grid.sizeY);

    // account for token footprint
    const tokenGridWidth = Math.max(1, Math.ceil(entityToken.width));
    const tokenGridHeight = Math.max(1, Math.ceil(entityToken.height));

    const maxTargetX = Math.max(0, width - tokenGridWidth);
    const maxTargetY = Math.max(0, height - tokenGridHeight);

    const cappedTargetX = Math.max(0, Math.min(maxTargetX, this.targetX));
    const cappedTargetY = Math.max(0, Math.min(maxTargetY, this.targetY));

    const pixelPos = gridToPixel(cappedTargetX, cappedTargetY, activeScene);
    if (!pixelPos) return;
    // ignore if over movement speed (might need a proper capping later)
    const tokenObject = entityToken.object;
    if (!tokenObject) return;

    const isProne = entityToken.actor != null && actorHasStatusEffect(entityToken.actor, "prone");
    const movementSpeed = actorSys(this.entity).attributes?.movement?.speed ?? 30;
    const effectiveSpeed = isProne ? Math.floor(movementSpeed / 2) : movementSpeed;

    const destRect: GridRect = { x: cappedTargetX, y: cappedTargetY, width: tokenGridWidth, height: tokenGridHeight };
    if (destinationIsOccupied(activeScene, destRect, this.entity.id || "")) return;

    /* eslint-disable */
    // @ts-expect-error This is just wrong, createTerrainMovementPath does exist
    const cost = tokenObject.measureMovementPath(tokenObject.createTerrainMovementPath([{ x: entityToken.x, y: entityToken.y }, { x: pixelPos.x, y: pixelPos.y }], { "preview": false })).cost;
    /* eslint-enable */
    if (cost > effectiveSpeed) {
      return;
    }

    // we could probably make this less hacked in but whatever idk how lol
    if (isProne) {
      if (!actorHasStatusEffect(entityToken.actor, "sleeping") && !actorHasStatusEffect(entityToken.actor, "unconscious")) {
        await setActorStatusEffect(entityToken.actor, "prone", false);
      }
    }

    const old_pos = { x: entityToken.x, y: entityToken.y };
    await entityToken.move({ x: pixelPos.x, y: pixelPos.y, snapped: true }, { animate: false });

    const actualGridPos = pixelToGrid(entityToken.x, entityToken.y, activeScene, { round: true, silent: true });
    const reachedTargetGrid =
      actualGridPos != null &&
      actualGridPos.x === cappedTargetX &&
      actualGridPos.y === cappedTargetY;

    if (!reachedTargetGrid) {
      await entityToken.update({ x: old_pos.x, y: old_pos.y }, { animate: false });
      return;
    }

    if (Math.abs(entityToken.x - pixelPos.x) > 0.1 || Math.abs(entityToken.y - pixelPos.y) > 0.1) {
      await entityToken.update({ x: pixelPos.x, y: pixelPos.y }, { animate: false });
    }

    if (tokenOverlapsToken(activeScene, entityToken)) {
      await entityToken.update({ x: old_pos.x, y: old_pos.y }, { animate: false });
      return;
    }

    this.entity.x = entityToken.x;
    this.entity.y = entityToken.y;

    const path = getMovementGridPositions(old_pos, { x: entityToken.x, y: entityToken.y }, activeScene);
    const moverW = Math.max(1, Math.ceil(this.entity.width));
    const moverH = Math.max(1, Math.ceil(this.entity.height));
    // Check each enemy token's weapon ranges for exit triggers
    for (const token of activeScene.tokens) {
      if (token.disposition === entityToken.disposition) continue;
      if (token.actor && isActorUnableToAct(token.actor)) continue;
      const weapons = getEquippedWeaponsWithReach(token);
      // Deduplicate ranges so we only build positions once per unique reach value
      const reachValues = [...new Set(weapons.map(w => w.reach))];
      // for each unique reach, check if the mover exited that specific reach band
      const exitedReachPositions = new Map<number, { x: number; y: number }>();
      for (const reach of reachValues) {
        const rangePositions = await getPositionsInRange(token, reach, activeScene);
        const zone: WeaponRangeZone = {
          enemyTokenId: token.id,
          weaponName: "",
          reach,
          positions: rangePositions,
          state: "None",
        };
        const state = getRangeZoneIntersection(path, zone, moverW, moverH);
        if (state === "Exited" && zone.lastInsidePos) {
          exitedReachPositions.set(reach, zone.lastInsidePos);
        }
      }
      if (exitedReachPositions.size > 0) {
        const eligibleWeapons = weapons.filter(w => exitedReachPositions.has(w.reach)).map(w => w.name);
        if (eligibleWeapons.length === 0) continue;

        const weaponExitPositions = weapons.reduce<Record<string, { x: number; y: number }>>((acc, weapon) => {
          const exitPos = exitedReachPositions.get(weapon.reach);
          if (exitPos) {
            acc[weapon.name] = exitPos;
          }
          return acc;
        }, {});

        this.triggeredReactions[token.id] = { weaponExitPositions, eligibleWeapons };
      }
    }
  }
}

function pickMoveDestination(
  moverToken: TokenDocument,
  scene: Scene,
  movementUnits: number,
  enemyBias: number
): { x: number; y: number } | null {
  const currentPos = pixelToGrid(moverToken.x, moverToken.y, scene, { round: true, silent: true });
  if (!currentPos) return null;

  const tokenGridWidth = Math.max(1, Math.ceil(moverToken.width));
  const tokenGridHeight = Math.max(1, Math.ceil(moverToken.height));

  const info = getSceneGridInfo(scene);
  if (!info) return null;
  const maxTargetX = Math.max(0, info.widthCells - tokenGridWidth);
  const maxTargetY = Math.max(0, info.heightCells - tokenGridHeight);

  const minX = Math.max(0, currentPos.x - movementUnits);
  const maxX = Math.min(maxTargetX, currentPos.x + movementUnits);
  const minY = Math.max(0, currentPos.y - movementUnits);
  const maxY = Math.min(maxTargetY, currentPos.y + movementUnits);

  const candidates: { x: number; y: number }[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const destRect: GridRect = { x, y, width: tokenGridWidth, height: tokenGridHeight };
      if (destinationIsOccupied(scene, destRect, moverToken.id || "")) continue;
      candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return null;

  const useEnemyBias = enemyBias > 0 && Math.random() < enemyBias;
  if (!useEnemyBias) {
    return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
  }

  // Bias toward the cell whose center is closest to any threatening enemy.
  const enemyCenters: { x: number; y: number }[] = [];
  for (const t of scene.tokens) {
    if (t.id === moverToken.id) continue;
    if (t.disposition === moverToken.disposition) continue;
    if (t.actor && isActorUnableToAct(t.actor)) continue;
    const gp = pixelToGrid(t.x, t.y, scene, { round: true, silent: true });
    if (!gp) continue;
    enemyCenters.push({
      x: gp.x + Math.max(1, Math.ceil(t.width)) / 2,
      y: gp.y + Math.max(1, Math.ceil(t.height)) / 2,
    });
  }
  if (enemyCenters.length === 0) {
    return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
  }

  const halfW = tokenGridWidth / 2;
  const halfH = tokenGridHeight / 2;
  let best = candidates[0] ?? null;
  let bestDistSq = Infinity;
  for (const c of candidates) {
    const cx = c.x + halfW;
    const cy = c.y + halfH;
    let nearest = Infinity;
    for (const e of enemyCenters) {
      const dx = cx - e.x;
      const dy = cy - e.y;
      const d = dx * dx + dy * dy;
      if (d < nearest) nearest = d;
    }
    if (nearest < bestDistSq) {
      bestDistSq = nearest;
      best = c;
    }
  }
  return best;
}

export class RandomMoveAction extends MoveAction {
  constructor(entity: Entity) {
    const activeScene = canvas?.scene ?? game.scenes?.active;
    if (!activeScene) throw new Error("No active scene");
    const moverToken = activeScene.tokens.get(entity.id || "");
    const sourceX = moverToken?.x ?? entity.x;
    const sourceY = moverToken?.y ?? entity.y;
    const baseGridPos =
      pixelToGrid(sourceX, sourceY, activeScene, { round: true, silent: true })
      ?? pixelToGrid(sourceX, sourceY, activeScene)
      ?? { x: 0, y: 0 };
    const rawSpeed =
      actorSys(entity)
        .attributes?.movement?.speed ?? 30;
    const isProne = moverToken?.actor != null && actorHasStatusEffect(moverToken.actor, "prone");
    const movement_speed = isProne ? Math.floor(rawSpeed / 2) : rawSpeed;
    const gridDistance = activeScene.grid.distance;
    const movement_units = Math.floor(movement_speed / gridDistance);
    const prevalidated = moverToken
      ? pickMoveDestination(moverToken, activeScene, movement_units, 0)
      : null;
    const targetX = prevalidated
      ? prevalidated.x
      : Math.round(baseGridPos.x + (Math.random() * 2 - 1) * movement_units);
    const targetY = prevalidated
      ? prevalidated.y
      : Math.round(baseGridPos.y + (Math.random() * 2 - 1) * movement_units);
    super(entity, targetX, targetY);
  }
}

export class SmartMoveAction extends MoveAction {
  constructor(entity: Entity, enemyBias: number) {
    const activeScene = canvas?.scene ?? game.scenes?.active;
    if (!activeScene) throw new Error("No active scene");
    const moverToken = activeScene.tokens.get(entity.id || "");
    const sourceX = moverToken?.x ?? entity.x;
    const sourceY = moverToken?.y ?? entity.y;
    const baseGridPos =
      pixelToGrid(sourceX, sourceY, activeScene, { round: true, silent: true })
      ?? pixelToGrid(sourceX, sourceY, activeScene)
      ?? { x: 0, y: 0 };
    const rawSpeed =
      actorSys(entity)
        .attributes?.movement?.speed ?? 30;
    const isProne = moverToken?.actor != null && actorHasStatusEffect(moverToken.actor, "prone");
    const movement_speed = isProne ? Math.floor(rawSpeed / 2) : rawSpeed;
    const gridDistance = activeScene.grid.distance;
    const movement_units = Math.floor(movement_speed / gridDistance);
    const bias = Math.max(0, Math.min(1, enemyBias));
    const prevalidated = moverToken
      ? pickMoveDestination(moverToken, activeScene, movement_units, bias)
      : null;
    const targetX = prevalidated
      ? prevalidated.x
      : Math.round(baseGridPos.x + (Math.random() * 2 - 1) * movement_units);
    const targetY = prevalidated
      ? prevalidated.y
      : Math.round(baseGridPos.y + (Math.random() * 2 - 1) * movement_units);
    super(entity, targetX, targetY);
  }
}

export class TurnedFleeAction extends MoveAction {
  constructor(entity: Entity, sourceToken: TokenDocument) {
    const activeScene = canvas?.scene ?? game.scenes?.active;
    const moverToken = activeScene ? activeScene.tokens.get(entity.id || "") : null;
    const currentPos = moverToken && activeScene
      ? pixelToGrid(moverToken.x, moverToken.y, activeScene, { round: true, silent: true })
      : null;
    const sourcePos = moverToken && activeScene
      ? pixelToGrid(sourceToken.x, sourceToken.y, activeScene, { round: true, silent: true })
      : null;
    const info = activeScene ? getSceneGridInfo(activeScene) : null;
    let dest: { x: number; y: number } = currentPos ?? { x: 0, y: 0 };
    if (activeScene && moverToken && currentPos && sourcePos && info) {
      const rawSpeed = actorSys(entity).attributes?.movement?.speed ?? 30;
      const isProne = moverToken.actor != null && actorHasStatusEffect(moverToken.actor, "prone");
      const movementUnits = Math.floor((isProne ? Math.floor(rawSpeed / 2) : rawSpeed) / activeScene.grid.distance);
      const tokenGridWidth = Math.max(1, Math.ceil(moverToken.width));
      const tokenGridHeight = Math.max(1, Math.ceil(moverToken.height));
      const maxTargetX = Math.max(0, info.widthCells - tokenGridWidth);
      const maxTargetY = Math.max(0, info.heightCells - tokenGridHeight);
      let bestDistSq = -1;
      for (let x = Math.max(0, currentPos.x - movementUnits); x <= Math.min(maxTargetX, currentPos.x + movementUnits); x++) {
        for (let y = Math.max(0, currentPos.y - movementUnits); y <= Math.min(maxTargetY, currentPos.y + movementUnits); y++) {
          const destRect: GridRect = { x, y, width: tokenGridWidth, height: tokenGridHeight };
          if (destinationIsOccupied(activeScene, destRect, moverToken.id || "")) continue;
          const dx = x - sourcePos.x;
          const dy = y - sourcePos.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > bestDistSq) { bestDistSq = distSq; dest = { x, y }; }
        }
      }
    }
    super(entity, dest.x, dest.y);
  }
}

// Behold: the most fucked up class in the code
// Idk its not like that bad but everything is so jumbled together after like
// getting 1000 things to work.
// Needs a FULL refactor at some point
export class SpellAction extends Action {
  spellName: string | undefined;
  spellId: string | undefined;
  castSlot: CastSlot | undefined;
  cantripOnly: boolean = false;

  override async act() {
    if (!canvas?.scene) return;
    const scene = canvas.scene;
    if (!this.entity.id) return;
    const tokenActor = scene.tokens.get(this.entity.id)?.actor;
    if (!tokenActor || !this.spellName) return;

    const spell = (this.spellId ? tokenActor.items.get(this.spellId) : undefined)
      ?? tokenActor.items.getName(this.spellName)
      ?? tokenActor.items.find(i => i.name === this.spellName);
    if (!spell) return;
    const eligibility = evaluateSpellEligibilityForRandomAction(tokenActor, spell);
    if (!eligibility.ok) return;

    const castSlot = this.castSlot ?? pickCastSlot(tokenActor, spell);
    if (!castSlot) return;
    const castLevel = castSlot.level;

    const oldTargets = game.user?.targets;
    const tokensLayer = getTokenLayer();
    let plannedTargets: TokenDocument[] = [];
    let selectedTargets: TokenDocument[] = [];

    const setUniqueTargets = (targets: TokenDocument[]) => {
      const seen = new Set<string>();
      for (const t of targets) {
        if (!t.id || seen.has(t.id) || !t.object) continue;
        seen.add(t.id);
        t.object.setTarget(true, { releaseOthers: false });
      }
    };

    try {
      tokensLayer?.setTargets?.([]);

      if (eligibility.profile === "rangeTemplate") {
        plannedTargets = await getTargetsForRangeSpell(this.entity, spell, castLevel);
        if (plannedTargets.length === 0) return;
        selectedTargets = plannedTargets;
        setUniqueTargets(plannedTargets);

      } else if (eligibility.profile === "nativeTemplate") {
        if (getAutoPlaceTemplateActivity(spell)) {
          plannedTargets = await getTargetsForNativeTemplateSpell(this.entity, scene, spell);
          if (plannedTargets.length === 0) return;
          setUniqueTargets(plannedTargets);
        }

      } else if (eligibility.profile === "directUse") {
        const directTargets = await getTargetsForDirectUseSpell(this.entity, spell);
        if (directTargets.length > 0) {
          const maxTargets = Math.max(1, getSpellTargetCount(spell, castLevel));
          let chosen: TokenDocument[];
          if (canRepeatTargetSelection(spell, maxTargets)) {
            chosen = allocateRepeatableSpellTargets(directTargets, maxTargets);
          } else {
            chosen = [];
            const pool = [...directTargets];
            while (chosen.length < maxTargets && pool.length > 0) {
              const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
              if (pick) chosen.push(pick);
            }
          }
          plannedTargets = chosen;
          selectedTargets = chosen;
          const ids = chosen.map(t => t.id).filter((id): id is string => !!id);
          if (ids.length > 0) tokensLayer?.setTargets?.(ids);
          setUniqueTargets(chosen);
        } else {
          const casterToken = scene.tokens.get(this.entity.id);
          if (casterToken?.object && isValidDirectUseBuffTarget(casterToken, spell)) {
            casterToken.object.setTarget(true, { releaseOthers: false });
            plannedTargets = [casterToken];
            selectedTargets = [casterToken];
            const ids = casterToken.id ? [casterToken.id] : [];
            if (ids.length > 0) tokensLayer?.setTargets?.(ids);
          } else {
            return;
          }
        }
        await Promise.resolve();
      }

      const usableSpell = spell as ItemWithUse;
      const usableActivities = getItemActivities(spell).filter(
        (activity): activity is Activity & { use: NonNullable<Activity["use"]> } => typeof activity.use === "function"
      );

      let activityToUse = usableActivities[0];
      if (eligibility.profile === "directUse" && usableActivities.length > 0) {
        const priority = ["cast", "enchant", "utility"];
        activityToUse = usableActivities.find(a => priority.includes(a.type.toLowerCase()))
          ?? usableActivities[0];
      }

      if (castSlot.slot === "item") {
        const cachedForUuid = (spell.flags as { dnd5e?: { cachedFor?: string } } | undefined)?.dnd5e?.cachedFor;
        if (cachedForUuid) {
          const fus = (globalThis as unknown as { fromUuidSync?: (uuid: string, opts: { relative?: unknown; strict: boolean }) => unknown }).fromUuidSync;
          const sourceActivity = fus
            ? (fus(cachedForUuid, { relative: tokenActor, strict: false }) as (Activity & { use?: (...args: unknown[]) => Promise<unknown> }) | null)
            : null;
          if (sourceActivity && typeof sourceActivity.use === "function") {
            activityToUse = sourceActivity as Activity & { use: NonNullable<Activity["use"]> };
          }
        }
      }

      const useInvoker: ((
        config?: Record<string, unknown>,
        dialog?: Record<string, unknown>,
        message?: Record<string, unknown>
      ) => Promise<unknown>) | null = activityToUse
        ? activityToUse.use.bind(activityToUse)
        : (typeof usableSpell.use === "function" ? usableSpell.use.bind(usableSpell) : null);
      if (!useInvoker) return;

      const guidingBoltTargets = await getActiveGuidingBoltTargetIds(scene);
      const hasGuidingBoltAdvantage = guidingBoltTargets.size > 0 && selectedTargets.some(t => t.id && guidingBoltTargets.has(t.id));

      const useConfig: Record<string, unknown> = (eligibility.profile === "directUse")
        ? {}
        : {
          create: { measuredTemplate: false },
          midiOptions: { autoRollDamage: "none", autoFastDamage: true },
        };
      if ((itemSys(spell).level ?? 0) > 0 && castSlot.slot !== "item") {
        useConfig["spell"] = { slot: castSlot.slot };
      }
      const dialogConfig: Record<string, unknown> = { configure: false };

      if (hasGuidingBoltAdvantage) registerGuidingBoltAdvantageHook();

      const templateIdsBeforeCast = new Set(Array.from(scene.templates).map(t => t.id));
      const getCreatedTemplateIds = () => Array.from(scene.templates).map(t => t.id).filter(id => !templateIdsBeforeCast.has(id));

      const cleanupCastTemplates = async () => {
        const createdTemplateIds = getCreatedTemplateIds();
        if (createdTemplateIds.length > 0) {
          await scene.deleteEmbeddedDocuments("MeasuredTemplate", createdTemplateIds);
        }
      };

      const applyWalledFlagsToCreatedTemplates = async () => {
        const walledFlags = getWalledTemplateFlagsFromItem(spell);
        if (!walledFlags) return;
        const createdTemplateIds = getCreatedTemplateIds();
        if (createdTemplateIds.length === 0) return;
        const updates = createdTemplateIds.map(id => ({
          _id: id,
          "flags.walledtemplates": walledFlags,
        }));
        await scene.updateEmbeddedDocuments("MeasuredTemplate", updates);
      };

      const hasAttackActivity = getItemActivities(spell).some(a => a.type === "attack" && typeof a.rollDamage === "function");
      const attackHitPromise = hasAttackActivity ? waitForMidiAttackHits() : Promise.resolve(null);
      const saveFailPromise = isCharmPersonSpell(spell) ? waitForMidiSaveFails() : null;

      // If caster has sanctuary and is casting an offensive spell, it ends their sanctuary
      if (!isSanctuarySpell(spell) && !isHealingSpell(spell) && eligibility.profile !== "directUse") {
        const casterToken = scene.tokens.get(this.entity.id);
        if (casterToken) await clearSanctuaryOnOffensiveAct(casterToken);
      }

      const useResult = await useInvoker(useConfig, dialogConfig, {});
      if (useResult === false || useResult == null) {
        await cleanupCastTemplates();
        await delayMs(50);
        await cleanupCastTemplates();
        return;
      }

      if (isConcentrationSpell(spell)) {
        await applyWalledFlagsToCreatedTemplates();
        await delayMs(50);
        await applyWalledFlagsToCreatedTemplates();
      } else {
        await applyWalledFlagsToCreatedTemplates();
        await cleanupCastTemplates();
        await delayMs(50);
        await cleanupCastTemplates();
      }

      if (hasGuidingBoltAdvantage) {
        for (const target of selectedTargets) {
          if (target.id && guidingBoltTargets.has(target.id)) {
            await clearGuidingBoltFlag(target);
          }
        }
      }

      const systemTargets = game.user ? Array.from(game.user.targets).map(t => t.document) : [];
      selectedTargets = (plannedTargets.length > 0)
        ? plannedTargets
        : (selectedTargets.length > 0 ? selectedTargets : systemTargets);
      const isHealingSpellCast = isHealingSpell(spell);
      const isAidSpellCast = isAidSpell(spell);
      selectedTargets = selectedTargets.filter(t => {
        if (t.id === this.entity.id) return false;
        if (t.combatant?.defeated) return false;
        const actor = t.actor;
        if (!actor) return false;
        if (!isHealingSpellCast && isActorAtZeroHp(actor)) return false;
        if (isHealingSpellCast && !isAidSpellCast && !actorNeedsHealing(actor)) return false;
        if (isAidSpellCast && (actorSys(actor).attributes?.hp as { tempmax?: number | null } | undefined)?.tempmax) return false;
        return true;
      });

      const isSleep = isSleepSpell(spell);
      let sleepAffected = new Set<string>();
      if (isSleep && selectedTargets.length > 0) {
        sleepAffected = await applySleepEffect(spell, selectedTargets, this.entity.disposition, castLevel);
      }

      const isLightCantripCast = isLightCantrip(spell);
      let lightApplied = new Set<string>();
      if (isLightCantripCast && selectedTargets.length > 0) {
        lightApplied = await applyLightCantripEffect(tokenActor, selectedTargets, activityToUse, this.entity.disposition);
      }

      const isGuidingBolt = isGuidingBoltSpell(spell);
      const attackHitTokenIds = await attackHitPromise;
      const failedSaveIds = saveFailPromise ? await saveFailPromise : new Set<string>();

      const effectActivity = getItemActivities(spell).find(a => {
        if (a.type === "heal") return typeof a.rollHealing === "function" || typeof a.rollDamage === "function";
        return typeof a.rollDamage === "function" && (a.type === "attack" || a.type === "save" || a.type === "damage");
      });

      let damageApplied = new Map<string, number>();
      if (!isSleep && !isLightCantripCast && !isAidSpellCast && effectActivity && selectedTargets.length > 0) {
        const baseLevel = itemSys(spell).level ?? 0;
        const scaling = Math.max(0, castLevel - baseLevel);
        damageApplied = await applySpellEffectDamage(effectActivity, selectedTargets, attackHitTokenIds, scaling);
      }

      if (isAidSpellCast && effectActivity && selectedTargets.length > 0) {
        const baseLevel = itemSys(spell).level ?? 0;
        const scaling = Math.max(0, castLevel - baseLevel);
        const rollConfig = scaling > 0 ? { scaling } : {};
        const rollResult = typeof effectActivity.rollHealing === "function"
          ? await effectActivity.rollHealing(rollConfig, { configure: false })
          : await effectActivity.rollDamage?.(rollConfig, { configure: false });
        const heal = asDamageRollArray(rollResult).reduce((s, r) => s + r.total, 0);
        if (heal > 0) {
          for (const t of selectedTargets) {
            const hp = actorSys(t.actor).attributes?.hp as { value?: number; tempmax?: number | null } | undefined;
            if (!t.actor || !hp) continue;
            await t.actor.update({
              "system.attributes.hp.tempmax": (hp.tempmax ?? 0) + heal,
              "system.attributes.hp.value": (hp.value ?? 0) + heal,
            } as UpdateData);
            if (t.id) damageApplied.set(t.id, -heal);
          }
        }
      }

      if (isGuidingBolt && selectedTargets.length > 0) {
        await applyGuidingBoltEffect(tokenActor, selectedTargets, damageApplied, this.entity.disposition);
      }

      if (isMistyStepSpell(spell)) {
        await applyMistyStepTeleport(this.entity, spell, scene);
      }

      if (isLesserRestorationSpell(spell) && selectedTargets.length > 0) {
        await applyLesserRestorationEffect(selectedTargets);
      }

      if (isHoldPersonSpell(spell) && effectActivity && selectedTargets.length > 0) {
        await applyHoldPersonParalysis(effectActivity, selectedTargets);
      }

      if (isCharmPersonSpell(spell) && effectActivity && selectedTargets.length > 0) {
        await applyCharmPersonEffect(effectActivity, selectedTargets, tokenActor, this.entity.disposition, failedSaveIds);
      }

      if (isSanctuarySpell(spell) && effectActivity && selectedTargets.length > 0) {
        await applySanctuaryEffect(effectActivity, selectedTargets, tokenActor);
      }

      const isAttackEffect = effectActivity?.type === "attack";

      const targetEntries: AttackResultTarget[] = selectedTargets.map(t => {
        const tokenId = t.id ?? "";
        let hit = true;

        if (isSleep) {
          hit = tokenId.length > 0 ? sleepAffected.has(tokenId) : false;
        } else if (isLightCantripCast) {
          hit = tokenId.length > 0 ? lightApplied.has(tokenId) : false;
        } else if (isAttackEffect && attackHitTokenIds !== null) {
          const tid = t.id;
          const aid = t.actor?.id;
          hit = (tid ? attackHitTokenIds.has(tid) : false) || (aid ? attackHitTokenIds.has(aid) : false);
        } else if (isAttackEffect) {
          hit = false;
        }

        return {
          name: t.name,
          tokenId,
          ac: (actorSys(t.actor).attributes?.ac?.value) ?? 0,
          hit,
          damageDealt: tokenId.length > 0 ? (damageApplied.get(tokenId) ?? 0) : 0,
        };
      });

      const spellLabel = castLevel > 0 ? `${spell.name} (L${castLevel})` : spell.name;
      this.events.push({
        attacker: this.entity.name,
        attackerId: this.entity.id,
        weapon: spellLabel,
        attackTotal: 0,
        isCritical: false,
        isFumble: false,
        kind: "action",
        targets: targetEntries,
      });
    } finally {
      tokensLayer?.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
    }
  }
}
export class RandomSpellAction extends SpellAction {
  prepareSelectedSpell(): string | undefined {
    if (this.spellName) return this.spellName;
    if (!canvas?.scene || !this.entity.id) return undefined;

    const actor = canvas.scene.tokens.get(this.entity.id)?.actor;
    if (!actor) return undefined;

    const allSpells = getItemsOfType(actor.items, "spell");
    const spells = actorSys(actor).spells;

    const modeLabel = this.cantripOnly ? " [cantrip-only, bonus action spell reserved]" : "";
    console.group(`RandomSpell: ${this.entity.name} evaluating ${allSpells.length} spells${modeLabel}`);
    const available: Item[] = [];
    for (const spell of allSpells) {
      const level = itemSys(spell).level ?? 0;
      const eligibility = evaluateSpellEligibilityForRandomAction(actor, spell);
      const slotInfo = level > 0 ? spells?.[`spell${level}`] : undefined;
      const slotValue = slotInfo ? slotInfo.value : undefined;
      const slotMax = slotInfo ? slotInfo.max : undefined;
      const slotStr = level === 0 ? "cantrip" : `lvl ${level} (${slotValue ?? "?"}/${slotMax ?? "?"} slots)`;
      if (eligibility.ok) {
        console.log(`  ✓ "${spell.name}" [${slotStr}] eligible (${eligibility.profile})`);
        available.push(spell);
      } else {
        console.log(`  ✗ "${spell.name}" [${slotStr}] rejected: ${eligibility.reason}`);
      }
    }

    if (available.length === 0) {
      console.log(`  No castable spells available`);
      console.groupEnd();
      return undefined;
    }

    const pool = this.cantripOnly
      ? available.filter(s => (itemSys(s).level ?? 0) === 0)
      : available;
    if (pool.length === 0) {
      console.log(`  No cantrips available, bonus action spell will be used but main action has no cantrip to pair with it`);
      console.groupEnd();
      return undefined;
    }
    const selected = pool[Math.floor(Math.random() * pool.length)];
    if (!selected) { console.groupEnd(); return undefined; }

    this.spellName = selected.name;
    this.spellId = selected.id ?? undefined;
    this.castSlot = pickCastSlot(actor, selected) ?? undefined;
    const selLevel = this.castSlot?.level ?? (itemSys(selected).level ?? 0);
    const selSlot = selLevel > 0 ? spells?.[`spell${selLevel}`] : undefined;
    const costStr = this.castSlot?.slot === "item"
      ? "item charge"
      : selLevel === 0
        ? "no slot (cantrip)"
        : `1 level ${selLevel} slot (${(selSlot ? selSlot.value : 0) ?? 0} -> ${((selSlot ? selSlot.value : 0) ?? 0) - 1} remaining)`;
    const baseLevel = itemSys(selected).level ?? 0;
    const upcastNote = selLevel > baseLevel ? ` [upcast from L${baseLevel}]` : "";
    console.log(`  -> Selected: "${this.spellName}"${upcastNote}. Costs ${costStr}`);
    console.groupEnd();
    return this.spellName;
  }

  override async act() {
    const selectedSpell = this.prepareSelectedSpell();
    if (!selectedSpell) return;
    await super.act();
  }
}

export class RandomBonusSpellAction extends SpellAction {
  prepareSelectedSpell(): string | undefined {
    if (this.spellName) return this.spellName;
    if (!canvas?.scene || !this.entity.id) return undefined;
    const actor = canvas.scene.tokens.get(this.entity.id)?.actor;
    if (!actor) return undefined;
    const bonusSpells = getCastableBonusActionSpells(actor);
    if (bonusSpells.length === 0) return undefined;
    const selected = bonusSpells[Math.floor(Math.random() * bonusSpells.length)];
    if (!selected) return undefined;
    this.spellName = selected.name;
    this.spellId = selected.id ?? undefined;
    this.castSlot = pickCastSlot(actor, selected) ?? undefined;
    console.log(`[Bonus Action] ${this.entity.name} casts "${this.spellName}" as bonus action`);
    return this.spellName;
  }

  override async act() {
    const selectedSpell = this.prepareSelectedSpell();
    if (!selectedSpell) return;
    await super.act();
  }
}

// One day we should probably support throwing thrown weapons, but for now
// we can just assume that it's usually a bad choice
// it /isn't/, but a random agent would be better off not
// lowkey probably eventually just like, only throw if >1 but always keep 1? idk
export class Attack extends Action {
  shortRange: number 
  range: number;
  weapon: string | undefined;
  ammunitionId: string | undefined;
  targets: number | undefined;
  forcedTargetTokenIds: string[] | undefined;
  isRanged: boolean = false;
  disadvantage: boolean = false;

  constructor(entity: Entity, range: number, shortRange?: number) {
    super(entity);
    this.range = range;
    this.shortRange = shortRange ?? range;
  }

  override async act() {
    if (!canvas?.scene) return;
    const scene = canvas.scene;
    const weaponName = this.weapon || "Unarmed Strike";
    if (!canvas.tokens) return;
    const oldTargets = game.user?.targets;
    const tokensLayer = getTokenLayer();
    tokensLayer?.setTargets?.([]);

    try {
      let tokens = await withRangeTemplate<TokenDocument[]>(scene, this.entity, this.range, (templateObj) => {
        const validTokens = scene.tokens.filter(t => {
          if (t.id === this.entity.id) return false;
          if (t.disposition === this.entity.disposition) return false;
          if (this.forcedTargetTokenIds && this.forcedTargetTokenIds.length > 0) {
            return this.forcedTargetTokenIds.includes(t.id);
          }
          return true;
        });
        return getTokensInTemplate(templateObj, scene, validTokens);
      }, undefined, this.isRanged);

      if (!tokens || tokens.length === 0) {
        console.log(`Entity ${this.entity.name} found no targets in range to attack.`);
        return;
      }

      if (this.isRanged && this.shortRange < this.range) {
        const shortRangeTokens = await withRangeTemplate<TokenDocument[]>(scene, this.entity, this.shortRange, (templateObj) => {
          const validTokens = scene.tokens.filter(t => {
            if (t.id === this.entity.id) return false;
            if (t.disposition === this.entity.disposition) return false;
            if (this.forcedTargetTokenIds && this.forcedTargetTokenIds.length > 0) {
              return this.forcedTargetTokenIds.includes(t.id);
            }
            return true;
          });
          return getTokensInTemplate(templateObj, scene, validTokens);
        }, undefined, this.isRanged);

        if (shortRangeTokens) {
          // If there is any overlap between 'tokens' and 'shortRangeTokens', prioritize those
          const prioritizedTokens = tokens.filter(t => new Set(shortRangeTokens.map(t => t.id)).has(t.id));
          if (prioritizedTokens.length > 0) {
            tokens = prioritizedTokens;
          } else {
            // There are no prioritized tokens, i.e. there are no short ranged tokens
            // So you have to be hitting long range
            this.disadvantage = true;
          }
        }
      }

      // Remove dead targets
      const aliveTokens = tokens.filter(t => {
        const actor = t.actor;
        if (!actor) return false;
        return !isActorAtZeroHp(actor);
      });

      // Remove targets it can't see
      const visibleTokens = aliveTokens.filter(t => {
        const actor = t.actor;
        if (!actor) return false;
        return !tokenHidden(t, scene.tokens.get(this.entity.id ?? "") ?? t)
      });


      if (visibleTokens.length === 0) {
        console.log(`Entity ${this.entity.name} found only dead or hidden targets in range to attack.`);
      } else {
        const regularTargets = visibleTokens.filter(t => !isUnderSanctuary(t));
        if (regularTargets.length === 0 && visibleTokens.length > 0) {
          const attackerToken = scene.tokens.get(this.entity.id ?? "");
          const attackerActor = attackerToken?.actor;
          if (attackerActor) {
            const sanctuaryTarget = visibleTokens[Math.floor(Math.random() * visibleTokens.length)];
            if (!sanctuaryTarget) return;
            const blocked = await checkSanctuaryBlocked(attackerActor, sanctuaryTarget);
            if (blocked) {
              console.log(`[Sanctuary] ${this.entity.name}'s attack blocked by Sanctuary on ${sanctuaryTarget.name}`);
              return;
            }
          }
        } else if (regularTargets.length > 0) {
          visibleTokens.length = 0;
          visibleTokens.push(...regularTargets);
        }

        // Randomly reduce the array to size of targets
        if (this.targets && visibleTokens.length > this.targets) {
          while (visibleTokens.length > this.targets) {
            const removeIndex = Math.floor(Math.random() * visibleTokens.length);
            visibleTokens.splice(removeIndex, 1);
          }
        }
        console.log(`Entity ${this.entity.name} attacks tokens:`, visibleTokens.map(t => t.name));
        for (const token of visibleTokens) {
          if (!token.object) continue;
          token.object.setTarget(true, { releaseOthers: false });
        }
        const attackerToken = scene.tokens.get(this.entity.id ?? "");
        if (attackerToken) await clearSanctuaryOnOffensiveAct(attackerToken);
        try {
          const result = await rollAttack(this.entity, weaponName, this.ammunitionId, this.usedReaction, this.disadvantage);
          if (result) {
            result.kind = "action";
            this.events.push(result);
          }
        } catch (err: unknown) {
          console.error(`Error rolling damage for entity ${this.entity.name} with weapon ${weaponName}:`, err);
        }
      }
    } finally {
      tokensLayer?.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
    }
  }
}

export class RandomAttack extends Attack {
  forcedWeaponPool: string[] | undefined;

  constructor(entity: Entity) {
    // Default range; overridden in act() based on the selected weapon's reach
    super(entity, canvas?.scene?.grid.distance ?? 5);
  }

  async prepareSelectedWeapon(): Promise<string | undefined> {
    if (this.weapon) {
      return this.weapon;
    }

    const liveActor = canvas?.tokens?.get(this.entity.id ?? "")?.actor;

    // select random weapon from entity's items, or Unarmed Strike if none
    let weaponName = "Unarmed Strike";
    let selectedItem: Item | undefined;
    // random select from items that have type "weapon"
    const sourceItems = (liveActor ? liveActor.items.contents : this.entity.items);
    const allWeapons = getItemsOfType(sourceItems, "weapon")
      .filter(i => (itemSys(i).quantity ?? 1) > 0);
    let weaponItems = allWeapons;
    // If constrained to specific weapons (e.g. for AoO), filter to only those
    if (this.forcedWeaponPool && this.forcedWeaponPool.length > 0) {
      const pool = this.forcedWeaponPool;
      const forced = weaponItems.filter(i => pool.includes(i.name));
      if (forced.length > 0) weaponItems = forced;
    }

    // If this weapon requires ammunition and ammo exists in inventory, only consider it usable if some ammo quantity > 0.
    weaponItems = weaponItems.filter(w => getUsableAmmunitionIdOrNull(w) !== null);

    // Fallback to all weapons if ammo filtering removed everything
    if (weaponItems.length === 0 && allWeapons.length > 0) {
      weaponItems = allWeapons;
    }

    if (weaponItems.length > 0) {
      // Prefer real weapons over Unarmed Strike
      const nonUnarmedWeapons = weaponItems.filter(i => i.name !== "Unarmed Strike");
      const selectionPool = nonUnarmedWeapons.length > 0 ? nonUnarmedWeapons : weaponItems;
      const randomIndex = Math.floor(Math.random() * selectionPool.length);
      const randomWeapon = selectionPool.at(randomIndex);
      if (randomWeapon) {
        weaponName = randomWeapon.name;
        selectedItem = randomWeapon;
        const ammoId = getUsableAmmunitionIdOrNull(randomWeapon);
        this.ammunitionId = typeof ammoId === "string" ? ammoId : undefined;
      }
    } else {
      // Pull Unarmed Strike from the compendium if needed
      if (!this.entity.id) return undefined;
      if (!canvas?.tokens) return undefined;
      if (!canvas.tokens.get(this.entity.id)?.actor?.items.getName("Unarmed Strike")) {
        if (!game.packs) return undefined;
        const pack = game.packs.get("dnd5e.items");
        if (!pack) return undefined;
        const index = await pack.getIndex();
        const entry = index.find(e => e.name === "Unarmed Strike");
        if (!entry) return undefined;
        const itemData = await pack.getDocument(entry._id);
        if (!(itemData instanceof Item)) return undefined;
        const actor = canvas.tokens.get(this.entity.id)?.actor;
        if (!actor) return undefined;
        const itemSource = itemData.toObject();
        delete (itemSource as { _id?: string })._id;
        await actor.createEmbeddedDocuments("Item", [itemSource]);
      }
      selectedItem = canvas.tokens.get(this.entity.id)?.actor?.items.getName("Unarmed Strike") as Item | undefined;
      this.ammunitionId = undefined;
    }

    // Equip the selected weapon and unequip all other weapons
    if (liveActor && selectedItem) {
      const updates: { _id: string; "system.equipped": boolean }[] = [];
      for (const item of allWeapons) {
        if (!item.id) continue;
        const isEquipped = itemSys(item).equipped;
        if (item.id === selectedItem.id && !isEquipped) {
          updates.push({ _id: item.id, "system.equipped": true });
        } else if (item.id !== selectedItem.id && isEquipped) {
          updates.push({ _id: item.id, "system.equipped": false });
        }
      }
      if (updates.length > 0) {
        await liveActor.updateEmbeddedDocuments("Item", updates);
      }
    }

    const itemRange = itemSys(selectedItem).range;
    this.isRanged = itemSys(selectedItem).attackType === "ranged";

    if (this.isRanged) {
      this.shortRange = itemRange?.value ?? canvas?.scene?.grid.distance ?? 5;
      this.range = itemRange?.long ?? this.shortRange;
    } else {
      this.range = itemRange?.reach ?? canvas?.scene?.grid.distance ?? 5;
    }

    this.weapon = weaponName;
    return this.weapon;
  }

  override async act() {
    const selectedWeapon = await this.prepareSelectedWeapon();
    if (!selectedWeapon) return;
    this.targets = 1;
    await super.act();
  }
}

// Picks a weapon or spell that could actually target someone, then delegates to
// RandomAttack/SpellAction. Falls back to SmartMove if nothing valid is in range.
export class SmartAttack extends Action {
  enemyBias: number;
  cantripOnly: boolean;

  constructor(entity: Entity, enemyBias: number, opts: { cantripOnly?: boolean } = {}) {
    super(entity);
    this.enemyBias = enemyBias;
    this.cantripOnly = opts.cantripOnly ?? false;
  }

  override async act() {
    const scene = canvas?.scene ?? game.scenes?.active;
    if (!scene) return;
    const attackerToken = scene.tokens.get(this.entity.id ?? "");
    if (!attackerToken) return;
    const actor = attackerToken.actor;
    const attackerRect = toGridRect(
      { x: attackerToken.x, y: attackerToken.y, width: attackerToken.width, height: attackerToken.height },
      scene, { useCanvasGrid: true }
    );
    if (!actor || !attackerRect) {
      await this.fallbackToMove();
      return;
    }
    const gridDist = scene.grid.distance || 5;

    // Cheap chebyshev pre-filter for any candidate target tokens
    const inRangeOfRect = (candidates: TokenDocument[], rangeUnits: number): boolean => {
      const cells = Math.ceil(rangeUnits / gridDist);
      for (const t of candidates) {
        const tRect = toGridRect({ x: t.x, y: t.y, width: t.width, height: t.height }, scene, { useCanvasGrid: true });
        if (!tRect) continue;
        if (gridRectChebyshevDistance(attackerRect, tRect) <= cells) return true;
      }
      return false;
    };

    type WeaponCand = { name: string; range: number };
    const weaponCands: WeaponCand[] = [];
    if (!this.cantripOnly) {
      const hostiles = scene.tokens.filter(t =>
        t.id !== attackerToken.id
        && t.disposition !== attackerToken.disposition
        && !isActorAtZeroHp(t.actor ?? undefined)
        && !tokenHidden(t, attackerToken)
      ) as TokenDocument[];

      const allWeapons = getItemsOfType(actor.items, "weapon").filter(i => (itemSys(i).quantity ?? 1) > 0);
      const usable = allWeapons.filter(w => getUsableAmmunitionIdOrNull(w) !== null);
      const pool = usable.length > 0 ? usable : allWeapons;
      const weapons: WeaponCand[] = pool.map(w => {
        const r = itemSys(w).range;
        const isRanged = itemSys(w).attackType === "ranged";
        const range = isRanged ? (r?.long ?? r?.value ?? gridDist) : (r?.reach ?? gridDist);
        return { name: w.name, range };
      });
      if (weapons.length === 0) weapons.push({ name: "Unarmed Strike", range: gridDist });

      for (const w of weapons) {
        if (inRangeOfRect(hostiles, w.range)) weaponCands.push(w);
      }
    }

    type SpellCand = { spell: Item; profile: ReturnType<typeof getRandomSpellSupportProfile> };
    const spellCands: SpellCand[] = [];
    let spellList = getCastableSpellsForRandomAction(actor);
    if (this.cantripOnly) spellList = spellList.filter(s => (itemSys(s).level ?? 0) === 0);
    for (const spell of spellList) {
      const profile = getRandomSpellSupportProfile(spell);
      if (!profile) continue;
      const rangeUnits = (itemSys(spell).range?.units ?? "").toLowerCase();
      // Self-targeting buffs (no enemy/ally template, just caster)
      if (rangeUnits === "self") {
        if (isValidDirectUseBuffTarget(attackerToken, spell)) spellCands.push({ spell, profile });
        continue;
      }
      const valid = getValidSpellTargets(this.entity, scene, spell);
      if (valid.length === 0) continue;
      const range = Math.max(gridDist, getSpellRange(spell));
      if (inRangeOfRect(valid, range)) spellCands.push({ spell, profile });
    }

    const confirmedWeapons: WeaponCand[] = [];
    for (const w of weaponCands) {
      const tokens = await withRangeTemplate<TokenDocument[]>(scene, this.entity, w.range, (templateObj) => {
        const valid = scene.tokens.filter(t =>
          t.id !== attackerToken.id
          && t.disposition !== attackerToken.disposition
          && !isActorAtZeroHp(t.actor ?? undefined)
          && !tokenHidden(t, attackerToken)
        );
        return getTokensInTemplate(templateObj, scene, valid);
      }, undefined, true);
      if ((tokens?.length ?? 0) > 0) confirmedWeapons.push(w);
    }

    const confirmedSpells: Item[] = [];
    for (const { spell, profile } of spellCands) {
      let targets: TokenDocument[] = [];
      if (profile === "rangeTemplate") targets = await getTargetsForRangeSpell(this.entity, spell);
      else if (profile === "nativeTemplate") targets = await getTargetsForNativeTemplateSpell(this.entity, scene, spell);
      else if (profile === "directUse") targets = await getTargetsForDirectUseSpell(this.entity, spell);
      if (targets.length > 0) confirmedSpells.push(spell);
    }

    const total = confirmedWeapons.length + confirmedSpells.length;
    if (total === 0) {
      console.log(`SmartAttack: ${this.entity.name} found no in-range attacks/spells, moving instead`);
      await this.fallbackToMove();
      return;
    }

    const idx = Math.floor(Math.random() * total);
    let delegate: Action;
    if (idx < confirmedWeapons.length) {
      const picked = confirmedWeapons[idx];
      if (!picked) { await this.fallbackToMove(); return; }
      console.log(`SmartAttack: ${this.entity.name} -> attack with ${picked.name} (${confirmedWeapons.length} weapons / ${confirmedSpells.length} spells viable)`);
      const ra = new RandomAttack(this.entity);
      ra.forcedWeaponPool = [picked.name];
      delegate = ra;
    } else {
      const picked = confirmedSpells[idx - confirmedWeapons.length];
      if (!picked) { await this.fallbackToMove(); return; }
      console.log(`SmartAttack: ${this.entity.name} -> cast ${picked.name} (${confirmedWeapons.length} weapons / ${confirmedSpells.length} spells viable)`);
      const sa = new SpellAction(this.entity);
      sa.spellName = picked.name;
      sa.spellId = picked.id ?? undefined;
      sa.castSlot = pickCastSlot(actor, picked) ?? undefined;
      delegate = sa;
    }

    delegate.usedReaction = this.usedReaction;
    await delegate.act();
    this.events.push(...delegate.events);
  }

  private async fallbackToMove(): Promise<void> {
    const move = new SmartMoveAction(this.entity, this.enemyBias);
    move.usedReaction = this.usedReaction;
    await move.act();
    this.events.push(...move.events);
  }
}

export class Reaction extends Action {}

export class AttackOfOpportunity extends Reaction {
  attackAction: Attack;

  constructor(entity: Entity, attackAction: Attack) {
    super(entity);
    this.attackAction = attackAction;
  }
  override async act() {
    this.attackAction.usedReaction = this.usedReaction;
    await this.attackAction.act();
    for (const event of this.attackAction.events) {
      event.kind = "reaction";
    }
    this.events.push(...this.attackAction.events);
  }
}

export class RandomAttackOfOpportunity extends AttackOfOpportunity {
  eligibleWeapons: string[];
  constructor(entity: Entity, eligibleWeapons?: string[], triggeringTokenId?: string) {
    const attack = new RandomAttack(entity);
    // Constrain the attack to only use weapons whose range was exited
    if (eligibleWeapons && eligibleWeapons.length > 0) {
      attack.forcedWeaponPool = eligibleWeapons;
    }
    if (triggeringTokenId) {
      attack.forcedTargetTokenIds = [triggeringTokenId];
    }
    super(entity, attack);
    this.eligibleWeapons = eligibleWeapons ?? [];
  }

  async prepareSelectedWeapon(): Promise<string | undefined> {
    const randomAttack = this.attackAction as RandomAttack;
    return randomAttack.prepareSelectedWeapon();
  }
}

export const reactionCheck = async (action: Action, activeScene: Scene, entity: Entity, usedReaction: Set<string>, turnEvents: AttackResult[]) => {
  const movingToken = activeScene.tokens.get(entity.id || "");
  if (!movingToken) return;
  // Capture the final destination once before any teleporting
  const finalPos = { x: movingToken.x, y: movingToken.y };
  for (const [tokenId, reaction] of Object.entries(action.triggeredReactions)) {
    // Skip if this token already used its reaction this round
    if (usedReaction.has(tokenId)) continue;
    const reactionToken = activeScene.tokens.get(tokenId);
    if (!reactionToken) continue;
    const reactionActor = reactionToken.actor;
    if (!reactionActor) continue;
    if (isActorUnableToAct(reactionActor)) continue;
    if (reaction.eligibleWeapons.length === 0) continue;

    const reactionEntity = Entity.fromToken(reactionToken);
    const reAction = new RandomAttackOfOpportunity(reactionEntity, reaction.eligibleWeapons, entity.id ?? undefined);
    reAction.usedReaction = usedReaction;
    const selectedWeapon = await reAction.prepareSelectedWeapon();
    if (!selectedWeapon) continue;
    const selectedExitPos = reaction.weaponExitPositions[selectedWeapon];
    if (!selectedExitPos) continue;

    // Teleport the moving token back to where it was when it left range
    const exitPixel = gridToPixel(selectedExitPos.x, selectedExitPos.y, activeScene);
    if (exitPixel) {
      await movingToken.move({ x: exitPixel.x, y: exitPixel.y }, { animate: false, constrainOptions: { ignoreWalls: true, ignoreCost: true } });
    }

    // If the reaction token can't see the moving token, it can't react
    if (tokenHidden(movingToken, reactionToken)) continue;

    // Attack of opportunity with the selected eligible weapon
    await reAction.act();
    turnEvents.push(...reAction.events);
    usedReaction.add(tokenId);

    // If the moving token died, stop processing further reactions (stays where it died)
    const movingActor = movingToken.actor;
    if (movingActor && isActorAtZeroHp(movingActor)) break;
  }

  // If the moving token survived all reactions, teleport it back to the final destination
  const movingActor = movingToken.actor;
  if (movingActor && !isActorAtZeroHp(movingActor)) {
    await movingToken.move({ x: finalPos.x, y: finalPos.y }, { animate: false, constrainOptions: { ignoreWalls: true, ignoreCost: true } });
  }
}
