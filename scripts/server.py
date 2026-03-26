"""
Client: { "type": "state", "observation": [int, float, int, int] }
Server: { "type": "action", "action": int }

Client: { "type": "reward", "reward": float, "done": bool }
Server: { "type": "ack" }

Client: { "type": "ping" }
Server: { "type": "pong" }
"""

from __future__ import annotations

import json
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

from model import RLModel
from pathlib import Path
from datetime import datetime


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dnd-rl-server")

app = FastAPI(title="DnD Model RL Server")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected")
    
    # Test if this fixes the initialization issue
    model = None
    model_dir = None
    time_start = None
    max_turns = None
    num_runs = None
    username = None
    try:
        while True:  #TODO: need a message to tell us when human training starts -> opens the model and trains on top of that with human reward or feedback. Only 1 episode/run
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            model = None
            if msg_type == "start": # for pretraining
                model = RLModel()
                time_start = datetime.now().strftime("%Y-%m-%d_%H-%M-%S") 
                model_dir = Path.cwd() / "models"
                max_turns = message["maxTurns"]
                num_runs = message["numRuns"]
                model_dir.mkdir(parents=True, exist_ok=True)
            
            elif msg_type == "human_start": # for human training
                # load trained model 
                username = message["name"]
                pretrained_model_name = message["pretrained_name"] # TODO: decide if this is an input from the server, or hardcoded because we're only using one specific pretrained model. Prolly the latter
                model = RLModel()
                model_dir = Path.cwd() / "models" / pretrained_model_name

                model.load_trained_model(model_dir)


            elif msg_type == "state":
                # observation per token: [isHostile, isTurn, isDead, maxSpeed, distToActiveToken, canKill, range]
                model.last_observation = message["observation"]
                model.last_action= model.predict(model.last_observation)
                await websocket.send_json({"type": "action", "action": model.last_action})

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
            elif msg_type == "finish": # need to always have more than 1 run?
                # save model, finish will always come after
                logger.info("FINISHED THE RUNS")
                model_name = f"model_{time_start}_turns{max_turns}_runs{num_runs}.pth"
                save_path = model_dir / model_name
                model.save_model(save_path)

            elif msg_type == "human_finish":
                logger.info("Done human training!")
                model_name = f"{username}_model_{time_start}.pth" # Maybe want to have more info here when we receive the finish message
                save_path = model_dir / model_name
                model.save_model(save_path) 
                

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            else:
                logger.warning("Unknown message type: %s", msg_type)
                await websocket.send_json(
                    {"type": "error", "message": f"Unknown type: {msg_type}"}
                )

    except WebSocketDisconnect:
        logger.info("Client disconnected")


@app.get("/health")
async def health():
    return {"status": "ok"}


def main():
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8765,
        reload=True,
        reload_dirs=["."],
    )


if __name__ == "__main__":
    main()