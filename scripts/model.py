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


ACTIONS_PER_TARGET = 4

APPROACH_ATTACK = 0
APPROACH_DASH = 1
STILL_ATTACK = 2
FLEE_FLEE = 3
# Action encoding: action = target_index * ACTIONS_PER_TARGET + variant
# variant 0: approach target + attack
# variant 1: approach target + approach again (dash)
# variant 2: stand still + attack
# variant 3: flee from target + flee again (full escape)
TOKEN_INFO_SIZE = 10
# [isHostile, isTurn, isDead, canKill, canKillActive, isInRange, activeInRange, couldBeInRange, couldBeInRangeToActive, isCloseToBorder] per token

class RLModel:
    def __init__(self, token_count: int):
        self.token_count = token_count
        self.action_size = token_count * ACTIONS_PER_TARGET
        self.step_count = 0
        self.episode_rewards: list[float] = []

        self.obs_dim = token_count * TOKEN_INFO_SIZE
        self.input_dim = self.obs_dim + self.action_size
        self.model = BasicFF(in_shape=self.input_dim, out_shape=1)
        self.dataset = HRDataset(state_dim=self.obs_dim, n_actions=self.action_size)
        self.optimizer = torch.optim.Adam(self.model.parameters(), lr=1e-3)
        self.batch_size = 32

        self.last_observation = None
        self.last_action = None
        self.has_trained_weights = False


    def predict(self, observation: list[float]) -> int:
        """Return an action index given the observation vector.

        Observation: token_count * 10 floats.
        Per token: [isHostile, isTurn, isDead, canKill, canKillActive, isInRange, activeInRange, couldBeInRange, couldBeInRangeToActive, isCloseToBorder]
        Action: target_index * 4 + variant (0=approach+attack, 1=approach+dash, 2=still+attack, 3=flee+flee)
        """
        self.step_count += 1
        logger.info("Predicting action for step %d | observation=%s", self.step_count, observation)
        
        obs_tensor = torch.tensor(observation, dtype=torch.float32)
        if not self.has_trained_weights and len(self.dataset) == 0:
            topk_actions = list(range(self.action_size))
            random.shuffle(topk_actions)
            action = self.get_valid_action(observation, topk_actions)
            logger.info("No trained weights and no data, picking random valid action=%d", action)
            return action

        all_state_actions = []
        for action_idx in range(self.action_size):
            onehot_action = torch.zeros(self.action_size)
            onehot_action[action_idx] = 1
            state_action = torch.cat((obs_tensor, onehot_action), dim=0).unsqueeze(0)
            all_state_actions.append(state_action)

        batch = torch.stack(all_state_actions)
        rewards = self.model(batch).view(-1)

        _, topk_actions = torch.topk(rewards, k=self.action_size)
        topk_actions = topk_actions.tolist()
        action = self.get_valid_action(observation, topk_actions)
        
        logger.info("Predict step %d | action=%d | predicted_rewards=%s",
                    self.step_count, action, rewards.tolist()) # what should I log?

        return action

    def get_valid_action(self, observation, topk_actions):
        # variant 0: approach target + attack
        # variant 1: approach target + approach again (dash)
        # variant 2: stand still + attack
        # variant 3: flee from target + flee again (full escape)
        # isHostile, isTurn, isDead, canKill, canKillActive, isInRange, activeInRange, couldBeInRange, couldBeInRangeToActive, isCloseToBorder
        '''
        check valid actions
        go through each topk action
        get the token it corresponds to and only compare against that vector. Ex) if TOKEN_INFO_SIZE = 3, 0,1,2 is for token 1, 3,4,5 is for token 2
        '''
        
        IS_HOSTILE = 0
        IS_TURN = 1
        IS_DEAD = 2
        CAN_KILL = 3
        CAN_KILL_ACTIVE = 4
        IS_IN_RANGE = 5
        ACTIVE_IN_RANGE = 6
        COULD_BE_IN_RANGE = 7
        COULD_BE_IN_RANGE_TO_ACTIVE = 8
        IS_CLOSE_TO_BORDER = 9

        # Find the active token's info for self-referencing checks
        self_close_to_border = 0
        for i in range(self.token_count):
            if observation[i * TOKEN_INFO_SIZE + IS_TURN] == 1:
                self_close_to_border = observation[i * TOKEN_INFO_SIZE + IS_CLOSE_TO_BORDER]
                break

        for action in topk_actions:
            target = action // ACTIONS_PER_TARGET
            variant = action % ACTIONS_PER_TARGET

            target_start = target * TOKEN_INFO_SIZE
            target_info = observation[target_start:target_start + TOKEN_INFO_SIZE]

            # this is for padding which we dont have anymore but im paranoid
            if not any(target_info):
                continue

            is_hostile = target_info[IS_HOSTILE]
            is_dead = target_info[IS_DEAD]
            is_in_range = target_info[IS_IN_RANGE]
            could_be_in_range = target_info[COULD_BE_IN_RANGE]

            if is_dead: # thats a corpse
                continue
            if is_hostile == 1: # don't hit ur friends pls
                continue
            if variant == APPROACH_ATTACK:  # move towards target then attack
                if not could_be_in_range: # can't reach even after moving
                    continue
            elif variant == APPROACH_DASH:  # move towards target twice (no attack)
                if could_be_in_range: # get em bro GET EM u shld be fighting bro
                    continue
            elif variant == STILL_ATTACK: # if they're not in attack range, you gotta move bro
                if not is_in_range:
                    continue
            elif variant == FLEE_FLEE:
                if self_close_to_border: # don't be a coward bro, get in there
                    continue
     
            return action

        return topk_actions[0]



    def observe_reward(self, done: bool, observation: list[float], action: int, reward: float = 0) -> None:
        """Observe reward. done=True means combat ended.

        Rewards: +1 hostile win, -1 hostile loss, 0 draw/intermediate.
        """
        self.step_count += 1
        self.episode_rewards.append(reward)
        logger.info("Step %d | reward=%.2f done=%s", self.step_count, reward, done)
        self.dataset.add_sample(observation, action, reward)

        if done:
            total = sum(self.episode_rewards)
            logger.info("Episode ended | total_reward=%.2f steps=%d", total, self.step_count)
            self.episode_rewards.clear()
            self.step_count = 0


    def update_policy(self):

        # sample a batch, train on that batch once
        if len(self.dataset) < self.batch_size:
            return # not enough samples to train on yet

        dataloader = torch.utils.data.DataLoader(self.dataset, batch_size=self.batch_size, shuffle=True)
        data_iterator = iter(dataloader)

        batch = next(data_iterator) # this is a list of (S, RA) tuples
        state_action, reward = batch
        predicted_reward = self.model(state_action)
      
        predicted_reward = predicted_reward.view(-1)
        loss = torch.nn.MSELoss()(predicted_reward, reward.float())
        print(f"loss: {loss.item()}")
        self.optimizer.zero_grad()
        loss.backward()
        self.optimizer.step()
        self.has_trained_weights = True
        logger.info("Training step | loss=%.4f | dataset_size=%d",
                    loss.item(), len(self.dataset))

    def save_model(self, path):
            torch.save(self.model.state_dict(), path)
        
    def load_trained_model(self, model_path):
        self.model.load_state_dict(torch.load(model_path))
        self.model.eval()
        self.has_trained_weights = True