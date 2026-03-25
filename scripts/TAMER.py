from random import shuffle
from random import sample
import torch
import logging
from torch.utils.data import Dataset
from collections import namedtuple
import csv
import os
import time
import pickle
from pathlib import Path
import csv
import re

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dnd-rl-server")

# logpoints and humanrewards can be linked by episode.
LogPoint = namedtuple('LogPoint', ['state', 'action', 'episode', 'action_t'])
HumanReward = namedtuple('HumanReward', ['reward', 'time', 'episode'])

class BasicFF(torch.nn.Module):
    def __init__(self, in_shape, out_shape):
        super().__init__()
        self.ff1 = torch.nn.Linear(in_shape, 64)
        self.relu = torch.nn.ReLU()
        self.ff2 = torch.nn.Linear(64, 10)
        self.ff3 = torch.nn.Linear(10, out_shape)

    def forward(self, x):
        if len(x.shape) == 4:
            x = x.view(x.shape[0], -1)
        h = self.relu(self.ff1(x))
        h = self.relu(self.ff2(h))
        return self.ff3(h) # per action predicted rewards, not probabilities

class HRDataset(Dataset):
    def __init__(self, state_dim, n_actions):
        self.state_dim = state_dim  #obs_dim
        self.n_actions = n_actions
        self.dataset = [] # (S, RA) tuples for the entire session. RA is A * hR

    def __len__(self):
        return len(self.dataset)

    def __getitem__(self, idx):
        if torch.is_tensor(idx):
            idx = idx.tolist()
        sample = self.dataset[idx]
        return sample # S, RA

    def add_sample(self, observation, action, reward):
        onehot = torch.zeros(self.n_actions)
        onehot[action] = 1
        obs_tensor = torch.tensor(observation, dtype=torch.float32)
        state_action = torch.cat((obs_tensor, onehot), dim=0)
        reward_tensor = torch.tensor(reward, dtype=torch.float32)
        self.dataset.append((state_action, reward_tensor))


    def sample(self, batch_size):
        return sample(self.dataset, batch_size) # returns a list of (S, RA) tuples


# all this below is now in the model.py TODO: Delete later when no need reference
class TAMER:
    def __init__(self, env, conf):

        self.batch_size = conf.training.batch_size
        self.obs_dim = env.observation_space.shape[0] * env.observation_space.shape[1] # flatten
        self.n_actions = env.action_space.n
        self.obs_dim = self.obs_dim + self.n_actions
        self.model = BasicFF(in_shape=self.obs_dim, out_shape=1)
        self.dataset = HRDataset(state_dim=self.obs_dim, n_actions=self.n_actions)
        self.lr = conf.training.lr
        self.optimizer = torch.optim.Adam(self.model.parameters(), lr=self.lr)
        self.playback_duration = conf.study.playback_duration

    @torch.no_grad()
    def select_action(self, state):
        # in highway env we have "discrete meta actions" so we can treat this like discrete actions

        for action_idx in range(self.n_actions):
            onehot_action = torch.zeros(self.n_actions)
            onehot_action[action_idx] = 1
            state_action = torch.cat((torch.tensor(state.flatten(), dtype=torch.float32), onehot_action), dim=0).unsqueeze(0) # add batch dimension
            if action_idx == 0:
                all_state_actions = state_action
            else:
                all_state_actions = torch.cat((all_state_actions, state_action), dim=0)

        action_rewards = self.model(all_state_actions)
        action = torch.argmax(action_rewards).item()
        return action, action_rewards

    def add_samples(self, replay_buffer, human_reward):
        self.dataset.add_samples(replay_buffer, human_reward)

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

    def run_trained_model(self, env, path, render=True, max_steps=1000):
        '''Just running the general model. TODO: Maybe this is whitebox attack, but observing'''
        obs, info = env.reset()  
        done = False
        step_count = 0
        episode = 0
        trajectory = 0
        
        with open(os.path.join(path,"qfunction_log.csv"), "w", newline="") as f: #TODO add filename to cofig file, maybe have title with seed and model?
            fieldnames = ["trajectory", "episode","step", "action_rewards", "action", "observation"]
            writer = csv.DictWriter(f, fieldnames=fieldnames)   
            writer.writeheader()
            playback_start = time.time()
            while step_count < max_steps: #TODO make this have a persecond tracking (because we want to predict trajectories in a second)
                curr_time = time.time()
                if curr_time - playback_start >= self.playback_duration:
                    trajectory += 1
                    playback_start = curr_time  # reset timer
                action, action_rewards = self.select_action(obs)
                obs, reward, terminated, truncated, info = env.step(action)
                done = terminated or truncated
                # q function is the action_rewards
                row = {
                "trajectory": trajectory,
                "episode": episode,
                "step": step_count,
                "action_rewards": action_rewards.flatten().tolist(),
                "action": action,
                "observation": obs.flatten().tolist()
                }

                writer.writerow(row)
               
                if render:
                    env.render()
                if terminated or truncated:
                    episode += 1
                    obs, info = env.reset()
                step_count += 1



                