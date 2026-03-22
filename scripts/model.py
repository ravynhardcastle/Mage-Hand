"""
TODO
"""

from __future__ import annotations

import logging
import random

logger = logging.getLogger("dnd-rl-server")


class RLModel:
    # Action space: 0 = move/move (dash), 1 = move/attack
    ACTION_DASH = 0
    ACTION_ATTACK = 1

    def __init__(self, action_size: int = 2):
        self.action_size = action_size
        self.step_count = 0
        self.episode_rewards: list[float] = []

    def predict(self, observation: list[float]) -> int:
        """Return an action index given the observation vector.

        Observations: [isHostile, hpFraction, isCurrentTurn, distToActiveToken]
        Actions: 0 = move/move (dash), 1 = move/attack
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