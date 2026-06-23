import type { TokenLightSnapshot, Dnd5eActorSystem } from "./configuration";
import { FLAMING_SPHERE_FLAG_KEY, MODULE_ID, PARALYSIS_SAVE_FLAG_KEY, SPIRITUAL_WEAPON_FLAG_KEY, payload_version } from "./constants";
import { actorSys, dnd5eStaticId, getDefaultTokenLight } from "./foundry-helpers";
import { setActorStatusEffect } from "./actor-status";
import { pixelToGrid, gridToPixel } from "./grid";

export class Entity {
  name: string;
  id: string | null;
  actorId: string | null;
  x: number;
  y: number;
  elevation: number;
  width: number;
  height: number;
  system: Dnd5eActorSystem;
  items: Array<Item>;
  effects: Array<ActiveEffect.Source>;
  disposition: number;
  light: TokenLightSnapshot | null;
  statuses: string[];

  constructor(
    name: string,
    id: string | null,
    actorId: string | null,
    x: number,
    y: number,
    elevation: number,
    width: number,
    height: number,
    system: Dnd5eActorSystem,
    items: Array<Item>,
    effects: Array<ActiveEffect.Source>,
    disposition: number,
    light: TokenLightSnapshot | null = null,
    statuses: string[] = [],
  ) {
    this.name = name;
    this.id = id;
    this.actorId = actorId;
    this.x = x;
    this.y = y;
    this.elevation = elevation;
    this.width = width;
    this.height = height;
    this.system = system;
    this.items = items;
    this.effects = effects;
    this.disposition = disposition;
    this.light = light;
    this.statuses = statuses;
  }

  static fromToken(token: TokenDocument, light?: TokenLightSnapshot | null): Entity {
    const actor = token.actor;
    // dnd statuses are like, conjoined, so you have to be fucky with them
    const effectStatuses: string[] = [];
    for (const effect of actor?.effects ?? []) {
      if (effect.disabled) continue;
      for (const id of effect.statuses) {
        if (effect.id === dnd5eStaticId(`dnd5e${id}`)) effectStatuses.push(id);
      }
    }
    return new Entity(
      token.name, token.id, actor?.id ?? null,
      token.x, token.y, token.elevation, token.width, token.height,
      actorSys(actor),
      actor?.items.map(i => i) ?? [],
      actor?.effects.map(e => e.toObject()) ?? [],
      token.disposition, light ?? null,
      effectStatuses,
    );
  }

  toJSON() {
    return {
      name: this.name, id: this.id, actorId: this.actorId,
      x: this.x, y: this.y, elevation: this.elevation,
      width: this.width, height: this.height,
      system: this.system, items: this.items, effects: this.effects,
      disposition: this.disposition, light: this.light,
      statuses: this.statuses,
    };
  }

  static fromJSON(json: ReturnType<Entity["toJSON"]>): Entity {
    return new Entity(
      json.name, json.id, json.actorId,
      json.x, json.y, json.elevation, json.width, json.height,
      json.system, json.items,
      json.effects,
      json.disposition,
      json.light,
      json.statuses,
    );
  }
}

export type EncodedState = {
  version: number;
  round: number;
  entities: ReturnType<Entity["toJSON"]>[];
}

export type AttackResultTarget = {
  name: string;
  tokenId: string;
  ac: number;
  hit: boolean;
  damageDealt: number;
}

export type AttackResult = {
  attacker: string;
  attackerId: string;
  weapon: string;
  attackTotal: number;
  isCritical: boolean;
  isFumble: boolean;
  kind: "action" | "reaction";
  targets: AttackResultTarget[];
}

export type TurnLogEntry = {
  round: number;
  state: string | undefined;
  events: AttackResult[];
}

export function encodeState(entitites: Entity[]): string {
  const payload: EncodedState = {
    version: payload_version,
    round: game.combat?.round ?? -1,
    entities: entitites.map(e => e.toJSON())
  };

  return JSON.stringify(payload);
}

export function decodeState(encoded: string): { entities: Entity[]; round: number } {
  const payload = JSON.parse(encoded) as EncodedState;

  if (payload.version !== payload_version) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  const entities = payload.entities.map(e => Entity.fromJSON(e));

  return { entities, round: payload.round };
}

export async function restoreCombatRound(round: number): Promise<void> {
  if (round === -1) return;
  let combat = game.combats?.viewed ?? null;
  if (combat == null) {
    const created = await Combat.create({ scene: canvas?.scene?.id ?? game.scenes?.active?.id });
    if (!(created instanceof Combat)) {
      console.error("Error creating combat for decoded state: Combat creation failed");
      return;
    }
    combat = created;
  }
  await combat.startCombat();
  await combat.update({ round });
}

export function encodeScene(activeScene: Scene): string | undefined {
  const grid = activeScene.grid;
  if (grid.type !== 1) {
    ui.notifications?.warn("DNDModel.SceneCalc.GridTypeWarning");
    return undefined;
  }
  const entities = [];
  for (const token of activeScene.tokens) {
    if (token.actor == null) continue;
    entities.push(Entity.fromToken(token, foundry.utils.deepClone(token.toObject().light)));
  }
  return encodeState(entities);
}

export async function restoreSceneState(
  encodedState: string,
  scene: Scene,
  combat: Combat | undefined,
) {
  const { entities } = decodeState(encodedState);

  for (const entity of entities) {
    await generateEntity(entity, scene);
  }

  // Clear defeated status on all combatants
  if (combat) {
    for (const combatant of combat.combatants) {
      if (combatant.defeated) {
        await combatant.update({ defeated: false });
      }
    }
  }
}

export async function restoreEntityState(token: TokenDocument, entity: Entity, includeGeometry: boolean): Promise<void> {
  const update: Record<string, unknown> = {
    light: entity.light ?? getDefaultTokenLight(),
    "flags.dnd-model.lightSpell": null,
    "flags.dnd-model.guidingBoltNextAttack": null,
    "flags.dnd-model.turnedByCleric": null,
    "flags.dnd-model.holdPersonDC": null,
    "flags.dnd-model.charmPersonState": null,
    "flags.dnd-model.sanctuaryState": null,
    "flags.dnd-model.faerieFireState": null,
    "flags.dnd-model.webState": null,
    "flags.dnd-model.stabilized": null,
    [`flags.${MODULE_ID}.${SPIRITUAL_WEAPON_FLAG_KEY}`]: null,
    [`flags.${MODULE_ID}.${FLAMING_SPHERE_FLAG_KEY}`]: null,
    [`flags.${MODULE_ID}.${PARALYSIS_SAVE_FLAG_KEY}`]: null,
  };

  // Delete any lingering Spiritual Weapon / Flaming Sphere template before clearing its flag.
  const swState = token.getFlag(MODULE_ID, SPIRITUAL_WEAPON_FLAG_KEY);
  if (swState?.templateId && token.parent?.templates.has(swState.templateId)) {
    await token.parent.deleteEmbeddedDocuments("MeasuredTemplate", [swState.templateId]);
  }
  const fsState = token.getFlag(MODULE_ID, FLAMING_SPHERE_FLAG_KEY);
  if (fsState?.templateId && token.parent?.templates.has(fsState.templateId)) {
    await token.parent.deleteEmbeddedDocuments("MeasuredTemplate", [fsState.templateId]);
  }
  if (includeGeometry) {
    update["elevation"] = entity.elevation;
    update["width"] = entity.width;
    update["height"] = entity.height;
  }
  await token.update(update, { animate: false, render: false });
  const actor = token.actor;
  if (!actor) return;
  await actor.update({ "system": entity.system }, { render: false });

  const savedById = new Map<string, Item>();
  for (const itemData of entity.items) {
    const id = itemData._id;
    if (id) savedById.set(id, itemData);
  }

  // Update existing items or delete ones not in the snapshot
  for (const item of actor.items) {
    const saved = savedById.get(item.id);
    if (saved) {
      try { await item.update(saved, { render: false }); } catch { /* already gone */ }
      savedById.delete(item.id);
    } else {
      try { await item.delete({ render: false }); } catch { /* already gone */ }
    }
  }

  // Create any items that weren't already on the actor
  for (const itemData of savedById.values()) {
    await actor.createEmbeddedDocuments("Item", [itemData], { render: false });
  }

  const savedEffectsById = new Map<string, ActiveEffect.Source>();
  for (const effectData of entity.effects) {
    const id = effectData._id;
    if (id) savedEffectsById.set(id, effectData);
  }

  // Restore non-status ActiveEffects
  // canonical here just means things like prone and stuff
  // they have a different id schema for whatever reason
  // i could probably do this as an all in one 2 for 1 special but this worked so lol
  const isCanonicalStatusEffect = (effect: ActiveEffect) => {
    for (const id of effect.statuses) {
      if (effect.id === dnd5eStaticId(`dnd5e${id}`)) return true;
    }
    return false;
  };
  const isCanonicalStatusEffectData = (effectData: ActiveEffect.Source) => {
    const id = effectData._id;
    if (!id) return false;
    const statuses = effectData.statuses;
    for (const s of statuses) {
      if (id === dnd5eStaticId(`dnd5e${s}`)) return true;
    }
    return false;
  };

  for (const effect of actor.effects) {
    if (isCanonicalStatusEffect(effect)) continue;
    const saved = savedEffectsById.get(effect.id);
    if (saved) {
      await effect.update(saved, { render: false });
      savedEffectsById.delete(effect.id);
    } else {
      try { await effect.delete({ render: false }); } catch { /* already gone */ }
    }
  }

  // Create any non-status effects that weren't already on the actor
  for (const effectData of savedEffectsById.values()) {
    if (isCanonicalStatusEffectData(effectData)) continue;
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData], { render: false });
  }

  const savedStatuses = new Set(entity.statuses);
  const currentStatuses = new Set<string>();
  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    for (const id of effect.statuses) {
      if (effect.id === dnd5eStaticId(`dnd5e${id}`)) currentStatuses.add(id);
    }
  }
  const toRemove = [...currentStatuses].filter(s => !savedStatuses.has(s)).map(s => dnd5eStaticId(`dnd5e${s}`));
  if (toRemove.length > 0) {
    const existing = toRemove.filter(id => actor.effects.has(id));
    if (existing.length > 0) {
      try {
        await actor.deleteEmbeddedDocuments("ActiveEffect", existing, { render: false });
      } catch {
        for (const id of existing) {
          try { await actor.effects.get(id)?.delete({ render: false }); } catch { /* already gone */ }
        }
      }
    }
  }
  for (const status of savedStatuses) {
    if (!currentStatuses.has(status)) await setActorStatusEffect(actor, status, true);
  }
}

export async function generateEntity(entity: Entity, scene: Scene) {
  // Existing token on scene - move it and restore state
  const existing = scene.tokens.get(entity.id ?? "");
  if (existing) {
    const snappedGrid = pixelToGrid(entity.x, entity.y, scene, { round: true, silent: true });
    const snappedPixel = snappedGrid ? gridToPixel(snappedGrid.x, snappedGrid.y, scene) : undefined;
    await existing.move({
      x: snappedPixel?.x ?? entity.x, y: snappedPixel?.y ?? entity.y,
      snapped: true, action: "displace",
    }, { animate: false });
    await restoreEntityState(existing, entity, true);
    return;
  }

  // Known actor - create a new unlinked token from it
  const knownActor = game.actors?.get(entity.actorId ?? "");
  if (knownActor) {
    const tokenData = await knownActor.getTokenDocument({
      x: entity.x, y: entity.y, elevation: entity.elevation,
      width: entity.width, height: entity.height, actorLink: false,
    });
    const [token] = await scene.createEmbeddedDocuments("Token", [tokenData.toObject()], { render: false });
    if (token) await restoreEntityState(token, entity, false);
    return;
  }

  // Unknown actor - create a temporary one, spawn a token, then delete the temp
  const tempActor = await getDocumentClass("Actor").create({
    name: entity.name,
    // @ts-expect-error DND5e specific
    type: "character",
    system: entity.system,
  }, { render: false });
  if (!tempActor) return;
  const tokenData = await tempActor.getTokenDocument({
    x: entity.x, y: entity.y, elevation: entity.elevation,
    width: entity.width, height: entity.height, actorLink: false,
  });
  const [token] = await scene.createEmbeddedDocuments("Token", [tokenData.toObject()], { render: false });
  if (token?.actor) {
    for (const itemData of entity.items) await token.actor.createEmbeddedDocuments("Item", [itemData], { render: false });
  }
  await tempActor.delete();
}
