import { actorSys } from "./foundry-helpers";

export interface PartyMember {
  level: number;
}

export interface EncounterMeta {
  totalEnemyXp: number;
  enemyCount: number;
  partyLevels: number[];
  difficulty2014: Difficulty2014;
  difficulty2024: Difficulty2024;
}

export interface Difficulty2014 {
  multiplier: number;
  adjustedXp: number;
  thresholds: { easy: number; medium: number; hard: number; deadly: number };
  ratio: number;
  rating: "trivial" | "easy" | "medium" | "hard" | "deadly";
}

export interface Difficulty2024 {
  budget: { low: number; moderate: number; high: number };
  ratio: number;
  rating: "trivial" | "low" | "moderate" | "high";
}

const XP_THRESHOLDS_2014: Record<number, [number, number, number, number]> = {
  1: [25, 50, 75, 100],
  2: [50, 100, 150, 200],
  3: [75, 150, 225, 400],
  4: [125, 250, 375, 500],
  5: [250, 500, 750, 1100],
  6: [300, 600, 900, 1400],
  7: [350, 750, 1100, 1700],
  8: [450, 900, 1400, 2100],
  9: [550, 1100, 1600, 2400],
  10: [600, 1200, 1900, 2800],
  11: [800, 1600, 2400, 3600],
  12: [1000, 2000, 3000, 4500],
  13: [1100, 2200, 3400, 5100],
  14: [1250, 2500, 3800, 5700],
  15: [1400, 2800, 4300, 6400],
  16: [1600, 3200, 4800, 7200],
  17: [2000, 3900, 5900, 8800],
  18: [2100, 4200, 6300, 9500],
  19: [2400, 4900, 7300, 10900],
  20: [2800, 5700, 8500, 12700],
};

function encounterMultiplier2014(enemyCount: number): number {
  if (enemyCount <= 1) return 1;
  if (enemyCount === 2) return 1.5;
  if (enemyCount <= 6) return 2;
  if (enemyCount <= 10) return 2.5;
  if (enemyCount <= 14) return 3;
  return 4;
}

function clampLevel(level: number): number {
  return Math.max(1, Math.min(20, Math.round(level)));
}

function compute2014(totalEnemyXp: number, enemyCount: number, partyLevels: number[]): Difficulty2014 {
  const thresholds = { easy: 0, medium: 0, hard: 0, deadly: 0 };
  for (const lvl of partyLevels) {
    const [easy, medium, hard, deadly] = XP_THRESHOLDS_2014[clampLevel(lvl)] ?? [0, 0, 0, 0];
    thresholds.easy += easy;
    thresholds.medium += medium;
    thresholds.hard += hard;
    thresholds.deadly += deadly;
  }
  const multiplier = encounterMultiplier2014(enemyCount);
  const adjustedXp = totalEnemyXp * multiplier;
  let rating: Difficulty2014["rating"] = "trivial";
  if (adjustedXp >= thresholds.deadly) rating = "deadly";
  else if (adjustedXp >= thresholds.hard) rating = "hard";
  else if (adjustedXp >= thresholds.medium) rating = "medium";
  else if (adjustedXp >= thresholds.easy) rating = "easy";
  return {
    multiplier,
    adjustedXp,
    thresholds,
    ratio: thresholds.deadly > 0 ? adjustedXp / thresholds.deadly : 0,
    rating,
  };
}

function compute2024(totalEnemyXp: number, partyLevels: number[]): Difficulty2024 {
  const table = (CONFIG as unknown as { DND5E?: { ENCOUNTER_DIFFICULTY?: number[][] } })
    .DND5E?.ENCOUNTER_DIFFICULTY;
  const budget = { low: 0, moderate: 0, high: 0 };
  for (const lvl of partyLevels) {
    const row = table?.[clampLevel(lvl)] ?? [];
    budget.low += row[0] ?? 0;
    budget.moderate += row[1] ?? 0;
    budget.high += row[2] ?? 0;
  }
  let rating: Difficulty2024["rating"] = "trivial";
  if (totalEnemyXp >= budget.high) rating = "high";
  else if (totalEnemyXp >= budget.moderate) rating = "moderate";
  else if (totalEnemyXp >= budget.low) rating = "low";
  return {
    budget,
    ratio: budget.high > 0 ? totalEnemyXp / budget.high : 0,
    rating,
  };
}

export function computeEncounterMeta(scene: Scene): EncounterMeta {
  let totalEnemyXp = 0;
  let enemyCount = 0;
  const partyLevels: number[] = [];
  for (const token of scene.tokens) {
    const actor = token.actor;
    if (!actor) continue;
    if (token.disposition === 1) {
      partyLevels.push(actorSys(actor).details?.level ?? 1);
    } else {
      totalEnemyXp += actorSys(actor).details?.xp?.value ?? 0;
      enemyCount++;
    }
  }
  return {
    totalEnemyXp,
    enemyCount,
    partyLevels,
    difficulty2014: compute2014(totalEnemyXp, enemyCount, partyLevels),
    difficulty2024: compute2024(totalEnemyXp, partyLevels),
  };
}
