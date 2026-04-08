"""
PPO training wrapper using sb3-contrib's MaskablePPO.
"""
from __future__ import annotations

import logging
import threading
from queue import Queue
from typing import Any

import numpy as np
import gymnasium as gym
from gymnasium import spaces

try:
    from sb3_contrib import MaskablePPO
    from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy
    SB3_AVAILABLE = True
except ImportError:
    SB3_AVAILABLE = False

logger = logging.getLogger("dnd-rl-server")

ACTIONS_PER_TARGET = 4
TOKEN_INFO_SIZE = 10
APPROACH_ATTACK = 0
APPROACH_DASH = 1
STILL_ATTACK = 2
FLEE_FLEE = 3

IS_HOSTILE = 0
IS_TURN = 1
IS_DEAD = 2
IS_IN_RANGE = 5
COULD_BE_IN_RANGE = 7
IS_CLOSE_TO_BORDER = 9


def compute_action_mask(observation: list[float], token_count: int) -> np.ndarray:
    """Replicates RLModel.get_valid_action filtering as a boolean mask."""
    mask = np.zeros(token_count * ACTIONS_PER_TARGET, dtype=bool)

    self_close_to_border = 0.0
    for i in range(token_count):
        if observation[i * TOKEN_INFO_SIZE + IS_TURN] == 1:
            self_close_to_border = observation[i * TOKEN_INFO_SIZE + IS_CLOSE_TO_BORDER]
            break

    for action in range(token_count * ACTIONS_PER_TARGET):
        target = action // ACTIONS_PER_TARGET
        variant = action % ACTIONS_PER_TARGET
        target_start = target * TOKEN_INFO_SIZE
        target_info = observation[target_start:target_start + TOKEN_INFO_SIZE]

        if not any(target_info):
            continue
        if target_info[IS_DEAD]:
            continue
        if target_info[IS_HOSTILE] == 1:
            continue
        if variant == APPROACH_ATTACK and not target_info[COULD_BE_IN_RANGE]:
            continue
        if variant == APPROACH_DASH and target_info[COULD_BE_IN_RANGE]:
            continue
        if variant == STILL_ATTACK and not target_info[IS_IN_RANGE]:
            continue
        if variant == FLEE_FLEE and self_close_to_border:
            continue
        mask[action] = True

    if not mask.any():
        mask[0] = True
    return mask


class FoundryEnv(gym.Env):
    metadata = {"render_modes": []}

    def __init__(self, token_count: int, obs_q: Queue, act_q: Queue, step_penalty: float = -0.1):
        super().__init__()
        self.token_count = token_count
        self.obs_dim = token_count * TOKEN_INFO_SIZE
        self.action_dim = token_count * ACTIONS_PER_TARGET
        self.obs_q = obs_q
        self.act_q = act_q
        self.step_penalty = step_penalty

        self.observation_space = spaces.Box(low=-10.0, high=10.0, shape=(self.obs_dim,), dtype=np.float32)
        self.action_space = spaces.Discrete(self.action_dim)

        self._current_mask = np.ones(self.action_dim, dtype=bool)
        self._pending_obs: list[float] | None = None

        # Per-episode telemetry
        self._episode_idx = 0
        self._step_in_episode = 0
        self._global_step = 0
        self._episode_reward_raw = 0.0
        self._episode_reward_shaped = 0.0

    def action_masks(self) -> np.ndarray:
        return self._current_mask

    def _consume(self) -> tuple[list[float], float, bool]:
        msg = self.obs_q.get()
        kind = msg[0]
        if kind == "obs":
            return msg[1], 0.0, False
        if kind == "reward":
            # reward arrived without a fresh obs
            return self._pending_obs or [0.0] * self.obs_dim, msg[1], msg[2]
        raise RuntimeError(f"Unexpected msg kind: {kind}")

    def reset(self, *, seed: int | None = None, options: dict[str, Any] | None = None):
        super().reset(seed=seed)
        self._episode_idx += 1
        self._step_in_episode = 0
        self._episode_reward_raw = 0.0
        self._episode_reward_shaped = 0.0
        logger.info("[PPO] Episode %d reset, waiting for first observation", self._episode_idx)
        while True:
            msg = self.obs_q.get()
            if msg[0] == "obs":
                obs = msg[1]
                break
            else:
                logger.warning("[PPO] reset(): drained unexpected msg %s", msg[0])
        self._pending_obs = obs
        self._current_mask = compute_action_mask(obs, self.token_count)
        n_valid = int(self._current_mask.sum())
        logger.info("[PPO] Episode %d started | obs_dim=%d valid_actions=%d/%d",
                    self._episode_idx, len(obs), n_valid, self.action_dim)
        return np.asarray(obs, dtype=np.float32), {}

    def step(self, action: int):
        action_int = int(action)
        target = action_int // ACTIONS_PER_TARGET
        variant = action_int % ACTIONS_PER_TARGET
        variant_name = ["approach+attack", "approach+dash", "still+attack", "flee+flee"][variant]
        was_masked_valid = bool(self._current_mask[action_int]) if action_int < self.action_dim else False

        self._step_in_episode += 1
        self._global_step += 1
        logger.info(
            "[PPO] ep=%d step=%d (global=%d) | action=%d (target=%d %s) valid=%s",
            self._episode_idx, self._step_in_episode, self._global_step,
            action_int, target, variant_name, was_masked_valid,
        )

        # Send action to Foundry
        self.act_q.put(action_int)
        msg = self.obs_q.get()
        reward = 0.0
        done = False
        next_obs = self._pending_obs
        if msg[0] == "reward":
            reward = float(msg[1])
            done = bool(msg[2])
        elif msg[0] == "obs":
            next_obs = msg[1]

        if not done:
            obs_msg = self.obs_q.get()
            if obs_msg[0] == "obs":
                next_obs = obs_msg[1]
            elif obs_msg[0] == "reward":
                reward += float(obs_msg[1])
                done = bool(obs_msg[2])

        shaped = reward + (self.step_penalty if not done else 0.0)
        self._episode_reward_raw += reward
        self._episode_reward_shaped += shaped

        self._pending_obs = next_obs
        self._current_mask = compute_action_mask(next_obs or [0.0] * self.obs_dim, self.token_count)
        n_valid = int(self._current_mask.sum())

        logger.info(
            "[PPO] ep=%d step=%d | reward_raw=%+.2f shaped=%+.2f done=%s next_valid=%d/%d",
            self._episode_idx, self._step_in_episode, reward, shaped, done, n_valid, self.action_dim,
        )

        if done:
            logger.info(
                "[PPO] Episode %d FINISHED | steps=%d total_raw=%+.2f total_shaped=%+.2f",
                self._episode_idx, self._step_in_episode,
                self._episode_reward_raw, self._episode_reward_shaped,
            )

        return (
            np.asarray(next_obs, dtype=np.float32),
            shaped,
            done,
            False,
            {},
        )


class PPOTrainer:
    def __init__(self, token_count: int, total_timesteps: int = 100_000):
        self.token_count = token_count
        self.total_timesteps = total_timesteps
        self.obs_q: Queue = Queue()
        self.act_q: Queue = Queue()
        self.env = FoundryEnv(token_count, self.obs_q, self.act_q)
        self.model = MaskablePPO(
            MaskableActorCriticPolicy,
            self.env,
            verbose=1,
            n_steps=512,
            batch_size=64,
            learning_rate=3e-4,
        )
        self._thread: threading.Thread | None = None
        self._stopped = False

    def start(self):
        def _run():
            try:
                logger.info("PPO training thread started (timesteps=%d)", self.total_timesteps)
                self.model.learn(total_timesteps=self.total_timesteps)
                logger.info("PPO training thread finished normally")
            except Exception as e:
                logger.exception("PPO training thread crashed: %s", e)

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()

    def push_observation(self, obs: list[float]) -> int:
        self.obs_q.put(("obs", obs))
        return self.act_q.get()

    def push_reward(self, reward: float, done: bool) -> None:
        self.obs_q.put(("reward", reward, done))

    def save(self, path: str) -> None:
        self.model.save(path)

