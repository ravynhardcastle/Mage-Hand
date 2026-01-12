import * as tf from '@tensorflow/tfjs';
import * as buffer from 'buffer';

CONFIG.debug.hooks = false;

const payload_version: number = 1;

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
  tensor: {
    name: string;
    specs: tf.io.WeightsManifestEntry[];
    dataB64: string;
  };
  entities: ReturnType<Entity["toJSON"]>[];
}

function arrayBufferToBase64(ab: ArrayBuffer): string {
  const buffer = Buffer.from(ab);
  return buffer.toString('base64');
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const buffer = Buffer.from(b64, 'base64');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

export async function encodeState(gridTensor: tf.Tensor, entitites: Entity[]): Promise<string> {
  const name = "gridTensor";

  const { data, specs } = await tf.io.encodeWeights({ [name]: gridTensor });

  const payload: EncodedState = {
    version: payload_version,
    tensor: {
      name,
      specs,
      dataB64: arrayBufferToBase64(data)
    },
    entities: entitites.map(e => e.toJSON())
  };

  return JSON.stringify(payload);
}

export function decodeState(encoded: string): { gridTensor: tf.Tensor; entities: Entity[] } {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload: EncodedState = JSON.parse(encoded);

  if (payload.version !== payload_version) {
    throw new Error(`Unsupported payload version: ${payload.version}`);
  }

  const data = base64ToArrayBuffer(payload.tensor.dataB64);
  const weights = tf.io.decodeWeights(data, payload.tensor.specs);
  const gridTensor = weights[payload.tensor.name];

  if (!gridTensor) {
    throw new Error(`Tensor ${payload.tensor.name} not found in decoded weights`);
  }

  const entities = payload.entities.map(e => Entity.fromJSON(e));

  return { gridTensor, entities };
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
      const grid = activeScene.grid;
      if (grid.type !== 1) {
        ui.notifications?.warn("DNDModel.SceneCalc.GridTypeWarning");
        return;
      }
      const width = Math.floor(activeScene.dimensions.sceneWidth / grid.sizeX);
      const height = Math.floor(activeScene.dimensions.sceneHeight / grid.sizeY);

      const numTokens = activeScene.tokens.size;

      // Could be bools instead, but for now just leaving it default to simplify arithmetic
      // Boolean tensors could potentially save memory, but may be impractical
      const gridBuffer = tf.buffer([width, height, numTokens]);

      const paddingX = activeScene.dimensions.sceneWidth * activeScene.padding;
      const paddingY = activeScene.dimensions.sceneHeight * activeScene.padding;
      const entities = [];
      for (const token of activeScene.tokens) {
        if (token.actor == null) continue;
        entities.push(new Entity(token.name, token.id, token.actor.id, token.x, token.y, token.elevation, token.width, token.height, token.actor.system as unknown as CharacterData, token.actor.items.contents, token.disposition));

        const tokenIndex = entities.length - 1;

        const xPos = Math.round((token.x - paddingX) / grid.sizeX);
        const yPos = Math.round((token.y - paddingY) / grid.sizeY);

        const tokenWidth = token.width;
        const tokenHeight = token.height;

        if (xPos >= 0 && xPos + tokenWidth < width && yPos >= 0 && yPos + tokenHeight < height) {
          for (let dx = 0; dx < tokenWidth; dx++) {
            for (let dy = 0; dy < tokenHeight; dy++) {
              gridBuffer.set(1, xPos + dx, yPos + dy, tokenIndex);
            }
          }
        } else {
          console.warn(`Token ${token.name} at (${xPos}, ${yPos}) is out of bounds for grid ${width}x${height}`);
        }
      }
      const gridTensor = gridBuffer.toTensor();
      console.log("Tensor:", gridTensor.transpose().toString());
      console.log("Entities:", entities);

      encodeState(gridTensor, entities).then(encoded => {
        console.log("Encoded State:", encoded);
        const decodedState = decodeState(encoded);
        console.log("Decoded Tensor:", decodedState.gridTensor.transpose().toString());
        console.log("Decoded Entities:", decodedState.entities);
      }).catch((err: unknown) => {
        console.error("Error encoding state:", err);
      });

      for (const entity of entities) {
        void generateEntity(entity, activeScene);
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
});

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


    await entityToken.move({ x: pixelPos.x, y: pixelPos.y, snapped: true }, { animate: true });
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

  constructor(entity: Entity, range: number) {
    super(entity);
    this.range = range;
  }

  override async act() {
    if (!canvas?.scene) return;
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
      console.log(`Entity ${this.entity.name} attacks tokens:`, tokens.map(t => t.name));
      for (const token of tokens) {
        if (!token.object) continue;
        token.object.setTarget();
      }
    } else {
      console.log(`Entity ${this.entity.name} found no targets in range to attack.`);
    }

    await canvas.scene.deleteEmbeddedDocuments("MeasuredTemplate", [templateDoc.id]);

  }
}

class RandomAttack extends Attack {
  constructor(entity: Entity) {
    if (!canvas?.scene) return;
    const range = 1 * canvas.scene.grid.distance * 1.5;
    super(entity, range);
  }
}

function waitForDrawMeasuredTemplate(templateId: string): Promise<foundry.canvas.placeables.MeasuredTemplate> {
  return new Promise((resolve) => {
    const hookId = Hooks.on("refreshMeasuredTemplate", (template: foundry.canvas.placeables.MeasuredTemplate) => {
      if (template.document.id === templateId) {
        Hooks.off("refreshMeasuredTemplate", hookId);
        resolve(template);
        console.log(template);
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