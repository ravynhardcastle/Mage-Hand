def training_loop(pretraining:bool, model, max_timesteps: int, tot_episodes: int):
    '''
    pretraining: if false, human training NOTE: might get rid of this. I think the use rl for hostile units is the boolean? Maybe?
    max_timesteps = turns_per_run 
    tot_episodes = number_of_runs 
    '''

    for ep in range(tot_episodes):
        done = False
        steps = 0

        while not done and steps < max_timesteps:
            if msg_type == "state":
                observation = message["observation"]
                action = model.predict(observation)
                await websocket.send_json({"type": "action", "action": action})

            elif msg_type == "reward": # termination reward
                model.observe_reward(
                    reward=message["reward"],
                    done=message.get("done", False),
                    observation=model.last_observation,
                    action=model.last_action,
                )
                await websocket.send_json({"type": "ack"})

            elif msg_type == "human_reward": #TODO: make a human_reward type
                model.observe_reward(
                    human_reward=message["reward"],   # TODO: figure out what is the human reward (+/- some large number)
                    done=False,
                    observation=model.last_observation,
                    action=model.last_action,
                )
            model.update_policy()

  
    torch.save(model.model.state_dict(), "trained_model.pth")
