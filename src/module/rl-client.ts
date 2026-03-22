const RL_SERVER_URL = "ws://127.0.0.1:8765/ws";

let socket: WebSocket | null = null;
let pendingResolve: ((action: number) => void) | null = null;

export function connectRL(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    socket = new WebSocket(RL_SERVER_URL);

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

export function isRLConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}