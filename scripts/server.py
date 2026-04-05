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
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from model import RLModel
from pathlib import Path
from datetime import datetime


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dnd-rl-server")

app = FastAPI(title="DnD Model RL Server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# this is so that if the browser refreshes or anything, it still remembers the model
_session: dict = {
    "model": None,
    "model_dir": None,
    "time_start": None,
    "max_turns": None,
    "num_runs": None,
    "username": None,
    "session_type": None,
}


def _reset_session():
    for key in _session:
        _session[key] = None


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    logger.info("Client connected")

    try:
        while True:
            raw = await websocket.receive_text()
            message = json.loads(raw)
            msg_type = message.get("type")
            logger.info(message)
            if msg_type == "start": # for pretraining
                _reset_session()
                _session["session_type"] = "pretrain"
                token_count = message["tokenCount"]
                _session["model"] = RLModel(token_count)
                _session["time_start"] = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                _session["model_dir"] = Path.cwd() / "models"
                _session["max_turns"] = message["maxTurns"]
                _session["num_runs"] = message["numRuns"]
                _session["model_dir"].mkdir(parents=True, exist_ok=True)

            elif msg_type == "eval_start": # for eval only
                _reset_session()
                _session["session_type"] = "eval"
                token_count = message["tokenCount"]
                _session["model"] = RLModel(token_count)
                model_path = message.get("modelPath")

                if model_path:
                    logger.info("Loading model for eval: %s", model_path)
                    _session["model"].load_trained_model(model_path)
                else:
                    # Load the most recent model if no path specified
                    search_dirs = [Path.cwd() / "models" / "tamer", Path.cwd() / "models"]
                    loaded = False
                    for search_dir in search_dirs:
                        if not search_dir.exists():
                            continue
                        existing = sorted(search_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime, reverse=True)
                        if existing:
                            logger.info("Loading most recent model for eval: %s", existing[0])
                            _session["model"].load_trained_model(existing[0])
                            loaded = True
                            break
                    if not loaded:
                        logger.warning("No model found for eval, using untrained model")

            elif msg_type == "human_start": # for human training
                _reset_session()
                _session["session_type"] = "human"
                token_count = message["tokenCount"]
                _session["username"] = message["name"]
                _session["time_start"] = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
                _session["model"] = RLModel(token_count)
                pretrain_dir = Path.cwd() / "models"
                _session["model_dir"] = Path.cwd() / "models" / "tamer"
                _session["model_dir"].mkdir(parents=True, exist_ok=True)

                # Try to load the most recent pretrained model if one exists
                existing_models = sorted(pretrain_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime, reverse=True)
                if existing_models:
                    logger.info("Loading pretrained model: %s", existing_models[0])
                    _session["model"].load_trained_model(existing_models[0])
                    _session["model"].model.train()  # back to training mode for TAMER fine-tuning
                else:
                    logger.info("No pretrained model found, starting fresh")


            elif msg_type == "state":
                model = _session["model"]
                if model is None:
                    logger.warning("Received state before start/human_start, ignoring")
                    continue
                model.last_observation = message["observation"]
                model.last_action = model.predict(model.last_observation)
                logger.info(model.last_observation)
                await websocket.send_json({"type": "action", "action": model.last_action})

            elif msg_type == "reward":
                model = _session["model"]
                if _session["session_type"] == "eval":
                    await websocket.send_json({"type": "ack"})
                else:
                    model.observe_reward(
                        reward=message["reward"],
                        done=message.get("done", False),
                        observation=model.last_observation,
                        action=model.last_action,
                    )
                    model.update_policy()
                    await websocket.send_json({"type": "ack"})

            elif msg_type == "finish":
                model = _session["model"]
                model_dir = _session["model_dir"]
                if _session["session_type"] == "eval":
                    logger.info("Eval session finished")
                else:
                    logger.info("FINISHED THE RUNS")
                    model_name = f"model_{_session['time_start']}_turns{_session['max_turns']}_runs{_session['num_runs']}.pth"
                    save_path = model_dir / model_name
                    model.save_model(save_path)
                _reset_session()

            elif msg_type == "human_finish":
                model = _session["model"]
                model_dir = _session["model_dir"]
                logger.info("Done human training!")
                model_name = f"{_session['username']}_model_{_session['time_start']}.pth"
                save_path = model_dir / model_name
                model.save_model(save_path)
                _reset_session()

            elif msg_type == "resume":
                # bowser refresh
                if _session["model"] is not None:
                    logger.info("Resume received (type=%s)", _session["session_type"])
                    await websocket.send_json({"type": "ack"})
                else:
                    logger.warning("Resume received but no active session")
                    await websocket.send_json({"type": "error", "message": "No active session to resume"})

            elif msg_type == "ping":
                await websocket.send_json({"type": "pong"})

            else:
                logger.warning("Unknown message type: %s", msg_type)
                await websocket.send_json(
                    {"type": "error", "message": f"Unknown type: {msg_type}"}
                )

    except WebSocketDisconnect:
        logger.info("Client disconnected (session state preserved in memory)")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/models")
async def list_models():
    search_dirs = [Path.cwd() / "models" / "tamer", Path.cwd() / "models"]
    models = []
    for search_dir in search_dirs:
        if not search_dir.exists():
            continue
        for p in sorted(search_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime, reverse=True):
            models.append({
                "name": p.name,
                "path": str(p),
                "dir": search_dir.name,
                "size": p.stat().st_size,
                "modified": datetime.fromtimestamp(p.stat().st_mtime).isoformat(),
            })
    return {"models": models}


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