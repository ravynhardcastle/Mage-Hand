const {ApplicationV2} = foundry.applications.api;

class SceneCalc extends ApplicationV2 {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.DEFAULT_OPTIONS, {
      id: "scene-calc",
      title: "Scene Calculator",
    });
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
      const existing = foundry.applications.instances.get("scene-calc");
      if ( existing ) existing.close();
      else new SceneCalc().render({force: true});
    }
  };
});
