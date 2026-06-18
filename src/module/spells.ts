import type { Activity } from "./configuration";
import { MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY, DEFAULT_RANDOM_SPELL_EXCLUSIONS, TARGET_PER_LEVEL_SPELLS, CAN_REPEAT_TARGET_SPELLS, LESSER_RESTORATION_CONDITIONS, SANCTUARY_FLAG_KEY } from "./constants";
import { actorSys, itemSys, getItemActivities, getItemsOfType } from "./foundry-helpers";
import { actorHasStatusEffect, actorNeedsHealing, isActorAtZeroHp, isWearingArmor, tokenHidden } from "./actor-status";
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

export function getSpellRange(item: Item): number {
  const data = itemSys(item);
  const units = data.range?.units;
  if (units === "self") return 0;
  if (units === "touch") return 5;
  return data.range?.value ?? 0;
}

export function getSpellTargetCount(item: Item, castLevel?: number): number {
  const toCount = (raw: unknown): number | null => {
    if (typeof raw === "number" && raw > 0) return Math.floor(raw);
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return null;
  };

  let baseCount = 1;
  for (const activity of getItemActivities(item)) {
    const target = activity.target;
    const count = toCount(target?.affects?.count) ?? toCount(target?.template?.count);
    if (count) { baseCount = count; break; }
  }
  if (baseCount === 1) {
    baseCount = toCount(itemSys(item).target?.value) ?? 1;
  }

  // spells in TARGET_PER_LEVEL_SPELLS get +1 target per level above base
  const baseLevel = itemSys(item).level ?? 0;
  if (castLevel != null && castLevel > baseLevel && TARGET_PER_LEVEL_SPELLS.has(item.name.trim().toLowerCase())) {
    return baseCount + (castLevel - baseLevel);
  }
  return baseCount;
}

export function isTemplateSpell(item: Item): boolean {
  const target = itemSys(item).target ?? {};
  const templateType = target.template?.type?.toLowerCase();
  if (templateType) return true;
  const targetType = target.type?.toLowerCase();
  if (!targetType) return false;
  return ["cone", "cube", "cylinder", "line", "sphere", "radius"].includes(targetType);
}

export function isSingleTargetSpell(item: Item): boolean {
  const target = itemSys(item).target ?? {};
  const targetType = target.type?.toLowerCase();
  if (!targetType) return true;
  if (["creature", "enemy", "ally"].includes(targetType)) return true;
  if (targetType === "self") return true;
  return false;
}

export function canRepeatTargetSelection(item: Item, targetCount: number): boolean {
  if (targetCount <= 1) return false;
  return CAN_REPEAT_TARGET_SPELLS.has(item.name.trim().toLowerCase());
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

  if (isSpiritualWeaponSpell(item)) return "directUse";

  const hasNativeTemplate = activities.some(a =>
    !!a.target?.template?.type
  );
  if (isTemplateSpell(item) && hasNativeTemplate) return "nativeTemplate";

  const hasOffensiveActivity = activities.some(a => a.type === "attack" || a.type === "damage" || a.type === "save");
  const target = itemSys(item).target ?? {};
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

export type CastSlot = { slot: string; level: number };

function damagePartScales(part: { scaling?: { mode?: string } } | undefined): boolean {
  const mode = (part?.scaling?.mode ?? "").toLowerCase();
  return mode !== "" && mode !== "none";
}

export function spellBenefitsFromUpcast(spell: Item): boolean {
  if (TARGET_PER_LEVEL_SPELLS.has(spell.name.trim().toLowerCase())) return true;
  for (const activity of getItemActivities(spell)) {
    if (damagePartScales(activity.healing)) return true;
    for (const part of activity.damage?.parts ?? []) {
      if (damagePartScales(part)) return true;
    }
  }
  return false;
}

type CachedForActivity = {
  uses?: { value?: number };
  item?: { id?: string };
  consumption?: { targets?: Array<{ type: string; target?: string; value?: string }> };
};

function canCastItemSourcedSpell(actor: Actor, cachedForUuid: string): boolean {
  const fus = (globalThis as unknown as { fromUuidSync?: (uuid: string, opts: { relative?: unknown; strict: boolean }) => unknown }).fromUuidSync;
  if (!fus) return false;

  const cachedActivity = fus(cachedForUuid, { relative: actor, strict: false }) as CachedForActivity | null | undefined;
  if (!cachedActivity) return false;

  const targets = cachedActivity.consumption?.targets ?? [];

  const activityUsesTarget = targets.find(t => t.type === "activityUses");
  if (activityUsesTarget) {
    const cost = Math.max(1, parseInt(activityUsesTarget.value ?? "1", 10) || 1);
    const v = cachedActivity.uses?.value;
    return typeof v !== "number" || v >= cost;
  }

  const itemUsesTarget = targets.find(t => t.type === "itemUses");
  if (itemUsesTarget) {
    const cost = Math.max(1, parseInt(itemUsesTarget.value ?? "1", 10) || 1);
    const sourceId = itemUsesTarget.target ?? "";
    const sourceItem = (sourceId ? actor.items.get(sourceId) : undefined) ?? (cachedActivity.item?.id ? actor.items.get(cachedActivity.item.id) : undefined);
    if (!sourceItem) return false;
    const uses = (itemSys(sourceItem) as { uses?: { value?: number } }).uses;
    return typeof uses?.value !== "number" || uses.value >= cost;
  }

  return true;
}

export function getAvailableCastSlots(actor: Actor, spell: Item): CastSlot[] {
  const cachedForUuid = (spell.flags as { dnd5e?: { cachedFor?: string } } | undefined)?.dnd5e?.cachedFor;
  if (cachedForUuid) {
    const baseLevel = Math.max(1, itemSys(spell).level ?? 1);
    return [{ slot: "item", level: baseLevel }];
  }

  const baseLevel = itemSys(spell).level ?? 0;
  const spellData = itemSys(spell);
  const method = (spellData.method ?? "").toLowerCase();

  if (baseLevel === 0) return [{ slot: "spell0", level: 0 }];
  if (method === "innate" || method === "atwill") {
    return [{ slot: "innate", level: baseLevel }];
  }

  const spells = actorSys(actor).spells;
  if (!spells) return [];

  const maxLevel = spellBenefitsFromUpcast(spell) ? 9 : baseLevel;
  const slots: CastSlot[] = [];
  for (let lvl = baseLevel; lvl <= maxLevel; lvl++) {
    const entry = spells[`spell${lvl}`];
    if ((entry?.value ?? 0) > 0) slots.push({ slot: `spell${lvl}`, level: lvl });
  }
  const pact = spells["pact"];
  if (pact && (pact.value ?? 0) > 0 && (pact.level ?? 0) >= baseLevel && (pact.level ?? 0) <= maxLevel) {
    slots.push({ slot: "pact", level: pact.level ?? baseLevel });
  }
  return slots;
}

export function pickCastSlot(actor: Actor, spell: Item): CastSlot | null {
  const options = getAvailableCastSlots(actor, spell);
  if (options.length === 0) return null;
  const idx = Math.floor(Math.random() * options.length);
  return options[idx] ?? null;
}

export function canCastSpell(actor: Actor, spell: Item): boolean {
  const cachedForUuid = (spell.flags as { dnd5e?: { cachedFor?: string } } | undefined)?.dnd5e?.cachedFor;
  if (cachedForUuid) return canCastItemSourcedSpell(actor, cachedForUuid);

  const spellData = itemSys(spell);
  const method = (spellData.method ?? "").toLowerCase();
  const preparedValue = spellData.prepared;
  const isPrepared = preparedValue === true || preparedValue === 1 || preparedValue === 2;

  if (method === "atwill") return true;
  if (method === "innate") {
    const uses = (spellData as { uses?: { value?: number; max?: number } }).uses;
    if (uses && (uses.max ?? 0) > 0) return (uses.value ?? 0) > 0;
    return true;
  }
  if (!isPrepared) return false;
  if ((itemSys(spell).level ?? 0) === 0) return true;
  return getAvailableCastSlots(actor, spell).length > 0;
}

export function evaluateSpellEligibilityForRandomAction(actor: Actor, spell: Item): SpellEligibility {
  const excludedNonCombatSpells = getExcludedRandomSpellNames();
  if (excludedNonCombatSpells.has(spell.name.trim().toLowerCase())) {
    return { ok: false, reason: "non-combat-spell" };
  }

  const profile = getRandomSpellSupportProfile(spell);
  if (!profile) return { ok: false, reason: "unsupported-profile" };

  if (!canCastSpell(actor, spell)) return { ok: false, reason: "not-castable-now" };
  return { ok: true, reason: "supported", profile };
}

export function isSpellBonusAction(spell: Item): boolean {
  const itemActivation = (itemSys(spell).activation?.type ?? "").toLowerCase();
  if (itemActivation === "bonus") return true;
  // Also check activities (dnd5e 4.x may store activation on the activity)
  return getItemActivities(spell).some(a => (a.activation?.type ?? "").toLowerCase() === "bonus");
}

export function getCastableSpellsForRandomAction(actor: Actor): Item[] {
  const allSpells = getItemsOfType(actor.items, "spell");
  return allSpells
    .filter(spell => !isSpellBonusAction(spell) && evaluateSpellEligibilityForRandomAction(actor, spell).ok)
    .sort((a, b) => (itemSys(a).level ?? 0) - (itemSys(b).level ?? 0));
}

export function getCastableBonusActionSpells(actor: Actor): Item[] {
  return getItemsOfType(actor.items, "spell")
    .filter(spell => isSpellBonusAction(spell) && evaluateSpellEligibilityForRandomAction(actor, spell).ok);
}

export function getCastableCantripsForRandomAction(actor: Actor): Item[] {
  return getCastableSpellsForRandomAction(actor).filter(spell => (itemSys(spell).level ?? 0) === 0);
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

export function isMistyStepSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "misty step";
}

export function isAidSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "aid";
}

export function isHoldPersonSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "hold person";
}

export function isCharmPersonSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "charm person";
}

export function isLesserRestorationSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "lesser restoration";
}

export function isSanctuarySpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "sanctuary";
}

export function isSpareTheDyingSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "spare the dying";
}

export function isMirrorImageSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "mirror image";
}

export function isSpiritualWeaponSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "spiritual weapon";
}

export function isWebSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "web";
}

// The save/attack activity that represents this NPC action's "use it on someone" behavior.
export function getNpcActionActivity(item: Item): Activity | undefined {
  return getItemActivities(item).find(a => {
    if ((a.activation?.type ?? "").toLowerCase() !== "action") return false;
    if (a.type === "save") return a.save?.dc?.value !== undefined;
    if (a.type === "attack") {
    if ((item.type as string) === "feat") return true;
      if ((a.damage?.parts?.length ?? 0) > 0) return true;
      return a.damage?.includeBase !== false && !!itemSys(item).damage?.base;
    }
    return false;
  });
}

export function getUsableNpcActionItems(actor: Actor): Item[] {
  return [...actor.items].filter(item => {
    const itemType = item.type as string;
    if (itemType === "weapon" || itemType === "spell") return false;
    if (!getNpcActionActivity(item)) return false;
    const sys = itemSys(item) as { uses?: { value?: number; max?: number }; quantity?: number };
    if (sys.uses && (sys.uses.max ?? 0) > 0 && (sys.uses.value ?? 0) <= 0) return false;
    if (typeof sys.quantity === "number" && sys.quantity <= 0) return false;
    return true;
  });
}

export function getNpcActionRange(item: Item): { value: number; long: number } {
  const activity = getNpcActionActivity(item);
  const r = activity?.range ?? itemSys(item).range;
  if ((r?.units ?? "").toLowerCase() === "self") {
    const rawSize = activity?.target?.template?.size;
    const size = typeof rawSize === "number" ? rawSize : Number(rawSize) || 0;
    return { value: size, long: size };
  }
  const value = r?.value ?? r?.reach ?? 5;
  const long = (activity?.type === "attack" ? r?.long : undefined) ?? value;
  return { value, long };
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

// is this really a spells thing/?? not really but idk
function wordToCount(word: string | undefined): number | null {
  if (!word) return null;
  if (/^\d+$/.test(word)) return Math.max(1, parseInt(word, 10));
  return NUMBER_WORDS[word] ?? null;
}

// we use the labels to figure out what the multi attack is targetting
// so here we just check for the item that corresponds
function matchWeaponByLabel(label: string, weapons: Item[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const sing = (s: string) => s.replace(/s$/, "");
  const target = norm(label);
  if (!target) return undefined;
  const targetSing = sing(target);
  for (const w of weapons) {
    const wn = norm(w.name);
    if (wn === target || sing(wn) === targetSing) return w.name;
  }
  for (const w of weapons) {
    const wn = norm(w.name);
    if (wn && (target.includes(wn) || wn.includes(target))) return w.name;
  }
  return undefined;
}

export interface MultiattackEntry { weaponName: string; count: number; }

// this is really complicated
// the idea is that we read the description and check for key terms
// then check for proper nouns that are dragged in to see what the multi attack is
// works shockingly well
export function getMultiattackPlan(actor: Actor): MultiattackEntry[] | null {
  const feat = [...actor.items].find(
    i => (i.type as string) === "feat" && i.name.trim().toLowerCase() === "multiattack"
  );
  if (!feat) return null;
  const raw = (itemSys(feat) as { description?: { value?: string } }).description?.value ?? "";

  const weapons = getItemsOfType(actor.items, "weapon");
  const entries: MultiattackEntry[] = [];
  // example: 'Guy attacks with his {Weapon} two times.'
  // But also 'Guy makes two attacks with his {Weapon} works too.'
  // and also other weird things like doing multiple seperate ones and stuff
  // some descriptions won't work off the bat and will need to be mildly adjusted to be more specific
  // obviously grammar is weird
  const numberRe = /\b(one|two|three|four|five|\d+)\b/gi;
  const braceRe = /\{([^}]+)\}/g;
  let cursor = 0;
  let b: RegExpExecArray | null;
  while ((b = braceRe.exec(raw)) !== null) {
    const segment = raw.slice(cursor, b.index);
    cursor = braceRe.lastIndex;
    const nums = [...segment.matchAll(numberRe)];
    const count = wordToCount(nums.at(-1)?.[1]?.toLowerCase()) ?? 1;
    const weaponName = b[1] ? matchWeaponByLabel(b[1], weapons) : undefined;
    if (weaponName) entries.push({ weaponName, count });
  }
  return entries;
}

export function isFaerieFireSpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "faerie fire";
}

export function isInvisibilitySpell(spell: Item): boolean {
  return spell.name.trim().toLowerCase() === "invisibility";
}

export function actorHasRestorableCondition(actor: Actor): boolean {
  return LESSER_RESTORATION_CONDITIONS.some(c => actorHasStatusEffect(actor, c));
}

export function getRestorableCondition(actor: Actor): string | undefined {
  return LESSER_RESTORATION_CONDITIONS.find(c => actorHasStatusEffect(actor, c));
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

  if (isLesserRestorationSpell(spell) && !actorHasRestorableCondition(actor)) return false;

  if (isSanctuarySpell(spell)) {
    const alreadyUnder = !!(token.getFlag(MODULE_ID, SANCTUARY_FLAG_KEY) as unknown);
    return !alreadyUnder;
  }

  const spellName = spell.name.trim().toLowerCase();
  const canRetargetExistingEffect = isConcentrationSpell(spell);
  if (!canRetargetExistingEffect && hasMatchingSpellEffect(actor, spell)) return false;

  if (spellName.includes("mage armor") && isWearingArmor(actor)) return false;

  if (isMirrorImageSpell(spell)) return true;

  if (isInvisibilitySpell(spell)) return true;

  return true;
}

export function getValidSpellTargets(entity: Entity, scene: Scene, spell: Item): TokenDocument[] {
  const spellName = spell.name.toLowerCase();

  if (isSpareTheDyingSpell(spell)) {
    return scene.tokens.filter(t => {
      if (t.id === entity.id) return false;
      if (t.combatant?.defeated) return false;
      if (!t.actor) return false;
      if (!isActorAtZeroHp(t.actor)) return false;
      if (t.disposition !== entity.disposition) return false;
      const death = actorSys(t.actor).attributes?.death;
      return (death?.failure ?? 0) < 3;
    });
  }

  const prefersAllies = spellName.includes("heal") || spellName.includes("cure") || spellName.includes("bless")
    || isSanctuarySpell(spell)
    || getItemActivities(spell).some(a => a.type === "heal");
  const requiresInjuredTarget = isHealingSpell(spell) && !isAidSpell(spell);
  const aid = isAidSpell(spell);
  const casterToken = entity.id ? scene.tokens.get(entity.id) : null;
  return scene.tokens.filter(t => {
    if (t.id === entity.id) return false;
    if (t.combatant?.defeated) return false;
    if (isActorAtZeroHp(t.actor ?? undefined) && !requiresInjuredTarget) return false;
    if (requiresInjuredTarget && t.actor && !actorNeedsHealing(t.actor)) return false;
    if (aid && t.actor && ((actorSys(t.actor).attributes?.hp as { tempmax?: number | null } | undefined)?.tempmax)) return false;
    if (!prefersAllies && casterToken && tokenHidden(t, casterToken)) return false;
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
