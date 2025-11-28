import * as tf from '@tensorflow/tfjs';

Hooks.on("ready", () => {
  console.log("DNDModel Initialized! | TensorFlow.js version:", tf.version.tfjs);
});

class Entity {
  x: number;
  y: number;
  size: number;
  system: CharacterData; 
  
  constructor(x: number, y: number, size: number, system: CharacterData) {
    this.x = x;
    this.y = y;
    this.size = size;
    this.system = system;
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
        entities.push(new Entity(token.x, token.y, token.width, token.actor.system as unknown as CharacterData));

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
