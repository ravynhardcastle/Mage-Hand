const RL_SERVER_PORT = 8765;

function getRLServerURL(): string {
  const host = window.location.hostname || "127.0.0.1";
  return `ws://${host}:${RL_SERVER_PORT}/ws`;
}

function getRLServerHttpURL(): string {
  const host = window.location.hostname || "127.0.0.1";
  return `http://${host}:${RL_SERVER_PORT}`;
}

export async function fetchAvailableModels(): Promise<{ name: string; path: string; dir: string; modified: string }[]> {
  try {
    const resp = await fetch(`${getRLServerHttpURL()}/models`);
    if (!resp.ok) return [];
    const data = await resp.json() as { models: { name: string; path: string; dir: string; modified: string }[] };
    return data.models;
  } catch {
    return [];
  }
}

let socket: WebSocket | null = null;
let pendingResolve: ((action: number) => void) | null = null;

export function connectRL(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const url = getRLServerURL();
    console.log("Connecting to RL server at", url);
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log("RL server connected");
      resolve();
    };

    socket.onerror = (err) => {
      console.error("RL server connection error:", err);
      reject(new Error("RL server connection failed"));
    };

    socket.onclose = () => {
      console.log("RL server disconnected");
      socket = null;
    };

    socket.onmessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data as string) as { type: string; action?: number };
      if (msg.type === "action" && pendingResolve) {
        pendingResolve(msg.action ?? 0);
        pendingResolve = null;
      }
    };
  });
}

export function getAction(observation: number[]): Promise<number> {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("RL server not connected"));
      return;
    }
    pendingResolve = resolve;
    socket.send(JSON.stringify({ type: "state", observation }));
  });
}

export function sendReward(reward: number, done: boolean): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "reward", reward, done }));
}

export function sendStart(maxTurns: number, numRuns: number, tokenCount: number, ppo: boolean = false): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const type = ppo ? "ppo_start" : "start";
  socket.send(JSON.stringify({ type, maxTurns, numRuns, tokenCount }));
}

export function sendEvalStart(tokenCount: number, modelPath?: string): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "eval_start", tokenCount, modelPath }));
}

export function sendHumanStart(name: string, tokenCount: number): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "human_start", name, tokenCount }));
}

export function sendResume(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "resume" }));
}

export function sendFinish(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "finish" }));
}

export function sendHumanFinish(name: string): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "human_finish", name }));
}

export function isRLConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}