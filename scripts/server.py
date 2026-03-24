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
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")

            if msg_type == "state":
                observation = message["observation"]
                action = model.predict(observation)
                await websocket.send_json({"type": "action", "action": action})

            elif msg_type == "reward":
                model.observe_reward(
                    reward=message["reward"],
                    done=message.get("done", False),
                )
                await websocket.send_json({"type": "ack"})

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