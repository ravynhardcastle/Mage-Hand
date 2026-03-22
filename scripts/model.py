"""
TODO
"""

from __future__ import annotations

import logging
import random

logger = logging.getLogger("dnd-rl-server")


class RLModel:
    def __init__(self, action_size: int = 4):
        self.action_size = action_size
        self.step_count = 0

    def predict(self, observation: list[float]) -> int:
        """Return an action index given the observation vector.
        
        Observation: [int, float, int, int], isEnemy, hpFraction, isCurrentTurn, distToActiveToken"""
        self.step_count += 1
        logger.info("Predicting action for step %d | observation=%s", self.step_count, observation)
        # todo make it do something, rn just picks some random shit
        return random.randint(0, self.action_size - 1)

    def observe_reward(self, reward: float, done: bool) -> None:
        # also make it do shit
        logger.info("Step %d | reward=%.2f done=%s", self.step_count, reward, done)