"""
TODO
"""

from __future__ import annotations

import logging
import random
import torch
from torch.utils.data import DataLoader

from TAMER import BasicFF, HRDataset

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

        self.obs_dim = OBSERVATION_SIZE
        self.input_dim = self.obs_dim + self.action_size
        self.model = BasicFF(in_shape=self.input_dim, out_shape=1)
        self.dataset = HRDataset(state_dim=self.obs_dim, n_actions=self.action_size)
        self.optimizer = torch.optim.Adam(self.model.parameters(), lr=1e-3)
        self.batch_size = 32

        self.last_observation = None   
        self.last_action = None


    def predict(self, observation: list[float]) -> int:
        """Return an action index given the observation vector.

        Observation: MAX_TOKENS * 4 floats, padded with 0s.
        Per token: [isHostile, hpFraction, isCurrentTurn, distToActiveToken]
        Action: target_index * 4 + variant (0=approach+attack, 1=approach+dash, 2=flee+attack, 3=flee+flee)
        """
        self.step_count += 1
        logger.info("Predicting action for step %d | observation=%s", self.step_count, observation)
        # todo make it do something, rn just picks some random shit
        obs_tensor = torch.tensor(observation, dtype=torch.float32)
        if len(self.dataset) == 0:
            action = random.randint(0, self.action_size - 1)
            logger.info("Training dataset empty picking random action=%d", action)
            return action

        all_state_actions = []
        for action_idx in range(self.action_size):
            onehot_action = torch.zeros(self.action_size)
            onehot_action[action_idx] = 1
            state_action = torch.cat((obs_tensor, onehot_action), dim=0).unsqueeze(0) # check if need unsqueeze(0)
            all_state_actions.append(state_action)

        batch = torch.stack(all_state_actions)
        rewards = self.model(batch).view(-1)

        action = torch.argmax(rewards).item()
        logger.info("Predict step %d | action=%d | predicted_rewards=%s",
                    self.step_count, action, rewards.tolist()) # what should I log?
        
        return action

    def observe_reward(self, done: bool, observation: list[float], action: int, human_reward=None, reward=None) -> None: 
        """Observe reward. done=True means combat ended.

        Rewards: +1 hostile win, -1 hostile loss, 0 draw/intermediate. #NOTE: I forgot if 0 reward is the reward for every single step that is not a termination? That would make sense
        # done: termination for an epidsde, human_reward for during experiments, reward: termination reward
        HACK: maybe add a bool for either pretrain or tamer training
        """ 
        self.step_count+=1
        if reward is not None: # can happen for both pretraining or human training #NOTE: maybe it'll never be none if 0 is for every step that is not terminate. Check later
            self.episode_rewards.append(reward)
            logger.info("Step %d | reward=%.2f done=%s", self.step_count, reward, done)
            self.dataset.add_sample(observation, action, reward)
        
        if human_reward is not None:
            self.dataset.add_sample(observation, action, human_reward)

        if done:
            total = sum(self.episode_rewards)
            logger.info("Episode ended | total_reward=%.2f steps=%d", total, self.step_count)
            self.episode_rewards.clear()
            self.step_count = 0


    def update_policy(self):

        # sample a batch, train on that batch once
        if self.dataset.__len__() < self.batch_size:
            return # not enough samples to train on yet

        dataloader = torch.utils.data.DataLoader(self.dataset, batch_size=self.batch_size, shuffle=True)
        data_iterator = iter(dataloader)

        batch = next(data_iterator) # this is a list of (S, RA) tuples
        state_action, reward = batch
        predicted_reward = self.model(state_action)
        #flatten predicted reward from [16, 1] to [16]
        predicted_reward = predicted_reward.view(-1)
        loss = torch.nn.MSELoss()(predicted_reward, reward.float())
        print(f"loss: {loss.item()}")
        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()
        logger.info("Training step | loss=%.4f | dataset_size=%d",
                    loss.item(), len(self.dataset))
