// TODO: Big boy needs to have big boy attack range

import * as tf from '@tensorflow/tfjs';
import * as buffer from 'buffer';

CONFIG.debug.hooks = false;

const payload_version: number = 3;

Hooks.on("ready", () => {
  console.log("DNDModel Initialized! | TensorFlow.js version:", tf.version.tfjs);
  window.Buffer = buffer.Buffer;
});

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
  disposition: number;

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
    disposition: number
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
    this.disposition = disposition;
  }

  toJSON() {
    return {
      name: this.name,
      id: this.id,
      actorId: this.actorId,
      x: this.x,
      y: this.y,
      elevation: this.elevation,
      width: this.width,
      height: this.height,
      system: this.system,
      items: this.items,
      disposition: this.disposition
    };
  }

  static fromJSON(json: ReturnType<Entity["toJSON"]>): Entity {
    return new Entity(
      json.name,
      json.id,
      json.actorId,
      json.x,
      json.y,
      json.elevation,
      json.width,
      json.height,
      json.system,
      json.items,
      json.disposition
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

Hooks.on("getSceneControlButtons", controls => {
  if (controls["tokens"] == undefined) return;
  controls["tokens"].tools["sceneCalc"] = {
    name: "sceneCalc",
    title: "DNDModel.SceneCalc.Title",
    icon: "fa-solid fa-wrench",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      const activeScene = game.scenes?.active;
      if (!activeScene) return;
      const encodedScene = encodeScene(activeScene);
      if (encodedScene) {
        console.log("Encoded Scene State:", encodedScene);
      } else {
        console.error("Error encoding scene state");
      }
    }
  };

  controls["tokens"].tools["decodeScene"] = {
    name: "decodeScene",
    title: "DNDModel.DecodeScene.Title",
    icon: "fa-solid fa-download",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      const encoded = prompt("Paste encoded scene state:");
      if (!encoded) return;
      let decodedState;
      try {
        decodedState = decodeState(encoded);
        const activeScene = game.scenes?.active;
        if (!activeScene) return;
        for (const entity of decodedState.entities) {
          void generateEntity(entity, activeScene);
        }
      } catch (err) {
        console.error("Error decoding state:", err);
        return;
      }
    }
  };

  controls["tokens"].tools["randomAction"] = {
    name: "randomAction",
    title: "DNDModel.RandomAction.Title",
    icon: "fa-solid fa-dice",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      const activeScene = game.scenes?.active;
      if (!activeScene) return;
      const tokens = canvas?.tokens?.controlled;
      if (!tokens) return;
      for (const tokenObject of tokens) {
        const token = tokenObject.document;
        const actor = token.actor;
        if (!actor) continue;
        const entity = new Entity(token.name, token.id, actor.id, token.x, token.y, token.elevation, token.width, token.height, actor.system as unknown as CharacterData, actor.items.contents, token.disposition);
        const action = new RandomMoveAction(entity);
        action.act().catch((err: unknown) => {
          console.error(`Error performing action for entity ${entity.name}:`, err);
        });
      }
    }
  };

  controls["tokens"].tools["randomAttack"] = {
    name: "randomAttack",
    title: "DNDModel.RandomAttack.Title",
    icon: "fa-solid fa-sword",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      const activeScene = game.scenes?.active;
      if (!activeScene) return;
      const tokens = canvas?.tokens?.controlled;
      if (!tokens) return;
      for (const tokenObject of tokens) {
        const token = tokenObject.document;
        const actor = token.actor;
        if (!actor) continue;
        const entity = new Entity(token.name, token.id, actor.id, token.x, token.y, token.elevation, token.width, token.height, actor.system as unknown as CharacterData, actor.items.contents, token.disposition);
        const action = new RandomAttack(entity);
        action.act().catch((err: unknown) => {
          console.error(`Error performing action for entity ${entity.name}:`, err);
        });
      }
    }
  };

  controls["tokens"].tools["rollOut"] = {
    name: "rollOut",
    title: "DNDModel.RollOut.Title",
    icon: "fa-solid fa-dice-d20",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      void (async () => {
        const activeScene = game.scenes?.active;
        if (!activeScene) return;
        const tokens = canvas?.tokens?.controlled;
        if (!tokens) return;
        const log = {} as Record<number, TurnLogEntry>;
        // Popup that asks for max turns
        const maxTurnsStr = prompt("Enter number of turns to roll out:", "10");
        if (!maxTurnsStr) return;
        const maxTurns = parseInt(maxTurnsStr);
        if (isNaN(maxTurns) || maxTurns <= 0) {
          ui.notifications?.error("Invalid number of turns");
          return;
        }
        // Create combat, or hook into if already exists
        let createdCombat = false;
        let combat = game.combats?.viewed;
        if (!combat) {
          combat = await Combat.create({ scene: activeScene.id });
          for (const tokenObject of tokens) {
            const token = tokenObject.document;
            const actor = token.actor;
            if (!actor) return;
            await combat?.createEmbeddedDocuments("Combatant", [{ tokenId: token.id }]);
          }
          await combat?.startCombat();
          createdCombat = true;
        }
        if (!combat) return;
        let victor: number | null = null;
        let turnsTaken: number = maxTurns;
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

          const isDead = async () => {
            const currentHp = (actor.system as unknown as { attributes?: { hp?: { value?: number } } }).attributes?.hp?.value ?? 0;
            if (currentHp === 0) {
              console.log(`Combatant ${combatant.name} is at 0 HP, marking defeated`);
              await combatant.update({ defeated: true });
              await combat.nextTurn();
              return true;
            }
            return false;
          }
          
          if (await isDead()) continue;
          
          const entity = new Entity(token.name, token.id, actor.id, token.x, token.y, token.elevation, token.width, token.height, actor.system as unknown as CharacterData, actor.items.contents, token.disposition);
          const turnEvents: AttackResult[] = [];
          const moveAction = new RandomMoveAction(entity);
          await moveAction.act();
          // Check for reaction
          const reactionCheck = async (action: Action) => {
            for (const [tokenId, reacted] of Object.entries(action.triggeredReactions)) {
              if (reacted) {
                const reactionToken = activeScene.tokens.get(tokenId);
                if (!reactionToken) continue;
                const reactionActor = reactionToken.actor;
                if (!reactionActor) continue;
                // Random attack of opportunity
                const reactionEntity = new Entity(reactionToken.name, reactionToken.id, reactionActor.id, reactionToken.x, reactionToken.y, reactionToken.elevation, reactionToken.width, reactionToken.height, reactionActor.system as unknown as CharacterData, reactionActor.items.contents, reactionToken.disposition);
                const reAction = new RandomAttackOfOpportunity(reactionEntity);
                await reAction.act();
                turnEvents.push(...reAction.events);
              }
            }
          }
          await reactionCheck(moveAction);
          // Check if reaction killed you, if so, can't do second action
          if (!await isDead()) {
            // 50% chance to attack, 50% chance to dash (move again)
            let secondAction;
            if (Math.random() < 0.5) {
              secondAction = new RandomAttack(entity);
            } else {
              secondAction = new RandomMoveAction(entity);
            }
            await secondAction.act();
            turnEvents.push(...secondAction.events);
            await reactionCheck(secondAction);
          }
          
          // If all tokens of one dispositon are 0 HP, end early
          const dispositions = new Set<number>();
          for (const combatant of combat.combatants) {
            const token = activeScene.tokens.get(combatant.tokenId || "");
            if (!token) continue;
            const actor = token.actor;
            if (!actor) continue;
            const hp = (actor.system as unknown as { attributes?: { hp?: { value?: number } } }).attributes?.hp?.value ?? 0;
            if (hp > 0) {
              dispositions.add(token.disposition);
            }
          }
          if (dispositions.size <= 1) {
            console.log("All tokens of one disposition are at 0 HP, ending combat early");
            victor = dispositions.values().next().value ?? null;
            turnsTaken = turn + 1;
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
        ui.notifications?.info(`Rollout complete after ${turnsTaken} turns, or ${combat.round} rounds.${victor !== null ? ` Victor disposition: ${victor}` : ""}`);
        if (createdCombat) {
          await combat.endCombat();
        }
        saveLog(log).catch((err: unknown) => {
          console.error("Error saving log:", err)
        });
      })();
    }
  };

  controls["tokens"].tools["healAll"] = {
    name: "healAll",
    title: "DNDModel.HealAll.Title",
    icon: "fa-solid fa-heart",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      const activeScene = game.scenes?.active;
      if (!activeScene) return;
      const tokens = canvas?.tokens?.controlled;
      for (const token of tokens ?? []) {
        const actor = token.actor;
        if (!actor) continue;
        const hpMax = (actor.system as unknown as { attributes?: { hp?: { max?: number } } }).attributes?.hp?.max ?? 0;
        // @ts-expect-error DND5E has this, it doesn't know
        void actor.update({ "system.attributes.hp.value": hpMax });
      }
    }
  };
});


// function arrayBufferToBase64(ab: ArrayBuffer): string {
//   const buffer = Buffer.from(ab);
//   return buffer.toString('base64');
// }

// function base64ToArrayBuffer(b64: string): ArrayBuffer {
//   const buffer = Buffer.from(b64, 'base64');
//   return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
// }

async function saveLog(log: Record<number, TurnLogEntry>): Promise<void> {
  const worldId = game.world?.id ?? "unknown_world";
  const dir = `worlds/${worldId}/logs`;

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
    await foundry.applications.apps.FilePicker.createDirectory("data", dir);
  } catch (_err: unknown) {
    // Directory already existing is expected behaviour, no need to print warning
  }

  const file = new File([payload], filename, { type: "application/json" });

  await foundry.applications.apps.FilePicker.upload("data", dir, file, {}, { "notify": false });
}

export function encodeState(entitites: Entity[]): string {
  // Tensor unneeded for now
  // const name = "gridTensor";

  // const { data, specs } = await tf.io.encodeWeights({ [name]: gridTensor });

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
      Combat.create({ scene: game.scenes?.active?.id }).then(async combat => {
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

  // const data = base64ToArrayBuffer(payload.tensor.dataB64);
  // const weights = tf.io.decodeWeights(data, payload.tensor.specs);
  // const gridTensor = weights[payload.tensor.name];

  // if (!gridTensor) {
  //   throw new Error(`Tensor ${payload.tensor.name} not found in decoded weights`);
  // }

  const entities = payload.entities.map(e => Entity.fromJSON(e));

  return { entities };
}


function encodeScene(activeScene: Scene): string | undefined {
  const grid = activeScene.grid;
  if (grid.type !== 1) {
    ui.notifications?.warn("DNDModel.SceneCalc.GridTypeWarning");
    return undefined;
  }
  // const width = Math.floor(activeScene.dimensions.sceneWidth / grid.sizeX);
  // const height = Math.floor(activeScene.dimensions.sceneHeight / grid.sizeY);

  // const numTokens = activeScene.tokens.size;

  // Could be bools instead, but for now just leaving it default to simplify arithmetic
  // Boolean tensors could potentially save memory, but may be impractical
  // const gridBuffer = tf.buffer([width, height, numTokens]);

  // const paddingX = activeScene.dimensions.sceneWidth * activeScene.padding;
  // const paddingY = activeScene.dimensions.sceneHeight * activeScene.padding;
  const entities = [];
  for (const token of activeScene.tokens) {
    if (token.actor == null) continue;
    entities.push(new Entity(token.name, token.id, token.actor.id, token.x, token.y, token.elevation, token.width, token.height, token.actor.system as unknown as CharacterData, token.actor.items.contents, token.disposition));

    // const tokenIndex = entities.length - 1;

    // const xPos = Math.round((token.x - paddingX) / grid.sizeX);
    // const yPos = Math.round((token.y - paddingY) / grid.sizeY);

    // const tokenWidth = token.width;
    // const tokenHeight = token.height;

    // if (xPos >= 0 && xPos + tokenWidth < width && yPos >= 0 && yPos + tokenHeight < height) {
    //   for (let dx = 0; dx < tokenWidth; dx++) {
    //     for (let dy = 0; dy < tokenHeight; dy++) {
    //       gridBuffer.set(1, xPos + dx, yPos + dy, tokenIndex);
    //     }
    //   }
    // } else {
    //   console.warn(`Token ${token.name} at (${xPos}, ${yPos}) is out of bounds for grid ${width}x${height}`);
    // }
  }
  // const gridTensor = gridBuffer.toTensor();

  return encodeState(entities);
}

async function generateEntity(entity: Entity, scene: Scene) {
  if (scene.tokens.get(entity.id || "") != null) {
    const token = scene.tokens.get(entity.id || "");
    if (!token) return;
    await token.update({
      x: entity.x,
      y: entity.y,
      elevation: entity.elevation,
      width: entity.width,
      height: entity.height
    }, { animate: false });
    const actor = token.actor;
    if (!actor) return;
    await actor.update({ "system": entity.system });
    for (const item of actor.items) {
      await item.delete();
    }
    for (const itemData of entity.items) {
      await actor.createEmbeddedDocuments("Item", [itemData]);
    }
    return;
  }
  if (game.actors?.get(entity.actorId || "") != null) {
    const actor = game.actors.get(entity.actorId || "");
    if (!actor) return;
    const tokenData = await actor.getTokenDocument({
      x: entity.x,
      y: entity.y,
      elevation: entity.elevation,
      width: entity.width,
      height: entity.height,
      actorLink: false
    });
    const createdTokens = await scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
    const token = createdTokens[0];

    const tokenActor = token?.actor;
    if (!tokenActor) return;
    await tokenActor.update({ "system": entity.system });
    for (const item of tokenActor.items) {
      await item.delete();
    }
    for (const itemData of entity.items) {
      await tokenActor.createEmbeddedDocuments("Item", [itemData]);
    }
    return;
  } else {
    const tempActor = await getDocumentClass("Actor").create({
      "name": entity.name,
      // @ts-expect-error DND5e provides character, but we don't know about it
      "type": "character",
      "system": entity.system
    });
    if (!tempActor) return;
    const tokenData = await tempActor.getTokenDocument({
      x: entity.x,
      y: entity.y,
      elevation: entity.elevation,
      width: entity.width,
      height: entity.height,
      actorLink: false
    });
    const createdTokens = await scene.createEmbeddedDocuments("Token", [tokenData.toObject()]);
    const token = createdTokens[0];
    const tokenActor = token?.actor;
    if (!tokenActor) return;
    for (const itemData of entity.items) {
      await tokenActor.createEmbeddedDocuments("Item", [itemData]);
    }
    await tempActor.delete();
    return;
  }
}

function getAdjacentGridPositions(
  token: TokenDocument
): {x: number, y: number}[] {
  const scene = token.parent;
  if (!scene) return [];

  const topLeft = pixelToGrid(token.x, token.y, scene);
  if (!topLeft) return [];

  const tw = Math.max(1, Math.ceil(token.width));
  const th = Math.max(1, Math.ceil(token.height));
  const positions: {x: number, y: number}[] = [];

  for (let x = topLeft.x - 1; x <= topLeft.x + tw; x++) {
    for (let y = topLeft.y - 1; y <= topLeft.y + th; y++) {
      if (x >= topLeft.x && x < topLeft.x + tw && y >= topLeft.y && y < topLeft.y + th) continue;
      positions.push({ x, y });
    }
  }

  return positions;
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

type AdjacencyState = "None" | "Adjacent" | "Exited";
type Adjacency = {enemyTokenId: string, positions: {x: number, y: number}[], state: AdjacencyState}
type Adjacencies = Set<Adjacency>;

function getAdjacencyIntersection(path: {x: number, y: number}[], adjacency: Adjacency): AdjacencyState {
  for (const step of path) {
    // if you're ever adjacent, you're adjacent.
    // if you are ever not adjacent after previously being adjacent, you must have exited adjacency
    if (adjacency.positions.some(pos => pos.x === step.x && pos.y === step.y)) {
      if (adjacency.state === "None") {
          adjacency.state = "Adjacent";
      }
    } else {
      if (adjacency.state === "Adjacent") {
          adjacency.state = "Exited";
          return adjacency.state;
      }
    }
  }
  return adjacency.state;
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

function tokenToGridRect(token: TokenDocument, scene: Scene): GridRect | null {
  const topLeft = pixelToGrid(token.x, token.y, scene);
  if (!topLeft) return null;
  return { x: topLeft.x, y: topLeft.y, width: token.width, height: token.height };
}

function destinationIsOccupied(scene: Scene, dest: GridRect, movingTokenId: string): boolean {
  for (const token of scene.tokens) {
    if (token.id === movingTokenId) continue;
    const tokenRect = tokenToGridRect(token, scene);
    if (!tokenRect) continue;
    if (gridRectsOverlap(dest, tokenRect)) {
      return true;
    }
  }
  return false;
}

// Action space:
// Movement (if movement would be invalid, then just stay)
// Attack (if nothing is in range, then just do nothing)
// More later (rest of D&D actions)
// Actions:
// - Movement
// - Action
// - Bonus Action
// - Reaction
// For now, just movement and actions
class Action {
  entity: Entity;
  triggeredReactions: Record<string, boolean> = {};
  events: AttackResult[] = [];

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

  constructor(entity: Entity, targetX: number, targetY: number) {
    super(entity);
    this.targetX = targetX;
    this.targetY = targetY;
  }

  override async act() {
    // Move to targetX, targetY
    const entityToken = game.scenes?.active?.tokens.get(this.entity.id || "");
    if (!entityToken) return;
    const gridSize = game.scenes?.active?.grid.size;
    if (!gridSize) return;
    // convert x/y grid coordinates to pixel coordinates
    const activeScene = game.scenes.active;
    // Cap to scene bounds
    const width = Math.floor(activeScene.dimensions.sceneWidth / activeScene.grid.sizeX);
    const height = Math.floor(activeScene.dimensions.sceneHeight / activeScene.grid.sizeY);

    // Account for token footprint (width/height are in grid units). Target is the token's top-left grid cell.
    const tokenGridWidth = Math.max(1, Math.ceil(this.entity.width));
    const tokenGridHeight = Math.max(1, Math.ceil(this.entity.height));

    const maxTargetX = Math.max(0, width - tokenGridWidth);
    const maxTargetY = Math.max(0, height - tokenGridHeight);

    const cappedTargetX = Math.max(0, Math.min(maxTargetX, this.targetX));
    const cappedTargetY = Math.max(0, Math.min(maxTargetY, this.targetY));
    
    const pixelPos = gridToPixel(cappedTargetX, cappedTargetY, activeScene);
    if (!pixelPos) return;
    // Ignore if over movement speed (might need a capping later)
    const tokenObject = entityToken.object;
    if (!tokenObject) return;

    const destRect: GridRect = { x: cappedTargetX, y: cappedTargetY, width: tokenGridWidth, height: tokenGridHeight };
    if (destinationIsOccupied(activeScene, destRect, this.entity.id || "")) {
      console.log("Destination is occupied, not moving");
      return;
    }

    /* eslint-disable */
    // @ts-expect-error This is just wrong, createTerrainMovementPath does exist
    const cost = tokenObject.measureMovementPath(tokenObject.createTerrainMovementPath([{ x: entityToken.x, y: entityToken.y }, { x: pixelPos.x, y: pixelPos.y }], { "preview": false })).cost;
    /* eslint-enable */
    // ESLint is disabled because we don't have full V13 support yet. Also I'm doing typescript crimes because I'm evil
    console.log(cost);
    if (cost > ((this.entity.system as unknown as { attributes?: { movement?: { speed?: number } } }).attributes?.movement?.speed ?? 30)) {
      console.log("Exceeded movement speed, not moving");
      return;
    }

    const old_pos = { x: entityToken.getCenterPoint().x, y: entityToken.getCenterPoint().y };
    await entityToken.move({ x: pixelPos.x, y: pixelPos.y, snapped: true }, { animate: false });
    const path = getMovementGridPositions(old_pos, { x: entityToken.getCenterPoint().x, y: entityToken.getCenterPoint().y }, activeScene);
    console.log(path);
    // get all adjacencies of all tokens that are of a different disposition

    const adjacencies: Adjacencies = new Set();
    for (const token of activeScene.tokens) {
      if (token.disposition === entityToken.disposition) continue;
      adjacencies.add({enemyTokenId: token.id, positions: getAdjacentGridPositions(token), state: "None"});
    }
    
    for (const adjacency of adjacencies) {
      const state = getAdjacencyIntersection(path, adjacency);
      if (state === "Exited") {
        const exitedToken = activeScene.tokens.get(adjacency.enemyTokenId);
        console.log(`Entity ${this.entity.name} exited adjacency with token ${exitedToken?.name}`);
        this.triggeredReactions[adjacency.enemyTokenId] = true;
      }
    }
  }
}

class RandomMoveAction extends MoveAction {
  constructor(entity: Entity) {
    const movement_speed =
      (entity.system as unknown as { attributes?: { movement?: { speed?: number } } })
        .attributes?.movement?.speed ?? 30;
    const activeScene = game.scenes?.active;
    if (!activeScene) return;
    const gridPos = pixelToGrid(entity.x, entity.y, activeScene);
    if (!gridPos) return;
    const gridDistance = activeScene.grid.distance;
    const movement_units = Math.floor(movement_speed / gridDistance);
    const targetX = Math.round(gridPos.x + (Math.random() * 2 - 1) * movement_units);
    const targetY = Math.round(gridPos.y + (Math.random() * 2 - 1) * movement_units);
    super(entity, targetX, targetY);
  }

}

class Attack extends Action {
  range: number;
  weapon: string | undefined;
  targets: number | undefined;

  constructor(entity: Entity, range: number) {
    super(entity);
    this.range = range;
  }

  override async act() {
    // CURRENT PROBLEM: can attack through walls
    // possible solution is to just used 'walled' with walled templates
    // for now ignoring
    if (!canvas?.scene) return;
    const weaponName = this.weapon || "Unarmed Strike";
    const width = this.entity.width * canvas.scene.grid.size;
    const height = this.entity.height * canvas.scene.grid.size;
    const [templateDoc] = await canvas.scene.createEmbeddedDocuments("MeasuredTemplate", [{
      t: "circle" as const,
      angle: 0,
      direction: 0,
      distance: this.range,
      elevation: this.entity.elevation,
      x: this.entity.x + width / 2,
      y: this.entity.y + height / 2,
      borderColor: "#000000",
      fillColor: "#ffffff"
    }]);

    if (!templateDoc) return;

    if (!canvas.tokens) return;
    const oldTargets = game.user?.targets;
    // jank fix because the types aren't update for v13's setTargets()
    const tokensLayer = canvas.tokens as unknown as { setTargets?: (targets: unknown[]) => void };
    tokensLayer.setTargets?.([]);

    const templateObj = await waitForDrawMeasuredTemplate(templateDoc.id);
    if (!templateObj.shape) return;
    const validTokens = canvas.scene.tokens.filter(t => {
      return t.id !== this.entity.id && t.disposition !== this.entity.disposition;
    });
    const tokens = getTokensInTemplate(templateObj, canvas.scene, validTokens);

    if (tokens.length > 0) {
      // Remove dead targets
      const aliveTokens = tokens.filter(t => {
        const actor = t.actor;
        if (!actor) return false;
        const hpValue = (actor.system as unknown as { attributes?: { hp?: { value?: number } } }).attributes?.hp?.value ?? 0;
        return hpValue > 0;
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
          const result = await rollAttack(this.entity, weaponName);
          if (result) {
            result.kind = "action";
            this.events.push(result);
          }
        } catch (err: unknown) {
          console.error(`Error rolling damage for entity ${this.entity.name} with weapon ${weaponName}:`, err);
        }
     }
    } else {
      console.log(`Entity ${this.entity.name} found no targets in range to attack.`);
    }

    await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [templateDoc.id]);
    tokensLayer.setTargets?.(oldTargets ? Array.from(oldTargets) : []);
  }
}

class RandomAttack extends Attack {
  constructor(entity: Entity) {
    if (!canvas?.scene) return;
    const range = 1 * canvas.scene.grid.distance * 1.5;
    super(entity, range);
  }

  override async act() {
    // select random weapon from entity's items, or Unarmed Strike if none
    let weaponName = "Unarmed Strike";
    // random select from items that have type "weapon"
    // @ts-expect-error DND types don't have item types yet
    const weaponItems = this.entity.items.filter(i => i.type === "weapon");
    if (weaponItems.length > 0) {
      // Select from items that aren't Unarmed Strike, unless Unarmed Strike is the only weapon
      const nonUnarmedWeapons = weaponItems.filter(i => i.name !== "Unarmed Strike");
      const selectionPool = nonUnarmedWeapons.length > 0 ? nonUnarmedWeapons : weaponItems;
      const randomIndex = Math.floor(Math.random() * selectionPool.length);
      const randomWeapon = selectionPool.at(randomIndex);
      if (randomWeapon) weaponName = randomWeapon.name;
    } else {
     // If Unarmed Strike isn't in this entity's items, add it to the token by pulling from
     // the compendium
     if (!this.entity.id) return;
     if (!canvas?.tokens) return;
     if (!canvas.tokens.get(this.entity.id)?.actor?.items.getName("Unarmed Strike")) {
      if (!game.packs) return;
      const pack = game.packs.get("dnd5e.items");
      if (!pack) return;
      const index = await pack.getIndex();
      const entry = index.find(e => e.name === "Unarmed Strike");
      if (!entry) return;
      const itemData = await pack.getDocument(entry._id);
      if (!(itemData instanceof Item)) return;
      const actor = canvas.tokens.get(this.entity.id)?.actor;
      if (!actor) return;
        const itemSource = itemData.toObject();
        delete (itemSource as { _id?: string })._id;
        await actor.createEmbeddedDocuments("Item", [itemSource]);
     }
    }
    this.weapon = weaponName;
    this.targets = 1;
    await super.act();
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
    await this.attackAction.act();
    for (const event of this.attackAction.events) {
      event.kind = "reaction";
    }
    this.events.push(...this.attackAction.events);
  }
}

class RandomAttackOfOpportunity extends AttackOfOpportunity {
    constructor(entity: Entity) {
      super(entity, new RandomAttack(entity));
    }
}

// can be removed once dnd5e types is updated
type Activity = {
  type: string;
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

function isActivity(value: unknown): value is Activity {
  return isRecord(value) && typeof value["type"] === "string";
}

function getItemActivities(item: unknown): Activity[] {
  if (!isRecord(item)) return [];

  const system = item["system"];
  if (!isRecord(system)) return [];

  const activities = system["activities"];
  if (!isRecord(activities)) return [];

  const contents = activities["contents"];
  if (!Array.isArray(contents)) return [];

  return contents.filter(isActivity);
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

async function rollAttack(entity: Entity, weaponName: string): Promise<AttackResult | null> {
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

  // Activities workflow: the "skip dialog" switch is dialog.configure=false (2nd arg), not config.configure.
  const attackResult = await activity.rollAttack({}, { configure: false });
  const attackRolls = Array.isArray(attackResult) ? attackResult.filter(isAttackRollLike) : [];
  const attack = attackRolls[0];
  if (!attack) {
    console.error("No attack rolls returned for item", weaponName, attackResult);
    return null;
  }

  const result: AttackResult = {
    attacker: entity.name,
    attackerId: entity.id ?? "",
    weapon: weaponName,
    attackTotal: attack.total,
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
  let misses: number = 0;
  for (const target of targets) {
    const isCritical = attack.isCritical === true;
    const isFumble = attack.isFumble === true;
    // Grab the part of the UUID before the .Actor to get the token
    const beforeActor = target.uuid.split(".Actor")[0] ?? "";
    const targetTokenId = beforeActor.split("Token.")[1] ?? "";
    const targetToken = targetTokenId ? scene.tokens.get(targetTokenId) : undefined;
    if (!isCritical && ((attack.total < target.ac) || isFumble)) {
      console.log(`Attack missed target with AC ${target.ac}`);
      if (targetToken?.object) {
        targetToken.object.setTarget(false, { releaseOthers: false });// Deselect target on miss
      }
      result.targets.push({ name: targetToken?.name ?? "Unknown", tokenId: targetTokenId, ac: target.ac, hit: false, damageDealt: 0 });
      misses++;
    }
  }
  if (misses !== targets.length) {
    const damageResult = await activity.rollDamage({ isCritical: attack.isCritical === true }, { configure: false });
    const damageRolls = asDamageRollArray(damageResult);
    if (damageRolls.length === 0) {
      console.error(`No damage rolls returned for item ${weaponName}`);
      return result;
    }
    const multiplier: number = 1;
    const totalDamage = damageRolls.reduce((sum, dr) => sum + dr.total, 0);
    const damageData = buildDamageApplicationData(damageRolls);
    console.log(damageData);
    // Record hit results
    for (const target of targets) {
      const isCritical = attack.isCritical === true;
      const isFumble = attack.isFumble === true;
      if (isCritical || (attack.total >= target.ac && !isFumble)) {
        const beforeActor = target.uuid.split(".Actor")[0] ?? "";
        const targetTokenId = beforeActor.split("Token.")[1] ?? "";
        const targetToken = targetTokenId ? scene.tokens.get(targetTokenId) : undefined;
        result.targets.push({ name: targetToken?.name ?? "Unknown", tokenId: targetTokenId, ac: target.ac, hit: true, damageDealt: totalDamage });
      }
    }
    if (!game.user) return result;
    for (const token of game.user.targets) {
      if (!token.actor) continue;

      const damageActor = token.actor as unknown as DamageApplierActor;
      if (typeof damageActor.applyDamage !== "function") {
        console.warn("applyDamage is not available on this actor; skipping damage application.", damageActor);
        continue;
      }

      await damageActor.applyDamage(totalDamage, { multiplier: multiplier, damage: damageData });
    }

  }
  return result;
}

function waitForDrawMeasuredTemplate(templateId: string): Promise<foundry.canvas.placeables.MeasuredTemplate> {
  return new Promise((resolve) => {
    const hookId = Hooks.on("refreshMeasuredTemplate", (template: foundry.canvas.placeables.MeasuredTemplate) => {
      if (template.document.id === templateId) {
        Hooks.off("refreshMeasuredTemplate", hookId);
        resolve(template);
      }
    });
  });
}

function getTokensInTemplate(templateObj: foundry.canvas.placeables.MeasuredTemplate, scene: Scene, tokens: TokenDocument[]): TokenDocument[] {
  if (scene.grid.type !== 1) return [];

  const positions = (templateObj as unknown as { _getGridHighlightPositions: () => { x: number; y: number }[] })
    ._getGridHighlightPositions();

  const highlighted = new Set<string>();
  for (const position of positions) {
    const gridPos = pixelToGrid(position.x, position.y, scene);
    if (!gridPos) continue;
    highlighted.add(`${gridPos.x},${gridPos.y}`);
  }

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
    ui.notifications?.warn("DNDModel.SceneCalc.GridTypeWarning");
    return;
  }
  const width = Math.floor(scene.dimensions.sceneWidth / grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / grid.sizeY);

  const paddingX = scene.dimensions.sceneWidth * scene.padding;
  const paddingY = scene.dimensions.sceneHeight * scene.padding;

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
    ui.notifications?.warn("DNDModel.SceneCalc.GridTypeWarning");
    return;
  }
  const width = Math.floor(scene.dimensions.sceneWidth / grid.sizeX);
  const height = Math.floor(scene.dimensions.sceneHeight / grid.sizeY);

  const paddingX = scene.dimensions.sceneWidth * scene.padding;
  const paddingY = scene.dimensions.sceneHeight * scene.padding;

  const gridX = Math.floor((pixelX - paddingX) / grid.sizeX);
  const gridY = Math.floor((pixelY - paddingY) / grid.sizeY);

  if (gridX >= 0 && gridX < width && gridY >= 0 && gridY < height) {
    return { x: gridX, y: gridY };
  } else {
    console.warn(`Pixel position (${pixelX}, ${pixelY}) is out of bounds for scene ${scene.id}`);
    return;
  }
}