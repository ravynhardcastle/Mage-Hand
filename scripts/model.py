"""
TODO
"""

from __future__ import annotations

import logging
import random

logger = logging.getLogger("dnd-rl-server")


MAX_TOKENS = 10
ACTIONS_PER_TARGET = 4
# Action encoding: action = target_index * ACTIONS_PER_TARGET + variant
# variant 0: approach target + attack
# variant 1: approach target + approach again (dash)
# variant 2: flee from target + attack
# variant 3: flee from target + flee again (full escape)
OBSERVATION_SIZE = MAX_TOKENS * 4  # [isHostile, hpFraction, isCurrentTurn, distToActive] per token


class RLModel:
    def __init__(self, action_size: int = MAX_TOKENS * ACTIONS_PER_TARGET):
        self.action_size = action_size
        self.step_count = 0
        self.episode_rewards: list[float] = []

    def predict(self, observation: list[float]) -> int:
        """Return an action index given the observation vector.

        Observation: MAX_TOKENS * 4 floats, padded with 0s.
        Per token: [isHostile, hpFraction, isCurrentTurn, distToActiveToken]
        Action: target_index * 4 + variant (0=approach+attack, 1=approach+dash, 2=flee+attack, 3=flee+flee)
        """
        self.step_count += 1
        logger.info("Predicting action for step %d | observation=%s", self.step_count, observation)
        # todo make it do something, rn just picks some random shit
        return random.randint(0, self.action_size - 1)

    def observe_reward(self, reward: float, done: bool) -> None:
        """Observe reward. done=True means combat ended.

        Rewards: +1 hostile win, -1 hostile loss, 0 draw/intermediate.
        """
        self.episode_rewards.append(reward)
        logger.info("Step %d | reward=%.2f done=%s", self.step_count, reward, done)
        if done:
            total = sum(self.episode_rewards)
            logger.info("Episode ended | total_reward=%.2f steps=%d", total, self.step_count)
            self.episode_rewards.clear()
            self.step_count = 0