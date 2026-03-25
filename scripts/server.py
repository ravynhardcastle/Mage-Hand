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

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dnd-rl-server")

app = FastAPI(title="DnD Model RL Server")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    model = RLModel()
    logger.info("Client connected")

    try:
        while True: 
            #TODO: Is there like a "start_rollout" message to trigger this, gets the turns per run and number of runs 
            # so I can make a training loop
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            # if  msg_type == "start_rollout"
            # call a training function with rollout info
            if msg_type == "state":
                # observation per token: [isHostile, hpFraction, isCurrentTurn, distToActiveToken]
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