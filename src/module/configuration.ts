export interface RolloutState {
  status: "running" | "paused";
  completedRuns: number;
  maxRounds: number;
  numRuns: number;
  logFolder: string | undefined;
  refreshInterval: number;
  startingState: string;
  rolloutParticipants: { tokenId: string }[];
  originalCombatData: { tokenId: string; initiative: number | null }[] | null;
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

export interface Dnd5eActorSystem {
  attributes?: {
    hp?: { value?: number; max?: number };
    ac?: { value?: number; equippedArmor?: unknown };
    death?: { success?: number; failure?: number };
    movement?: { speed?: number };
  };
  spells?: SpellSlots;
  details?: {
    type?: string | { value?: string; subtype?: string; custom?: string };
  };
  traits?: { ci?: { value?: Set<string> | string[] } };
}

export interface Dnd5eItemSystem extends SpellSystemData, Equippable {
  quantity?: number;
  attackType?: string;
  ammunitionOptions?: Array<{ value?: string; disabled?: boolean }>;
  activities?: { contents?: unknown[] };
}

export interface Activity {
  id?: string;
  type: string;
  target?: {
    template?: { type?: string; count?: number | string };
    affects?: { type?: string; count?: number | string };
  };
  damage?: { onSave?: string };
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

// fvtt-types stuff

declare module "fvtt-types/configuration" {
  interface SettingConfig {
    "dnd-model.randomSpellExclusions": string;
  }

  interface FlagConfig {
    Token: {
      "dnd-model": {
        lightSpell?: {
          sourceActorId?: string | null;
          previousLight?: TokenLightSnapshot;
        };
        guidingBoltNextAttack?: GuidingBoltFlag;
      };
    };
    Actor: {
      "dnd-model": {
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
    }
  }
}