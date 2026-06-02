export const payload_version: number = 3;
export const MODULE_ID = "dnd-model";
export const LIGHT_SPELL_FLAG_KEY = "lightSpell";
export const GUIDING_BOLT_FLAG_KEY = "guidingBoltNextAttack";
export const HOLD_PERSON_DC_FLAG_KEY = "holdPersonDC";
export const CHARM_PERSON_FLAG_KEY = "charmPersonState";
export const SANCTUARY_FLAG_KEY = "sanctuaryState";
export const TURNED_FLAG_KEY = "turnedByCleric";
export const RANDOM_SPELL_EXCLUSIONS_SETTING_KEY = "randomSpellExclusions";
export const DEFAULT_RANDOM_SPELL_EXCLUSIONS = ["thaumaturgy", "mage hand", "prestidigitation"];
export const ROLLOUT_STATE_FLAG_KEY = "rolloutState";
// spells that get more targets on upcast
export const TARGET_PER_LEVEL_SPELLS = new Set(["magic missile", "eldritch blast", "scorching ray", "bless", "charm person"]);
// repeatable spells
export const CAN_REPEAT_TARGET_SPELLS = new Set(["magic missile", "eldritch blast", "scorching ray"]);
// Conditions that Lesser Restoration can remove
export const LESSER_RESTORATION_CONDITIONS = ["blinded", "deafened", "paralyzed", "poisoned"] as const;
export type LesserRestorationCondition = typeof LESSER_RESTORATION_CONDITIONS[number];
export const RANGE_POSITIONS_CACHE_MAX_ENTRIES = 2000;
