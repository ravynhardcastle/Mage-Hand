import type { UpdateData } from "./configuration";
import { MODULE_ID } from "./constants";
import { actorSys, asDnd5eActor, dnd5eStaticId } from "./foundry-helpers";

export async function setActorStabilized(token: TokenDocument, stabilized: boolean): Promise<void> {
  if (stabilized) {
    await token.setFlag(MODULE_ID, "stabilized", true);
  } else {
    await token.unsetFlag(MODULE_ID, "stabilized");
  }
}

export function actorHasStatusEffect(actor: Actor, statusId: string): boolean {
  const normalizedStatusId = statusId.toLowerCase();
  if (actor.statuses.has(normalizedStatusId)) return true;

  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    if (effect.statuses.has(normalizedStatusId)) return true;
  }

  return false;
}

export function isActorUnconscious(actor: Actor): boolean {
  return actorHasStatusEffect(actor, "unconscious") || actorHasStatusEffect(actor, "sleeping");
}

export function isActorAtZeroHp(actor: Actor | null | undefined): boolean {
  const hp = actorSys(actor)
    .attributes?.hp?.value;
  return typeof hp === "number" && hp <= 0;
}

export function isActorUnableToAct(actor: Actor): boolean {
  return isActorAtZeroHp(actor) || isActorUnconscious(actor) || actorHasStatusEffect(actor, "incapacitated");
}

export function getActorDeathSaves(actor: Actor): { success: number; failure: number } {
  const death = actorSys(actor).attributes?.death;
  return { success: death?.success ?? 0, failure: death?.failure ?? 0 };
}

export function actorNeedsHealing(actor: Actor): boolean {
  const hp = actorSys(actor).attributes?.hp;
  const current = hp?.value;
  const max = hp?.max;
  if (typeof current !== "number" || typeof max !== "number") return false;
  if (current <= 0 && getActorDeathSaves(actor).failure >= 3) return false;
  return current < max;
}

export function isWearingArmor(actor: Actor): boolean {
  const dndAc = actorSys(actor).attributes?.ac;
  return Boolean(dndAc?.equippedArmor);
}

export function isUndeadActor(actor: Actor): boolean {
  const details = actorSys(actor).details;
  const type = details?.type;
  if (typeof type === "string") return type.toLowerCase().includes("undead");

  const value = (type?.value ?? "").toLowerCase();
  const subtype = (type?.subtype ?? "").toLowerCase();
  const custom = (type?.custom ?? "").toLowerCase();
  return value.includes("undead") || subtype.includes("undead") || custom.includes("undead");
}

export function isConstructActor(actor: Actor): boolean {
  const details = actorSys(actor).details;
  const type = details?.type;
  if (typeof type === "string") return type.toLowerCase().includes("construct");

  const value = (type?.value ?? "").toLowerCase();
  const subtype = (type?.subtype ?? "").toLowerCase();
  const custom = (type?.custom ?? "").toLowerCase();
  return value.includes("construct") || subtype.includes("construct") || custom.includes("construct");
}

export function hasConditionImmunity(actor: Actor, conditionId: string): boolean {
  const ci = actorSys(actor).traits?.ci?.value;

  if (ci instanceof Set) return ci.has(conditionId);
  if (Array.isArray(ci)) return ci.includes(conditionId);
  return false;
}

export async function applyDamageAtZeroHp(
  actor: Actor,
  name: string,
  damage: number,
  failCount: number,
  damageKind: string,
): Promise<void> {
  const maxHp = actorSys(actor).attributes?.hp?.max ?? 0;
  const curFails = getActorDeathSaves(actor).failure;
  if (maxHp > 0 && damage >= maxHp) {
    console.log(`${name} takes massive ${damageKind} (${damage} >= ${maxHp} max HP) at 0 HP, instant death`);
    await actor.update({ "system.attributes.death.failure": 3 } as UpdateData);
  } else {
    console.log(`${name} takes ${damageKind} at 0 HP, adding ${failCount} death save failure(s)`);
    await actor.update({ "system.attributes.death.failure": Math.min(curFails + failCount, 3) } as UpdateData);
  }
}

export async function rollAbilitySaveTotal(actor: Actor, ability: string, dc: number): Promise<number | null> {
  const saveActor = asDnd5eActor(actor);
  if (typeof saveActor.rollSavingThrow !== "function") return null;
  const result = await saveActor.rollSavingThrow({ ability, target: dc }, { configure: false });
  const records = Array.isArray(result) ? result : [result];
  for (const r of records) {
    const rec = r as { total?: unknown } | null | undefined;
    if (rec && typeof rec.total === "number") return rec.total;
  }
  return null;
}

export async function rollActorDeathSave(token: TokenDocument): Promise<{ rolledNat20: boolean; dead: boolean; stabilized: boolean }> {
  const actor = token.actor;
  if (!actor) return { rolledNat20: false, dead: false, stabilized: false };
  const roller = asDnd5eActor(actor);
  if (typeof roller.rollDeathSave !== "function") {
    return { rolledNat20: false, dead: false, stabilized: false };
  }
  const preRollSaves = getActorDeathSaves(actor);
  const rolls = await roller.rollDeathSave({}, { configure: false }, { data: { speaker: ChatMessage.getSpeaker({ actor }) } });
  const roll = (rolls ?? [])[0];
  const rolledNat20 = roll?.isCritical === true;
  const postRollSaves = getActorDeathSaves(actor);
  const stabilized = rolledNat20
    || postRollSaves.success >= 3
    || (preRollSaves.success >= 2 && postRollSaves.success === 0 && postRollSaves.failure < 3);
  if (stabilized) {
    await setActorStabilized(token, true);
  }
  return { rolledNat20, dead: postRollSaves.failure >= 3, stabilized };
}

export async function setActorStatusEffect(actor: Actor, statusId: string, active: boolean): Promise<boolean> {
  if (active) {
    const toggler = actor;
    if (typeof toggler.toggleStatusEffect !== "function") return false;
    await toggler.toggleStatusEffect(statusId, { active: true });
    return true;
  }
  const effectId = dnd5eStaticId(`dnd5e${statusId}`);
  const effect = actor.effects.get(effectId);
  if (!effect) return false;
  await effect.delete();
  return true;
}

export async function getBlessBonusIfAny(actor: Actor): Promise<number> {
  let hasBless = actorHasStatusEffect(actor, "blessed") || actorHasStatusEffect(actor, "bless");
  if (!hasBless) {
    for (const effect of actor.effects) {
      if (effect.disabled) continue;
      if (effect.name.trim().toLowerCase() === "bless") { hasBless = true; break; }
    }
  }
  if (!hasBless) return 0;
  const blessRoll = await new Roll("1d4").evaluate();
  return Math.max(0, Math.floor(blessRoll.total));
}

export function tokenHidden(token: TokenDocument, checkingToken: TokenDocument): boolean {
  if (token.hidden) return true;
  if (token.hasStatusEffect("hidden")) return true;
  const checkingObj = checkingToken.object;
  const targetObj = token.object;
  if (!checkingObj || !targetObj) return false;

  // Temporarily control the checking token so its vision.los polygon is valid.
  const prevControlled = canvas?.tokens?.controlled.slice() ?? [];
  const wasControlled = checkingObj.controlled;
  if (!wasControlled) checkingObj.control({ releaseOthers: true });
  try {
    const los = checkingObj.vision?.los;
    if (!los) return false;
    return !los.contains(targetObj.center.x, targetObj.center.y);
  } finally {
    if (!wasControlled) {
      checkingObj.release();
      for (const t of prevControlled) t.control({ releaseOthers: false });
    }
  }
}