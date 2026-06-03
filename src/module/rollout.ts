import type { RolloutState } from "./configuration";
import { MODULE_ID, ROLLOUT_STATE_FLAG_KEY, TURNED_FLAG_KEY, payload_version } from "./constants";
import { actorHasStatusEffect, getActorDeathSaves, isActorAtZeroHp, isActorUnableToAct, isActorUnconscious, rollActorDeathSave, setActorStabilized, setActorStatusEffect } from "./actor-status";
import { Entity, encodeScene, restoreSceneState, type AttackResult, type TurnLogEntry } from "./entity";
import { checkNearbyReactions, clearRangePositionsCache } from "./combat";
import { Action, RandomBonusSpellAction, SmartAttack, SmartMoveAction, TurnedFleeAction, reactionCheck } from "./actions";
import { getCastableBonusActionSpells } from "./spells";
import { applyActionSurge, applyPreserveLife, applySecondWind, applyTurnUndead, clearCharmPersonForDamaged, clearExpiredCharms, clearExpiredSanctuaries, isCharmedByEnemy, tryHoldPersonEndOfTurnSave } from "./spell-execution";

class RolloutManager {
  paused = false;
  stopped = false;
  hudEl: HTMLDivElement | null = null;
  unconsciousRoundMap = new Map<string, number>();

  reset(): void {
    this.paused = false;
    this.stopped = false;
  }

  createHUD(onPause: () => void, onStop: () => void): void {
    if (this.hudEl) return;
    const hud = document.createElement("div");
    hud.id = "dnd-model-rollout-hud";
    hud.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:999;background:#1a1a2e;color:#e0e0e0;border:1px solid #444;border-radius:6px;padding:6px 14px;display:flex;align-items:center;gap:10px;font-family:sans-serif;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.5);";

    const label = document.createElement("span");
    label.id = "dnd-model-rollout-hud-label";
    label.textContent = "Run 0 / 0";
    hud.appendChild(label);

    const pauseBtn = document.createElement("button");
    pauseBtn.id = "dnd-model-rollout-hud-pause";
    pauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    pauseBtn.title = "Pause";
    pauseBtn.style.cssText = "background:none;border:1px solid #666;color:#e0e0e0;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:13px;";
    pauseBtn.addEventListener("click", onPause);
    hud.appendChild(pauseBtn);

    const stopBtn = document.createElement("button");
    stopBtn.innerHTML = '<i class="fa-solid fa-stop"></i>';
    stopBtn.title = "Stop";
    stopBtn.style.cssText = "background:none;border:1px solid #666;color:#e0e0e0;cursor:pointer;padding:4px 8px;border-radius:4px;font-size:13px;";
    stopBtn.addEventListener("click", onStop);
    hud.appendChild(stopBtn);

    document.body.appendChild(hud);
    this.hudEl = hud;
  }

  updateHUD(run: number, total: number, paused: boolean): void {
    const label = document.getElementById("dnd-model-rollout-hud-label");
    if (label) label.textContent = paused ? `Paused at run ${run} / ${total}` : `Run ${run} / ${total}`;
    const pauseBtn = document.getElementById("dnd-model-rollout-hud-pause");
    if (pauseBtn) {
      pauseBtn.innerHTML = paused ? '<i class="fa-solid fa-play"></i>' : '<i class="fa-solid fa-pause"></i>';
      pauseBtn.title = paused ? "Resume" : "Pause";
    }
  }

  startHUD(scene: Scene): void {
    const onPauseOrResume = () => {
      if (this.paused) {
        this.paused = false;
        const state = getRolloutState(scene);
        if (state) {
          void setRolloutState(scene, { ...state, status: "running" }).then(() => {
            this.updateHUD(state.completedRuns + 1, state.numRuns, false);
            void executeNextRun(scene);
          });
        }
      } else {
        this.paused = true;
      }
    };
    const onStop = () => {
      if (this.paused) {
        void finishRollout(scene, true);
      } else {
        this.stopped = true;
      }
    };
    this.createHUD(onPauseOrResume, onStop);
  }
}

export const rolloutManager = new RolloutManager();

export function getRolloutState(scene: Scene): RolloutState | null {
  const raw = scene.getFlag(MODULE_ID, ROLLOUT_STATE_FLAG_KEY);
  return (raw && typeof raw === "object" && "status" in raw) ? raw : null;
}

export async function setRolloutState(scene: Scene, state: RolloutState): Promise<void> {
  await scene.setFlag(MODULE_ID, ROLLOUT_STATE_FLAG_KEY, state);
}

export async function executeNextRun(scene: Scene): Promise<void> {
  const state = getRolloutState(scene);
  if (!state || state.status !== "running") return;

  if (rolloutManager.stopped) {
    await finishRollout(scene, true);
    return;
  }
  if (rolloutManager.paused) {
    await restoreSceneState(state.startingState, scene, undefined);
    await setRolloutState(scene, { ...state, status: "paused" });
    rolloutManager.updateHUD(state.completedRuns, state.numRuns, true);
    ui.notifications?.info(`Rollout paused at run ${state.completedRuns} / ${state.numRuns}.`);
    return;
  }

  if (state.completedRuns >= state.numRuns) {
    await finishRollout(scene, false);
    return;
  }

  const run = state.completedRuns;
  rolloutManager.updateHUD(run + 1, state.numRuns, false);
  if (state.numRuns > 1) {
    ui.notifications?.info(`Starting run ${run + 1} / ${state.numRuns}`);
  }

  await restoreSceneState(state.startingState, scene, undefined);

  const log: Record<number, TurnLogEntry> = {};

  const createdCombat = await Combat.create({ scene: scene.id });
  if (!(createdCombat instanceof Combat)) {
    await finishRollout(scene, true);
    return;
  }
  const combat = createdCombat;

  await combat.createEmbeddedDocuments(
    "Combatant",
    state.rolloutParticipants.map(participant => ({ tokenId: participant.tokenId }))
  );

  await combat.activate();
  await game.combat?.rollAll();
  await combat.startCombat();
  let victor: number | null = null;
  let roundsTaken: number = state.maxRounds;
  const usedReaction = new Set<string>();
  for (let turn = 0; combat.round <= state.maxRounds; turn++) {
    const combatant = combat.combatants.get(combat.current.combatantId || "");
    if (!combatant) {
      console.error("No combatant for current turn");
      break;
    }
    const token = scene.tokens.get(combatant.tokenId || "");
    if (!token) continue;
    const actor = token.actor;
    if (!actor) continue;

    const isFriendly = token.disposition === 1;
    const isDownedOrDead = async () => {
      if (!isActorAtZeroHp(actor)) {
        if (isActorUnconscious(actor) || actorHasStatusEffect(actor, "incapacitated")) {
          if (isActorUnconscious(actor) && !isActorAtZeroHp(actor) && actor.id) {
            const flagRound = rolloutManager.unconsciousRoundMap.get(actor.id);
            const currentRound = combat.round;
            if (flagRound == null) {
              rolloutManager.unconsciousRoundMap.set(actor.id, currentRound);
            } else if (currentRound - flagRound >= 10) {
              console.log(`Combatant ${combatant.name} has been unconscious for 10+ rounds, waking up`);
              await setActorStatusEffect(actor, "unconscious", false);
              await setActorStatusEffect(actor, "sleeping", false);
              rolloutManager.unconsciousRoundMap.delete(actor.id);
              return false;
            }
          }
          console.log(`Combatant ${combatant.name} is unconscious/incapacitated, skipping turn`);
          await tryHoldPersonEndOfTurnSave(token);
          await combat.nextTurn();
          return true;
        }
        return false;
      }
      if (!isFriendly) {
        console.log(`Combatant ${combatant.name} is at 0 HP, marking defeated`);
        await combatant.update({ defeated: true });
        await combat.nextTurn();
        return true;
      }
      if (getActorDeathSaves(actor).failure >= 3) {
        console.log(`Combatant ${combatant.name} has 3 death save failures, marking defeated`);
        await combatant.update({ defeated: true });
        await combat.nextTurn();
        return true;
      }
      if (token.getFlag(MODULE_ID, "stabilized")) {
        console.log(`Combatant ${combatant.name} is stabilized, skipping turn`);
        await combat.nextTurn();
        return true;
      }
      console.log(`Combatant ${combatant.name} is at 0 HP, rolling death save`);
      const result = await rollActorDeathSave(token);
      if (result.dead) {
        console.log(`Combatant ${combatant.name} has died from death save failures`);
        await combatant.update({ defeated: true });
        await combat.nextTurn();
        return true;
      }
      if (result.rolledNat20 && !isActorAtZeroHp(actor)) {
        console.log(`Combatant ${combatant.name} rolled a nat 20 and is back up!`);
        await setActorStabilized(token, false);
        await setActorStatusEffect(actor, "unconscious", false);
        if (actor.id) rolloutManager.unconsciousRoundMap.delete(actor.id);
        return false;
      }
      console.log(`Combatant ${combatant.name} is unconscious, skipping turn`);
      await combat.nextTurn();
      return true;
    };

    if (await isDownedOrDead()) continue;

    if (token.id) usedReaction.delete(token.id);

    const entity = Entity.fromToken(token);
    const turnEvents: AttackResult[] = [];

    const turnedData = token.getFlag(MODULE_ID, TURNED_FLAG_KEY) as { sourceActorId: string; round: number } | undefined;
    if (turnedData) {
      if (combat.round > turnedData.round) {
        await token.unsetFlag(MODULE_ID, TURNED_FLAG_KEY);
      } else {
        const sourceToken = scene.tokens.find(t => t.actor?.id === turnedData.sourceActorId);
        console.log(`[Turn Undead] ${actor.name} is turned, fleeing from ${sourceToken?.actor?.name ?? "cleric"}`);
        if (sourceToken) await new TurnedFleeAction(entity, sourceToken).act();
        if (token.id) usedReaction.add(token.id);
        log[turn] = { round: combat.round, state: String(encodeScene(scene)), events: [] };
        await combat.nextTurn();
        continue;
      }
    }
    const canFreeDisengage = actor.items.some(i => i.name === "Nimble Escape");
    const hasCunningAction = actor.items.some(i => i.name === "Cunning Action");
    const hasSecondWind = actor.items.some(i => i.name === "Second Wind");
    const hasActionSurge = actor.items.some(i => i.name === "Action Surge");
    let disengaged = false;
    let usedBonusAction = false;
    let cunningActionDash = false;
    const moveAction = new SmartMoveAction(entity, state.smartMoveBias);
    moveAction.usedReaction = usedReaction;
    const reactable = await checkNearbyReactions(scene, entity, usedReaction);
    if (canFreeDisengage || (hasCunningAction && reactable)) {
      disengaged = true;
      usedBonusAction = true;
      if (hasCunningAction && reactable) console.log(`[Cunning Action] ${actor.name} uses Disengage as bonus action`);
      await moveAction.act();
    } else if (!reactable || Math.random() < 0.5) {
      await moveAction.act();
      if (hasCunningAction) cunningActionDash = true;
    } else {
      disengaged = true;
      console.log(`Entity ${entity.name} is disengaging to avoid reaction`);
    }
    if (!disengaged) {
      await reactionCheck(moveAction, scene, entity, usedReaction, turnEvents);
    }
    const liveTokenAfterMove = scene.tokens.get(entity.id || "") ?? token;
    entity.x = liveTokenAfterMove.x;
    entity.y = liveTokenAfterMove.y;
    if (!isActorUnableToAct(actor)) {
      if (await applyTurnUndead(actor, liveTokenAfterMove, scene, combat.round)) {
        log[turn] = { round: combat.round, state: String(encodeScene(scene)), events: turnEvents };
        await combat.nextTurn();
        continue;
      }
      if (await applyPreserveLife(actor, liveTokenAfterMove, scene)) {
        log[turn] = { round: combat.round, state: String(encodeScene(scene)), events: turnEvents };
        await combat.nextTurn();
        continue;
      }
      await clearExpiredCharms(liveTokenAfterMove, scene);
      await clearExpiredSanctuaries(liveTokenAfterMove, scene);
      if (isCharmedByEnemy(liveTokenAfterMove)) {
        console.log(`[Charm Person] ${actor.name} is charmed, skipping action`);
        log[turn] = { round: combat.round, state: String(encodeScene(scene)), events: turnEvents };
        await combat.nextTurn();
        continue;
      }
      // Decide whether to use a bonus action spell this turn
      const castableBonusSpells = getCastableBonusActionSpells(actor);
      const willUseBonusSpell = !usedBonusAction && castableBonusSpells.length > 0 && Math.random() < 0.5;

      // SmartAttack picks a viable weapon/spell and falls back to SmartMove if nothing can hit.
      // When pairing with a bonus action spell, the main action's spell choice is restricted to cantrips.
      const secondAction: Action = new SmartAttack(entity, state.smartMoveBias, { cantripOnly: willUseBonusSpell });
      secondAction.usedReaction = usedReaction;
      await secondAction.act();
      turnEvents.push(...secondAction.events);
      if (!disengaged) {
        await reactionCheck(secondAction, scene, entity, usedReaction, turnEvents);
      }
      if (!usedBonusAction && hasSecondWind && await applySecondWind(actor)) {
        usedBonusAction = true;
      }
      if (!usedBonusAction && cunningActionDash) {
        usedBonusAction = true;
        console.log(`[Cunning Action] ${actor.name} uses Dash as bonus action`);
        const bonusDash = new SmartMoveAction(entity, state.smartMoveBias);
        bonusDash.usedReaction = usedReaction;
        await bonusDash.act();
        await reactionCheck(bonusDash, scene, entity, usedReaction, turnEvents);
      }
      if (willUseBonusSpell && !usedBonusAction) {
        usedBonusAction = true;
        const bonusSpellAction = new RandomBonusSpellAction(entity);
        bonusSpellAction.usedReaction = usedReaction;
        await bonusSpellAction.act();
        turnEvents.push(...bonusSpellAction.events);
        if (!disengaged) {
          await reactionCheck(bonusSpellAction, scene, entity, usedReaction, turnEvents);
        }
      }
      if (hasActionSurge && await applyActionSurge(actor)) {
        const surgeAction: Action = new SmartAttack(entity, state.smartMoveBias);
        surgeAction.usedReaction = usedReaction;
        await surgeAction.act();
        turnEvents.push(...surgeAction.events);
        if (!disengaged) {
          await reactionCheck(surgeAction, scene, entity, usedReaction, turnEvents);
        }
      }
    }

    const dispositions = new Set<number>();
    for (const c of combat.combatants) {
      const t = scene.tokens.get(c.tokenId || "");
      if (!t) continue;
      const a = t.actor;
      if (!a) continue;
      if (!isActorAtZeroHp(a)) {
        dispositions.add(t.disposition);
      }
    }
    if (dispositions.size <= 1) {
      console.log("All tokens of one disposition are at 0 HP, ending combat early");
      victor = dispositions.values().next().value ?? null;
      roundsTaken = combat.round;
      const encodedScene = encodeScene(scene);
      log[turn] = { round: combat.round, state: String(encodedScene), events: turnEvents };
      break;
    }
    const encodedScene = encodeScene(scene);
    await clearCharmPersonForDamaged(scene, turnEvents);
    log[turn] = { round: combat.round, state: String(encodedScene), events: turnEvents };
    await combat.nextTurn();
  }

  const runLabel = state.numRuns > 1 ? ` (run ${run + 1}/${state.numRuns})` : "";
  ui.notifications?.info(
    `Rollout complete${runLabel} after ${roundsTaken} rounds.` +
    (victor !== null ? ` Victor disposition: ${victor}` : "")
  );

  await combat.delete();
  if (state.saveLog) {
    try {
      await saveLog(log, state.logFolder);
    } catch (err: unknown) {
      console.error("Log save failed:", err);
      ui.notifications?.error(
        `Log save failed and rollout has been halted. Check the console for details.`
      );
      return;
    }
  }

  clearRangePositionsCache();

  const newState: RolloutState = { ...state, completedRuns: run + 1 };
  await setRolloutState(scene, newState);

  if (newState.refreshInterval > 0 && newState.completedRuns > 0 && newState.completedRuns % newState.refreshInterval === 0 && newState.completedRuns < newState.numRuns) {
    await restoreSceneState(newState.startingState, scene, undefined);
    await setRolloutState(scene, newState);
    console.log(`Refreshing browser after ${newState.completedRuns} runs...`);
    ui.notifications?.info(`Refreshing browser after ${newState.completedRuns} runs...`);
    window.location.reload();
    return;
  }

  setTimeout(() => void executeNextRun(scene), 0);
}

export async function finishRollout(scene: Scene, stopped: boolean): Promise<void> {
  const state = getRolloutState(scene);
  if (state) {
    await restoreSceneState(state.startingState, scene, undefined);

    if (state.numRuns > 1) {
      const label = stopped ? "Rollout stopped" : "All runs complete";
      ui.notifications?.info(`${label} (${state.completedRuns} / ${state.numRuns}). Scene restored.`);
    }

    if (state.originalCombatData && state.originalCombatData.length > 0) {
      const restoredCombat = await Combat.create({ scene: scene.id });
      if (restoredCombat instanceof Combat) {
        await restoredCombat.createEmbeddedDocuments(
          "Combatant",
          state.originalCombatData.map(c => ({
            tokenId: c.tokenId,
            ...(c.initiative !== null ? { initiative: c.initiative } : {})
          }))
        );
      }
    }

    await scene.unsetFlag(MODULE_ID, ROLLOUT_STATE_FLAG_KEY);
  }
  if (rolloutManager.hudEl) {
    rolloutManager.hudEl.remove();
    rolloutManager.hudEl = null;
  }
  rolloutManager.paused = false;
  rolloutManager.stopped = false;
}

export async function saveLog(log: Record<number, TurnLogEntry>, subfolder?: string): Promise<void> {
  const worldId = game.world?.id ?? "unknown_world";
  const baseDir = `worlds/${worldId}/logs`;
  const dir = subfolder ? `${baseDir}/${subfolder}` : baseDir;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // We're calling it .json, but it's secretly a .gz
  // Foundry only lets us upload JSON files, but we want to compress them
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
  } catch (_err: unknown) { /* already exists */ }

  const compressedStream = new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressedBlob = await new Response(compressedStream).blob();
  const file = new File([compressedBlob], filename, { type: "application/gzip" });
  const payloadMB = (payload.length / (1024 * 1024)).toFixed(1);
  const compressedMB = (compressedBlob.size / (1024 * 1024)).toFixed(2);
  console.log(`Saving log "${filename}" (${payloadMB} MB raw, ${compressedMB} MB gzipped) to "${dir}"`);

  async function tryUpload(targetDir: string): Promise<void> {
    const result = await foundry.applications.apps.FilePicker.upload("data", targetDir, file, {}, { "notify": false });
    if (!result || !("path" in result)) {
      throw new Error(`FilePicker.upload to "${targetDir}" returned failure (result: ${JSON.stringify(result)}) (${payloadMB} MB).`);
    }
  }

  if (dir !== baseDir) {
    try {
      await tryUpload(dir);
      return;
    } catch (err: unknown) {
      console.warn(`Failed to save log to subfolder "${dir}", falling back to base logs directory:`, err);
      ui.notifications?.warn(`Failed to save log to subfolder "${dir}", falling back to base logs directory.`);
    }
  }

  await tryUpload(baseDir);
}
