import type { Activity } from "./configuration";
import { MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY, DEFAULT_RANDOM_SPELL_EXCLUSIONS, REPEAT_TARGET_SPELLS } from "./constants";
import { actorSys, itemSys, getItemActivities, getItemsOfType } from "./foundry-helpers";
import { actorNeedsHealing, isActorAtZeroHp, isWearingArmor } from "./actor-status";
import type { Entity } from "./entity";

// brace your eyes for incoming fuckshit. The spells are so cooked
// also there are just sOOOO many types. dnd5e types doesnt work anymore so like
// i have to make so many of these. why did I decide to use typescript
// This is because sometimes they give us a template, sometimes we make one
// and sometimes it just Does The Thing
export type RandomSpellSupportProfile = "nativeTemplate" | "rangeTemplate" | "directUse";
export type SpellEligibility = { ok: boolean; reason: string; profile?: RandomSpellSupportProfile };

export type SpellTargetTemplate = { type?: string; units?: string; size?: number };
export type SpellTargetAffects = { type?: string };
export type SpellTargetData = {
  type?: string;
  value?: number | string;
  units?: string;
  template?: SpellTargetTemplate;
  affects?: SpellTargetAffects;
};

export type ItemWithUse = Item & {
  use?: (
    config?: Record<string, unknown>,
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
};

export function getCombatRoundTurn(): { round: number; turn: number } | undefined {
  const combat = game.combat;
  if (!combat) return undefined;

  const round = combat.round;
  const turn = combat.turn;
  if (typeof round !== "number" || !Number.isFinite(round)) return undefined;
  if (typeof turn !== "number" || !Number.isFinite(turn)) return undefined;
  return { round, turn };
}

export function getGuidingBoltExpiryForActor(actorId: string | null | undefined) {
  const combat = game.combat;
  const now = getCombatRoundTurn();
  if (!combat || !now || !actorId) return {};

  const turns = Array.isArray(combat.turns) ? combat.turns : [];
  const casterTurnIndex = turns.findIndex(c => c.actorId === actorId);

  if (casterTurnIndex < 0 || turns.length === 0) {
    return { appliedRound: now.round, appliedTurn: now.turn, expiresRound: now.round + 1, expiresTurn: now.turn };
  }

  return {
    appliedRound: now.round, appliedTurn: now.turn,
    expiresRound: casterTurnIndex > now.turn ? now.round : now.round + 1,
    expiresTurn: casterTurnIndex,
  };
}

export function isConcentrationSpell(item: Item): boolean {
  const duration = itemSys(item).duration;

  if (duration?.concentration) return true;

  const units = (duration?.units ?? "").toLowerCase();
  const type = (duration?.type ?? "").toLowerCase();
  return units === "concentration" || type === "concentration";
}

// Allow list is probably better, but this is faster lol
export function getExcludedRandomSpellNames(): Set<string> {
  const configured = game.settings?.get(MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY);
  if (typeof configured !== "string") return new Set(DEFAULT_RANDOM_SPELL_EXCLUSIONS);
  const parsed = configured.split(/[\n,;]+/).map(e => e.trim().toLowerCase()).filter(e => e.length > 0);
  return parsed.length > 0 ? new Set(parsed) : new Set(DEFAULT_RANDOM_SPELL_EXCLUSIONS);
}

export function getSpellLevel(item: Item): number {
  const data = itemSys(item);
  return data.level ?? 0;
}

export function getSpellRange(item: Item): number {
  const data = itemSys(item);
  const units = data.range?.units;
  if (units === "self") return 0;
  if (units === "touch") return 5;
  return data.range?.value ?? 0;
}

export function getSpellTarget(item: Item): SpellTargetData {
  return itemSys(item).target ?? {};
}

export async function getSpellTargetCount(item: Item): Promise<number> {
  const parseCount = async (raw: unknown): Promise<number | null> => {
    if (typeof raw === "number" && raw > 0) return Math.max(1, Math.floor(raw));
    if (typeof raw !== "string") return null;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.floor(parsed));
    try {
      const rollData = item.getRollData();
      const total = (await new Roll(raw, rollData).evaluate()).total;
      return (typeof total === "number" && total > 0) ? Math.max(1, Math.floor(total)) : null;
    } catch { return null; }
  };

  for (const activity of getItemActivities(item)) {
    const target = activity.target;
    const count = (await parseCount(target?.affects?.count)) ?? (await parseCount(target?.template?.count));
    if (count) return count;
  }
  return (await parseCount(getSpellTarget(item).value)) ?? 1;
}

export function isTemplateSpell(item: Item): boolean {
  const target = getSpellTarget(item);
  const templateType = target.template?.type?.toLowerCase();
  if (templateType) return true;
  const targetType = target.type?.toLowerCase();
  if (!targetType) return false;
  return ["cone", "cube", "cylinder", "line", "sphere", "radius"].includes(targetType);
}

export function isSingleTargetSpell(item: Item): boolean {
  const target = getSpellTarget(item);
  const targetType = target.type?.toLowerCase();
  if (!targetType) return true;
  if (["creature", "enemy", "ally"].includes(targetType)) return true;
  if (targetType === "self") return true;
  return false;
}

export function canRepeatTargetSelection(item: Item, targetCount: number): boolean {
  if (targetCount <= 1) return false;
  return REPEAT_TARGET_SPELLS.has(item.name.trim().toLowerCase());
}

export function allocateRepeatableSpellTargets(inRange: TokenDocument[], count: number): TokenDocument[] {
  if (count <= 0 || inRange.length === 0) return [];
  const result: TokenDocument[] = [];
  for (let i = 0; i < count; i++) {
    const pick = inRange[Math.floor(Math.random() * inRange.length)];
    if (pick) result.push(pick);
  }
  return result;
}

// idek man
export function getRandomSpellSupportProfile(item: Item): RandomSpellSupportProfile | null {
  const activities = getItemActivities(item);
  const supportedTypes = ["attack", "save", "damage", "heal", "enchant", "cast", "utility"];
  if (activities.length === 0 || !activities.some(a => supportedTypes.includes(a.type))) return null;

  const hasNativeTemplate = activities.some(a =>
    !!a.target?.template?.type
  );
  if (isTemplateSpell(item) && hasNativeTemplate) return "nativeTemplate";

  const hasOffensiveActivity = activities.some(a => a.type === "attack" || a.type === "damage" || a.type === "save");
  const target = getSpellTarget(item);
  const targetType = target.type?.toLowerCase();

  if (hasOffensiveActivity && !isTemplateSpell(item) && isSingleTargetSpell(item) && targetType !== "self" && getSpellRange(item) > 0) {
    return "rangeTemplate";
  }

  if (activities.some(a => ["enchant", "cast", "utility"].includes(a.type))
    || item.effects.size > 0) {
    return "directUse";
  }

  if (!isTemplateSpell(item) && isSingleTargetSpell(item) && targetType !== "self" && getSpellRange(item) > 0) {
    return "rangeTemplate";
  }

  return null;
}

export function canCastSpell(actor: Actor, spell: Item): boolean {
  const level = getSpellLevel(spell);
  const spellData = itemSys(spell);
  const method = (spellData.method ?? "").toLowerCase();
  const preparedValue = spellData.prepared;
  const isPrepared = preparedValue === true || preparedValue === 1 || preparedValue === 2;

  if (method === "innate" || method === "atwill") return true;
  if (!isPrepared) return false;
  if (level === 0) return true;
  const spells = actorSys(actor).spells;
  if (!spells) return false;
  const slot = spells[`spell${level}`];
  return (slot?.value ?? 0) > 0;
}

export function evaluateSpellEligibilityForRandomAction(actor: Actor, spell: Item): SpellEligibility {
  const excludedNonCombatSpells = getExcludedRandomSpellNames();
  if (excludedNonCombatSpells.has(spell.name.trim().toLowerCase())) {
    return { ok: false, reason: "non-combat-spell" };
  }

  const level = getSpellLevel(spell);
  if (level > 1) return { ok: false, reason: "level>1" };

  const profile = getRandomSpellSupportProfile(spell);
  if (!profile) return { ok: false, reason: "unsupported-profile" };

  if (!canCastSpell(actor, spell)) return { ok: false, reason: "not-castable-now" };
  return { ok: true, reason: "supported", profile };
}

export function getCastableSpellsForRandomAction(actor: Actor): Item[] {
  const allSpells = getItemsOfType(actor.items, "spell");
  return allSpells
    .filter(spell => evaluateSpellEligibilityForRandomAction(actor, spell).ok)
    .sort((a, b) => getSpellLevel(a) - getSpellLevel(b));
}

// Name / content predicates
export function isHealingSpell(spell: Item): boolean {
  const spellName = spell.name.trim().toLowerCase();
  if (spellName.includes("heal") || spellName.includes("cure")) return true;
  return getItemActivities(spell).some(activity => activity.type === "heal");
}

export function isSleepSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "sleep";
}

export function isGuidingBoltSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "guiding bolt";
}

export function isLightCantrip(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "light";
}

export function hasMatchingSpellEffect(actor: Actor, spell: Item): boolean {
  const spellName = spell.name.trim().toLowerCase();
  const spellUuid = spell.uuid;
  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    const origin = effect.origin ?? "";
    const effectLabel = effect.name.trim().toLowerCase();
    if (origin === spellUuid || origin.includes(spellUuid)) return true;
    if (effectLabel.length > 0 && effectLabel === spellName) return true;
  }
  return false;
}

// Marker re-exports so other modules don't have to know the activity type
export type { Activity };

export function isValidDirectUseBuffTarget(token: TokenDocument, spell: Item): boolean {
  const actor = token.actor;
  if (!actor) return false;

  if (isHealingSpell(spell) && !actorNeedsHealing(actor)) return false;

  const spellName = spell.name.trim().toLowerCase();
  const canRetargetExistingEffect = isConcentrationSpell(spell);
  if (!canRetargetExistingEffect && hasMatchingSpellEffect(actor, spell)) return false;

  if (spellName.includes("mage armor") && isWearingArmor(actor)) return false;

  return true;
}

export function getValidSpellTargets(entity: Entity, scene: Scene, spell: Item): TokenDocument[] {
  const spellName = spell.name.toLowerCase();
  const prefersAllies = spellName.includes("heal") || spellName.includes("cure") || spellName.includes("bless")
    || getItemActivities(spell).some(a => a.type === "heal");
  const requiresInjuredTarget = isHealingSpell(spell);
  return scene.tokens.filter(t => {
    if (t.id === entity.id) return false;
    if (t.combatant?.defeated) return false;
    if (isActorAtZeroHp(t.actor ?? undefined) && !requiresInjuredTarget) return false;
    if (requiresInjuredTarget && t.actor && !actorNeedsHealing(t.actor)) return false;
    return prefersAllies ? t.disposition === entity.disposition : t.disposition !== entity.disposition;
  });
}

export function getAutoPlaceTemplateActivity(spell: Item): Activity | undefined {
  const activities = getItemActivities(spell);
  return activities.find(a => {
    const t = a.target?.template?.type?.toLowerCase();
    return !!t;
  });
}
