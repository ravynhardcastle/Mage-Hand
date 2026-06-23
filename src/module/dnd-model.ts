import * as tf from '@tensorflow/tfjs';
import * as buffer from 'buffer';
import type { UpdateData } from "./configuration";
import { MODULE_ID, RANDOM_SPELL_EXCLUSIONS_SETTING_KEY, DEFAULT_RANDOM_SPELL_EXCLUSIONS, ROLLOUT_QUEUE_SETTING_KEY } from "./constants";
import { actorSys } from "./foundry-helpers";
import { getActorDeathSaves, isActorAtZeroHp, rollActorDeathSave } from "./actor-status";
import { Entity, encodeScene, generateEntity, decodeState, restoreCombatRound } from "./entity";
import { getCastableSpellsForRandomAction, isFlamingSphereSpell, isSpiritualWeaponSpell } from "./spells";
import { breakInvisibilityOnAttack } from "./spell-execution";
import { hasEnemyInMeleeRange } from "./combat";
import { RandomAttack, RandomMoveAction, RandomSpellAction, SmartAttack, reactionCheck } from "./actions";
import {
  anySceneHasActiveRollout,
  executeNextRun,
  getRolloutQueue,
  getRolloutState,
  rolloutManager,
  setRolloutQueue,
  startNextQueuedRollout,
  startRollout,
  type RolloutParams,
} from "./rollout";

CONFIG.debug.hooks = false;

// Spiritual Weapon / Flaming Sphere build their own templates (because using the real dnd5e
// way freezes rollouts for some reason)
Hooks.on("dnd5e.preUseActivity", (activity, usageConfig) => {
  if (activity.item && (isSpiritualWeaponSpell(activity.item) || isFlamingSphereSpell(activity.item))) {
    usageConfig.create = { ...usageConfig.create, measuredTemplate: false };
  }
  return undefined;
});

Hooks.on("midi-qol.AttackRollComplete", (workflow) => {
  void breakInvisibilityOnAttack(workflow.actor);
});

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === "&" ? "&amp;"
    : c === "<" ? "&lt;"
    : c === ">" ? "&gt;"
    : c === '"' ? "&quot;"
    : "&#39;"
  );
}

function readRolloutForm(form: HTMLFormElement): (RolloutParams & { targetSceneId: string }) | null {
  const el = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
  const maxRounds = Number(el("maxRounds")?.value);
  const numRuns = Number(el("numRuns")?.value);
  if (!Number.isFinite(maxRounds) || maxRounds <= 0 || !Number.isFinite(numRuns) || numRuns <= 0) {
    ui.notifications?.error("Invalid input");
    return null;
  }
  const logFolder = (el("logFolder")?.value ?? "").trim() || undefined;
  return {
    maxRounds,
    numRuns,
    logFolder,
    saveLog: (el("saveLog") as HTMLInputElement | null)?.checked ?? true,
    refreshInterval: Math.max(0, Number(el("refreshInterval")?.value) || 0),
    smartMoveBias: Math.max(0, Math.min(1, Number(el("smartMoveBias")?.value) || 0)),
    targetSceneId: el("targetSceneId")?.value ?? "",
  };
}

function renderQueueList(): string {
  const queue = getRolloutQueue();
  if (queue.length === 0) return `<p style="opacity:0.7;font-style:italic;margin:0;">No queued rollouts.</p>`;
  const rows = queue.map(job => {
    const queuedScene = game.scenes?.get(job.sceneId);
    const sceneName = queuedScene?.name ?? `(missing scene ${job.sceneId})`;
    const folder = job.logFolder ? ` &middot; ${escapeHtml(job.logFolder)}` : "";
    return `<li style="display:flex;align-items:center;gap:6px;padding:2px 0;">
      <span style="flex:1;">${escapeHtml(sceneName)} &middot; ${job.numRuns}\u00d7${job.maxRounds}r &middot; bias ${job.smartMoveBias}${folder}</span>
      <button type="button" class="dnd-model-queue-remove" data-job-id="${escapeHtml(job.id)}" title="Remove" style="background:none;border:1px solid #888;border-radius:3px;cursor:pointer;padding:1px 6px;">\u2715</button>
    </li>`;
  }).join("");
  return `<ul style="list-style:none;padding:0;margin:0;max-height:160px;overflow-y:auto;">${rows}</ul>`;
}

async function openRolloutDialog(): Promise<void> {
  const activeScene = canvas?.scene ?? game.scenes?.active;
  if (!activeScene) {
    ui.notifications?.warn("No active scene.");
    return;
  }

  const sceneOptions = (game.scenes?.contents ?? []).filter(s => s.navigation).map(s => {
    const sel = s.id === activeScene.id ? " selected" : "";
    return `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(s.name)}</option>`;
  }).join("");

  const content = `
    <div class="form-group"><label>Rounds per run</label><input name="maxRounds" type="number" min="1" value="10" autofocus /></div>
    <div class="form-group"><label>Number of runs</label><input name="numRuns" type="number" min="1" value="1" /></div>
    <div class="form-group"><label>Log folder name (optional)</label><input name="logFolder" type="text" placeholder="e.g. goblin-vs-fighter" /></div>
    <div class="form-group"><label>Save log</label><input name="saveLog" type="checkbox" checked /></div>
    <div class="form-group"><label>Refresh browser every N runs (0 = never)</label><input name="refreshInterval" type="number" min="0" value="5" /></div>
    <div class="form-group"><label>Smart move enemy bias (0 = random, 1 = always toward nearest enemy)</label><input name="smartMoveBias" type="number" min="0" max="1" step="0.05" value="0.5" /></div>
    <hr/>
    <div class="form-group"><label>Queue target scene</label><select name="targetSceneId">${sceneOptions}</select></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
      <strong>Queued rollouts</strong>
      <button type="button" id="dnd-model-queue-clear" style="background:none;border:1px solid #888;border-radius:3px;cursor:pointer;padding:1px 8px;">Clear queue</button>
    </div>
    <div id="dnd-model-queue-list" style="margin-top:4px;">${renderQueueList()}</div>
  `;

  const dialog = new foundry.applications.api.DialogV2({
    window: { title: "Rollout Configuration" },
    content,
    buttons: [
      {
        action: "rollNow",
        label: "Roll Out Now",
        icon: "fa-solid fa-dice-d20",
        default: true,
        callback: (_event, button) => {
          const form = button.form;
          if (!form) return null;
          const data = readRolloutForm(form);
          if (!data) return null;
          void startRollout(activeScene, data);
          return "rollNow";
        },
      },
      { action: "addQueue", label: "Add to Queue", icon: "fa-solid fa-plus", type: "button" },
      { action: "close", label: "Close", icon: "fa-solid fa-xmark", callback: () => "close" },
    ],
  });

  type RenderFn = (...a: unknown[]) => Promise<void>;
  const dialogObj = dialog as unknown as { _onRender?: RenderFn; element: HTMLElement | null };
  const origRender = dialogObj._onRender;
  dialogObj._onRender = async function (...args: unknown[]) {
    if (origRender) await origRender.apply(dialog, args);
    const root = dialogObj.element;
    if (!(root instanceof HTMLElement)) return;

    const refreshList = () => {
      const listEl = root.querySelector("#dnd-model-queue-list");
      if (listEl) listEl.innerHTML = renderQueueList();
      root.querySelectorAll<HTMLButtonElement>(".dnd-model-queue-remove").forEach(btn => {
        btn.addEventListener("click", ev => {
          ev.preventDefault();
          const id = btn.dataset["jobId"];
          if (!id) return;
          void setRolloutQueue(getRolloutQueue().filter(j => j.id !== id)).then(refreshList);
        });
      });
    };
    refreshList();

    root.querySelector<HTMLButtonElement>("#dnd-model-queue-clear")?.addEventListener("click", ev => {
      ev.preventDefault();
      void setRolloutQueue([]).then(refreshList);
    });

    root.querySelector<HTMLButtonElement>("button[data-action='addQueue']")?.addEventListener("click", ev => {
      ev.preventDefault();
      const form = root.querySelector<HTMLFormElement>("form");
      if (!form) return;
      const data = readRolloutForm(form);
      if (!data) return;
      if (!data.targetSceneId) {
        ui.notifications?.error("Pick a target scene to queue.");
        return;
      }
      const { targetSceneId, ...params } = data;
      const id = crypto.randomUUID();
      void setRolloutQueue([...getRolloutQueue(), { id, sceneId: targetSceneId, ...params }]).then(() => {
        const queuedScene = game.scenes?.get(targetSceneId);
        const sceneName = queuedScene?.name ?? targetSceneId;
        ui.notifications?.info(`Queued rollout for "${sceneName}". (${getRolloutQueue().length} total)`);
        refreshList();
      });
    });
  };

  await dialog.render({ force: true });
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
  game.settings?.register(MODULE_ID, ROLLOUT_QUEUE_SETTING_KEY, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });
});

Hooks.on("ready", () => {
  console.log("DNDModel Initialized! | TensorFlow.js version:", tf.version.tfjs);
  window.Buffer = buffer.Buffer;

  const tryResumeRollout = () => {
    const scene = canvas?.scene ?? game.scenes?.active;
    if (!scene) return;
    const state = getRolloutState(scene);
    if (!state) {
      if (!anySceneHasActiveRollout() && getRolloutQueue().length > 0) {
        void startNextQueuedRollout();
      }
      return;
    }

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
        void restoreCombatRound(decodedState.round);
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

  controls["tokens"].tools["smartAttack"] = {
    name: "smartAttack",
    title: "Smart Attack",
    icon: "fa-solid fa-crosshairs",
    order: Object.keys(controls["tokens"].tools).length,
    button: true,
    visible: game.user?.isGM,
    onChange: () => { forSelectedTokens(entity => new SmartAttack(entity, 1).act()); },
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
    onChange: () => { void openRolloutDialog(); }
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