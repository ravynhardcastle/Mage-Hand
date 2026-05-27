import type { TokenLightSnapshot, Dnd5eActorSystem, Dnd5eItemSystem, Dnd5eActorExt, TokenLayerExt, Dnd5eApi, Activity } from "./configuration";
import { MODULE_ID } from "./constants";

// quick ways to do things i do a lot

export function actorSys(actor: { system?: unknown } | null | undefined): Dnd5eActorSystem {
  return (actor?.system ?? {}) as Dnd5eActorSystem;
}

export function itemSys(item: { system?: unknown } | null | undefined): Dnd5eItemSystem {
  return (item?.system ?? {}) as Dnd5eItemSystem;
}

export function asDnd5eActor(actor: Actor): Actor & Dnd5eActorExt {
  return actor as Actor & Dnd5eActorExt;
}

export function getTokenLayer(): (foundry.canvas.layers.TokenLayer & TokenLayerExt) | undefined {
  return canvas?.tokens as (foundry.canvas.layers.TokenLayer & TokenLayerExt) | undefined;
}

export function getDnd5eApi(): Dnd5eApi | undefined {
  return (globalThis as unknown as { dnd5e?: Dnd5eApi }).dnd5e;
}

// bunch of helpers, i also have some below, I lost track of where they should all go idk
export function getDefaultTokenLight(): TokenLightSnapshot {
  return {
    bright: 0,
    dim: 0,
    angle: 360,
    alpha: 0.5,
  };
}

export function getItemsOfType(items: Iterable<Item>, type: string): Item[] {
  const out: Item[] = [];
  for (const i of items) if ((i.type as string) === type) out.push(i);
  return out;
}

export function getModuleFlag(token: TokenDocument, key: string): Record<string, unknown> | undefined {
  const raw: unknown = token.getFlag(MODULE_ID, key as never);
  return (raw && typeof raw === "object") ? raw as Record<string, unknown> : undefined;
}

export function isModuleActive(moduleId: string): boolean {
  const mod = game.modules?.get(moduleId);
  return !!mod?.active;
}

export function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// realistically this doesn't need to be a function but i want it here cuz
// it explicitly shows that dnd actively makes sure EVERY status is 16 characters
// i have no clue why??
export function dnd5eStaticId(id: string): string {
  return id.length >= 16 ? id.substring(0, 16) : id.padEnd(16, "0");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getItemActivities(item: unknown): Activity[] {
  if (!isRecord(item)) return [];

  const system = item["system"];
  if (!isRecord(system)) return [];

  const activities = system["activities"];
  if (!isRecord(activities)) return [];

  const contents = activities["contents"];
  if (!Array.isArray(contents)) return [];

  return contents.filter((v: unknown): v is Activity => isRecord(v) && typeof v["type"] === "string");
}
