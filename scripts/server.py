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
    
    model = None
    model_dir = None
    time_start = None
    max_turns = None
    num_runs = None
    username = None
    session_type = None
    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            logger.info(message)
            if msg_type == "start": # for pretraining
                session_type = "pretrain"
                token_count = message["tokenCount"]
                model = RLModel(token_count)
                time_start = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                model_dir = Path.cwd() / "models"
                max_turns = message["maxTurns"]
                num_runs = message["numRuns"]
                model_dir.mkdir(parents=True, exist_ok=True)

            elif msg_type == "human_start": # for human training
                session_type = "human"
                token_count = message["tokenCount"]
                username = message["name"]
                time_start = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                model = RLModel(token_count)
                pretrain_dir = Path.cwd() / "models"
                model_dir = Path.cwd() / "models" / "tamer"
                model_dir.mkdir(parents=True, exist_ok=True)

                # Try to load the most recent pretrained model if one exists
                existing_models = sorted(pretrain_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime, reverse=True)
                if existing_models:
                    logger.info("Loading pretrained model: %s", existing_models[0])
                    model.load_trained_model(existing_models[0])
                else:
                    logger.info("No pretrained model found, starting fresh")


            elif msg_type == "state":
                if model is None:
                    logger.warning("Received state before start/human_start, ignoring")
                    continue
                model.last_observation = message["observation"]
                model.last_action= model.predict(model.last_observation)
                logger.info(model.last_observation)
                await websocket.send_json({"type": "action", "action": model.last_action})

            elif msg_type == "reward":
                model.observe_reward(
                    reward=message["reward"],
                    done=message.get("done", False),
                    observation=model.last_observation,
                    action=model.last_action,
                )
                model.update_policy()
                await websocket.send_json({"type": "ack"})

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
        logger.info("Client disconnected, saving prematurely")
        if model and model_dir:
            if session_type == "human":
                model_name = f"{username}_model_{time_start}.pth"
            else:
                model_name = f"model_{time_start}_turns{max_turns}_runs{num_runs}.pth"
            save_path = model_dir / model_name
            model.save_model(save_path)


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