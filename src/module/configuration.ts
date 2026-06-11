export interface RolloutState {
  status: "running" | "paused";
  completedRuns: number;
  maxRounds: number;
  numRuns: number;
  logFolder: string | undefined;
  saveLog: boolean;
  refreshInterval: number;
  smartMoveBias: number;
  startingState: string;
  rolloutParticipants: { tokenId: string }[];
  originalCombatData: { tokenId: string; initiative: number | null }[] | null;
}

export interface QueuedRollout {
  id: string;
  sceneId: string;
  maxRounds: number;
  numRuns: number;
  logFolder: string | undefined;
  saveLog: boolean;
  refreshInterval: number;
  smartMoveBias: number;
}

export type TokenLightSnapshot = Record<string, unknown>;

// this type is purely to clearly model times where updatedata is dotted
// it's not necessary, just for my visuals
export type UpdateData = Record<string, unknown>;

export interface GuidingBoltFlag {
  sourceActorId?: string;
  appliedRound?: number;
  appliedTurn?: number;
  expiresRound?: number;
  expiresTurn?: number;
}

// dnd5e

export interface ItemRange {
  reach?: number | null;
  long?: number | null;
  value?: number | null;
  units?: string;
  special?: string;
}

export interface Equippable {
  equipped?: boolean;
}

export interface SpellSlotEntry {
  value?: number;
  max?: number;
  level?: number;
}

export type SpellSlots = Record<string, SpellSlotEntry | undefined>;

export interface SpellTargetTemplate {
  type?: string;
  units?: string;
  size?: number;
  count?: number | string;
}

export interface SpellTargetAffects {
  type?: string;
  count?: number | string;
}

export interface SpellTargetData {
  type?: string;
  value?: number | string;
  units?: string;
  template?: SpellTargetTemplate;
  affects?: SpellTargetAffects;
}

export interface SpellSystemData {
  level?: number;
  method?: string;
  prepared?: number | boolean;
  range?: ItemRange;
  target?: SpellTargetData;
  activation?: { type?: string };
  duration?: { concentration?: boolean; units?: string; type?: string };
}

export interface MidiItem {
  name?: string;
  system: Dnd5eItemSystem;
  use?: (
    config?: Record<string, unknown>,
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
}

export interface Dnd5eActorSystem {
  attributes?: {
    hp?: { value?: number; max?: number };
    ac?: { value?: number; equippedArmor?: unknown };
    death?: { success?: number; failure?: number };
    movement?: { speed?: number };
    spellcasting?: string;
    spell?: { dc?: number; attack?: number; mod?: number };
  };
  spells?: SpellSlots;
  details?: {
    level?: number;
    type?: string | { value?: string; subtype?: string; custom?: string };
  };
  traits?: { ci?: { value?: Set<string> | string[] } };
}

export interface Dnd5eItemSystem extends SpellSystemData, Equippable {
  quantity?: number;
  attackType?: string;
  ammunitionOptions?: Array<{ value?: string; disabled?: boolean }>;
  activities?: { contents?: unknown[] };
  properties?: Set<string>;
}

export interface DamagePart {
  scaling?: { mode?: string; number?: number; formula?: string };
}

export interface Activity {
  id?: string;
  type: string;
  activation?: { type?: string };
  target?: {
    template?: { type?: string; count?: number | string };
    affects?: { type?: string; count?: number | string };
  };
  damage?: { onSave?: string; parts?: DamagePart[] };
  healing?: DamagePart;
  save?: { ability?: Set<string> | string[]; dc?: { value?: number } };
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
  use?: (
    config?: Record<string, unknown>,
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
  workflow?: { saves?: Set<{ id?: string }> };
}

// midi-qol

export interface MidiAttackWorkflow {
  hitTargets?: Set<{ id?: string }>;
}

export interface MidiRollWorkflow {
  failedSaves?: Set<{ id?: string }>;
}

export interface MidiPreAttackWorkflow {
  attackRollModifierTracker?: {
    advantage?: { add?: (source: string, label: string) => void };
  };
}

// extensions

export interface Dnd5eActorExt {
  applyDamage?: (
    amount: number,
    options?: { multiplier?: number; damage?: Record<string, unknown> }
  ) => Promise<unknown>;
  rollDeathSave?: (
    config?: Record<string, unknown>,
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<Array<{ isCritical?: boolean }> | null>;
  rollSavingThrow?: (
    config: { ability: string; target?: number; event?: Event },
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
  rollAbilityCheck?: (
    config: { ability: string; target?: number },
    dialog?: Record<string, unknown>,
    message?: Record<string, unknown>
  ) => Promise<unknown>;
}

export interface TokenLayerExt {
  setTargets?: (targets: Iterable<string | { id?: string }>) => void;
}

export interface Dnd5eApi {
  canvas?: {
    AbilityTemplate?: {
      fromActivity?: (
        activity: Activity,
        options?: Record<string, unknown>
      ) => Array<{ document: { toObject: () => { flags?: Record<string, unknown> } & Record<string, unknown> } }> | null;
    };
  };
}

export interface MidiQolApi {
  completeItemUse?: (
    item: Item,
    options?: Record<string, unknown>,
    config?: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
}

// fvtt-types stuff

declare module "fvtt-types/configuration" {
  interface SettingConfig {
    "dnd-model.randomSpellExclusions": string;
    "dnd-model.rolloutQueue": QueuedRollout[];
  }

  interface FlagConfig {
    Token: {
      "dnd-model": {
        lightSpell?: {
          sourceActorId?: string | null;
          previousLight?: TokenLightSnapshot;
        };
        guidingBoltNextAttack?: GuidingBoltFlag;
        turnedByCleric?: { sourceActorId: string; round: number };
        holdPersonDC?: number;
        charmPersonState?: { dc: number; casterActorId: string; casterDisposition: number };
        sanctuaryState?: { dc: number; casterActorId: string };
        stabilized?: boolean;
      };
    };
    Scene: {
      "dnd-model": {
        rolloutState?: RolloutState;
      };
    };
  }

  // hooks
  namespace Hooks {
    interface HookConfig {
      "midi-qol.AttackRollComplete": (workflow: MidiAttackWorkflow) => void;
      "midi-qol.preAttackRollConfig": (workflow: MidiPreAttackWorkflow) => void;
      "midi-qol.RollComplete": (workflow: MidiRollWorkflow) => void;
      "dnd5e.postCreateUsageMessage": (activity: unknown, card: unknown) => void;
    }
  }
}