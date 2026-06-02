import * as tf from '@tensorflow/tfjs';
import * as buffer from 'buffer';
import type { RolloutState, UpdateData } from "./configuration";
import { MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY, DEFAULT_RANDOM_SPELL_EXCLUSIONS } from "./constants";
import { actorSys } from "./foundry-helpers";
import { getActorDeathSaves, isActorAtZeroHp, rollActorDeathSave } from "./actor-status";
import { Entity, encodeScene, generateEntity, decodeState } from "./entity";
import { getCastableSpellsForRandomAction } from "./spells";
import { hasEnemyInMeleeRange } from "./combat";
import { RandomAttack, RandomMoveAction, RandomSpellAction, reactionCheck } from "./actions";
import { executeNextRun, getRolloutState, rolloutManager, setRolloutState } from "./rollout";

CONFIG.debug.hooks = false;

export { encodeState, decodeState } from "./entity";

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

Hooks.once("init", () => {
  game.settings?.register(MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY, {
    name: "Random Spell Exclusions",
    hint: "Comma-separated spell/cantrip names to exclude from random spell casting.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_RANDOM_SPELL_EXCLUSIONS.join(", "),
  });
});

Hooks.on("ready", () => {
  console.log("DNDModel Initialized! | TensorFlow.js version:", tf.version.tfjs);
  window.Buffer = buffer.Buffer;

  const tryResumeRollout = () => {
    const scene = canvas?.scene ?? game.scenes?.active;
    if (!scene) return;
    const state = getRolloutState(scene);
    if (!state) return;

    rolloutManager.reset();

    if (state.status === "running") {
      console.log(`[dnd-model] Resuming rollout from run ${state.completedRuns + 1} / ${state.numRuns}`);
      ui.notifications?.info(`Resuming rollout from run ${state.completedRuns + 1} / ${state.numRuns}...`);
      rolloutManager.startHUD(scene);
      rolloutManager.updateHUD(state.completedRuns + 1, state.numRuns, false);
      void executeNextRun(scene);
    } else {
      console.log(`[dnd-model] Rollout paused at run ${state.completedRuns} / ${state.numRuns}`);
      ui.notifications?.info(`Rollout paused at run ${state.completedRuns} / ${state.numRuns}. Click play to resume.`);
      rolloutManager.startHUD(scene);
      rolloutManager.updateHUD(state.completedRuns, state.numRuns, true);
    }
  };

  if (canvas?.scene) {
    tryResumeRollout();
  } else {
    Hooks.once("canvasReady", tryResumeRollout);
  }
});

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
    title: "DNDModel.DecodeScene.Title",
    icon: "fa-solid fa-download",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      const encoded = prompt("Paste encoded scene state:");
      if (!encoded) return;
      try {
        const decodedState = decodeState(encoded);
        const scene = canvas?.scene ?? game.scenes?.active;
        if (!scene) return;
        for (const entity of decodedState.entities) {
          void generateEntity(entity, scene);
        }
      } catch (err) {
        console.error("Error decoding state:", err);
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
            try { await action.act(); }
            catch (err: unknown) { console.error(`Error performing action for entity ${entity.name}:`, err); }
            continue;
          }

          const roll = Math.random();
          const action = hasCastableSpell && roll < 0.34
            ? new RandomSpellAction(entity)
            : roll < 0.67
              ? new RandomAttack(entity)
              : new RandomMoveAction(entity);
          try { await action.act(); }
          catch (err: unknown) { console.error(`Error performing action for entity ${entity.name}:`, err); }
        }
      })();
    }
  };

  controls["tokens"].tools["randomAttack"] = {
    name: "randomAttack",
    title: "DNDModel.RandomAttack.Title",
    icon: "fa-solid fa-sword",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => { forSelectedTokens(entity => new RandomAttack(entity).act()); },
  };

  controls["tokens"].tools["randomMove"] = {
    name: "randomMove",
    title: "Random Move",
    icon: "fa-solid fa-shoe-prints",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => { forSelectedTokens(entity => new RandomMoveAction(entity).act()); },
  };

  controls["tokens"].tools["randomSpell"] = {
    name: "randomSpell",
    title: "Random Spell/Cantrip",
    icon: "fa-solid fa-wand-magic-sparkles",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      forSelectedTokens(async (entity, token) => {
        const actor = token.actor;
        if (!actor || getCastableSpellsForRandomAction(actor).length === 0) return;
        const spellsBefore = foundry.utils.deepClone(actorSys(actor).spells ?? {});
        await new RandomSpellAction(entity).act();
        await actor.update({ "system.spells": spellsBefore } as UpdateData);
      });
    },
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
            ui.notifications?.warn("No combat is active. Select tokens for rollout.");
            return;
          }
        }

        const formData = await foundry.applications.api.DialogV2.input({
          window: { title: "Rollout Configuration" },
          content: `
            <div class="form-group">
              <label>Rounds per run</label>
              <input name="maxRounds" type="number" min="1" value="10" autofocus />
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
              <label>Save log</label>
              <input name="saveLog" type="checkbox" checked />
            </div>
            <div class="form-group">
              <label>Refresh browser every N runs (0 = never)</label>
              <input name="refreshInterval" type="number" min="0" value="20" />
            </div>
            <div class="form-group">
              <label>Smart move enemy bias (0 = random, 1 = always toward nearest enemy)</label>
              <input name="smartMoveBias" type="number" min="0" max="1" step="0.05" value="0" />
            </div>
          `,
          ok: { label: "Roll Out", icon: "fa-solid fa-dice-d20" },
          rejectClose: false,
        }) as { maxRounds: string; numRuns: string; logFolder: string; saveLog: boolean; refreshInterval: string; smartMoveBias: string } | null;
        if (!formData) return;
        const maxRounds = Number(formData.maxRounds);
        const numRuns = Number(formData.numRuns);
        const logFolder = formData.logFolder.trim() || undefined;
        const saveLog = formData.saveLog;
        const refreshInterval = Math.max(0, Number(formData.refreshInterval) || 0);
        const smartMoveBias = Math.max(0, Math.min(1, Number(formData.smartMoveBias) || 0));
        if (isNaN(maxRounds) || maxRounds <= 0 || isNaN(numRuns) || numRuns <= 0) {
          ui.notifications?.error("Invalid input");
          return;
        }

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

        const rolloutState: RolloutState = {
          status: "running",
          completedRuns: 0,
          maxRounds,
          numRuns,
          logFolder,
          saveLog,
          refreshInterval,
          smartMoveBias,
          startingState,
          rolloutParticipants: rolloutParticipants.map(p => ({ tokenId: p.tokenId })),
          originalCombatData,
        };
        await setRolloutState(activeScene, rolloutState);
        rolloutManager.reset();
        rolloutManager.startHUD(activeScene);
        rolloutManager.updateHUD(1, numRuns, false);
        void executeNextRun(activeScene);
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
      for (const token of (canvas?.tokens?.controlled ?? [])) {
        const actor = token.actor;
        if (!actor) continue;
        const hpMax = actorSys(actor).attributes?.hp?.max ?? 0;
        void actor.update({ "system.attributes.hp.value": hpMax } as UpdateData);
      }
    }
  };

  controls["tokens"].tools["testDeathSave"] = {
    name: "testDeathSave",
    title: "DNDModel.TestDeathSave.Title",
    icon: "fa-solid fa-skull",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      forSelectedTokens(async (_entity, _token, _scene) => {
        const actor = _token.actor;
        if (!actor) return;
        if (!isActorAtZeroHp(actor)) {
          ui.notifications?.warn(`${actor.name} is not at 0 HP`);
          return;
        }
        const result = await rollActorDeathSave(_token);
        const saves = getActorDeathSaves(actor);
        const status = result.dead ? "DEAD" : result.rolledNat20 ? "NAT 20, revived!" : result.stabilized ? "Stabilized" : "Still rolling";
        ui.notifications?.info(`${actor.name} death save: ${status} (${saves.success} successes, ${saves.failure} failures)`);
      });
    },
  };

  controls["tokens"].tools["testReaction"] = {
    name: "testReaction",
    title: "DNDModel.TestReaction.Title",
    icon: "fa-solid fa-bell",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => {
      forSelectedTokens(async (entity, token, scene) => {
        const action = new RandomMoveAction(entity);
        await action.act();
        const canFreeDisengage = token.actor?.items.some(i => i.name === "Nimble Escape");
        if (!canFreeDisengage) {
          await reactionCheck(action, scene, entity, new Set<string>(), []);
        }
      });
    },
  };
});

// remove this later once the warning is gone
Hooks.once("init", () => {
  CONFIG.compatibility.excludePatterns.push(/senses\.\w+ has moved to "senses\.ranges/);
});