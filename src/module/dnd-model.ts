import * as tf from '@tensorflow/tfjs';

Hooks.on("ready", () => {
  console.log("DNDModel Initialized! | TensorFlow.js version:", tf.version.tfjs);
});

class Entity {
  name: string;
  id: string;
  actorId: string | null;
  x: number;
  y: number;
  elevation: number;
  size: number;
  system: CharacterData; 
  items: Object;
  
  constructor(name: string, id: string, actorId: string | null, x: number, y: number, elevation: number, size: number, system: CharacterData, items: Object) {
    this.name = name;
    this.id = id;
    this.actorId = actorId;
    this.x = x;
    this.y = y;
    this.elevation = elevation;
    this.size = size;
    this.system = system;
    this.items = items;
  }
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
        entities.push(new Entity(token.name, token.id, token.actor.id, token.x, token.y, token.elevation, token.width, token.actor.system as unknown as CharacterData, token.actor.itemTypes));

        const tokenIndex = entities.length - 1;

        const xPos = Math.round((token.x - paddingX)/grid.sizeX);
        const yPos = Math.round((token.y - paddingY)/grid.sizeY);

        const tokenWidth = token.width;
        
        if (xPos >= 0 && xPos + tokenWidth < width && yPos >= 0 && yPos + tokenWidth < height) {
          for (let dx = 0; dx < tokenWidth; dx++) {
            for (let dy = 0; dy < tokenWidth; dy++) {
              gridBuffer.set(1, xPos + dx, yPos + dy, tokenIndex);
            }
          }
        } else {
          console.warn(`Token ${token.name} at (${xPos}, ${yPos}) is out of bounds for grid ${width}x${height}`);
        }
      }
      const gridTensor = gridBuffer.toTensor();
      console.log(gridTensor.transpose().toString());
      console.log(entities);
    }
  };
});

async function generateActorlessToken(x: number, y: number) {
  const tempActor: Actor = await getDocumentClass("Actor").create({
    "name": "test",
    "type": "character"
  })
  const tokenData = await tempActor.getTokenDocument();
  const data = canvas.grid.getSnappedPoint((x - tokenData.width / 2), (y - tokenData.height / 2), 1);
  data.actorLink = false;
  const tokenUpdate = await tempActor.getTokenDocument(data);
  await canvas.scene.createEmbeddedDocuments("Token", [tokenUpdate.toObject()]);
  tempActor.delete();
}