// TODO: Misc. Actions (such as hide)
//   - implicitly, cover
//   - this might not be necessary, but enemies can disengage for free
//   - because they are goblins

import * as tf from '@tensorflow/tfjs';
import * as buffer from 'buffer';
import { connectRL, getAction, sendReward, sendStart, sendEvalStart, sendHumanStart, sendFinish, sendHumanFinish, isRLConnected, fetchAvailableModels } from './rl-client';

CONFIG.debug.hooks = false;

const payload_version: number = 3;
const MODULE_ID = "dnd-model";
const LIGHT_SPELL_FLAG_KEY = "lightSpell";
const GUIDING_BOLT_FLAG_KEY = "guidingBoltNextAttack";
const RANDOM_SPELL_EXCLUSIONS_SETTING_KEY = "randomSpellExclusions";
const DEFAULT_RANDOM_SPELL_EXCLUSIONS = ["thaumaturgy", "mage hand", "prestidigitation"];

type TokenLightSnapshot = Record<string, unknown>;
type GuidingBoltFlag = {
  sourceActorId?: string;
  appliedRound?: number;
  appliedTurn?: number;
  expiresRound?: number;
  expiresTurn?: number;
};

// bunch of helpers, i also have some below, I lost track of where they should all go idk
function cloneTokenLight(token: TokenDocument): TokenLightSnapshot {
  // because it was bugging tf out and annoying me i made this but probably not needed
  const tokenData = token.toObject() as { light?: Record<string, unknown> };
  const light = tokenData.light ?? {};
  return foundry.utils.deepClone(light) as TokenLightSnapshot;
}

function getDefaultTokenLight(): TokenLightSnapshot {
  return {
    bright: 0,
    dim: 0,
    angle: 360,
    alpha: 0.5,
  };
}

function getModuleFlag(token: TokenDocument, key: string): Record<string, unknown> | undefined {
  const raw = (token as unknown as { getFlag: (m: string, k: string) => unknown }).getFlag(MODULE_ID, key);
  return (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : undefined;
}


function getCombatRoundTurn(): { round: number; turn: number } | undefined {
  const combat = game.combat;
  if (!combat) return undefined;

  const round = combat.round;
  const turn = combat.turn;
  if (typeof round !== "number" || !Number.isFinite(round)) return undefined;
  if (typeof turn !== "number" || !Number.isFinite(turn)) return undefined;
  return { round, turn };
}

function getGuidingBoltExpiryForActor(actorId: string | null | undefined) {
  const combat = game.combat;
  const now = getCombatRoundTurn();
  if (!combat || !now || !actorId) return {};

  const turns = Array.isArray(combat.turns) ? combat.turns : [];
  const casterTurnIndex = turns.findIndex(c =>
    (c as unknown as { actorId?: string | null }).actorId === actorId
  );

  if (casterTurnIndex < 0 || turns.length === 0) {
    return { appliedRound: now.round, appliedTurn: now.turn, expiresRound: now.round + 1, expiresTurn: now.turn };
  }

  return {
    appliedRound: now.round, appliedTurn: now.turn,
    expiresRound: casterTurnIndex > now.turn ? now.round : now.round + 1,
    expiresTurn: casterTurnIndex,
  };
}

function isGuidingBoltExpired(flag: GuidingBoltFlag): boolean {
  if (typeof flag.expiresRound !== "number" || typeof flag.expiresTurn !== "number") return false;
  const now = getCombatRoundTurn();
  if (!now) return false;
  return now.round > flag.expiresRound || (now.round === flag.expiresRound && now.turn > flag.expiresTurn);
}

async function clearGuidingBoltFlag(token: TokenDocument): Promise<void> {
  await token.update({ "flags.dnd-model.guidingBoltNextAttack": null } as Record<string, unknown>);
}

async function getActiveGuidingBoltTargetIds(scene: Scene): Promise<Set<string>> {
  const active = new Set<string>();

  for (const token of scene.tokens) {
    if (!token.id) continue;

    const flag = getModuleFlag(token, GUIDING_BOLT_FLAG_KEY) as GuidingBoltFlag | undefined;
    if (!flag) continue;
    if (isGuidingBoltExpired(flag)) {
      await clearGuidingBoltFlag(token);
      continue;
    }

    active.add(token.id);
  }

  return active;
}

function registerGuidingBoltAdvantageHook(): void {
  const hooksApi = Hooks as unknown as {
    on?: (hook: string, fn: (workflow: unknown) => void) => number;
    off?: (hook: string, fn: number | ((...args: unknown[]) => unknown)) => void;
  };
  if (typeof hooksApi.on !== "function" || typeof hooksApi.off !== "function") return;

  const hookId = hooksApi.on("midi-qol.preAttackRollConfig", (workflow: unknown) => {
    hooksApi.off?.("midi-qol.preAttackRollConfig", hookId);
    if (typeof workflow !== "object" || workflow === null) return;
    const tracker = (workflow as Record<string, unknown>)["attackRollModifierTracker"] as
      { advantage?: { add?: (source: string, label: string) => void } } | undefined;
    tracker?.advantage?.add?.("guidingBolt", "Guiding Bolt");
  });
}

function isConcentrationSpell(item: Item): boolean {
  const duration = (item.system as unknown as {
    duration?: { concentration?: boolean; units?: string; type?: string };
  }).duration;

  if (duration?.concentration === true) return true;

  const units = (duration?.units ?? "").toLowerCase();
  const type = (duration?.type ?? "").toLowerCase();
  return units === "concentration" || type === "concentration";
}

const ACTIONS_PER_TARGET = 4;
// Action encoding: action = targetIndex * ACTIONS_PER_TARGET + variant

type RoutinglibAPI = {
  calculatePath: (from: {x: number; y: number}, to: {x: number; y: number}, options?: Record<string, unknown>) => Promise<{path: {x: number; y: number}[]; cost: number} | null>;
  pixelToGrid: (x: number, y: number) => {x: number; y: number};
  gridToPixel: (x: number, y: number) => {x: number; y: number};
};

Hooks.on("ready", () => {
  console.log("DNDModel Initialized! | TensorFlow.js version:", tf.version.tfjs);
  window.Buffer = buffer.Buffer;
});

Hooks.once("init", () => {
  const settings = (game as unknown as { settings?: { register?: (...args: unknown[]) => unknown } }).settings;
  if (!settings?.register) return;

  settings.register(MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY, {
    name: "Random Spell Exclusions",
    hint: "Comma-separated spell/cantrip names to exclude from random spell casting.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_RANDOM_SPELL_EXCLUSIONS.join(", "),
  });

  settings.register(MODULE_ID, "debugMode", {
    name: "Debug Mode",
    hint: "Show debug/test buttons in the token controls toolbar.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
});

// Allow list is probably better, but this is faster lol
function getExcludedRandomSpellNames(): Set<string> {
  const configured = (game as unknown as { settings?: { get?: (...args: unknown[]) => unknown } })
    .settings?.get?.(MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY);
  if (typeof configured !== "string") return new Set(DEFAULT_RANDOM_SPELL_EXCLUSIONS);
  const parsed = configured.split(/[\n,;]+/).map(e => e.trim().toLowerCase()).filter(e => e.length > 0);
  return parsed.length > 0 ? new Set(parsed) : new Set(DEFAULT_RANDOM_SPELL_EXCLUSIONS);
}

// realistically this doesn't need to be a function but i want it here cuz
// it explicitly shows that dnd actively makes sure EVERY status is 16 characters
// i have no clue why??
function dnd5eStaticId(id: string): string {
  return id.length >= 16 ? id.substring(0, 16) : id.padEnd(16, "0");
}

class Entity {
  name: string;
  id: string | null;
  actorId: string | null;
  x: number;
  y: number;
  elevation: number;
  width: number;
  height: number;
  system: CharacterData;
  items: Array<Item>;
  effects: Array<Record<string, unknown>>;
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
    system: CharacterData,
    items: Array<Item>,
    effects: Array<Record<string, unknown>>,
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
    // dnd statues are like, conjoined, so you have to be fucky with them
    const effectStatuses: string[] = [];
    for (const effect of actor?.effects ?? []) {
      if (effect.disabled) continue;
      const s = (effect as unknown as { statuses?: Set<string> }).statuses;
      if (s) for (const id of s) {
        if (effect.id === dnd5eStaticId(`dnd5e${id}`)) effectStatuses.push(id);
      }
    }
    return new Entity(
      token.name, token.id, actor?.id ?? null,
      token.x, token.y, token.elevation, token.width, token.height,
      (actor?.system ?? {}) as unknown as CharacterData,
      actor?.items.map(i => (i as unknown as { toObject: () => Item }).toObject()) ?? [],
      actor?.effects.map(e => (e as unknown as { toObject: () => Record<string, unknown> }).toObject()) ?? [],
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
      (json as { effects?: Array<Record<string, unknown>> }).effects ?? [],
      json.disposition,
      (json as { light?: TokenLightSnapshot | null }).light ?? null,
      (json as { statuses?: string[] }).statuses ?? [],
    );
  }
}

type EncodedState = {
  version: number;
  round: number;
  entities: ReturnType<Entity["toJSON"]>[];
}

type AttackResultTarget = {
  name: string;
  tokenId: string;
  ac: number;
  hit: boolean;
  damageDealt: number;
}

type AttackResult = {
  attacker: string;
  attackerId: string;
  weapon: string;
  attackTotal: number;
  isCritical: boolean;
  isFumble: boolean;
  kind: "action" | "reaction";
  targets: AttackResultTarget[];
}

type TurnLogEntry = {
  state: string | undefined;
  events: AttackResult[];
}

type HumanReadableObservation = Record<string, string>;

type RLResult = {
  actionIndex: number;
  tokenList: TokenDocument[];
  validTargets: TokenDocument[];
  observation: number[];
  readableObservation: HumanReadableObservation;
};

type HumanTamerWinner = "goblins" | "players" | "draw";

type HumanTamerFeedback = "good" | "neutral" | "bad" | "no-valid-targets" | "no-target-token";

type HumanTamerActionType = "approach+attack" | "approach+dash" | "still+attack" | "flee+flee";

type HumanTamerPromptLog = {
  timestamp: string;
  observation: HumanReadableObservation;
  actionType: HumanTamerActionType;
  target: { id: string | null; name: string | null };
  userResponse: HumanTamerFeedback;
  responseTimeSec: number;
};

type HumanTamerSessionLog = {
  version: number;
  createdAt: string;
  world: string;
  sessionType: "human-tamer-test";
  username: string;
  startedAt: string;
  finishedAt: string;
  winner: HumanTamerWinner;
  promptCount: number;
  prompts: HumanTamerPromptLog[];
};

function getHumanTamerActionType(variant: ActionVariant): HumanTamerActionType {
  switch (variant) {
    case ActionVariant.ApproachAttack:
      return "approach+attack";
    case ActionVariant.ApproachDash:
      return "approach+dash";
    case ActionVariant.StillAttack:
      return "still+attack";
    case ActionVariant.FleeFlee:
      return "flee+flee";
    default:
      return "still+attack";
  }
}

function getMaxAttackRanges(actor: Actor): { melee: number; ranged: number } {
  let maxMelee = 5; // unarmed strike baseline
  let maxRanged = 0;
  // @ts-expect-error DND types don't have item types yet
  const weapons = (actor.items.filter(i => i.type === "weapon") as Item[])
    .filter(i => ((i.system as unknown as { quantity?: number }).quantity ?? 1) > 0)
    .filter(w => getUsableAmmunitionIdOrNull(w) !== null);
  for (const w of weapons) {
    const range = (w.system as unknown as { range?: ItemRange }).range;
    const reach = range?.reach ?? range?.value ?? 5;
    if ((w.system as unknown as { attackType?: string }).attackType === "ranged") {
      if (reach > maxRanged) maxRanged = reach;
    } else {
      if (reach > maxMelee) maxMelee = reach;
    }
  }
  const spells = getCastableSpellsForRandomAction(actor);
  for (const s of spells) {
    const range = (s.system as unknown as { range?: ItemRange }).range;
    const reach = range?.value ?? 5;
    if (reach > maxRanged) maxRanged = reach;
  }
  return { melee: maxMelee, ranged: maxRanged };
}

function getMaxDamageForItem(item: Item): number {
  const activities = getItemActivities(item);
  const activity = activities.find(a => a.type === "attack") ?? activities.find(a => a.damage?.parts);
  if (!activity?.damage?.parts) return 0;
  let total = 0;
  for (const part of activity.damage.parts) {
    const n = part.number ?? 0;
    const d = part.denomination ?? 0;
    total += n * d; // max roll on NdD
    if (part.bonus) {
      const bonusNum = parseInt(part.bonus, 10);
      if (!isNaN(bonusNum)) total += bonusNum;
    }
  }
  return total;
}

function getMaxAttackDamage(actor: Actor): number {
  let maxDmg = 1; // unarmed strike baseline
  // @ts-expect-error DND types don't have item types yet
  const weapons = (actor.items.filter(i => i.type === "weapon") as Item[])
    .filter(i => ((i.system as unknown as { quantity?: number }).quantity ?? 1) > 0)
    .filter(w => getUsableAmmunitionIdOrNull(w) !== null);
  for (const w of weapons) {
    const dmg = getMaxDamageForItem(w);
    if (dmg > maxDmg) maxDmg = dmg;
  }
  const spells = getCastableSpellsForRandomAction(actor);
  for (const s of spells) {
    const dmg = getMaxDamageForItem(s);
    if (dmg > maxDmg) maxDmg = dmg;
  }
  return maxDmg;
}

// observation per token: [isHostile, isTurn, isDead, distToActiveToken, canKill, canKillActive, isInRange, activeInRange, couldBeInRange, couldBeInRangeToActive, isCloseToBorder]
async function queryRL(): Promise<RLResult> {
  if (!isRLConnected()) {
    await connectRL();
  }

  const activeScene = game.scenes?.active;
  if (!activeScene) throw new Error("No active scene");

  // determine whose turn it is: combat combatant -> GM-controlled token -> nobody
  let activeTokenId: string | null = null;
  const combatant = game.combat?.combatants.get(game.combat.current.combatantId || "");
  if (combatant?.tokenId) {
    activeTokenId = combatant.tokenId;
  } else {
    const controlled = canvas?.tokens?.controlled ?? [];
    if (controlled.length === 1) {
      activeTokenId = controlled[0]?.document.id ?? null;
    }
  }

  const activeToken = activeTokenId ? activeScene.tokens.get(activeTokenId) : null;
  // [isHostile, isTurn, isDead, canKill, canKillActive, isInRange, activeInRange, couldBeInRange, couldBeInRangeToActive, isCloseToBorder] per token
  const observation: number[] = [];
  const tokenList: TokenDocument[] = [];
  const validTargets: TokenDocument[] = []; // non-hostile tokens only (valid targets for hostile RL agent)
  const records: HumanReadableObservation = {}; // remove this later to reduce lag
  const activeMaxDmg = activeToken?.actor ? getMaxAttackDamage(activeToken.actor) : 0;
  const activeHp = activeToken?.actor ? ((activeToken.actor.system as unknown as { attributes?: { hp?: { value?: number } } }).attributes?.hp?.value ?? 0) : 0;

  // Pre-compute range templates: active token's attack range, and active token's move+attack range
  const inRangeIds = new Set<string>();
  const couldBeInRangeIds = new Set<string>();
  const activeInRangeIds = new Set<string>();
  const couldBeInRangeToActiveIds = new Set<string>();
  if (activeToken?.actor && canvas?.scene) {
    const activeRanges = getMaxAttackRanges(activeToken.actor);
    const activeSpeed = (activeToken.actor.system as unknown as { attributes?: { movement?: { speed?: number } } }).attributes?.movement?.speed ?? 30;
    const activeSource = {
      x: activeToken.x,
      y: activeToken.y,
      width: activeToken.width,
      height: activeToken.height,
      elevation: activeToken.elevation,
    };
    const allSceneTokens = [...activeScene.tokens];
    const addIds = (tokens: TokenDocument[] | undefined, set: Set<string>) => {
      if (tokens) for (const t of tokens) { if (t.id) set.add(t.id); }
    };

    // isInRange: targets currently in the active token's melee OR ranged attack range
    addIds(await withRangeTemplate<TokenDocument[]>(activeScene, activeSource, activeRanges.melee, (templateObj) => {
      return getTokensInTemplate(templateObj, activeScene, allSceneTokens);
    }, undefined, false, true), inRangeIds);
    if (activeRanges.ranged > 0) {
      addIds(await withRangeTemplate<TokenDocument[]>(activeScene, activeSource, activeRanges.ranged, (templateObj) => {
        return getTokensInTemplate(templateObj, activeScene, allSceneTokens);
      }, undefined, true, true), inRangeIds);
    }

    // couldBeInRange: targets reachable if the active token moves first
    addIds(await withRangeTemplate<TokenDocument[]>(activeScene, activeSource, activeSpeed + activeRanges.melee, (templateObj) => {
      return getTokensInTemplate(templateObj, activeScene, allSceneTokens);
    }, undefined, false, true), couldBeInRangeIds);
    if (activeRanges.ranged > 0) {
      addIds(await withRangeTemplate<TokenDocument[]>(activeScene, activeSource, activeSpeed + activeRanges.ranged, (templateObj) => {
        return getTokensInTemplate(templateObj, activeScene, allSceneTokens);
      }, undefined, true, true), couldBeInRangeIds);
    }

    // activeInRange + couldBeInRangeToActive: for each other token, check if active is in that token's attack range (and move+attack range)
    for (const token of allSceneTokens) {
      if (token.id === activeTokenId || !token.actor) continue;
      const tokenRanges = getMaxAttackRanges(token.actor);
      const tokenSpeed = (token.actor.system as unknown as { attributes?: { movement?: { speed?: number } } }).attributes?.movement?.speed ?? 30;
      const tokenSource = {
        x: token.x,
        y: token.y,
        width: token.width,
        height: token.height,
        elevation: token.elevation,
      };
      // Check melee range
      const meleeHits = await withRangeTemplate<TokenDocument[]>(activeScene, tokenSource, tokenRanges.melee, (templateObj) => {
        return getTokensInTemplate(templateObj, activeScene, [activeToken]);
      }, undefined, false, true);
      // Check ranged range
      const rangedHits = tokenRanges.ranged > 0 ? await withRangeTemplate<TokenDocument[]>(activeScene, tokenSource, tokenRanges.ranged, (templateObj) => {
        return getTokensInTemplate(templateObj, activeScene, [activeToken]);
      }, undefined, true, true) : undefined;
      const inRange = (meleeHits && meleeHits.length > 0) || (rangedHits && rangedHits.length > 0);
      if (inRange && token.id) {
        activeInRangeIds.add(token.id);
        couldBeInRangeToActiveIds.add(token.id);
      } else if (token.id) {
        // Check if could be in range after moving
        const couldMelee = await withRangeTemplate<TokenDocument[]>(activeScene, tokenSource, tokenSpeed + tokenRanges.melee, (templateObj) => {
          return getTokensInTemplate(templateObj, activeScene, [activeToken]);
        }, undefined, false, true);
        const couldRanged = tokenRanges.ranged > 0 ? await withRangeTemplate<TokenDocument[]>(activeScene, tokenSource, tokenSpeed + tokenRanges.ranged, (templateObj) => {
          return getTokensInTemplate(templateObj, activeScene, [activeToken]);
        }, undefined, true, true) : undefined;
        if ((couldMelee && couldMelee.length > 0) || (couldRanged && couldRanged.length > 0)) {
          couldBeInRangeToActiveIds.add(token.id);
        }
      }
    }
  }

  for (const token of activeScene.tokens) {
    const actor = token.actor;
    if (!actor) continue;
    const isHostile = token.disposition === -1 ? 1 : 0;
    const sys = actor.system as unknown as { attributes?: { hp?: { value?: number; max?: number }, movement?: { speed?: number } } };
    const hp = sys.attributes?.hp?.value ?? 0;
    const isTurn = token.id === activeTokenId ? 1 : 0;
    const isDead = hp <= 0 ? 1 : 0;
    const canKill = (hp > 0 && hp <= activeMaxDmg) ? 1 : 0;
    const canKillActive = (activeHp > 0 && activeHp <= getMaxAttackDamage(actor)) ? 1 : 0;
    const isInRange = token.id ? (inRangeIds.has(token.id) ? 1 : 0) : 0;
    const activeInRange = token.id ? (activeInRangeIds.has(token.id) ? 1 : 0) : 0;
    const couldBeInRange = token.id ? (couldBeInRangeIds.has(token.id) ? 1 : 0) : 0;
    const couldBeInRangeToActive = token.id ? (couldBeInRangeToActiveIds.has(token.id) ? 1 : 0) : 0;
    if (!canvas?.scene?.grid) continue;
    const gridPos = pixelToGrid(token.x, token.y, canvas.scene);
    const gridW = Math.floor(canvas.scene.dimensions.sceneWidth / canvas.scene.grid.sizeX);
    const gridH = Math.floor(canvas.scene.dimensions.sceneHeight / canvas.scene.grid.sizeY);
    const isCloseToBorder = !gridPos || gridPos.x < 3 || gridPos.y < 3 || gridPos.x + token.width > gridW - 3 || gridPos.y + token.height > gridH - 3 ? 1 : 0;

    const actorName = actor.name;
    let recordKey = actorName !== token.name ? `${actorName} (${token.name})` : actorName;
    if (recordKey in records) {
      let suffix = 2;
      while (`${recordKey} ${suffix}` in records) suffix++;
      recordKey = `${recordKey} ${suffix}`;
    }
    records[recordKey] = `isHostile: ${isHostile}, isTurn: ${isTurn}, isDead: ${isDead}, canKill: ${canKill}, canKillActive: ${canKillActive}, isInRange: ${isInRange}, activeInRange: ${activeInRange}, couldBeInRange: ${couldBeInRange}, couldBeInRangeToActive: ${couldBeInRangeToActive}, close to border: ${isCloseToBorder}`;
    observation.push(isHostile, isTurn, isDead, canKill, canKillActive, isInRange, activeInRange, couldBeInRange, couldBeInRangeToActive, isCloseToBorder);
    tokenList.push(token);
    if (token.disposition !== -1) {
      validTargets.push(token);
    }
  }

  const actionIndex = await getAction(observation);
  console.log("RL observation:", observation, ", action:", actionIndex);
  return { actionIndex, tokenList, validTargets, observation, readableObservation: { ...records } };
}

function forSelectedTokens(fn: (entity: Entity, token: TokenDocument, scene: Scene) => Promise<void> | void): void {
  const scene = canvas?.scene ?? game.scenes?.active;
  if (!scene) return;
  for (const tokenObject of (canvas?.tokens?.controlled ?? [])) {
    const token = tokenObject.document;
    if (!token.actor) continue;
    Promise.resolve(fn(Entity.fromToken(token), token, scene)).catch((err: unknown) => {
      console.error(`Error for ${token.name}:`, err);
    });
  }
}

Hooks.on("getSceneControlButtons", controls => {
  if (controls["tokens"] == undefined) return;
  const isGM = game.user?.isGM;
  const debugMode = (game as unknown as { settings?: { get?: (m: string, k: string) => unknown } }).settings?.get?.(MODULE_ID, "debugMode") === true;

  controls["tokens"].tools["humanFeedback"] = {
    name: "humanFeedback",
    title: "DNDModel.HumanFeedback",
    icon: "fa-solid fa-comments",
    order: 0,
    button: true,
    visible: isGM,
    onChange: () => {
      void (async () => {
        const nameInput = await foundry.applications.api.DialogV2.input({
          window: { title: "Human Feedback" },
          content: `
            <div class="form-group">
              <label>Your name</label>
              <input name="humanName" type="text" autofocus required />
            </div>
          `,
          ok: { label: "Start", icon: "fa-solid fa-play" },
          rejectClose: false,
        }) as { humanName: string } | null;
        if (!nameInput || !nameInput.humanName.trim()) return;
        const humanName = nameInput.humanName.trim();

        const activeScene = canvas?.scene ?? game.scenes?.active;
        if (!activeScene) return;

        const originalViewedCombat = game.combats?.viewed;

        const controlledTokens = canvas?.tokens?.controlled ?? [];
        let rolloutParticipants: { tokenId: string }[];
        if (originalViewedCombat && originalViewedCombat.combatants.size > 0) {
          rolloutParticipants = Array.from(originalViewedCombat.combatants)
            .filter(c => !!c.tokenId)
            .map(c => ({ tokenId: c.tokenId || "" }));
        } else {
          rolloutParticipants = controlledTokens
            .map(tokenObject => ({ tokenId: tokenObject.document.id }))
            .filter((p): p is { tokenId: string } => !!p.tokenId);
          if (rolloutParticipants.length === 0) {
            rolloutParticipants = activeScene.tokens
              .map(t => ({ tokenId: t.id }))
              .filter((p): p is { tokenId: string } => !!p.tokenId);
            if (rolloutParticipants.length === 0) {
              ui.notifications?.warn("No tokens in the active scene.");
              return;
            }
          }
        }

        // Connect to RL server
        try {
          if (!isRLConnected()) {
            ui.notifications?.info("Connecting to RL server...");
            await connectRL();
          }
          sendHumanStart(humanName, activeScene.tokens.size);
        } catch (err: unknown) {
          console.error("Failed to connect to RL server:", err);
          ui.notifications?.error("Failed to connect to RL server. Start it with 'yarn rl:server'.");
          return;
        }

        // Snapshot the starting state so we can restore after
        const startingState = encodeScene(activeScene);
        if (!startingState) return;

        let originalCombatData: { tokenId: string; initiative: number | null }[] | null = null;
        if (originalViewedCombat && originalViewedCombat.combatants.size > 0) {
          originalCombatData = Array.from(originalViewedCombat.combatants)
            .filter(c => !!c.tokenId)
            .map(c => ({
              tokenId: c.tokenId || "",
              initiative: typeof c.initiative === "number" ? c.initiative : null,
            }));
          await originalViewedCombat.delete();
        }

        const createdCombat = await Combat.create({ scene: activeScene.id });
        if (!(createdCombat instanceof Combat)) return;
        const combat = createdCombat;

        await combat.createEmbeddedDocuments(
          "Combatant",
          rolloutParticipants.map(p => ({ tokenId: p.tokenId }))
        );

        await combat.activate();
        await game.combat?.rollAll();
        await combat.startCombat();

        const usedReaction = new Set<string>();
        const tamerPromptLogs: HumanTamerPromptLog[] = [];
        const tamerStartedAt = new Date().toISOString();
        let tamerWinner: HumanTamerWinner = "draw";
        let running = true;
        let turnCount = 0;
        while (running) {
          turnCount++;
          const combatant = combat.combatants.get(combat.current.combatantId || "");
          if (!combatant) break;
          const token = activeScene.tokens.get(combatant.tokenId || "");
          if (!token) { await combat.nextTurn(); continue; }
          const actor = token.actor;
          if (!actor) { await combat.nextTurn(); continue; }

          // Skip dead/downed
          if (isActorAtZeroHp(actor)) {
            if (token.disposition !== 1) {
              await combatant.update({ defeated: true });
            } else if (getActorDeathSaves(actor).failure >= 3) {
              await combatant.update({ defeated: true });
            } else {
              const result = await rollActorDeathSave(actor);
              if (result.dead) await combatant.update({ defeated: true });
              else if (result.rolledNat20 && !isActorAtZeroHp(actor)) {
                await setActorStatusEffect(actor, "unconscious", false);
              }
            }
            // Check if combat is over
            const dispositions = new Set<number>();
            for (const c of combat.combatants) {
              const t = activeScene.tokens.get(c.tokenId || "");
              if (t?.actor && !isActorAtZeroHp(t.actor)) dispositions.add(t.disposition);
            }
            if (dispositions.size <= 1) {
              const victor = dispositions.values().next().value ?? null;
              const hostileWon = victor === -1;
              tamerWinner = hostileWon ? "goblins" : "players";
              sendReward(hostileWon ? 10 : -10, true);
              console.log(`%c[Human Session] Combat ended. Round: ${combat.round}, Turns: ${turnCount}, Winner: ${hostileWon ? "Hostile (goblins)" : "Players"}`, "color: #ff9900; font-weight: bold;");
              running = false;
              break;
            }
            await combat.nextTurn();
            continue;
          }

          if (token.id) usedReaction.delete(token.id);
          const entity = Entity.fromToken(token);
          const isHostile = token.disposition === -1;

          if (isHostile) {
            // RL agent turn: query, execute, then ask for human feedback
            const { actionIndex, validTargets, readableObservation } = await queryRL();
            if (validTargets.length > 0) {
              const targetIndex = Math.floor(actionIndex / ACTIONS_PER_TARGET) % validTargets.length;
              const variant = actionIndex % ACTIONS_PER_TARGET as ActionVariant;
              const actionType = getHumanTamerActionType(variant);
              const toward = variant !== ActionVariant.FleeFlee;
              const secondIsAttack = variant === ActionVariant.ApproachAttack || variant === ActionVariant.StillAttack;
              const moves = variant !== ActionVariant.StillAttack;
              const targetToken = validTargets[targetIndex];
              if (targetToken) {
                const tGrid = pixelToSnappedGrid(targetToken.x, targetToken.y, activeScene);
                if (tGrid) {
                  await executeRLTurn(entity, token, activeScene, tGrid.x, tGrid.y, toward, moves, secondIsAttack, usedReaction, targetToken.id ?? undefined);
                }
                const feedbackStart = performance.now();
                const feedback = await foundry.applications.api.DialogV2.wait({
                  window: { title: "RL Feedback" },
                  content: `<p><strong>${entity.name}</strong> chose <strong>${actionType}</strong> targeting <strong>${targetToken.name}</strong></p><p>Was this a good action?</p>`,
                  buttons: [
                    { action: "good", label: "Good", icon: "fa-solid fa-thumbs-up" },
                    { action: "neutral", label: "Neutral", icon: "fa-solid fa-minus" },
                    { action: "bad", label: "Bad", icon: "fa-solid fa-thumbs-down" },
                  ],
                  rejectClose: false,
                }) as string | null;
                const responseTimeSec = Number(((performance.now() - feedbackStart) / 1000).toFixed(3));
                const normalizedFeedback = feedback === "good" || feedback === "bad" || feedback === "neutral" ? feedback : "neutral";
                const reward = normalizedFeedback === "good" ? 100 : normalizedFeedback === "bad" ? -100 : 0;
                tamerPromptLogs.push({
                  timestamp: new Date().toISOString(),
                  observation: { ...readableObservation },
                  actionType,
                  target: { id: targetToken.id ?? null, name: targetToken.name },
                  userResponse: normalizedFeedback,
                  responseTimeSec,
                });
                sendReward(reward, false);
              } else {
                tamerPromptLogs.push({
                  timestamp: new Date().toISOString(),
                  observation: { ...readableObservation },
                  actionType,
                  target: { id: null, name: null },
                  userResponse: "no-target-token",
                  responseTimeSec: 0,
                });
                sendReward(0, false);
              }
            } else {
              const variant = actionIndex % ACTIONS_PER_TARGET as ActionVariant;
              const actionType = getHumanTamerActionType(variant);
              tamerPromptLogs.push({
                timestamp: new Date().toISOString(),
                observation: { ...readableObservation },
                actionType,
                target: { id: null, name: null },
                userResponse: "no-valid-targets",
                responseTimeSec: 0,
              });
              sendReward(0, false);
            }
          } else {
            // pause so humans can follow along
            ui.notifications?.info(`${entity.name}'s turn`);
            await new Promise(r => setTimeout(r, 1500));

            let firstChoice = "";
            let secondChoice = "";
            let disengaged = false;
            const canFreeDisengage = actor.items.some(i => i.name === "Nimble Escape");
            const moveAction = new RandomMoveAction(entity);
            moveAction.usedReaction = usedReaction;
            const reactable = await checkNearbyReactions(activeScene, entity, usedReaction);
            if (canFreeDisengage) {
              disengaged = true;
              firstChoice = "move (nimble escape)";
              await moveAction.act();
            } else if (!reactable || Math.random() < 0.5) {
              firstChoice = "move";
              await moveAction.act();
            } else {
              disengaged = true;
              firstChoice = "disengage";
            }
            if (!disengaged) {
              await reactionCheck(moveAction, activeScene, entity, usedReaction, []);
            }
            if (!isActorAtZeroHp(actor)) {
              const hasCastableSpell = getCastableSpellsForRandomAction(actor).length > 0;
              const actingToken = activeScene.tokens.get(entity.id || "") ?? token;
              const enemyInMeleeRange = await hasEnemyInMeleeRange(actingToken, activeScene);
              let secondAction: Action;
              if (hasCastableSpell && !enemyInMeleeRange) {
                const spellAction = new RandomSpellAction(entity);
                secondAction = spellAction;
                secondAction.usedReaction = usedReaction;
                await secondAction.act();
                secondChoice = spellAction.spellName ? `${spellAction.spellLevel === 0 ? "cantrip" : "spell"}: ${spellAction.spellName}` : "spell (none available)";
              } else {
                const chooseAttack = Math.random() < 0.5;
                if (chooseAttack) {
                  const chooseSpellAttack = hasCastableSpell && Math.random() < 0.5;
                  if (chooseSpellAttack) {
                    const spellAction = new RandomSpellAction(entity);
                    secondAction = spellAction;
                    secondAction.usedReaction = usedReaction;
                    await secondAction.act();
                    secondChoice = spellAction.spellName ? `${spellAction.spellLevel === 0 ? "cantrip" : "spell"}: ${spellAction.spellName}` : "spell (none available)";
                  } else {
                    const attackAction = new SmartAttack(entity);
                    secondAction = attackAction;
                    secondAction.usedReaction = usedReaction;
                    await secondAction.act();
                    secondChoice = attackAction.weapon ? `attack: ${attackAction.weapon}` : "attack (no target in range)";
                  }
                } else {
                  secondAction = new RandomMoveAction(entity);
                  secondAction.usedReaction = usedReaction;
                  await secondAction.act();
                  secondChoice = "move";
                }
              }
              if (!disengaged) {
                await reactionCheck(secondAction, activeScene, entity, usedReaction, []);
              }
            } else {
              secondChoice = "none (at 0 HP)";
            }
            ui.notifications?.info(`${entity.name}: [${firstChoice}] then [${secondChoice}]`);
            await new Promise(r => setTimeout(r, 2000));
          }

          // Check if combat is over
          const dispositions = new Set<number>();
          for (const c of combat.combatants) {
            const t = activeScene.tokens.get(c.tokenId || "");
            if (t?.actor && !isActorAtZeroHp(t.actor)) dispositions.add(t.disposition);
          }
          if (dispositions.size <= 1) {
            const victor = dispositions.values().next().value ?? null;
            const hostileWon = victor === -1;
            tamerWinner = hostileWon ? "goblins" : "players";
            sendReward(hostileWon ? 10 : -10, true);
            console.log(`%c[Human Session] Combat ended after ${turnCount} turns. Winner: ${hostileWon ? "Hostile (goblins)" : "Players"}`, "color: #ff9900; font-weight: bold;");
            running = false;
          } else {
            await combat.nextTurn();
          }
        }

        const tamerFinishedAt = new Date().toISOString();
        try {
          await saveHumanTamerSessionLog(humanName, tamerWinner, tamerStartedAt, tamerFinishedAt, tamerPromptLogs);
        } catch (err: unknown) {
          console.error("Failed to save TAMER session log:", err);
          ui.notifications?.warn("TAMER test finished, but saving the log failed.");
        }

        sendHumanFinish(humanName);
        await combat.delete();

        // Restore scene
        await restoreSceneState(startingState, activeScene, undefined);

        // Restore original combat
        if (originalCombatData && originalCombatData.length > 0) {
          const restoredCombat = await Combat.create({ scene: activeScene.id });
          if (restoredCombat instanceof Combat) {
            await restoredCombat.createEmbeddedDocuments(
              "Combatant",
              originalCombatData.map(c => ({ tokenId: c.tokenId }))
            );
            await restoredCombat.activate();
            const initUpdates = originalCombatData
              .filter(c => c.initiative !== null)
              .map(c => {
                const restored = restoredCombat.combatants.find(rc => rc.tokenId === c.tokenId);
                return restored ? { _id: restored.id, initiative: c.initiative } : null;
              })
              .filter((u): u is { _id: string; initiative: number | null } => u !== null);
            if (initUpdates.length > 0) {
              await restoredCombat.updateEmbeddedDocuments("Combatant", initUpdates);
            }
          }
        }

        ui.notifications?.info("Human feedback session complete.");
      })();
    },
  };

  controls["tokens"].tools["sceneCalc"] = {
    name: "sceneCalc",
    title: "DNDModel.SceneCalc",
    icon: "fa-solid fa-wrench",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      const scene = canvas?.scene ?? game.scenes?.active;
      if (!scene) return;
      const encodedScene = encodeScene(scene);
      if (encodedScene) {
        console.log("Encoded Scene State:", encodedScene);
      } else {
        console.error("Error encoding scene state");
      }
    }
  };

  controls["tokens"].tools["decodeScene"] = {
    name: "decodeScene",
    title: "DNDModel.DecodeScene",
    icon: "fa-solid fa-download",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      const encoded = prompt("Paste encoded scene state:");
      if (!encoded) return;
      let decodedState;
      try {
        decodedState = decodeState(encoded);
        const scene = canvas?.scene ?? game.scenes?.active;
        if (!scene) return;
        for (const entity of decodedState.entities) {
          void generateEntity(entity, scene);
        }
      } catch (err) {
        console.error("Error decoding state:", err);
        return;
      }
    }
  };

  controls["tokens"].tools["randomAction"] = {
    name: "randomAction",
    title: "DNDModel.RandomAction",
    icon: "fa-solid fa-dice",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      void (async () => {
        const activeScene = canvas?.scene ?? game.scenes?.active;
        if (!activeScene) return;
        const tokens = canvas?.tokens?.controlled;
        if (!tokens) return;
        for (const tokenObject of tokens) {
          const token = tokenObject.document;
          const actor = token.actor;
          if (!actor) continue;
          const entity = Entity.fromToken(token);
          const hasCastableSpell = getCastableSpellsForRandomAction(actor).length > 0;
          const enemyInMeleeRange = await hasEnemyInMeleeRange(token, activeScene);
          if (hasCastableSpell && !enemyInMeleeRange) {
            const action = new RandomSpellAction(entity);
            try {
              await action.act();
            } catch (err: unknown) {
              console.error(`Error performing action for entity ${entity.name}:`, err);
            }
            continue;
          }

          const roll = Math.random();
          const action = hasCastableSpell && roll < 0.34
            ? new RandomSpellAction(entity)
            : roll < 0.67
              ? new SmartAttack(entity)
              : new RandomMoveAction(entity);
          try {
            await action.act();
          } catch (err: unknown) {
            console.error(`Error performing action for entity ${entity.name}:`, err);
          }
        }
      })();
    }
  };

  controls["tokens"].tools["randomAttack"] = {
    name: "randomAttack",
    title: "DNDModel.RandomAttack",
    icon: "fa-solid fa-sword",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => { forSelectedTokens(entity => new RandomAttack(entity).act()); },
  };

  controls["tokens"].tools["randomMove"] = {
    name: "randomMove",
    title: "Random Move",
    icon: "fa-solid fa-shoe-prints",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => { forSelectedTokens(entity => new RandomMoveAction(entity).act()); },
  };

  controls["tokens"].tools["randomSpell"] = {
    name: "randomSpell",
    title: "Random Spell/Cantrip",
    icon: "fa-solid fa-wand-magic-sparkles",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      forSelectedTokens((entity, token) => {
        if (!token.actor || getCastableSpellsForRandomAction(token.actor).length === 0) return Promise.resolve();
        return new RandomSpellAction(entity).act();
      });
    },
  };

  controls["tokens"].tools["rollOut"] = {
    name: "rollOut",
    title: "DNDModel.RollOut",
    icon: "fa-solid fa-dice-d20",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      void (async () => {
        const activeScene = canvas?.scene ?? game.scenes?.active;
        if (!activeScene) return;

        const originalViewedCombat = game.combats?.viewed;

        const controlledTokens = canvas?.tokens?.controlled ?? [];

        let rolloutParticipants: { tokenId: string; initiative?: number }[] = [];

        if (originalViewedCombat && originalViewedCombat.combatants.size > 0) {
          rolloutParticipants = Array.from(originalViewedCombat.combatants)
            .filter(c => !!c.tokenId && activeScene.tokens.has(c.tokenId))
            .map(c => ({
              tokenId: c.tokenId || "",
              initiative: typeof c.initiative === "number" ? c.initiative : undefined
            }))
            .filter(p => p.tokenId.length > 0);

          if (rolloutParticipants.length === 0) {
            ui.notifications?.warn("Viewed combat has no participants in the active scene.");
            return;
          }
        } else {
          rolloutParticipants = controlledTokens
            .map(tokenObject => ({ tokenId: tokenObject.document.id }))
            .filter((p): p is { tokenId: string } => !!p.tokenId);

          if (rolloutParticipants.length === 0) {
            rolloutParticipants = activeScene.tokens
              .map(t => ({ tokenId: t.id }))
              .filter((p): p is { tokenId: string } => !!p.tokenId);
            if (rolloutParticipants.length === 0) {
              ui.notifications?.warn("No tokens in the active scene.");
              return;
            }
          }
        }

        // Fetch available models for the eval dropdown
        const availableModels = await fetchAvailableModels();
        const modelOptions = availableModels.length > 0
          ? availableModels.map(m => `<option value="${m.path}">[${m.dir}] ${m.name}</option>`).join("")
          : `<option value="">(no models found)</option>`;

        const formData = await foundry.applications.api.DialogV2.input({
          window: { title: "Rollout Configuration" },
          content: `
            <div class="form-group">
              <label>Turns per run</label>
              <input name="maxTurns" type="number" min="1" value="10" autofocus />
            </div>
            <div class="form-group">
              <label>Number of runs</label>
              <input name="numRuns" type="number" min="1" value="1" />
            </div>
            <div class="form-group">
              <label>Log folder name (optional)</label>
              <input name="logFolder" type="text" placeholder="e.g. goblin-vs-fighter" />
            </div>
            <div class="form-group">
              <label>
                <input name="useRL" type="checkbox" />
                Use RL for hostile units (training)
              </label>
            </div>
            <div class="form-group">
              <label>
                <input name="evalRL" type="checkbox" />
                Use RL for hostile units (eval only)
              </label>
            </div>
            <div class="form-group">
              <label>Model to evaluate</label>
              <select name="evalModel">
                <option value="">(most recent)</option>
                ${modelOptions}
              </select>
            </div>
          `,
          ok: { label: "Roll Out", icon: "fa-solid fa-dice-d20" },
          rejectClose: false,
        }) as { maxTurns: string; numRuns: string; logFolder: string; useRL: boolean; evalRL: boolean; evalModel: string } | null;
        if (!formData) return;
        const maxTurns = Number(formData.maxTurns);
        const numRuns = Number(formData.numRuns);
        const logFolder = formData.logFolder.trim() || undefined;
        const useRL = formData.useRL;
        const evalRL = formData.evalRL && !useRL;
        const evalModelPath = formData.evalModel || undefined;
        if (isNaN(maxTurns) || maxTurns <= 0 || isNaN(numRuns) || numRuns <= 0) {
          ui.notifications?.error("Invalid input");
          return;
        }

        // Connect to RL server if enabled
        if (useRL || evalRL) {
          try {
            if (!isRLConnected()) {
              ui.notifications?.info("Connecting to RL server...");
              await connectRL();
            }
            if (useRL) sendStart(maxTurns, numRuns, activeScene.tokens.size);
            else if (evalRL) sendEvalStart(activeScene.tokens.size, evalModelPath);
          } catch (err: unknown) {
            console.error("Failed to connect to RL server:", err);
            ui.notifications?.error("Failed to connect to RL server. Start it with 'yarn rl:server'.");
            return;
          }
        }

        // Snapshot the starting state so we can restore between runs
        const startingState = encodeScene(activeScene);
        if (!startingState) return;

        // Save original combat data and delete it so we can create a fresh one
        let originalCombatData: { tokenId: string; initiative: number | null }[] | null = null;
        if (originalViewedCombat && originalViewedCombat.combatants.size > 0) {
          originalCombatData = Array.from(originalViewedCombat.combatants)
            .filter(c => !!c.tokenId)
            .map(c => ({
              tokenId: c.tokenId || "",
              initiative: typeof c.initiative === "number" ? c.initiative : null,
            }));
          await originalViewedCombat.delete();
        }

        for (let run = 0; run < numRuns; run++) {
          if (numRuns > 1) {
            ui.notifications?.info(`Starting run ${run + 1} / ${numRuns}`);
          }

          // Restore starting state before every run after the first
          if (run > 0) {
            await restoreSceneState(startingState, activeScene, undefined);
          }

          const log = {} as Record<number, TurnLogEntry>;

          const createdCombat = await Combat.create({ scene: activeScene.id });
          if (!(createdCombat instanceof Combat)) return;
          const combat = createdCombat;

          await combat.createEmbeddedDocuments(
            "Combatant",
            rolloutParticipants.map(participant => ({
              tokenId: participant.tokenId,
            }))
          );

          // Activate so game.combat points to this instance, then roll initiative
          await combat.activate();
          await game.combat?.rollAll();
          await combat.startCombat();
          let victor: number | null = null;
          let turnsTaken: number = maxTurns;
          // Track which tokens have used their reaction (regained at the start of their turn)
          const usedReaction = new Set<string>();
          for (let turn = 0; turn < maxTurns; turn++) {
            const combatant = combat.combatants.get(combat.current.combatantId || "");
            if (!combatant) {
              console.error("No combatant for current turn");
              break;
            }
            const token = activeScene.tokens.get(combatant.tokenId || "");
            if (!token) continue;
            const actor = token.actor;
            if (!actor) continue;

            const isFriendly = token.disposition === 1;
            const isDownedOrDead = async () => {
              if (!isActorAtZeroHp(actor)) return false;
              if (!isFriendly) {
                console.log(`Combatant ${combatant.name} is at 0 HP, marking defeated`);
                await combatant.update({ defeated: true });
                await combat.nextTurn();
                return true;
              }
              // Already dead from previous death save failures
              if (getActorDeathSaves(actor).failure >= 3) {
                console.log(`Combatant ${combatant.name} has 3 death save failures, marking defeated`);
                await combatant.update({ defeated: true });
                await combat.nextTurn();
                return true;
              }
              // Roll a death save at the start of their turn
              console.log(`Combatant ${combatant.name} is at 0 HP, rolling death save`);
              const result = await rollActorDeathSave(actor);
              if (result.dead) {
                console.log(`Combatant ${combatant.name} has died from death save failures`);
                await combatant.update({ defeated: true });
                await combat.nextTurn();
                return true;
              }
              if (result.rolledNat20 && !isActorAtZeroHp(actor)) {
                // Nat 20: revived with 1 HP, can act this turn
                console.log(`Combatant ${combatant.name} rolled a nat 20 and is back up!`);
                await setActorStatusEffect(actor, "unconscious", false);
                return false;
              }
              // Still unconscious (stabilized or still rolling) skip turn
              console.log(`Combatant ${combatant.name} is unconscious, skipping turn`);
              await combat.nextTurn();
              return true;
            }

            if (await isDownedOrDead()) continue;

            // Combatant regains their reaction at the start of their turn
            if (token.id) usedReaction.delete(token.id);

            const entity = Entity.fromToken(token);
            const turnEvents: AttackResult[] = [];

            const isHostile = token.disposition === -1;

            if ((useRL || evalRL) && isHostile) {
              const { actionIndex, validTargets } = await queryRL();
              if (validTargets.length > 0) {
                const targetIndex = Math.floor(actionIndex / ACTIONS_PER_TARGET) % validTargets.length;
                const variant = actionIndex % ACTIONS_PER_TARGET as ActionVariant;
                const toward = variant !== ActionVariant.FleeFlee;
                const secondIsAttack = variant === ActionVariant.ApproachAttack || variant === ActionVariant.StillAttack;
                const moves = variant !== ActionVariant.StillAttack;
                const targetToken = validTargets[targetIndex];
                if (targetToken) {
                  const variantNames = ["approach+attack", "approach+dash", "still+attack", "flee+flee"];
                  console.log(`${evalRL ? "Eval" : "RL"} ${entity.name}: ${variantNames[variant]} -> ${targetToken.name} (raw action: ${actionIndex})`);
                  const tGrid = pixelToSnappedGrid(targetToken.x, targetToken.y, activeScene);
                  if (tGrid) {
                    const rlEvents = await executeRLTurn(entity, token, activeScene, tGrid.x, tGrid.y, toward, moves, secondIsAttack, usedReaction, targetToken.id ?? undefined);
                    turnEvents.push(...rlEvents);
                  }
                }
              }
              if (useRL) sendReward(-0.1, false);
            } else {
              const startPos = { x: token.x, y: token.y };
              let firstChoice = "";
              let secondChoice = "";
              let disengaged = false;
              const canFreeDisengage = actor.items.some(i => i.name === "Nimble Escape");
              const moveAction = new RandomMoveAction(entity);
              moveAction.usedReaction = usedReaction;
              const reactable = await checkNearbyReactions(activeScene, entity, usedReaction);
              if (canFreeDisengage) {
                // Nimble Escape: disengage and move freely
                disengaged = true;
                firstChoice = "move (nimble escape)";
                await moveAction.act();
              } else if (!reactable || Math.random() < 0.5) {
                firstChoice = "move";
                await moveAction.act();
              } else {
                disengaged = true;
                firstChoice = "disengage";
                console.log(`Entity ${entity.name} is disengaging to avoid reaction`);
              }
              // Check for reaction
              if (!disengaged) {
                await reactionCheck(moveAction, activeScene, entity, usedReaction, turnEvents);
              }
              // Check if reaction dropped you to 0 HP, if so, can't do second action
              if (!isActorAtZeroHp(actor)) {
                let secondAction: Action;
                const hasCastableSpell = getCastableSpellsForRandomAction(actor).length > 0;
                const actingToken = activeScene.tokens.get(entity.id || "") ?? token;
                const enemyInMeleeRange = await hasEnemyInMeleeRange(actingToken, activeScene);
                if (hasCastableSpell && !enemyInMeleeRange) {
                  secondAction = new RandomSpellAction(entity);
                  secondChoice = "spell (no enemy in melee)";
                } else {
                  const chooseAttack = Math.random() < 0.5;
                  if (chooseAttack) {
                    const chooseSpellAttack = hasCastableSpell && Math.random() < 0.5;
                    secondAction = chooseSpellAttack
                      ? new RandomSpellAction(entity)
                      : new SmartAttack(entity);
                    secondChoice = chooseSpellAttack ? "spell" : "smart attack";
                  } else {
                    secondAction = new RandomMoveAction(entity);
                    secondChoice = "move";
                  }
                }
                secondAction.usedReaction = usedReaction;
                await secondAction.act();
                turnEvents.push(...secondAction.events);
                if (!disengaged) {
                  await reactionCheck(secondAction, activeScene, entity, usedReaction, turnEvents);
                }
              } else {
                secondChoice = "none (at 0 HP)";
              }
              const endPos = { x: token.x, y: token.y };
              if (startPos.x === endPos.x && startPos.y === endPos.y) {
                console.warn(`${entity.name} didn't move! Actions: [${firstChoice}] then [${secondChoice}]`);
              }
            }
            
            // If all tokens of one dispositon are 0 HP, end early
            const dispositions = new Set<number>();
            for (const combatant of combat.combatants) {
              const token = activeScene.tokens.get(combatant.tokenId || "");
              if (!token) continue;
              const actor = token.actor;
              if (!actor) continue;
              if (!isActorAtZeroHp(actor)) {
                dispositions.add(token.disposition);
              }
            }
            if (dispositions.size <= 1) {
              console.log("All tokens of one disposition are at 0 HP, ending combat early");
              victor = dispositions.values().next().value ?? null;
              turnsTaken = turn + 1;
              // Send terminal reward: +10 if hostiles won, -10 if hostiles lost
              if (useRL) {
                const hostileWon = victor === -1;
                sendReward(hostileWon ? 10 : -10, true);
              }
              // log final state
              const encodedScene = encodeScene(activeScene);
              log[turn] = { state: String(encodedScene), events: turnEvents };
              break;
            }
            // At the end of the turn, get the state of the scene
            const encodedScene = encodeScene(activeScene);
            log[turn] = { state: String(encodedScene), events: turnEvents };
            await combat.nextTurn();
          }

          // If combat timed out with no victor, send draw reward
          if (useRL && victor === null) {
            sendReward(0, true);
          }

          const runLabel = numRuns > 1 ? ` (run ${run + 1}/${numRuns})` : "";
          ui.notifications?.info(
            `Rollout complete${runLabel} after ${turnsTaken} turns, or ${combat.round} rounds.` +
            (victor !== null ? ` Victor disposition: ${victor}` : "")
          );

          await combat.delete();
          saveLog(log, logFolder).catch((err: unknown) => {
            console.error("Error saving log:", err);
          });
          
        }

        // Restore starting state after all runs are done
        await restoreSceneState(startingState, activeScene, undefined);
        if (numRuns > 1) {
          ui.notifications?.info(`All ${numRuns} runs complete. Scene restored to starting state.`);
          if (useRL) {
            sendFinish();
          }
        }

        // Restore the original combat if one existed
        if (originalCombatData && originalCombatData.length > 0) {
          const restoredCombat = await Combat.create({ scene: activeScene.id });
          if (restoredCombat instanceof Combat) {
            await restoredCombat.createEmbeddedDocuments(
              "Combatant",
              originalCombatData.map(c => ({
                tokenId: c.tokenId,
                ...(c.initiative !== null ? { initiative: c.initiative } : {})
              }))
            );
          }
        }
      })();
    }
  };

  controls["tokens"].tools["healAll"] = {
    name: "healAll",
    title: "DNDModel.HealAll",
    icon: "fa-solid fa-heart",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      for (const token of (canvas?.tokens?.controlled ?? [])) {
        const actor = token.actor;
        if (!actor) continue;
        const hpMax = (actor.system as unknown as { attributes?: { hp?: { max?: number } } }).attributes?.hp?.max ?? 0;
        // @ts-expect-error DND5E specific
        void actor.update({ "system.attributes.hp.value": hpMax });
      }
    }
  };

  controls["tokens"].tools["testDeathSave"] = {
    name: "testDeathSave",
    title: "DNDModel.TestDeathSave",
    icon: "fa-solid fa-skull",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      forSelectedTokens(async (_entity, _token, _scene) => {
        const actor = _token.actor;
        if (!actor) return;
        if (!isActorAtZeroHp(actor)) {
          ui.notifications?.warn(`${actor.name} is not at 0 HP`);
          return;
        }
        const result = await rollActorDeathSave(actor);
        const saves = getActorDeathSaves(actor);
        const status = result.dead ? "DEAD" : result.rolledNat20 ? "NAT 20, revived!" : result.stabilized ? "Stabilized" : "Still rolling";
        ui.notifications?.info(`${actor.name} death save: ${status} (${saves.success} successes, ${saves.failure} failures)`);
      });
    },
  };

  controls["tokens"].tools["testReaction"] = {
    name: "testReaction",
    title: "DNDModel.TestReaction",
    icon: "fa-solid fa-bell",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      forSelectedTokens(async (entity, token, scene) => {
        const action = new RandomMoveAction(entity);
        await action.act();
        const canFreeDisengage = token.actor?.items.some(i => i.name === "Nimble Escape") === true;
        if (!canFreeDisengage) {
          await reactionCheck(action, scene, entity, new Set<string>(), []);
        }
      });
    },
  }

  controls["tokens"].tools["testSmartAttack"] = {
    name: "testSmartAttack",
    title: "DNDModel.TestSmartAttack",
    icon: "fa-solid fa-crosshairs",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      forSelectedTokens(async (entity, _token, _scene) => {
        const attack = new SmartAttack(entity);
        attack.targets = 1;
        await attack.act();
        const weapon = attack.weapon ?? "nothing";
        const hitInfo = attack.events.length > 0
          ? attack.events.map(e => e.targets.map(t => `${t.name}: ${t.hit ? `hit for ${t.damageDealt}` : "miss"}`).join(", ")).join("; ")
          : "no targets in range";
        ui.notifications?.info(`${entity.name} smart attack with ${weapon}: ${hitInfo}`);
      });
    },
  }

  controls["tokens"].tools["testRL"] = {
    name: "testRL",
    title: "DNDModel.TestRL",
    icon: "fa-solid fa-robot",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: isGM && debugMode,
    onChange: () => {
      void (async () => {
        try {
          if (!isRLConnected()) {
            ui.notifications?.info("Connecting to RL server...");
            await connectRL();
          }

          const activeScene = game.scenes?.active;
          if (!activeScene) return;
          const controlled = canvas?.tokens?.controlled ?? [];
          if (controlled.length === 0) {
            ui.notifications?.warn("Select a token first");
            return;
          }

          const { actionIndex, validTargets } = await queryRL();
          const variantNames = ["approach+attack", "approach+dash", "still+attack", "flee+flee"];
          const variant = actionIndex % ACTIONS_PER_TARGET as ActionVariant;
          const toward = variant !== ActionVariant.FleeFlee;
          const moves = variant !== ActionVariant.StillAttack;
          const secondIsAttack = variant === ActionVariant.ApproachAttack || variant === ActionVariant.StillAttack;

          if (validTargets.length === 0) {
            ui.notifications?.info(`RL action: ${variantNames[variant]} but no valid targets (raw: ${actionIndex})`);
            return;
          }

          const targetIndex = Math.floor(actionIndex / ACTIONS_PER_TARGET) % validTargets.length;
          const targetToken = validTargets[targetIndex];
          if (!targetToken) return;
          ui.notifications?.info(`RL action: ${variantNames[variant]} -> ${targetToken.name} (raw: ${actionIndex})`);

          const tGrid = pixelToSnappedGrid(targetToken.x, targetToken.y, activeScene);
          if (!tGrid) return;

          // Execute the action on the selected token
          const tokenObj = controlled[0];
          if (!tokenObj) return;
          const token = tokenObj.document;
          const actor = token.actor;
          if (!actor) return;
          const entity = new Entity(token.name, token.id, actor.id, token.x, token.y, token.elevation, token.width, token.height, actor.system as unknown as CharacterData, actor.items.contents, actor.effects.map(e => (e as unknown as { toObject: () => Record<string, unknown> }).toObject()), token.disposition);

          await executeRLTurn(entity, token, activeScene, tGrid.x, tGrid.y, toward, moves, secondIsAttack, new Set<string>());
          sendReward(0, false);
        } catch (err: unknown) {
          console.error("RL test failed:", err);
          ui.notifications?.error("RL test failed");
        }
      })();
    }
  };
});

async function saveLog(log: Record<number, TurnLogEntry>, subfolder?: string): Promise<void> {
  const worldId = game.world?.id ?? "unknown_world";
  const baseDir = `worlds/${worldId}/logs`;
  const dir = subfolder ? `${baseDir}/${subfolder}` : baseDir;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `log-${timestamp}.json`;

  const payload = JSON.stringify(
    {
      version: payload_version,
      createdAt: new Date().toISOString(),
      world: worldId,
      log
    },
    null,
    2
  );

  try {
    await foundry.applications.apps.FilePicker.createDirectory("data", baseDir);
  } catch (_err: unknown) { /* already exists */ }
  try {
    await foundry.applications.apps.FilePicker.createDirectory("data", dir);
  } catch (_err: unknown) {
    // Directory already existing is expected behaviour, no need to print warning
  }

  const file = new File([payload], filename, { type: "application/json" });

  await foundry.applications.apps.FilePicker.upload("data", dir, file, {}, { "notify": false });
}

async function saveHumanTamerSessionLog(
  username: string,
  winner: HumanTamerWinner,
  startedAt: string,
  finishedAt: string,
  prompts: HumanTamerPromptLog[],
): Promise<void> {
  const worldId = game.world?.id ?? "unknown_world";
  const dir = `worlds/${worldId}/logs`;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeUser = username.trim().replace(/[^A-Za-z0-9._-]+/g, "_") || "unknown-user";
  const filename = `tamer-test-${safeUser}-${timestamp}.json`;

  const payload: HumanTamerSessionLog = {
    version: payload_version,
    createdAt: new Date().toISOString(),
    world: worldId,
    sessionType: "human-tamer-test",
    username,
    startedAt,
    finishedAt,
    winner,
    promptCount: prompts.length,
    prompts,
  };

  try {
    await foundry.applications.apps.FilePicker.createDirectory("data", dir);
  } catch (_err: unknown) {
    // Directory already existing is expected behavior.
  }

  const file = new File([JSON.stringify(payload, null, 2)], filename, { type: "application/json" });
  await foundry.applications.apps.FilePicker.upload("data", dir, file, {}, { "notify": false });
}

export function encodeState(entitites: Entity[]): string {
  const payload: EncodedState = {
    version: payload_version,
    round: game.combat?.round ?? -1,
    entities: entitites.map(e => e.toJSON())
  };

  return JSON.stringify(payload);
}

export function decodeState(encoded: string): { entities: Entity[] } {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload: EncodedState = JSON.parse(encoded);

  if (payload.version !== payload_version) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  if (payload.round !== -1) {
    if (game.combats?.viewed == null) {
      Combat.create({ scene: canvas?.scene?.id ?? game.scenes?.active?.id }).then(async combat => {
        if (!combat) {
          console.error("Error creating combat for decoded state: Combat creation failed");
          return;
        }
        void combat.startCombat();
        await combat.update({ round: payload.round });
      }).catch((err: unknown) => {
        console.error("Error creating combat for decoded state:", err);
      });
    } else {
      const combat = game.combats.viewed;
      void combat.startCombat();
      combat.update({ round: payload.round }).catch((err: unknown) => {
        console.error("Error updating combat round for decoded state:", err);
      });
    }
  }

  const entities = payload.entities.map(e => Entity.fromJSON(e));

  return { entities };
}


function encodeScene(activeScene: Scene): string | undefined {
  const grid = activeScene.grid;
  if (grid.type !== 1) {
    ui.notifications?.warn("DNDModel.SceneCalcGridTypeWarning");
    return undefined;
  }
  const entities = [];
  for (const token of activeScene.tokens) {
    if (token.actor == null) continue;
    entities.push(Entity.fromToken(token, cloneTokenLight(token)));
  }
  return encodeState(entities);
}

async function restoreSceneState(
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

async function restoreEntityState(token: TokenDocument, entity: Entity, includeGeometry: boolean): Promise<void> {
  const update: Record<string, unknown> = {
    light: entity.light ?? getDefaultTokenLight(),
    "flags.dnd-model.lightSpell": null,
    "flags.dnd-model.guidingBoltNextAttack": null,
  };
  if (includeGeometry) {
    update["elevation"] = entity.elevation;
    update["width"] = entity.width;
    update["height"] = entity.height;
  }
  await token.update(update, { animate: false });
  const actor = token.actor;
  if (!actor) return;
  await actor.update({ "system": entity.system });

  const savedById = new Map<string, Record<string, unknown>>();
  for (const itemData of entity.items) {
    const id = (itemData as unknown as { _id?: string })._id;
    if (id) savedById.set(id, itemData as unknown as Record<string, unknown>);
  }

  // Update existing items or delete ones not in the snapshot
  for (const item of actor.items) {
    const saved = savedById.get(item.id);
    if (saved) {
      await item.update(saved);
      savedById.delete(item.id);
    } else {
      await item.delete();
    }
  }

  // Create any items that weren't already on the actor
  for (const itemData of savedById.values()) {
    await actor.createEmbeddedDocuments("Item", [itemData as unknown as Item]);
  }

  const savedEffectsById = new Map<string, Record<string, unknown>>();
  for (const effectData of entity.effects) {
    const id = (effectData as { _id?: string })._id;
    if (id) savedEffectsById.set(id, effectData);
  }

  // Restore non-status ActiveEffects  
  const isStatusEffect = (id: string) => {
    const s = (actor.effects.get(id) as unknown as { statuses?: Set<string> }).statuses;
    return s && s.size > 0;
  };

  for (const effect of actor.effects) {
    if (isStatusEffect(effect.id)) continue;
    const saved = savedEffectsById.get(effect.id);
    if (saved) {
      await effect.update(saved);
      savedEffectsById.delete(effect.id);
    } else {
      await effect.delete();
    }
  }

  // Create any non-status effects that weren't already on the actor
  for (const effectData of savedEffectsById.values()) {
    if (isStatusEffect((effectData as { _id?: string })._id ?? "")) continue;
    // @ts-expect-error Foundry CreateData types are overly strict for restoring serialized effect data
    await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  }

  // Restore dnd5e status effects via the proper API
  const savedStatuses = new Set(entity.statuses);
  const currentStatuses = new Set<string>();
  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    const s = (effect as unknown as { statuses?: Set<string> }).statuses;
    if (s) for (const id of s) {
      if (effect.id === dnd5eStaticId(`dnd5e${id}`)) currentStatuses.add(id);
    }
  }
  const toRemove = [...currentStatuses].filter(s => !savedStatuses.has(s)).map(s => dnd5eStaticId(`dnd5e${s}`));
  if (toRemove.length > 0) {
    const existing = toRemove.filter(id => actor.effects.has(id));
    if (existing.length > 0) {
      await actor.deleteEmbeddedDocuments("ActiveEffect", existing);
    }
  }
  for (const status of savedStatuses) {
    if (!currentStatuses.has(status)) await setActorStatusEffect(actor, status, true);
  }
}

async function generateEntity(entity: Entity, scene: Scene) {
  // Existing token on scene - move it and restore state
  const existing = scene.tokens.get(entity.id ?? "");
  if (existing) {
    const snappedGrid = pixelToSnappedGrid(entity.x, entity.y, scene);
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
    const [token] = await scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
    if (token) await restoreEntityState(token, entity, false);
    return;
  }

  // Unknown actor - create a temporary one, spawn a token, then delete the temp
  const tempActor = await getDocumentClass("Actor").create({
    name: entity.name,
    // @ts-expect-error DND5e specific
    type: "character",
    system: entity.system,
  });
  if (!tempActor) return;
  const tokenData = await tempActor.getTokenDocument({
    x: entity.x, y: entity.y, elevation: entity.elevation,
    width: entity.width, height: entity.height, actorLink: false,
  });
  const [token] = await scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
  if (token?.actor) {
    for (const itemData of entity.items) await token.actor.createEmbeddedDocuments("Item", [itemData]);
  }
  await tempActor.delete();
}

// consolidate this eventually, this is lame
async function hasEnemyInMeleeRange(token: TokenDocument, scene: Scene): Promise<boolean> {
  const enemies = scene.tokens.filter(t => {
    if (t.id === token.id) return false;
    if (t.combatant?.defeated === true) return false;
    if (isActorAtZeroHp(t.actor ?? undefined)) return false;
    return t.disposition !== token.disposition;
  });
  if (enemies.length === 0) return false;

  const inMelee = await withRectRangeTemplate<TokenDocument[]>(scene, {
    x: token.x,
    y: token.y,
    width: token.width,
    height: token.height,
    elevation: token.elevation,
  }, 5, (templateObj) => {
    return getTokensInTemplate(templateObj, scene, enemies);
  });

  return (inMelee?.length ?? 0) > 0;
}

async function checkNearbyReactions(scene: Scene, entity: Entity, usedReaction: Set<string>): Promise<boolean> {
  for (const token of scene.tokens) {
    if (token.disposition === entity.disposition) continue;
    if (usedReaction.has(token.id)) continue;
    if (token.actor && isActorAtZeroHp(token.actor)) continue;
    const weapons = getEquippedWeaponsWithReach(token);
    // Deduplicate ranges so we only build positions once per unique reach value
    const reachValues = [...new Set(weapons.map(w => w.reach))];
    for (const reach of reachValues) {
      const rangePositions = await getPositionsInRange(token, reach, scene);
      // if any of the tokens positions (x + width, y + height) are in the rangePositions, then this is a valid possible reaction
      const entityRect = entityToGridRect(entity, scene);
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

async function reactionCheck(action: Action, activeScene: Scene, entity: Entity, usedReaction: Set<string>, turnEvents: AttackResult[]): Promise<void> {
  const movingToken = activeScene.tokens.get(entity.id || "");
  // Capture the final destination once before any teleporting
  const finalPos = movingToken ? { x: movingToken.x, y: movingToken.y } : null;
  for (const [tokenId, reaction] of Object.entries(action.triggeredReactions)) {
    // Skip if this token already used its reaction this round
    if (usedReaction.has(tokenId)) continue;
    const reactionToken = activeScene.tokens.get(tokenId);
    if (!reactionToken) continue;
    const reactionActor = reactionToken.actor;
    if (!reactionActor) continue;
    if (isActorAtZeroHp(reactionActor)) continue;
    if (reaction.eligibleWeapons.length === 0) continue;

    const reactionEntity = Entity.fromToken(reactionToken);
    const reAction = new RandomAttackOfOpportunity(reactionEntity, reaction.eligibleWeapons, entity.id ?? undefined);
    reAction.usedReaction = usedReaction;
    const selectedWeapon = await reAction.prepareSelectedWeapon();
    if (!selectedWeapon) continue;
    const selectedExitPos = reaction.weaponExitPositions[selectedWeapon];
    if (!selectedExitPos) continue;

    // Teleport the moving token back to where it was when it left range
    if (movingToken) {
      const exitPixel = gridToPixel(selectedExitPos.x, selectedExitPos.y, activeScene);
      if (exitPixel) {
        await movingToken.move({ x: exitPixel.x, y: exitPixel.y }, { animate: false, constrainOptions: { ignoreWalls: true, ignoreCost: true } });
      }
    }

    // Attack of opportunity with the selected eligible weapon
    await reAction.act();
    turnEvents.push(...reAction.events);
    usedReaction.add(tokenId);

    // If the moving token died, stop processing further reactions (stays where it died)
    if (movingToken) {
      const movingActor = movingToken.actor;
      if (movingActor && isActorAtZeroHp(movingActor)) break;
    }
  }

  // If the moving token survived all reactions, teleport it back to the final destination
  if (movingToken && finalPos) {
    const movingActor = movingToken.actor;
    if (movingActor && !isActorAtZeroHp(movingActor)) {
      await movingToken.move({ x: finalPos.x, y: finalPos.y }, { animate: false, constrainOptions: { ignoreWalls: true, ignoreCost: true } });
    }
  }
}

enum ActionVariant {
  ApproachAttack = 0,
  ApproachDash = 1,
  StillAttack = 2,
  FleeFlee = 3
}

async function executeRLTurn(
  entity: Entity,
  token: TokenDocument,
  activeScene: Scene,
  targetGridX: number,
  targetGridY: number,
  toward: boolean,
  moves: boolean,
  secondIsAttack: boolean,
  usedReaction: Set<string>,
  targetTokenId?: string,
): Promise<AttackResult[]> {
  const turnEvents: AttackResult[] = [];
  let disengaged = false;
  const canFreeDisengage = token.actor?.items.some(i => i.name === "Nimble Escape") === true;

  const moveAction = new DirectedMoveAction(entity, targetGridX, targetGridY, toward);
  moveAction.usedReaction = usedReaction;
  if (canFreeDisengage) {
    // Nimble Escape: disengage and move freely
    disengaged = true;
    if (moves) await moveAction.act();
  } else {
    const reactable = await checkNearbyReactions(activeScene, entity, usedReaction);
    if (!reactable || secondIsAttack) {
      if (moves) {
        const original_location = { x: entity.x, y: entity.y };
        await moveAction.act();
        if (Object.entries(moveAction.triggeredReactions).length > 0) {
          // Movement would trigger a reaction, cancel and disengage
          await token.move({ x: original_location.x, y: original_location.y }, { animate: false, constrainOptions: { ignoreWalls: true, ignoreCost: true } });
          disengaged = true;
        }
      }
    } else {
      disengaged = true;
    }
  }
  // Check for reaction on first move
  if (!disengaged) {
    await reactionCheck(moveAction, activeScene, entity, usedReaction, turnEvents);
  }

  // Check if reaction killed token, if so can't do second action
  const actor = token.actor;
  if (!actor || !isActorAtZeroHp(actor)) {
    let secondAction: Action;
    if (secondIsAttack) {
      const hasCastableSpell = actor ? getCastableSpellsForRandomAction(actor).length > 0 : false;
      const actingToken = activeScene.tokens.get(entity.id || "") ?? token;
      const enemyInMeleeRange = await hasEnemyInMeleeRange(actingToken, activeScene);
      if (hasCastableSpell && !enemyInMeleeRange) {
        secondAction = new RandomSpellAction(entity);
      } else {
        const chooseSpellAttack = hasCastableSpell && Math.random() < 0.5;
        if (chooseSpellAttack) {
          secondAction = new RandomSpellAction(entity);
        } else {
          const attack = new SmartAttack(entity);
          if (targetTokenId) attack.forcedTargetTokenIds = [targetTokenId];
          secondAction = attack;
        }
      }
    } else {
      secondAction = new DirectedMoveAction(entity, targetGridX, targetGridY, toward);
    }
    secondAction.usedReaction = usedReaction;
    await secondAction.act();
    turnEvents.push(...secondAction.events);
    if (!disengaged) {
      await reactionCheck(secondAction, activeScene, entity, usedReaction, turnEvents);
    }
  }

  return turnEvents;
}

async function getPositionsInRange(
  token: TokenDocument,
  rangeUnits: number,
  scene: Scene,
): Promise<{x: number, y: number}[]> {
  const cacheKey = getRangePositionsCacheKey(token, rangeUnits, scene);
  const cachedPositions = rangePositionsCache.get(cacheKey);
  if (cachedPositions) {
    return cachedPositions;
  }

  const highlighted = await withRectRangeTemplate<{x: number, y: number}[]>(scene, {
    x: token.x,
    y: token.y,
    width: token.width,
    height: token.height,
    elevation: token.elevation,
  }, rangeUnits, (templateObj) => {
    return getTemplateHighlightedGridPositions(templateObj, scene);
  });

  if (!highlighted) return [];

  const topLeft = pixelToGrid(token.x, token.y, scene);
  if (!topLeft) {
    setCachedRangePositions(cacheKey, highlighted);
    return highlighted;
  }

  const tokenWidth = token.width;
  const tokenHeight = token.height;
  const filtered = highlighted.filter(position => {
    return !(
      position.x >= topLeft.x &&
      position.x < topLeft.x + tokenWidth &&
      position.y >= topLeft.y &&
      position.y < topLeft.y + tokenHeight
    );
  });

  setCachedRangePositions(cacheKey, filtered);
  return filtered;
}

const RANGE_POSITIONS_CACHE_MAX_ENTRIES = 2000;
const rangePositionsCache = new Map<string, {x: number, y: number}[]>();

function getRangePositionsCacheKey(token: TokenDocument, rangeUnits: number, scene: Scene): string {
  return [
    scene.id,
    token.id,
    token.x,
    token.y,
    token.width,
    token.height,
    token.elevation,
    rangeUnits,
  ].join(":");
}

function setCachedRangePositions(cacheKey: string, positions: {x: number, y: number}[]): void {
  if (rangePositionsCache.size >= RANGE_POSITIONS_CACHE_MAX_ENTRIES) {
    rangePositionsCache.clear();
  }
  rangePositionsCache.set(cacheKey, positions);
}

// brace your eyes for incoming fuckshit. The spells are so cooked
// also there are just sOOOO many types. dnd5e types doesnt work anymore so like
// i have to make so many of these. why did I decide to use typescript
type ItemRange = { reach?: number | null; value?: number | null };
type Equippable = { equipped?: boolean };
type SpellSlotEntry = { value?: number };
type SpellSlots = Record<string, SpellSlotEntry | undefined>;
// This is because sometimes they give us a template, sometimes we make one
// and sometimes it just Does The Thing
type RandomSpellSupportProfile = "nativeTemplate" | "rangeTemplate" | "directUse";
type SpellEligibility = { ok: boolean; reason: string; profile?: RandomSpellSupportProfile };

type SpellTargetTemplate = { type?: string; units?: string; size?: number };
type SpellTargetAffects = { type?: string };
type SpellTargetData = {
  type?: string;
  value?: number | string;
  units?: string;
  template?: SpellTargetTemplate;
  affects?: SpellTargetAffects;
};

type SpellSystemData = {
  level?: number;
  method?: string;
  prepared?: number | boolean;
  range?: ItemRange & { units?: string; special?: string };
  target?: SpellTargetData;
  activation?: { type?: string };
};

type ActivityTargetLike = {
  affects?: { count?: number | string };
  template?: { count?: number | string };
};

type ItemWithUse = Item & {
  use?: (
    config?: Record<string, unknown>,
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
};


function isModuleActive(moduleId: string): boolean {
  const mod = game.modules?.get(moduleId);
  return mod?.active === true;
}

function getSpellLevel(item: Item): number {
  const data = item.system as unknown as SpellSystemData;
  return data.level ?? 0;
}

function getSpellRange(item: Item): number {
  const data = item.system as unknown as SpellSystemData;
  const units = data.range?.units;
  if (units === "self") return 0;
  if (units === "touch") return 5;
  return data.range?.value ?? 0;
}


function getSpellTarget(item: Item): SpellTargetData {
  return (item.system as unknown as SpellSystemData).target ?? {};
}

async function getSpellTargetCount(item: Item): Promise<number> {
  const parseCount = async (raw: unknown): Promise<number | null> => {
    if (typeof raw === "number" && raw > 0) return Math.max(1, Math.floor(raw));
    if (typeof raw !== "string") return null;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.max(1, Math.floor(parsed));
    try {
      const rollData = (item as unknown as { getRollData?: () => Record<string, unknown> }).getRollData?.() ?? {};
      const total = (await new Roll(raw, rollData).evaluate()).total;
      return (typeof total === "number" && total > 0) ? Math.max(1, Math.floor(total)) : null;
    } catch { return null; }
  };

  for (const activity of getItemActivities(item)) {
    const target = (activity as unknown as { target?: ActivityTargetLike }).target;
    const count = (await parseCount(target?.affects?.count)) ?? (await parseCount(target?.template?.count));
    if (count) return count;
  }
  return (await parseCount(getSpellTarget(item).value)) ?? 1;
}

function isTemplateSpell(item: Item): boolean {
  const target = getSpellTarget(item);
  const templateType = target.template?.type?.toLowerCase();
  if (templateType) return true;
  const targetType = target.type?.toLowerCase();
  if (!targetType) return false;
  return ["cone", "cube", "cylinder", "line", "sphere", "radius"].includes(targetType);
}

function isSingleTargetSpell(item: Item): boolean {
  const target = getSpellTarget(item);
  const targetType = target.type?.toLowerCase();
  if (!targetType) return true;
  if (["creature", "enemy", "ally"].includes(targetType)) return true;
  if (targetType === "self") return true;
  return false;
}

function shouldPreferAllies(item: Item): boolean {
  const name = item.name.toLowerCase();
  if (name.includes("heal") || name.includes("cure") || name.includes("bless")) return true;
  const activities = getItemActivities(item);
  return activities.some(a => a.type === "heal");
}

function canRepeatTargetSelection(item: Item, targetCount: number): boolean {
  if (targetCount <= 1) return false;
  const activities = getItemActivities(item);
  return activities.some(activity => {
    const target = (activity as unknown as {
      target?: { affects?: { choice?: boolean; type?: string } }
      type?: string;
    }).target;
    const activityType = (activity as unknown as { type?: string }).type;
    const affectsType = target?.affects?.type?.toLowerCase();
    const isCreatureTarget = affectsType === "creature" || affectsType === "enemy" || affectsType === "ally";
    const isRepeatFriendlyActivity = activityType === "attack" || activityType === "damage";
    return target?.affects?.choice === true || (isCreatureTarget && isRepeatFriendlyActivity);
  });
}

function allocateRepeatableSpellTargets(inRange: TokenDocument[], count: number): TokenDocument[] {
  if (count <= 0 || inRange.length === 0) return [];
  const shuffled = [...inRange].sort(() => Math.random() - 0.5);
  const result: TokenDocument[] = [];
  for (let i = 0; i < count; i++) {
    const token = shuffled[i % shuffled.length];
    if (token) result.push(token);
  }
  return result;
}

// idek man
function getRandomSpellSupportProfile(item: Item): RandomSpellSupportProfile | null {
  const activities = getItemActivities(item);
  const supportedTypes = ["attack", "save", "damage", "heal", "enchant", "cast", "utility"];
  if (activities.length === 0 || !activities.some(a => supportedTypes.includes(a.type))) return null;

  const hasNativeTemplate = activities.some(a =>
    !!(a as unknown as { target?: { template?: { type?: string } } }).target?.template?.type
  );
  if (isTemplateSpell(item) && hasNativeTemplate) return "nativeTemplate";

  if (activities.some(a => ["enchant", "cast", "utility"].includes(a.type))
    || ((item as unknown as { effects?: { size?: number } }).effects?.size ?? 0) > 0) {
    return "directUse";
  }

  const target = getSpellTarget(item);
  const targetType = target.type?.toLowerCase();
  if (!isTemplateSpell(item) && isSingleTargetSpell(item) && targetType !== "self" && getSpellRange(item) > 0) {
    return "rangeTemplate";
  }

  return null;
}

function canCastSpell(actor: Actor, spell: Item): boolean {
  const level = getSpellLevel(spell);
  const spellData = spell.system as unknown as SpellSystemData;
  const method = (spellData.method ?? "").toLowerCase();
  const preparedValue = spellData.prepared;
  const isPrepared = preparedValue === true || preparedValue === 1 || preparedValue === 2;

  if (method === "innate" || method === "atwill") return true;
  if (!isPrepared) return false;
  if (level === 0) return true;
  const spells = (actor.system as unknown as { spells?: SpellSlots }).spells;
  if (!spells) return false;
  const slot = spells[`spell${level}`];
  return (slot?.value ?? 0) > 0;
}

async function castShieldReaction(targetToken: TokenDocument, shieldSpell: Item): Promise<boolean> {
  const actor = targetToken.actor;
  if (!actor) return false;

  const useSpell = shieldSpell as ItemWithUse;
  if (typeof useSpell.use !== "function") return false;

  const oldTargets = game.user?.targets;
  const canvasRef = canvas;
  if (!canvasRef) return false;
  const tokensLayer = canvasRef.tokens as unknown as { setTargets?: (targets: unknown[]) => void };

  try {
    tokensLayer.setTargets?.([]);
    if (targetToken.object) {
      targetToken.object.setTarget(true, { releaseOthers: false });
    }

    const useConfig: Record<string, unknown> = {
      create: {
        measuredTemplate: false,
      },
      midiOptions: {
        autoRollDamage: "none",
        autoFastDamage: true,
      }
    };
    const dialogConfig: Record<string, unknown> = { configure: false };

    const useResult = await useSpell.use(useConfig, dialogConfig, {});
    return useResult !== false && useResult != null;
  } finally {
    tokensLayer.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
  }
}

// Only use it if it's good, but even then, only use it 50% of the time, because random agents are dumb
// Should they use it everytime? Like. Probably. But. Whatever
async function maybeUseShieldReaction(
  targetToken: TokenDocument,
  attackTotal: number,
  isCritical: boolean,
  usedReaction?: Set<string>
): Promise<boolean> {
  if (!targetToken.id || !targetToken.actor) return false;
  if (usedReaction?.has(targetToken.id)) return false;
  if (isCritical) return false;
  if (attackTotal >= (((targetToken.actor.system as unknown as { attributes?: { ac?: { value?: number } } }).attributes?.ac?.value) ?? 0) + 5) return false;
  if (Math.random() >= 0.5) return false;

  const shieldSpell = targetToken.actor.items.getName("Shield") ?? targetToken.actor.items.getName("shield");
  if (!shieldSpell) return false;
  if (!canCastSpell(targetToken.actor, shieldSpell)) return false;

  const cast = await castShieldReaction(targetToken, shieldSpell);
  if (!cast) return false;

  usedReaction?.add(targetToken.id);
  return true;
}

function evaluateSpellEligibilityForRandomAction(actor: Actor, spell: Item): SpellEligibility {
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

function getCastableSpellsForRandomAction(actor: Actor): Item[] {
  // @ts-expect-error DND types do not expose item.type discriminants yet
  const allSpells = (actor.items.filter(i => i.type === "spell") as Item[]);
  return allSpells
    .filter(spell => evaluateSpellEligibilityForRandomAction(actor, spell).ok)
    .sort((a, b) => getSpellLevel(a) - getSpellLevel(b));
}

type WeaponInfo = { name: string; reach: number };

type AmmunitionOption = { value: string; disabled?: boolean };

function getUsableAmmunitionIdOrNull(weapon: Item): string | undefined | null {
  const ammoOptions = (weapon.system as unknown as { ammunitionOptions?: unknown }).ammunitionOptions;
  if (!Array.isArray(ammoOptions) || ammoOptions.length === 0) return undefined;
  const usable = (ammoOptions as unknown[]).find((o): o is AmmunitionOption => {
    if (typeof o !== "object" || o === null) return false;
    const rec = o as Record<string, unknown>;
    const value = rec["value"];
    const disabled = rec["disabled"];
    return typeof value === "string" && value.length > 0 && disabled !== true;
  });
  return usable?.value ?? null;
}

function getEquippedWeaponsWithReach(token: TokenDocument): WeaponInfo[] {
  const actor = token.actor;
  if (!actor) return [];
  // @ts-expect-error DND types don't have item types yet
  const allWeapons = (actor.items.filter(i => i.type === "weapon") as Item[])
    .filter(i => (i.system as unknown as { attackType?: string }).attackType !== "ranged")
    .filter(i => ((i.system as unknown as { quantity?: number }).quantity ?? 1) > 0);
  const equipped = allWeapons.filter(i => (i.system as unknown as Equippable).equipped);
  if (equipped.length === 0) return [{ name: "Unarmed Strike", reach: 5 }];
  return equipped.map(w => {
    const range = (w.system as unknown as { range?: ItemRange }).range;
    return { name: w.name, reach: range?.reach ?? range?.value ?? 5 };
  });
}

function getMovementGridPositions(
  oldPos: { x: number; y: number },
  newPos: { x: number; y: number },
  scene: Scene
): { x: number; y: number }[] {
  const dx = newPos.x - oldPos.x;
  const dy = newPos.y - oldPos.y;
  const distancePx = Math.sqrt(dx * dx + dy * dy);
  if (distancePx === 0) return [];

  const grid = canvas?.grid;
  if (!grid) return [];

  const startOffset = grid.getOffset(oldPos);
  const endOffset = grid.getOffset(newPos);

  const pathOffsets = grid.getDirectPath([startOffset, endOffset]);

  const gridCells: { x: number; y: number }[] = [];
  const seen = new Set<string>();

  for (const offset of pathOffsets) {
    // Convert grid offset back to our grid coordinate system
    const topLeft = grid.getTopLeftPoint(offset);
    const gridPos = pixelToGrid(topLeft.x, topLeft.y, scene);
    if (!gridPos) continue;

    const key = `${gridPos.x},${gridPos.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      gridCells.push(gridPos);
    }
  }

  return gridCells;
}

type RangeZoneState = "None" | "Inside" | "Exited";
type WeaponRangeZone = {
  enemyTokenId: string;
  weaponName: string;
  reach: number;
  positions: {x: number, y: number}[];
  state: RangeZoneState;
  lastInsidePos?: {x: number, y: number};
}

function getRangeZoneIntersection(
  path: {x: number, y: number}[],
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

type GridRect = {
  x: number;
  y: number;
  width: number;
  height: number;
}

function gridRectsOverlap(a: GridRect, b: GridRect): boolean {
  return (a.x < b.x + b.width) && (a.x + a.width > b.x) && (a.y < b.y + b.height) && (a.y + a.height > b.y); 
}

function pixelToSnappedGrid(pixelX: number, pixelY: number, scene: Scene): { x: number; y: number } | undefined {
  const grid = scene.grid;
  if (grid.type !== 1) {
    ui.notifications?.warn("DNDModel.SceneCalcGridTypeWarning");
    return;
  }

  const width = Math.floor(scene.dimensions.sceneWidth / grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / grid.sizeY);
  const paddingX = scene.dimensions.sceneX;
  const paddingY = scene.dimensions.sceneY;

  const gridX = Math.round((pixelX - paddingX) / grid.sizeX);
  const gridY = Math.round((pixelY - paddingY) / grid.sizeY);

  if (gridX >= 0 && gridX < width && gridY >= 0 && gridY < height) {
    return { x: gridX, y: gridY };
  }

  return;
}

function tokenToGridRect(token: TokenDocument, scene: Scene): GridRect | null {
  const grid = canvas?.grid;
  const currentCanvasScene = canvas?.scene ?? null;
  let topLeft: { x: number; y: number } | undefined;

  if (grid && currentCanvasScene && currentCanvasScene.id === scene.id) {
    const offset = grid.getOffset({ x: token.x, y: token.y });
    const canonicalTopLeft = grid.getTopLeftPoint(offset);
    topLeft = pixelToGrid(canonicalTopLeft.x, canonicalTopLeft.y, scene);
  } else {
    topLeft = pixelToSnappedGrid(token.x, token.y, scene);
  }

  if (!topLeft) return null;
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(1, Math.ceil(token.width)),
    height: Math.max(1, Math.ceil(token.height))
  };
}

function entityToGridRect(entity: Entity, scene: Scene): GridRect | null {
  const grid = canvas?.grid;
  if (!grid) return null;
  const topLeft = pixelToSnappedGrid(entity.x, entity.y, scene);
  if (!topLeft) return null;
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(1, Math.ceil(entity.width)),
    height: Math.max(1, Math.ceil(entity.height))
  };
}

function isActorAtZeroHp(actor: Actor | null | undefined): boolean {
  const hp = (actor?.system as unknown as { attributes?: { hp?: { value?: number } } })
    .attributes?.hp?.value;
  return typeof hp === "number" && hp <= 0;
}

function getActorDeathSaves(actor: Actor): { success: number; failure: number } {
  const death = (actor.system as unknown as { attributes?: { death?: { success?: number; failure?: number } } }).attributes?.death;
  return { success: death?.success ?? 0, failure: death?.failure ?? 0 };
}

async function rollActorDeathSave(actor: Actor): Promise<{ rolledNat20: boolean; dead: boolean; stabilized: boolean }> {
  const roller = actor as unknown as {
    rollDeathSave?: (
      config: Record<string, unknown>,
      dialog: Record<string, unknown>,
      message?: Record<string, unknown>
    ) => Promise<unknown[] | null>;
  };
  if (typeof roller.rollDeathSave !== "function") {
    return { rolledNat20: false, dead: false, stabilized: false };
  }
  const rolls = await roller.rollDeathSave({}, { configure: false }, { data: { speaker: ChatMessage.getSpeaker({ actor }) } });
  const roll = (rolls ?? [])[0] as { isCritical?: boolean } | undefined;
  const rolledNat20 = roll?.isCritical === true;
  const saves = getActorDeathSaves(actor);
  return { rolledNat20, dead: saves.failure >= 3, stabilized: saves.success >= 3 || rolledNat20 };
}

function destinationIsOccupied(scene: Scene, dest: GridRect, movingTokenId: string): boolean {
  for (const token of scene.tokens) {
    if (token.id === movingTokenId) continue;
    if (isActorAtZeroHp(token.actor ?? undefined)) continue;
    const tokenRect = tokenToGridRect(token, scene);
    if (!tokenRect) continue;
    if (gridRectsOverlap(dest, tokenRect)) {
      return true;
    }
  }
  return false;
}

function getTokenPixelRect(token: TokenDocument, scene: Scene): GridRect {
  return {
    x: token.x,
    y: token.y,
    width: Math.max(1, Math.ceil(token.width)) * scene.grid.sizeX,
    height: Math.max(1, Math.ceil(token.height)) * scene.grid.sizeY,
  };
}

function tokenOverlapsToken(scene: Scene, movingToken: TokenDocument): boolean {
  const moverRect = getTokenPixelRect(movingToken, scene);
  for (const token of scene.tokens) {
    if (token.id === movingToken.id) continue;
    if (isActorAtZeroHp(token.actor ?? undefined)) continue;
    const tokenRect = getTokenPixelRect(token, scene);
    if (gridRectsOverlap(moverRect, tokenRect)) {
      return true;
    }
  }
  return false;
}

type TriggeredReaction = {
  weaponExitPositions: Record<string, {x: number, y: number}>;
  eligibleWeapons: string[];
}

class Action {
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

class MoveAction extends Action {
  targetX: number;
  targetY: number;
  protected pathValidated = false;
  protected pathPixelWaypoints: {x: number; y: number}[] = [];

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
    const movementSpeed = (this.entity.system as unknown as { attributes?: { movement?: { speed?: number } } }).attributes?.movement?.speed ?? 30;
    const effectiveSpeed = isProne ? Math.floor(movementSpeed / 2) : movementSpeed;

    const destRect: GridRect = { x: cappedTargetX, y: cappedTargetY, width: tokenGridWidth, height: tokenGridHeight };
    if (destinationIsOccupied(activeScene, destRect, this.entity.id || "")) return;

    // Build movement path through waypoints for accurate cost measurement
    const movementPoints: {x: number; y: number}[] = [{ x: entityToken.x, y: entityToken.y }];
    for (const wp of this.pathPixelWaypoints) {
      movementPoints.push(wp);
    }
    movementPoints.push({ x: pixelPos.x, y: pixelPos.y });

    /* eslint-disable */
    // @ts-expect-error createTerrainMovementPath does exist in V13
    const cost = tokenObject.measureMovementPath(tokenObject.createTerrainMovementPath(movementPoints, { "preview": false })).cost;
    /* eslint-enable */
    // ESLint is disabled because we don't have full V13 support yet. Also I'm doing typescript crimes because I'm evil
    if (cost > effectiveSpeed) {
      return;
    }

    const old_pos = { x: entityToken.x, y: entityToken.y };

    // NOTE: We are ignoring walls here because there is some
    // slight differences in routinglib and fvtt
    // THIS IS NOT GOOD LONG TERM
    // We might sometimes make illegal moves that routinglib thinks are okay
    // longterm we should probably bake our own A* instead of relying on routinglib
    const moveWaypoints = [
      ...this.pathPixelWaypoints.map(wp => ({ x: wp.x, y: wp.y, snapped: true })),
      { x: pixelPos.x, y: pixelPos.y, snapped: true },
    ];
    if (this.pathValidated) {
      await entityToken.move(moveWaypoints, { animate: false, constrainOptions: { ignoreWalls: true, ignoreCost: false } });
    } else {
      await entityToken.move(moveWaypoints, { animate: false });
    }

    const actualGridPos = pixelToSnappedGrid(entityToken.x, entityToken.y, activeScene);
    const reachedTargetGrid =
      actualGridPos != null &&
      actualGridPos.x === cappedTargetX &&
      actualGridPos.y === cappedTargetY;

    if (!reachedTargetGrid && !this.pathValidated) {
      await entityToken.update({ x: old_pos.x, y: old_pos.y }, { animate: false });
      return;
    }

    if (Math.abs(entityToken.x - pixelPos.x) > 0.1 || Math.abs(entityToken.y - pixelPos.y) > 0.1) {
      await entityToken.update({ x: pixelPos.x, y: pixelPos.y }, { animate: false });
    }

    // we could probably make this less hacked in but whatever idk how lol
    if (isProne) {
      await tryStandFromProne(entityToken.actor);
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
      if (token.actor && isActorAtZeroHp(token.actor)) continue;
      const weapons = getEquippedWeaponsWithReach(token);
      // Deduplicate ranges so we only build positions once per unique reach value
      const reachValues = [...new Set(weapons.map(w => w.reach))];
      // for each unique reach, check if the mover exited that specific reach band
      const exitedReachPositions = new Map<number, {x: number, y: number}>();
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

        const weaponExitPositions = weapons.reduce<Record<string, {x: number, y: number}>>((acc, weapon) => {
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

async function getRandomPrevalidatedDestination(
  moverToken: TokenDocument,
  scene: Scene,
  movementUnits: number
): Promise<{ x: number; y: number } | null> {
  const currentPos = pixelToSnappedGrid(moverToken.x, moverToken.y, scene);
  if (!currentPos) return null;

  const tokenGridWidth = Math.max(1, Math.ceil(moverToken.width));
  const tokenGridHeight = Math.max(1, Math.ceil(moverToken.height));

  const width = Math.floor(scene.dimensions.sceneWidth / scene.grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / scene.grid.sizeY);
  const maxTargetX = Math.max(0, width - tokenGridWidth);
  const maxTargetY = Math.max(0, height - tokenGridHeight);

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

  // Pick a random candidate, but verify it's reachable through walls.
  // Retry a few times if not; give up and use unvalidated pick after max attempts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  const routinglib = (globalThis as any).routinglib as RoutinglibAPI | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const useRL = routinglib && game.modules?.get("routinglib")?.active;
  const maxAttempts = useRL ? Math.min(candidates.length, 5) : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const randomIndex = Math.floor(Math.random() * candidates.length);
    const pick = candidates[randomIndex];
    if (!pick) continue;
    if (!useRL) return pick;
    const px = gridToPixel(pick.x, pick.y, scene);
    if (!px) continue;
    const fromRL = routinglib.pixelToGrid(moverToken.x, moverToken.y);
    const toRL = routinglib.pixelToGrid(px.x, px.y);
    try {
      const result = await routinglib.calculatePath(fromRL, toRL, { interpolate: false });
      if (result) return pick;
    } catch {
      // routinglib crash, try another candidate
    }
    // Remove failed candidate so we don't retry it
    candidates.splice(randomIndex, 1);
    if (candidates.length === 0) return null;
  }

  // Fallback: return a random unvalidated candidate
  const randomIndex = Math.floor(Math.random() * candidates.length);
  return candidates[randomIndex] ?? null;
}

class RandomMoveAction extends MoveAction {
  private needsPrevalidation = true;

  constructor(entity: Entity) {
    super(entity, 0, 0);
  }

  override async act() {
    if (this.needsPrevalidation) {
      const activeScene = (canvas?.scene ?? game.scenes?.active) as Scene;
      const moverToken = activeScene.tokens.get(this.entity.id || "");
      const sourceX = moverToken?.x ?? this.entity.x;
      const sourceY = moverToken?.y ?? this.entity.y;
      const baseGridPos =
        pixelToSnappedGrid(sourceX, sourceY, activeScene)
        ?? pixelToGrid(sourceX, sourceY, activeScene)
        ?? { x: 0, y: 0 };
      const movement_speed =
        (this.entity.system as unknown as { attributes?: { movement?: { speed?: number } } })
          .attributes?.movement?.speed ?? 30;
      const gridDistance = activeScene.grid.distance;
      const movement_units = Math.floor(movement_speed / gridDistance);
      const prevalidated = moverToken
        ? await getRandomPrevalidatedDestination(moverToken, activeScene, movement_units)
        : null;
      this.targetX = prevalidated
        ? prevalidated.x
        : Math.round(baseGridPos.x + (Math.random() * 2 - 1) * movement_units);
      this.targetY = prevalidated
        ? prevalidated.y
        : Math.round(baseGridPos.y + (Math.random() * 2 - 1) * movement_units);
    }
    await super.act();
  }
}

class DirectedMoveAction extends MoveAction {
  private toward: boolean = false;
  private directedTargetGridX!: number;
  private directedTargetGridY!: number;

  constructor(entity: Entity, targetGridX: number, targetGridY: number, toward: boolean = true, _directedTargetGridX: number = 0, _directedTargetGridY: number = 0) {
    const activeScene = game.scenes?.active;
    if (!activeScene) { super(entity, 0, 0); toward = true; return; }

    const movement_speed =
      (entity.system as unknown as { attributes?: { movement?: { speed?: number } } })
        .attributes?.movement?.speed ?? 30;
    const gridDistance = activeScene.grid.distance;
    const movement_units = Math.floor(movement_speed / gridDistance);

    const moverToken = activeScene.tokens.get(entity.id || "");
    const sourceX = moverToken?.x ?? entity.x;
    const sourceY = moverToken?.y ?? entity.y;
    const currentGrid = pixelToSnappedGrid(sourceX, sourceY, activeScene);
    if (!currentGrid) { super(entity, 0, 0); toward = true; return; }

    const cg = currentGrid;
    let dx = targetGridX - cg.x;
    let dy = targetGridY - cg.y;
    if (!toward) { dx = -dx; dy = -dy; }

    const dist = Math.max(Math.abs(dx), Math.abs(dy)); // chebyshev
    let moveX: number;
    let moveY: number;

    if (dist === 0) {
      moveX = cg.x;
      moveY = cg.y;
    } else if (toward && dist <= movement_units) {
      if (dist <= 1) {
        moveX = cg.x;
        moveY = cg.y;
      } else {
        const scale = (dist - 1) / dist;
        moveX = Math.round(cg.x + dx * scale);
        moveY = Math.round(cg.y + dy * scale);
      }
    } else {
      const scale = movement_units / dist;
      const width = Math.floor(activeScene.dimensions.sceneWidth / activeScene.grid.sizeX);
      const height = Math.floor(activeScene.dimensions.sceneHeight / activeScene.grid.sizeY);
      moveX = Math.max(0, Math.min(width - 1, Math.round(cg.x + dx * scale)));
      moveY = Math.max(0, Math.min(height - 1, Math.round(cg.y + dy * scale)));
    }

    super(entity, moveX, moveY);
    this.toward = toward;
    this.directedTargetGridX = targetGridX;
    this.directedTargetGridY = targetGridY;
    console.log(`DirectedMove constructor: ${entity.name} at (${cg.x},${cg.y}) -> target (${targetGridX},${targetGridY}) toward=${toward} -> computed (${moveX},${moveY})`);
  }

  override async act() {
    const activeScene = game.scenes?.active;
    if (!activeScene || !game.modules) { await super.act(); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const routinglib = (globalThis as any).routinglib as RoutinglibAPI | undefined;
    const useRoutinglib = routinglib && game.modules.get("routinglib")?.active;

    if (useRoutinglib) {
      const moverToken = activeScene.tokens.get(this.entity.id || "");
      if (!moverToken) { await super.act(); return; }

      const fromGrid = pixelToSnappedGrid(moverToken.x, moverToken.y, activeScene);
      if (!fromGrid) { await super.act(); return; }

      const movement_speed =
        (this.entity.system as unknown as { attributes?: { movement?: { speed?: number } } })
          .attributes?.movement?.speed ?? 30;
      const gridDistance = activeScene.grid.distance;
      const movement_units = Math.floor(movement_speed / gridDistance);

      const fromRL = routinglib.pixelToGrid(moverToken.x, moverToken.y);

      let pathTargetRL: { x: number; y: number };
      if (this.toward) {
        const targetPixel = gridToPixel(this.directedTargetGridX, this.directedTargetGridY, activeScene);
        if (!targetPixel) { await super.act(); return; }
        pathTargetRL = routinglib.pixelToGrid(targetPixel.x, targetPixel.y);
      } else {
        // for fleeing, go opposite
        const dx = fromGrid.x - this.directedTargetGridX;
        const dy = fromGrid.y - this.directedTargetGridY;
        const mag = Math.max(Math.abs(dx), Math.abs(dy));
        if (mag === 0) { await super.act(); return; }
        const scale = (movement_units * 2) / mag;
        const width = Math.floor(activeScene.dimensions.sceneWidth / activeScene.grid.sizeX);
        const height = Math.floor(activeScene.dimensions.sceneHeight / activeScene.grid.sizeY);
        const fleeGridX = Math.max(0, Math.min(width - 1, Math.round(fromGrid.x + dx * scale)));
        const fleeGridY = Math.max(0, Math.min(height - 1, Math.round(fromGrid.y + dy * scale)));
        const fleePixel = gridToPixel(fleeGridX, fleeGridY, activeScene);
        if (!fleePixel) { await super.act(); return; }
        pathTargetRL = routinglib.pixelToGrid(fleePixel.x, fleePixel.y);
      }

      console.log(`DirectedMove act: routinglib from RL(${fromRL.x},${fromRL.y}) to RL(${pathTargetRL.x},${pathTargetRL.y})`);
      let result;
      try {
        result = await routinglib.calculatePath(fromRL, pathTargetRL, { interpolate: false });
      } catch {
        console.warn(`DirectedMove act: routinglib crashed for path (${fromRL.x},${fromRL.y}) to (${pathTargetRL.x},${pathTargetRL.y}), falling back`);
        result = null;
      }
      if (result && result.path.length > 0) {
        console.log(`DirectedMove act: routinglib path has ${result.path.length} cells, cost=${result.cost}`);

        // Convert routinglib grid cells to our grid coords
        const grid = canvas?.grid;
        const allCells: { x: number; y: number }[] = [];
        const allPixels: { x: number; y: number }[] = [];
        for (const rlCell of result.path) {
          const px = routinglib.gridToPixel(rlCell.x, rlCell.y);
          const topLeft = grid ? grid.getTopLeftPoint(grid.getOffset(px)) : px;
          const gridPos = pixelToGrid(topLeft.x, topLeft.y, activeScene);
          if (!gridPos) continue;
          const last = allCells[allCells.length - 1];
          if (last && last.x === gridPos.x && last.y === gridPos.y) continue;
          allCells.push(gridPos);
          allPixels.push({ x: topLeft.x, y: topLeft.y });
        }

        const tokenObject = moverToken.object;
        const tokenGridWidth = Math.max(1, Math.ceil(moverToken.width));
        const tokenGridHeight = Math.max(1, Math.ceil(moverToken.height));
        let bestIdx = 0;
        if (tokenObject) {
          for (let ci = 0; ci < allCells.length; ci++) {
            const cell = allCells[ci];
            if (!cell) break;
            if (this.toward && cell.x === this.directedTargetGridX && cell.y === this.directedTargetGridY) {
              break;
            }
            const destRect: GridRect = { x: cell.x, y: cell.y, width: tokenGridWidth, height: tokenGridHeight };
            if (destinationIsOccupied(activeScene, destRect, this.entity.id || "")) {
              continue;
            }
            const cellPixel = allPixels[ci];
            if (!cellPixel) break;

            // Measure cost along the actual path cells up to this point
            const costPoints: {x: number; y: number}[] = [{ x: moverToken.x, y: moverToken.y }];
            for (let p = 1; p <= ci; p++) {
              const pp = allPixels[p];
              if (pp) costPoints.push(pp);
            }

            /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
            const cost = (tokenObject as any).measureMovementPath(
              (tokenObject as any).createTerrainMovementPath(costPoints, { preview: false })
            ).cost as number;
            /* eslint-enable */
            if (cost <= movement_speed) {
              bestIdx = ci;
            } else {
              break;
            }
          }
        }

        const bestCell = allCells[bestIdx] ?? fromGrid;
        // Collect all intermediate pixel waypoints along the path up to bestCell
        const usedWaypoints: {x: number; y: number}[] = [];
        for (let p = 1; p < bestIdx; p++) {
          const pp = allPixels[p];
          if (pp) usedWaypoints.push(pp);
        }

        console.log(`DirectedMove act: bestCell=(${bestCell.x},${bestCell.y}), path waypoints=${usedWaypoints.length}`);
        this.targetX = bestCell.x;
        this.targetY = bestCell.y;
        this.pathPixelWaypoints = usedWaypoints;
        this.pathValidated = true;
      } else {
        console.log(`DirectedMove act: routinglib returned ${result ? 'empty path' : 'null'}, using constructor fallback (${this.targetX},${this.targetY})`);
      }
      // If routinglib fails, we fall through to the straight-line target from the constructor
    }

    await super.act();
  }
}

// Behold: the most fucked up class in the code
// Idk its not like that bad but everything is so jumbled together after like
// getting 1000 things to work.
// Needs a FULL refactor at some point
class SpellAction extends Action {
  spellName: string | undefined;
  spellLevel: number | undefined;

  private isHealingSpell(spell: Item): boolean {
    const spellName = spell.name.trim().toLowerCase();
    if (spellName.includes("heal") || spellName.includes("cure")) return true;
    return getItemActivities(spell).some(activity => activity.type === "heal");
  }

  private actorNeedsHealing(actor: Actor): boolean {
    const hp = (actor.system as unknown as {
      attributes?: { hp?: { value?: number; max?: number } };
    }).attributes?.hp;
    const current = hp?.value;
    const max = hp?.max;
    if (typeof current !== "number" || typeof max !== "number") return false;
    return current < max;
  }

  private hasMatchingSpellEffect(actor: Actor, spell: Item): boolean {
    const spellName = spell.name.trim().toLowerCase();
    const spellUuid = spell.uuid;
    for (const effect of actor.effects) {
      if (effect.disabled) continue;
      const origin = (effect as unknown as { origin?: string }).origin ?? "";
      const effectLabel = ((effect as unknown as { name?: string; label?: string }).name
        ?? (effect as unknown as { label?: string }).label
        ?? "").trim().toLowerCase();
      if (origin === spellUuid || origin.includes(spellUuid)) return true;
      if (effectLabel.length > 0 && effectLabel === spellName) return true;
    }
    return false;
  }

  private isWearingArmor(actor: Actor): boolean {
    const dndAc = (actor.system as unknown as {
      attributes?: { ac?: { equippedArmor?: unknown } };
    }).attributes?.ac;
    return Boolean(dndAc?.equippedArmor);
  }

  private isValidDirectUseBuffTarget(token: TokenDocument, spell: Item): boolean {
    const actor = token.actor;
    if (!actor) return false;

    if (this.isHealingSpell(spell) && !this.actorNeedsHealing(actor)) return false;

    const spellName = spell.name.trim().toLowerCase();
    const canRetargetExistingEffect = isConcentrationSpell(spell);
    if (!canRetargetExistingEffect && this.hasMatchingSpellEffect(actor, spell)) return false;

    if (spellName.includes("mage armor") && this.isWearingArmor(actor)) return false;

    return true;
  }

  private isSleepSpell(spell: Item): boolean {
    return spell.name.trim().toLowerCase() === "sleep";
  }

  private isGuidingBoltSpell(spell: Item): boolean {
    return spell.name.trim().toLowerCase() === "guiding bolt";
  }

  private async applyGuidingBoltEffect(
    spell: Item,
    caster: Actor,
    selectedTargets: TokenDocument[],
    damageApplied: Map<string, number>
  ): Promise<void> {
    const expiry = getGuidingBoltExpiryForActor(caster.id);
    const affected: string[] = [];

    for (const target of selectedTargets) {
      if (!target.id) continue;
      if (target.disposition === this.entity.disposition) continue;
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
      affected.push(target.id);
    }

  }

  private getSavedTokenIdsFromWorkflow(activity: unknown): Set<string> {
    const saved = new Set<string>();
    if (typeof activity !== "object" || activity === null) return saved;

    const workflow = (activity as Record<string, unknown>)["workflow"];
    if (typeof workflow !== "object" || workflow === null) return saved;

    const saves = (workflow as Record<string, unknown>)["saves"];
    if (!(saves instanceof Set)) return saved;

    for (const token of saves) {
      const id = (token as Record<string, unknown>)["id"];
      if (typeof id === "string") saved.add(id);
    }
    return saved;
  }

  private getAttackHitTokenIdsFromWorkflow(activity: unknown): { known: boolean; ids: Set<string> } {
    const hitIds = new Set<string>();
    if (typeof activity !== "object" || activity === null) return { known: false, ids: hitIds };

    const workflow = (activity as Record<string, unknown>)["workflow"];
    if (typeof workflow !== "object" || workflow === null) return { known: false, ids: hitIds };

    const hitTargets = (workflow as Record<string, unknown>)["hitTargets"];
    if (!(hitTargets instanceof Set)) return { known: false, ids: hitIds };

    for (const token of hitTargets) {
      const id = (token as Record<string, unknown>)["id"];
      if (typeof id === "string") hitIds.add(id);
    }
    return { known: true, ids: hitIds };
  }

  // I don't know why I added this
  // Like, okay, i DO know why, in a dark cave, this means a token can see more things
  // Currently, it does nothing, because we're not restricted to sight yet
  // but it WILL....
  private async applyLightCantripEffect(spell: Item, caster: Actor, selectedTargets: TokenDocument[], activity: unknown): Promise<Set<string>> {
    await this.clearPreviousLightTargets(caster);

    const savedTokenIds = this.getSavedTokenIdsFromWorkflow(activity);
    const applied = new Set<string>();

    for (const target of selectedTargets) {
      if (!target.id || !target.actor) continue;

      let resisted = false;
      const isHostileTarget = target.disposition !== this.entity.disposition;
      if (isHostileTarget) resisted = savedTokenIds.has(target.id);

      if (resisted) continue;

      const previousLight = cloneTokenLight(target);
      const lightUpdate = {
        "light.bright": 20,
        "light.dim": 40,
        "light.angle": 360,
        "light.alpha": 0.5,
        "flags.dnd-model.lightSpell": {
          sourceActorId: caster.id,
          previousLight,
        },
      } as unknown as Record<string, unknown>;
      await target.update(lightUpdate);
      applied.add(target.id);
    }

    return applied;
  }

  private async clearPreviousLightTargets(caster: Actor): Promise<void> {
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

  private isUndeadActor(actor: Actor): boolean {
    const details = (actor.system as unknown as {
      details?: { type?: string | { value?: string; subtype?: string; custom?: string } };
    }).details;
    const type = details?.type;
    if (typeof type === "string") return type.toLowerCase().includes("undead");

    const value = (type?.value ?? "").toLowerCase();
    const subtype = (type?.subtype ?? "").toLowerCase();
    const custom = (type?.custom ?? "").toLowerCase();
    return value.includes("undead") || subtype.includes("undead") || custom.includes("undead");
  }

  private hasConditionImmunity(actor: Actor, conditionId: string): boolean {
    const ci = (actor.system as unknown as {
      traits?: { ci?: { value?: Set<string> | string[] } };
    }).traits?.ci?.value;

    if (ci instanceof Set) return ci.has(conditionId);
    if (Array.isArray(ci)) return ci.includes(conditionId);
    return false;
  }

  private async rollSleepHpPool(spell: Item): Promise<number> {
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

  private async applySleepEffect(spell: Item, selectedTargets: TokenDocument[]): Promise<Set<string>> {
    const candidates = selectedTargets
      .filter(t => !!t.actor)
      .filter(t => t.disposition !== this.entity.disposition)
      .filter(t => !isActorAtZeroHp(t.actor || undefined))
      .filter(t => !isActorUnconscious(t.actor as Actor))
      .filter(t => !this.isUndeadActor(t.actor as Actor))
      .filter(t => !this.hasConditionImmunity(t.actor as Actor, "charmed"));

    const hpValue = (actor: Actor | null | undefined): number => {
      return (actor?.system as unknown as { attributes?: { hp?: { value?: number } } })
        .attributes?.hp?.value ?? Number.POSITIVE_INFINITY;
    };

    candidates.sort((a, b) => hpValue(a.actor) - hpValue(b.actor));

    let remainingPool = await this.rollSleepHpPool(spell);
    const affected = new Set<string>();

    for (const token of candidates) {
      const actor = token.actor;
      if (!actor || !token.id) continue;

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

  // There are so many of these functions. They should be consolidated into like one big function
  private async getTargetsForDirectUseSpell(spell: Item): Promise<TokenDocument[]> {
    if (!canvas?.scene) return [];
    const scene = canvas.scene;

    const spellRangeUnits = ((spell.system as unknown as SpellSystemData).range?.units ?? "").toLowerCase();
    if (spellRangeUnits === "self") {
      const casterToken = scene.tokens.get(this.entity.id ?? "");
      if (casterToken && this.isValidDirectUseBuffTarget(casterToken, spell)) return [casterToken];
      return [];
    }

    const allies = scene.tokens.filter(t => {
      if (t.id === this.entity.id) return false;
      if (t.combatant?.defeated === true) return false;
      if (isActorAtZeroHp(t.actor ?? undefined)) return false;
      if (t.disposition !== this.entity.disposition) return false;
      return this.isValidDirectUseBuffTarget(t, spell);
    });
    if (allies.length === 0) return [];

    const range = Math.max(5, getSpellRange(spell));
    const inRange = await withRangeTemplate<TokenDocument[]>(scene, {
      x: this.entity.x,
      y: this.entity.y,
      width: this.entity.width,
      height: this.entity.height,
      elevation: this.entity.elevation,
    }, range, (templateObj) => {
      return getTokensInTemplate(templateObj, scene, allies);
    }, spell, true);

    return inRange ?? [];
  }

  private async getTargetsForRangeSpell(spell: Item): Promise<TokenDocument[]> {
    if (!canvas?.scene) return [];
    const scene = canvas.scene;

    const valid = this.getValidSpellTargets(scene, spell);
    if (valid.length === 0) return [];

    const range = Math.max(5, getSpellRange(spell));
    const inRange = await withRangeTemplate<TokenDocument[]>(scene, {
      x: this.entity.x,
      y: this.entity.y,
      width: this.entity.width,
      height: this.entity.height,
      elevation: this.entity.elevation,
    }, range, (templateObj) => {
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

  private getValidSpellTargets(scene: Scene, spell: Item): TokenDocument[] {
    const prefersAllies = shouldPreferAllies(spell);
    const requiresInjuredTarget = this.isHealingSpell(spell);
    return scene.tokens.filter(t => {
      if (t.id === this.entity.id) return false;
      if (t.combatant?.defeated === true) return false;
      if (isActorAtZeroHp(t.actor ?? undefined)) return false;
      if (requiresInjuredTarget && t.actor && !this.actorNeedsHealing(t.actor)) return false;
      return prefersAllies ? t.disposition === this.entity.disposition : t.disposition !== this.entity.disposition;
    });
  }

  private getAutoPlaceTemplateActivity(spell: Item): Activity | undefined {
    const activities = getItemActivities(spell);
    return activities.find(a => {
      const t = a.target?.template?.type?.toLowerCase();
      return !!t;
    });
  }

  private chooseEdgeOrCornerAnchorForTarget(
    caster: TokenDocument,
    target: TokenDocument,
    scene: Scene
  ): { x: number; y: number; direction: number } {
    const w = Math.max(1, Math.ceil(caster.width)) * scene.grid.sizeX;
    const h = Math.max(1, Math.ceil(caster.height)) * scene.grid.sizeY;
    const left = caster.x;
    const top = caster.y;
    const right = left + w;
    const bottom = top + h;

    const candidates = [
      { x: left + (w / 2), y: top, direction: 270 },
      { x: right, y: top + (h / 2), direction: 0 },
      { x: left + (w / 2), y: bottom, direction: 90 },
      { x: left, y: top + (h / 2), direction: 180 },
      { x: left, y: top, direction: 225 },
      { x: right, y: top, direction: 315 },
      { x: right, y: bottom, direction: 45 },
      { x: left, y: bottom, direction: 135 },
    ];

    const targetCenterX = target.x + (Math.max(1, Math.ceil(target.width)) * scene.grid.sizeX) / 2;
    const targetCenterY = target.y + (Math.max(1, Math.ceil(target.height)) * scene.grid.sizeY) / 2;

    const angleToTarget = (fromX: number, fromY: number) => {
      const dx = targetCenterX - fromX;
      const dy = targetCenterY - fromY;
      const deg = Math.toDegrees(Math.atan2(dy, dx));
      return (deg + 360) % 360;
    };
    const angleDiff = (a: number, b: number) => {
      const diff = Math.abs(a - b) % 360;
      return diff > 180 ? 360 - diff : diff;
    };

    let best = candidates[0] ?? { x: left + (w / 2), y: top, direction: 270 };
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const targetAngle = angleToTarget(candidate.x, candidate.y);
      const diff = angleDiff(candidate.direction, targetAngle);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = candidate;
      }
    }

    return best;
  }

  private getTokenCenter(token: TokenDocument, scene: Scene): { x: number; y: number } {
    return {
      x: token.x + (Math.max(1, Math.ceil(token.width)) * scene.grid.sizeX) / 2,
      y: token.y + (Math.max(1, Math.ceil(token.height)) * scene.grid.sizeY) / 2,
    };
  }

  private async getTargetsForNativeTemplateSpell(scene: Scene, spell: Item): Promise<TokenDocument[]> {
    if (!this.entity.id) return [];

    const caster = scene.tokens.get(this.entity.id);
    if (!caster) return [];

    const activity = this.getAutoPlaceTemplateActivity(spell);
    if (!activity) return [];
    const templateType = activity.target?.template?.type?.toLowerCase();
    if (!templateType) return [];

    const directionalTemplateTypes = new Set(["cone", "ray", "line"]);
    const pointTemplateTypes = new Set(["circle", "rect", "sphere", "cylinder", "radius"]);

    const valid = this.getValidSpellTargets(scene, spell);
    const affectsType = ((activity as unknown as { target?: { affects?: { type?: string } } }).target?.affects?.type ?? "").toLowerCase();
    const isDirectionalTemplate = directionalTemplateTypes.has(templateType);
    const selfCentered = !isDirectionalTemplate && (affectsType === "self" || getSpellRange(spell) === 0);
    if (!selfCentered && valid.length === 0) return [];

    const casterCenter = this.getTokenCenter(caster, scene);

    let focus: TokenDocument | undefined;
    if (!selfCentered) {
      const rangeUnits = Math.max(0, getSpellRange(spell));
      const rangePx = rangeUnits > 0
        ? (rangeUnits / scene.grid.distance) * scene.grid.size
        : Number.POSITIVE_INFINITY;
      const inRange = valid.filter(token => {
        const tokenCenter = this.getTokenCenter(token, scene);
        const dist = Math.hypot(tokenCenter.x - casterCenter.x, tokenCenter.y - casterCenter.y);
        return dist <= rangePx;
      });
      const candidates = inRange.length > 0 ? inRange : valid;

      if (pointTemplateTypes.has(templateType)) {
        focus = candidates[Math.floor(Math.random() * candidates.length)] ?? candidates[0];
      } else {
        let nearestDistance = Number.POSITIVE_INFINITY;
        const nearest: TokenDocument[] = [];
        for (const token of candidates) {
          const tokenCenter = this.getTokenCenter(token, scene);
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
      const anchor = this.chooseEdgeOrCornerAnchorForTarget(caster, focus, scene);
      templateX = anchor.x;
      templateY = anchor.y;
      templateDirection = anchor.direction;
    } else if (pointTemplateTypes.has(templateType) && focus && !selfCentered) {
      const targetCenter = this.getTokenCenter(focus, scene);
      templateX = targetCenter.x;
      templateY = targetCenter.y;
      const angle = Math.toDegrees(Math.atan2(targetCenter.y - casterCenter.y, targetCenter.x - casterCenter.x));
      const snapped = Math.round((angle + 360) % 360 / 45) * 45;
      templateDirection = ((snapped % 360) + 360) % 360;
    }

    const dnd5eApi = (globalThis as unknown as {
      dnd5e?: {
        canvas?: {
          AbilityTemplate?: {
            fromActivity?: (activity: Activity, options?: Record<string, unknown>) => Array<{ document: { toObject: () => object } }> | null;
          };
        };
      };
    }).dnd5e;
    const abilityTemplateClass = dnd5eApi?.canvas?.AbilityTemplate;
    if (!abilityTemplateClass || typeof abilityTemplateClass.fromActivity !== "function") return [];

    const templates = abilityTemplateClass.fromActivity(activity, {
      x: templateX,
      y: templateY,
      direction: templateDirection,
    });
    const template = templates?.[0];
    if (!template) return [];

    const templateCreateData = template.document.toObject() as Record<string, unknown>;
    const walledFlags = getWalledTemplateFlagsFromItem(spell);
    if (walledFlags) {
      templateCreateData["flags"] = {
        ...((templateCreateData["flags"] as Record<string, unknown> | undefined) ?? {}),
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

  override async act() {
    if (!canvas?.scene) return;
    const scene = canvas.scene;
    if (!this.entity.id) return;
    const tokenActor = scene.tokens.get(this.entity.id)?.actor;
    if (!tokenActor || !this.spellName) return;

    const spell = tokenActor.items.getName(this.spellName) ?? tokenActor.items.find(i => i.name === this.spellName);
    if (!spell) return;
    this.spellLevel = getSpellLevel(spell);
    const eligibility = evaluateSpellEligibilityForRandomAction(tokenActor, spell);
    if (!eligibility.ok) {
      return;
    }

    const oldTargets = game.user?.targets;
    const tokensLayer = canvas.tokens as unknown as { setTargets?: (targets: unknown[]) => void };
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
      tokensLayer.setTargets?.([]);

      if (eligibility.profile === "rangeTemplate") {
        plannedTargets = await this.getTargetsForRangeSpell(spell);
        if (plannedTargets.length === 0) return;
        selectedTargets = plannedTargets;
        setUniqueTargets(plannedTargets);

      } else if (eligibility.profile === "nativeTemplate") {
        if (this.getAutoPlaceTemplateActivity(spell)) {
          plannedTargets = await this.getTargetsForNativeTemplateSpell(scene, spell);
          if (plannedTargets.length === 0) return;
          setUniqueTargets(plannedTargets);
        }

      } else if (eligibility.profile === "directUse") {
        const directTargets = await this.getTargetsForDirectUseSpell(spell);
        if (directTargets.length > 0) {
          const maxTargets = Math.max(1, await getSpellTargetCount(spell));
          const pool = [...directTargets];
          const chosen: TokenDocument[] = [];
          while (chosen.length < maxTargets && pool.length > 0) {
            const pick = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
            if (pick) chosen.push(pick);
          }
          plannedTargets = chosen;
          selectedTargets = chosen;
          const ids = chosen.map(t => t.id).filter((id): id is string => !!id);
          if (ids.length > 0) tokensLayer.setTargets?.(ids);
          setUniqueTargets(chosen);
        } else {
          const casterToken = scene.tokens.get(this.entity.id);
          if (casterToken?.object && this.isValidDirectUseBuffTarget(casterToken, spell)) {
            casterToken.object.setTarget(true, { releaseOthers: false });
            plannedTargets = [casterToken];
            selectedTargets = [casterToken];
            const ids = casterToken.id ? [casterToken.id] : [];
            if (ids.length > 0) tokensLayer.setTargets?.(ids);
          } else {
            return;
          }
        }
        await Promise.resolve();
      }

      const usableSpell = spell as ItemWithUse;
      const activityRecords = ((spell.system as unknown as {
        activities?: { contents?: unknown[] };
      }).activities?.contents ?? []);
      const usableActivities = activityRecords.filter((activity): activity is {
        id?: string;
        type?: string;
        use: (
          config?: Record<string, unknown>,
          dialog?: Record<string, unknown>,
          message?: Record<string, unknown>
        ) => Promise<unknown>;
      } => {
        return typeof (activity as { use?: unknown }).use === "function";
      });

      let activityToUse = usableActivities[0];
      if (eligibility.profile === "directUse" && usableActivities.length > 0) {
        const priority = ["cast", "enchant", "utility"];
        activityToUse = usableActivities.find(a => priority.includes((a.type ?? "").toLowerCase()))
          ?? usableActivities[0];
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
          create: {
            measuredTemplate: false,
          },
          midiOptions: {
            autoRollDamage: "none",
            autoFastDamage: true,
          }
        };
      const dialogConfig: Record<string, unknown> = { configure: false };

      if (hasGuidingBoltAdvantage) {
        registerGuidingBoltAdvantageHook();
      }

      const templateIdsBeforeCast = new Set(Array.from(scene.templates).map(t => t.id));

      const getCreatedTemplateIds = () => Array.from(scene.templates)
        .map(t => t.id)
        .filter(id => !templateIdsBeforeCast.has(id));

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

      // Consume guiding bolt advantage (hit or miss)
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
      selectedTargets = selectedTargets.filter(t => t.id !== this.entity.id && t.combatant?.defeated !== true && !isActorAtZeroHp(t.actor ?? undefined));

      const isSleep = this.isSleepSpell(spell);
      let sleepAffected = new Set<string>();
      if (isSleep && selectedTargets.length > 0) {
        sleepAffected = await this.applySleepEffect(spell, selectedTargets);
      }

      const isLightCantrip = spell.name.trim().toLowerCase() === "light";
      let lightApplied = new Set<string>();
      if (isLightCantrip && selectedTargets.length > 0) {
        lightApplied = await this.applyLightCantripEffect(spell, tokenActor, selectedTargets, activityToUse);
      }

      const isGuidingBolt = this.isGuidingBoltSpell(spell);
      const attackHitData = this.getAttackHitTokenIdsFromWorkflow(activityToUse);
      const isTokenHitByAttackWorkflow = (token: TokenDocument): boolean => {
        const tokenId = token.id;
        const actorId = token.actor?.id;
        if (tokenId && attackHitData.ids.has(tokenId)) return true;
        if (actorId && attackHitData.ids.has(actorId)) return true;
        return false;
      };
      const hasAnyKnownAttackHits = attackHitData.known && selectedTargets.some(t => isTokenHitByAttackWorkflow(t));

      const effectActivity = getItemActivities(spell).find(a => {
        if (a.type === "heal") return typeof a.rollHealing === "function" || typeof a.rollDamage === "function";
        return typeof a.rollDamage === "function" && (a.type === "attack" || a.type === "save" || a.type === "damage");
      });

      const damageApplied = new Map<string, number>();
      if (!isSleep && !isLightCantrip && effectActivity && selectedTargets.length > 0) {
        const isHealingActivity = effectActivity.type === "heal";

        if (!isHealingActivity && effectActivity.type === "attack" && !hasAnyKnownAttackHits) {
          // No confirmed hits, skip damage
        } else {
        let damageResult: unknown;
        if (isHealingActivity) {
          if (typeof effectActivity.rollHealing === "function") {
            damageResult = await effectActivity.rollHealing({}, { configure: false });
          } else if (typeof effectActivity.rollDamage === "function") {
            damageResult = await effectActivity.rollDamage({}, { configure: false });
          }
        } else if (typeof effectActivity.rollDamage === "function") {
          damageResult = await effectActivity.rollDamage({}, { configure: false });
        }

        const damageRolls = asDamageRollArray(damageResult);
        if (damageRolls.length > 0) {
          const totalAmount = damageRolls.reduce((sum, dr) => sum + dr.total, 0);
          const appliedAmount = isHealingActivity ? -totalAmount : totalAmount;
          const damageData = buildDamageApplicationData(damageRolls);
          const savedByTokenId = new Map<string, boolean>();

          const extractRollTotal = (rollResult: unknown): number | undefined => {
            if (typeof rollResult === "object" && rollResult !== null) {
              const rec = rollResult as Record<string, unknown>;
              if (typeof rec["total"] === "number" && Number.isFinite(rec["total"])) {
                return rec["total"];
              }
              if (typeof rec["_total"] === "number" && Number.isFinite(rec["_total"])) {
                return rec["_total"];
              }
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
            const effectRecord = effectActivity as Record<string, unknown>;
            const saveDataRaw = effectRecord["save"];
            const saveData = (typeof saveDataRaw === "object" && saveDataRaw !== null)
              ? (saveDataRaw as { ability?: Set<string> | string[]; dc?: { value?: number } })
              : undefined;
            const abilitySet = saveData?.ability;
            const ability = abilitySet instanceof Set
              ? abilitySet.values().next().value
              : (Array.isArray(abilitySet) ? abilitySet[0] : undefined);
            const dc = saveData?.dc?.value;
            if (!ability || typeof dc !== "number" || !token.actor) return undefined;

            const saveActor = token.actor as unknown as {
              rollSavingThrow?: (
                config: { ability: string; target: number; event?: Event },
                dialog?: Record<string, unknown>,
                message?: Record<string, unknown>
              ) => Promise<unknown>;
            };
            if (typeof saveActor.rollSavingThrow !== "function") return undefined;
            const speaker = ChatMessage.getSpeaker({ actor: token.actor, scene: canvas.scene, token });
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

          if (!isHealingActivity && effectActivity.type === "save") {
            for (const token of selectedTargets) {
              if (!token.id || !token.actor) continue;
              const saved = await getSaveOutcome(token);
              if (typeof saved === "boolean") savedByTokenId.set(token.id, saved);
            }
          }

          for (const token of selectedTargets) {
            if (!token.id || !token.actor) continue;
            const damageActor = token.actor as unknown as DamageApplierActor;
            if (typeof damageActor.applyDamage !== "function") continue;

            if (!isHealingActivity && effectActivity.type === "attack") {
              if (!isTokenHitByAttackWorkflow(token)) continue;
            }

            let tokenAmount = appliedAmount;
            if (!isHealingActivity && effectActivity.type === "save") {
              const saved = token.id ? savedByTokenId.get(token.id) : undefined;
              const onSave = ((effectActivity as unknown as { damage?: { onSave?: string } }).damage?.onSave ?? "half").toLowerCase();
              const saveMultiplier = saved === true
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
                // Damage to a 0 HP friendly: death save failures instead of damage
                const maxHp = (token.actor.system as unknown as { attributes?: { hp?: { max?: number } } }).attributes?.hp?.max ?? 0;
                const curFails = getActorDeathSaves(token.actor).failure;
                if (maxHp > 0 && tokenAmount >= maxHp) {
                  console.log(`${token.name} takes massive spell damage (${tokenAmount} >= ${maxHp} max HP) at 0 HP, instant death`);
                  // @ts-expect-error DND5E specific
                  await token.actor.update({ "system.attributes.death.failure": 3 });
                } else {
                  console.log(`${token.name} takes spell damage at 0 HP, adding 1 death save failure`);
                  // @ts-expect-error DND5E specific
                  await token.actor.update({ "system.attributes.death.failure": Math.min(curFails + 1, 3) });
                }
              } else {
                await setActorStatusEffect(token.actor, "unconscious", false);
                await damageActor.applyDamage(tokenAmount, { multiplier: 1, damage: damageData });
                // If the target just dropped to 0 HP, mark them unconscious
                if (!isHealingActivity && isActorAtZeroHp(token.actor)) {
                  await setActorStatusEffect(token.actor, "unconscious", true);
                }
              }
            }
            damageApplied.set(token.id, (damageApplied.get(token.id) ?? 0) + tokenAmount);
          }

        }
        }
      }

      if (isGuidingBolt && selectedTargets.length > 0) {
        await this.applyGuidingBoltEffect(spell, tokenActor, selectedTargets, damageApplied);
      }

      const isAttackEffect = effectActivity?.type === "attack";

      const targetEntries: AttackResultTarget[] = selectedTargets.map(t => {
        const tokenId = t.id ?? "";
        let hit = true;

        if (isSleep) {
          hit = tokenId.length > 0 ? sleepAffected.has(tokenId) : false;
        } else if (isLightCantrip) {
          hit = tokenId.length > 0 ? lightApplied.has(tokenId) : false;
        } else if (isAttackEffect) {
          hit = attackHitData.known ? isTokenHitByAttackWorkflow(t) : false;
        }

        return {
          name: t.name,
          tokenId,
          ac: ((t.actor?.system as unknown as { attributes?: { ac?: { value?: number } } })
            .attributes?.ac?.value) ?? 0,
          hit,
          damageDealt: tokenId.length > 0 ? (damageApplied.get(tokenId) ?? 0) : 0,
        };
      });

      this.events.push({
        attacker: this.entity.name,
        attackerId: this.entity.id,
        weapon: spell.name,
        attackTotal: 0,
        isCritical: false,
        isFumble: false,
        kind: "action",
        targets: targetEntries,
      });
    } finally {
      tokensLayer.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
    }
  }
}

class RandomSpellAction extends SpellAction {
  prepareSelectedSpell(): string | undefined {
    if (this.spellName) return this.spellName;
    if (!canvas?.scene || !this.entity.id) return undefined;

    const actor = canvas.scene.tokens.get(this.entity.id)?.actor;
    if (!actor) return undefined;

    const available = getCastableSpellsForRandomAction(actor);
    if (available.length === 0) return undefined;

    const selected = available[Math.floor(Math.random() * available.length)];
    if (!selected) return undefined;

    this.spellName = selected.name;
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
class Attack extends Action {
  range: number;
  weapon: string | undefined;
  ammunitionId: string | undefined;
  targets: number | undefined;
  forcedTargetTokenIds: string[] | undefined;
  isRanged: boolean = false;

  constructor(entity: Entity, range: number) {
    super(entity);
    this.range = range;
  }

  override async act() {
    if (!canvas?.scene) return;
    const scene = canvas.scene;
    const weaponName = this.weapon || "Unarmed Strike";
    if (!canvas.tokens) return;
    const oldTargets = game.user?.targets;
    // jank fix because the types aren't updated for v13's setTargets()
    const tokensLayer = canvas.tokens as unknown as { setTargets?: (targets: unknown[]) => void };
    tokensLayer.setTargets?.([]);

    try {
      const tokens = await withRangeTemplate<TokenDocument[]>(scene, {
        x: this.entity.x,
        y: this.entity.y,
        width: this.entity.width,
        height: this.entity.height,
        elevation: this.entity.elevation,
      }, this.range, (templateObj) => {
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

      // Remove dead targets
      const aliveTokens = tokens.filter(t => {
        const actor = t.actor;
        if (!actor) return false;
        return !isActorAtZeroHp(actor);
      });

      if (aliveTokens.length === 0) {
        console.log(`Entity ${this.entity.name} found only dead targets in range to attack.`);
      } else {
        // Randomly reduce the array to size of targets
        if (this.targets && aliveTokens.length > this.targets) {
          while (aliveTokens.length > this.targets) {
            const removeIndex = Math.floor(Math.random() * aliveTokens.length);
            aliveTokens.splice(removeIndex, 1);
          }
        }
        console.log(`Entity ${this.entity.name} attacks tokens:`, aliveTokens.map(t => t.name));
        for (const token of aliveTokens) {
          if (!token.object) continue;
          token.object.setTarget(true, { releaseOthers: false });
        }
        try {
          const result = await rollAttack(this.entity, weaponName, this.ammunitionId, this.usedReaction);
          if (result) {
            result.kind = "action";
            this.events.push(result);
          }
        } catch (err: unknown) {
          console.error(`Error rolling damage for entity ${this.entity.name} with weapon ${weaponName}:`, err);
        }
      }
    } finally {
      tokensLayer.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
    }
  }
}

class RandomAttack extends Attack {
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
    // @ts-expect-error DND types don't have item types yet
    const allWeapons = sourceItems.filter(i => i.type === "weapon"
      && ((i.system as unknown as { quantity?: number }).quantity ?? 1) > 0);
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
        const isEquipped = (item.system as unknown as Equippable).equipped;
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

    const itemRange = (selectedItem?.system as unknown as { range?: ItemRange }).range;
    this.range = itemRange?.reach ?? itemRange?.value ?? canvas?.scene?.grid.distance ?? 5;

    this.isRanged = (selectedItem?.system as unknown as { attackType?: string }).attackType === "ranged";

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

class SmartAttack extends RandomAttack {
  override async prepareSelectedWeapon(): Promise<string | undefined> {
    if (this.weapon) return this.weapon;

    const liveActor = canvas?.tokens?.get(this.entity.id ?? "")?.actor;
    if (!liveActor) return super.prepareSelectedWeapon();

    const scene = canvas.scene;
    if (!scene) return super.prepareSelectedWeapon();

    // @ts-expect-error DND types don't have item types yet
    const allWeapons = (liveActor.items.filter(i => i.type === "weapon") as Item[])
      .filter(i => ((i.system as unknown as { quantity?: number }).quantity ?? 1) > 0)
      .filter(w => getUsableAmmunitionIdOrNull(w) !== null);

    if (allWeapons.length === 0) return super.prepareSelectedWeapon();

    // Score each weapon by estimated average damage
    const scored: { item: Item; avgDamage: number; reach: number; isRanged: boolean }[] = [];
    for (const w of allWeapons) {
      const activities = getItemActivities(w);
      const attackActivity = activities.find(a => a.type === "attack");
      let avgDamage = 0;
      if (attackActivity?.damage?.parts) {
        for (const part of attackActivity.damage.parts) {
          const n = part.number ?? 0;
          const d = part.denomination ?? 0;
          avgDamage += n * (d + 1) / 2;
          // Parse bonus if it's a simple number
          if (part.bonus) {
            const bonusNum = parseInt(part.bonus, 10);
            if (!isNaN(bonusNum)) avgDamage += bonusNum;
          }
        }
      }
      const range = (w.system as unknown as { range?: ItemRange }).range;
      const reach = range?.reach ?? range?.value ?? 5;
      const isRanged = (w.system as unknown as { attackType?: string }).attackType === "ranged";
      scored.push({ item: w, avgDamage, reach, isRanged });
    }

    // Sort by damage descending
    scored.sort((a, b) => b.avgDamage - a.avgDamage);

    // Check which weapons can reach an enemy
    const tokenDoc = scene.tokens.get(this.entity.id ?? "");
    let bestInRange: typeof scored[0] | undefined;
    if (tokenDoc) {
      const enemies = scene.tokens.filter(t => {
        if (t.id === tokenDoc.id) return false;
        if (t.combatant?.defeated === true) return false;
        if (isActorAtZeroHp(t.actor ?? undefined)) return false;
        return t.disposition !== tokenDoc.disposition;
      });
      for (const candidate of scored) {
        const inRange = await withRangeTemplate<TokenDocument[]>(scene, {
          x: this.entity.x, y: this.entity.y,
          width: this.entity.width, height: this.entity.height,
          elevation: this.entity.elevation,
        }, candidate.reach, (templateObj) => getTokensInTemplate(templateObj, scene, enemies),
        undefined, candidate.isRanged);
        if (inRange && inRange.length > 0) {
          bestInRange = candidate;
          break; // Already sorted by damage, first hit is best
        }
      }
    }

    const chosen = bestInRange ?? scored[0];
    if (!chosen) return super.prepareSelectedWeapon();

    const ammoId = getUsableAmmunitionIdOrNull(chosen.item);
    this.ammunitionId = typeof ammoId === "string" ? ammoId : undefined;

    // Equip chosen, unequip others
    const updates: { _id: string; "system.equipped": boolean }[] = [];
    for (const w of allWeapons) {
      if (!w.id) continue;
      const isEquipped = (w.system as unknown as Equippable).equipped;
      if (w.id === chosen.item.id && !isEquipped) {
        updates.push({ _id: w.id, "system.equipped": true });
      } else if (w.id !== chosen.item.id && isEquipped) {
        updates.push({ _id: w.id, "system.equipped": false });
      }
    }
    if (updates.length > 0) {
      await liveActor.updateEmbeddedDocuments("Item", updates);
    }

    const itemRange = (chosen.item.system as unknown as { range?: ItemRange }).range;
    this.range = itemRange?.reach ?? itemRange?.value ?? scene.grid.distance;
    this.isRanged = chosen.isRanged;
    this.weapon = chosen.item.name;

    console.log(`SmartAttack: ${this.entity.name} chose ${this.weapon} (avg dmg: ${chosen.avgDamage.toFixed(1)}, reach: ${chosen.reach}, ${chosen.isRanged ? "ranged" : "melee"}${bestInRange ? ", in range" : ", no target in range"})`);
    return this.weapon;
  }
}

class Reaction extends Action {}

class AttackOfOpportunity extends Reaction {
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

class RandomAttackOfOpportunity extends AttackOfOpportunity {
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

// can be removed once dnd5e types is updated
type Activity = {
  type: string;
  target?: {
    template?: {
      type?: string;
    };
  };
  damage?: {
    parts?: Array<{
      number?: number;
      denomination?: number;
      bonus?: string;
      custom?: { enabled?: boolean; formula?: string };
    }>;
  };
  rollAttack?: (
    config?: Record<string, unknown>,
    dialog?: { configure?: boolean } & Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;

  rollDamage?: (
    config?: Record<string, unknown>,
    dialog?: { configure?: boolean } & Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;

  rollHealing?: (
    config?: Record<string, unknown>,
    dialog?: { configure?: boolean } & Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
};

type DamageRoll = {
  total: number;
  options?: {
    type?: string;
    types?: string[];
    properties?: string[];
    rollType?: string;
    isCritical?: boolean;
  }
}

type DamageApplierActor = Actor & {
  applyDamage?: (
    amount: number,
    options?: { multiplier?: number; damage?: Record<string, unknown> }
  ) => Promise<unknown>;
};

type AttackRollLike = {
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

type TargetDescriptorLike = {
  ac: number;
  uuid: string;
};

function isAttackRollLike(value: unknown): value is AttackRollLike {
  return isRecord(value) && typeof value["total"] === "number";
}

function isTargetDescriptorLike(value: unknown): value is TargetDescriptorLike {
  return isRecord(value) && typeof value["ac"] === "number" && typeof value["uuid"] === "string";
}

function getTargetsFromAttackRoll(attack: AttackRollLike): TargetDescriptorLike[] {
  const targets = attack.parent?.flags?.dnd5e?.targets;
  if (!Array.isArray(targets)) return [];
  return targets.filter(isTargetDescriptorLike);
}

function isDamageRoll(value: unknown): value is DamageRoll {
  return isRecord(value) && typeof value["total"] === "number";
}

function asDamageRollArray(value: unknown): DamageRoll[] {
  if (Array.isArray(value)) return value.filter(isDamageRoll);
  if (isDamageRoll(value)) return [value];
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


function getItemActivities(item: unknown): Activity[] {
  if (!isRecord(item)) return [];

  const system = item["system"];
  if (!isRecord(system)) return [];

  const activities = system["activities"];
  if (!isRecord(activities)) return [];

  const contents = activities["contents"];
  if (!Array.isArray(contents)) return [];

  return contents.filter((v: unknown): v is Activity => isRecord(v) && typeof v["type"] === "string");
}

function actorHasStatusEffect(actor: Actor, statusId: string): boolean {
  const normalizedStatusId = statusId.toLowerCase();
  const statuses = (actor as unknown as { statuses?: Set<string> }).statuses;
  if (statuses?.has(normalizedStatusId)) return true;

  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    const effectStatuses = (effect as unknown as { statuses?: Set<string> }).statuses;
    if (effectStatuses?.has(normalizedStatusId)) return true;
    const effectStatusId = ((effect as unknown as { statusId?: string }).statusId ?? "").toLowerCase();
    if (effectStatusId === normalizedStatusId) return true;
  }

  return false;
}

function isActorUnconscious(actor: Actor): boolean {
  return actorHasStatusEffect(actor, "unconscious") || actorHasStatusEffect(actor, "sleeping");
}

function actorHasBlessStatus(actor: Actor): boolean {
  if (actorHasStatusEffect(actor, "blessed")) return true;
  if (actorHasStatusEffect(actor, "bless")) return true;

  for (const effect of actor.effects) {
    if (effect.disabled) continue;
    const label = ((effect as unknown as { name?: string; label?: string }).name
      ?? (effect as unknown as { label?: string }).label
      ?? "").trim().toLowerCase();
    if (label === "bless") return true;
  }

  return false;
}

async function getBlessBonusIfAny(actor: Actor): Promise<number> {
  if (!actorHasBlessStatus(actor)) return 0;
  const blessRoll = await new Roll("1d4").evaluate();
  return Math.max(0, Math.floor(blessRoll.total));
}

async function setActorStatusEffect(actor: Actor, statusId: string, active: boolean): Promise<boolean> {
  if (active) {
    const toggler = actor as unknown as {
      toggleStatusEffect?: (
        effectStatusId: string,
        options?: { active?: boolean; overlay?: boolean }
      ) => Promise<unknown>;
    };
    if (typeof toggler.toggleStatusEffect !== "function") return false;
    await toggler.toggleStatusEffect(statusId, { active: true });
    return true;
  }
  // When removing, delete the effect directly by its static ID to avoid DnD5e's _onDelete
  // hook chain trying to clean up implied sub-statuses that don't exist as standalone effects
  const effectId = dnd5eStaticId(`dnd5e${statusId}`);
  const effect = actor.effects.get(effectId);
  if (!effect) return false;
  await effect.delete();
  return true;
}

async function tryStandFromProne(actor: Actor): Promise<boolean> {
  if (!actorHasStatusEffect(actor, "prone")) return false;
  if (actorHasStatusEffect(actor, "sleeping") || actorHasStatusEffect(actor, "unconscious")) return false;
  return setActorStatusEffect(actor, "prone", false);
}

function buildDamageApplicationData(rolls: DamageRoll[]): Record<string, unknown> {
  const parts = rolls.map(r => ({
    amount: r.total,
    type: r.options?.type ?? r.options?.types?.[0] ?? "none"
  }));

  const types = Array.from(new Set(parts.map(p => p.type).filter(t => t && t !== "none")));
  const properties = Array.from(new Set(rolls.flatMap(r => r.options?.properties ?? [])));

  return {
    // Actor5e.calculateDamage will set damage.amount = <amount passed to applyDamage>
    // but we provide the typing/breakdown it needs for traits.
    parts,
    types,
    type: types[0],
    properties
  };
}

async function rollAttack(entity: Entity, weaponName: string, ammunitionId?: string, usedReaction?: Set<string>): Promise<AttackResult | null> {
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

  if (!activity.rollAttack) {
    console.error(`Item ${weaponName} does not have an attack roll defined`);
    return null;
  }

  if (!activity.rollDamage) {
    console.error(`Item ${weaponName} does not have a damage roll defined`);
    return null;
  }

  const ammoItem = ammunitionId ? actor.items.get(ammunitionId) : undefined;

  const guidingBoltTargets = await getActiveGuidingBoltTargetIds(scene);

  const attackConfig: Record<string, unknown> = {};
  if (ammoItem?.id) attackConfig["ammunition"] = ammoItem.id;

  if (guidingBoltTargets.size > 0) {
    attackConfig["advantage"] = true;
  }

  const attackResult = await activity.rollAttack(attackConfig, { configure: false });
  const attackRolls = Array.isArray(attackResult) ? attackResult.filter(isAttackRollLike) : [];
  const attack = attackRolls[0];
  if (!attack) {
    console.error("No attack rolls returned for item", weaponName, attackResult);
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

  const targets = getTargetsFromAttackRoll(attack);
  if (targets.length === 0) {
    console.log("No targets for attack");
    return result;
  }
  const hitTargetIds = new Set<string>();
  for (const target of targets) {
    const isCritical = attack.isCritical === true;
    const isFumble = attack.isFumble === true;
    // Grab the part of the UUID before the .Actor to get the token
    const beforeActor = target.uuid.split(".Actor")[0] ?? "";
    const targetTokenId = beforeActor.split("Token.")[1] ?? "";
    const targetToken = targetTokenId ? scene.tokens.get(targetTokenId) : undefined;
    let hit = isCritical || (effectiveAttackTotal >= target.ac && !isFumble);
    if (hit && targetToken) {
      const shieldUsed = await maybeUseShieldReaction(targetToken, effectiveAttackTotal, isCritical, usedReaction);
      if (shieldUsed) {
        hit = false;
      }
    }

    // Clear guiding bolt flag on any attack attempt (hit or miss)
    if (targetTokenId && guidingBoltTargets.has(targetTokenId)) {
      const token = scene.tokens.get(targetTokenId);
      if (token) await clearGuidingBoltFlag(token);
    }

    if (!hit) {
      console.log(`Attack missed target with AC ${target.ac}`);
      if (targetToken?.object) {
        targetToken.object.setTarget(false, { releaseOthers: false });
      }
      result.targets.push({ name: targetToken?.name ?? "Unknown", tokenId: targetTokenId, ac: target.ac, hit: false, damageDealt: 0 });
    } else {
      hitTargetIds.add(targetTokenId);
      result.targets.push({ name: targetToken?.name ?? "Unknown", tokenId: targetTokenId, ac: target.ac, hit: true, damageDealt: 0 });
    }
  }

  if (hitTargetIds.size > 0) {
    const damageConfig: Record<string, unknown> = { isCritical: attack.isCritical === true };
    if (ammoItem) {
      damageConfig["ammunition"] = ammoItem;
    }
    const damageResult = await activity.rollDamage(damageConfig, { configure: false });
    const damageRolls = asDamageRollArray(damageResult);
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
        const maxHp = (token.actor.system as unknown as { attributes?: { hp?: { max?: number } } }).attributes?.hp?.max ?? 0;
        const curFails = getActorDeathSaves(token.actor).failure;
        if (maxHp > 0 && totalDamage >= maxHp) {
          console.log(`${token.name} takes massive damage (${totalDamage} >= ${maxHp} max HP) while at 0 HP, instant death`);
          // @ts-expect-error DND5E specific
          await token.actor.update({ "system.attributes.death.failure": 3 });
        } else {
          console.log(`${token.name} takes damage at 0 HP, adding ${failCount} death save failure(s)`);
          // @ts-expect-error DND5E specific
          await token.actor.update({ "system.attributes.death.failure": Math.min(curFails + failCount, 3) });
        }
        continue;
      }

      await setActorStatusEffect(token.actor, "unconscious", false);

      const damageActor = token.actor as unknown as DamageApplierActor;
      if (typeof damageActor.applyDamage !== "function") {
        console.warn("applyDamage is not available on this actor; skipping damage application.", damageActor);
        continue;
      }

      await damageActor.applyDamage(totalDamage, { multiplier: multiplier, damage: damageData });

      // If the target just dropped to 0 HP, mark them unconscious
      if (isActorAtZeroHp(token.actor)) {
        await setActorStatusEffect(token.actor, "unconscious", true);
      }
    }

  }
  return result;
}

function waitForDrawMeasuredTemplate(templateId: string, timeoutMs: number = 5000): Promise<foundry.canvas.placeables.MeasuredTemplate> {
  return new Promise((resolve, reject) => {
    const hookId = Hooks.on("refreshMeasuredTemplate", (template: foundry.canvas.placeables.MeasuredTemplate) => {
      if (template.document.id === templateId) {
        clearTimeout(timer);
        Hooks.off("refreshMeasuredTemplate", hookId);
        resolve(template);
      }
    });
    const timer = setTimeout(() => {
      Hooks.off("refreshMeasuredTemplate", hookId);
      reject(new Error(`waitForDrawMeasuredTemplate timed out for ${templateId}`));
    }, timeoutMs);
  });
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function scheduleTemplateCleanup(scene: Scene, templateId: string): void {
  const chrisPremadesActive = isModuleActive("chris-premades");
  const deleteDelayMs = chrisPremadesActive ? 175 : 0;

  void (async () => {
    if (deleteDelayMs > 0) {
      await delayMs(deleteDelayMs);
    }
    if (scene.templates.has(templateId)) {
      await scene.deleteEmbeddedDocuments("MeasuredTemplate", [templateId]);
    }
  })();
}

type TemplateRangeSource = {
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
}

async function withRangeTemplate<T>(
  scene: Scene,
  source: TemplateRangeSource,
  rangeUnits: number,
  useTemplate: (templateObj: foundry.canvas.placeables.MeasuredTemplate) => Promise<T> | T,
  sourceItem?: Item,
  ranged: boolean = false,
  hidden: boolean = false
): Promise<T | undefined> {
  if (!canvas?.scene || scene.id !== canvas.scene.id) return undefined;

  const gridSize = scene.grid.size;
  const gridDist = scene.grid.distance;

  // Token center in pixels
  const tokenWidthPx = source.width * gridSize;
  const tokenHeightPx = source.height * gridSize;
  const centerX = source.x + tokenWidthPx / 2;
  const centerY = source.y + tokenHeightPx / 2;

  const walledFlags = sourceItem ? getWalledTemplateFlagsFromItem(sourceItem) : undefined;

  let templateCreateData: Record<string, unknown>;
  let swappedRegistry: { original: unknown; registry: Map<string, unknown> } | undefined;

  if (ranged) {    
    const radiusUnits = rangeUnits + Math.max(source.width, source.height) * gridDist / 2;
    templateCreateData = {
      t: "circle" as const,
      distance: radiusUnits,
      x: centerX,
      y: centerY,
      elevation: source.elevation,
      borderColor: "#000000",
      fillColor: "#ffffff",
    };
  } else {
    // centered square via rect template + WalledTemplateSquare swap
    const halfReach = rangeUnits + Math.max(source.width, source.height) * gridDist / 2;
    templateCreateData = {
      t: "rect" as const,
      direction: 45,
      distance: halfReach,
      x: centerX,
      y: centerY,
      elevation: source.elevation,
      borderColor: "#000000",
      fillColor: "#ffffff",
    };

    if (isModuleActive("walledtemplates")) {
      const wtModule = game.modules?.get("walledtemplates");
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
      const wtApi = (wtModule as any)?.api;
      const registry = wtApi?.WalledTemplateShape?.shapeCodeRegister as Map<string, unknown> | undefined;
      const squareClass = wtApi?.WalledTemplateSquare;
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
      if (registry && squareClass) {
        swappedRegistry = { original: registry.get("rect"), registry };
        registry.set("rect", squareClass);
      }
    }
  }

  if (walledFlags) {
    templateCreateData["flags"] = { walledtemplates: walledFlags };
  }
  const [templateDoc] = await scene.createEmbeddedDocuments("MeasuredTemplate", [templateCreateData]);

  if (!templateDoc) {
    if (swappedRegistry) {
      swappedRegistry.registry.set("rect", swappedRegistry.original);
    }
    return undefined;
  }

  try {
    // Suppress grid highlighting during template creation so hidden templates don't flash
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    const gridLayer = canvas.interface?.grid;
    let origHighlightPosition: ((...args: any[]) => void) | undefined;
    let origAddHighlightLayer: ((...args: any[]) => any) | undefined;
    if (hidden && gridLayer) {
      origHighlightPosition = gridLayer.highlightPosition.bind(gridLayer);
      origAddHighlightLayer = gridLayer.addHighlightLayer.bind(gridLayer);
      gridLayer.highlightPosition = () => {};
      gridLayer.addHighlightLayer = (() => undefined) as any;
    }
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
    const templateObj = await waitForDrawMeasuredTemplate(templateDoc.id);
    if (hidden && gridLayer && origHighlightPosition && origAddHighlightLayer) {
      gridLayer.highlightPosition = origHighlightPosition;
      gridLayer.addHighlightLayer = origAddHighlightLayer;
      templateObj.visible = false;
    }
    if (!templateObj.shape) return undefined;
    return await Promise.resolve(useTemplate(templateObj));
  } finally {
    if (swappedRegistry) {
      swappedRegistry.registry.set("rect", swappedRegistry.original);
    }
    scheduleTemplateCleanup(scene, templateDoc.id);
  }
}

async function withRectRangeTemplate<T>(
  scene: Scene,
  source: TemplateRangeSource,
  rangeUnits: number,
  useTemplate: (templateObj: foundry.canvas.placeables.MeasuredTemplate) => Promise<T> | T,
  sourceItem?: Item
): Promise<T | undefined> {
  return withRangeTemplate(scene, source, rangeUnits, useTemplate, sourceItem, false);
}

function getWalledTemplateFlagsFromItem(item: Item): Record<string, unknown> | undefined {
  if (!isModuleActive("walledtemplates")) return undefined;

  const moduleId = "walledtemplates";
  const flagKeys = [
    "wallsBlock",
    "wallRestriction",
    "noAutotarget",
    "hideBorder",
    "hideHighlighting",
    "showOnHover",
    "snapCenter",
    "snapCorner",
    "snapSideMidpoint",
    "addTokenSize",
    "attachToken",
    "rotateWithAttachedToken",
  ];

  const flags: Record<string, unknown> = {};
  for (const key of flagKeys) {
    const value = foundry.utils.getProperty(item, `flags.${moduleId}.${key}`);
    if (value !== undefined) flags[key] = value;
  }

  return Object.keys(flags).length > 0 ? flags : undefined;
}

function getTemplateHighlightedGridPositions(
  templateObj: foundry.canvas.placeables.MeasuredTemplate,
  scene: Scene
): { x: number; y: number }[] {
  if (scene.grid.type !== 1) return [];

  const positions = (templateObj as unknown as { _getGridHighlightPositions: () => { x: number; y: number }[] })
    ._getGridHighlightPositions();

  const grid = scene.grid;
  const paddingX = scene.dimensions.sceneWidth * scene.padding;
  const paddingY = scene.dimensions.sceneHeight * scene.padding;
  const width = Math.floor(scene.dimensions.sceneWidth / grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / grid.sizeY);

  const highlighted = new Set<string>();
  const results: { x: number; y: number }[] = [];
  for (const position of positions) {
    const gridX = Math.floor((position.x - paddingX) / grid.sizeX);
    const gridY = Math.floor((position.y - paddingY) / grid.sizeY);
    if (gridX < 0 || gridX >= width || gridY < 0 || gridY >= height) continue;
    const key = `${gridX},${gridY}`;
    if (highlighted.has(key)) continue;
    highlighted.add(key);
    results.push({ x: gridX, y: gridY });
  }

  return results;
}

function getTokensInTemplate(templateObj: foundry.canvas.placeables.MeasuredTemplate, scene: Scene, tokens: TokenDocument[]): TokenDocument[] {
  if (scene.grid.type !== 1) return [];

  const highlightedPositions = getTemplateHighlightedGridPositions(templateObj, scene);
  const highlighted = new Set(highlightedPositions.map(position => `${position.x},${position.y}`));

  const hits: TokenDocument[] = [];
  for (const token of tokens) {
    const topLeft = pixelToGrid(token.x, token.y, scene);
    if (!topLeft) continue;
    const tokenWidth = token.width;
    const tokenHeight = token.height;
    let hit = false;
    for (let dx = 0; dx < tokenWidth; dx++) {
      for (let dy = 0; dy < tokenHeight; dy++) {
        const checkX = topLeft.x + dx;
        const checkY = topLeft.y + dy;
        if (highlighted.has(`${checkX},${checkY}`)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      hits.push(token);
    }
  }

  return hits;
}

function gridToPixel(gridX: number, gridY: number, scene: Scene): { x: number; y: number } | undefined {
  const grid = scene.grid;
  if (grid.type !== 1) {
    ui.notifications?.warn("DNDModel.SceneCalcGridTypeWarning");
    return;
  }
  const width = Math.floor(scene.dimensions.sceneWidth / grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / grid.sizeY);

  const paddingX = scene.dimensions.sceneX;
  const paddingY = scene.dimensions.sceneY;

  if (gridX >= 0 && gridX < width && gridY >= 0 && gridY < height) {
    const x = gridX * grid.sizeX + paddingX;
    const y = gridY * grid.sizeY + paddingY;
    return { x, y };
  } else {
    console.warn(`Grid position (${gridX}, ${gridY}) is out of bounds for scene ${scene.id}`);
    return;
  }
}

function pixelToGrid(pixelX: number, pixelY: number, scene: Scene): { x: number; y: number } | undefined {
  const grid = scene.grid;
  if (grid.type !== 1) {
    ui.notifications?.warn("DNDModel.SceneCalcGridTypeWarning");
    return;
  }
  const width = Math.floor(scene.dimensions.sceneWidth / grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / grid.sizeY);

  const paddingX = scene.dimensions.sceneX;
  const paddingY = scene.dimensions.sceneY;

  const gridX = Math.floor((pixelX - paddingX) / grid.sizeX);
  const gridY = Math.floor((pixelY - paddingY) / grid.sizeY);

  if (gridX >= 0 && gridX < width && gridY >= 0 && gridY < height) {
    return { x: gridX, y: gridY };
  } else {
    console.trace(`Pixel position (${pixelX}, ${pixelY}) is out of bounds for scene ${scene.id}`);
    return;
  }
}


