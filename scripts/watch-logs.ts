import fs from "node:fs";
import path from "node:path";

import { processFile } from "./extract-metrics";

const root = path.resolve(process.cwd(), process.argv[2] ?? "logs");
const DEBOUNCE_MS = 400;
const STABLE_POLL_MS = 250;

const debounceTimers = new Map<string, NodeJS.Timeout>();
const inFlight = new Set<string>();

function isLogFile(p: string): boolean {
  return /\.json(\.gz)?$/i.test(p) && !p.endsWith(".ndjson");
}

function ndjsonPathFor(jsonPath: string): string {
  return jsonPath.replace(/\.json(\.gz)?$/i, ".ndjson");
}

async function ndjsonIsFresh(jsonPath: string, ndjsonPath: string): Promise<boolean> {
  try {
    const [j, n] = await Promise.all([fs.promises.stat(jsonPath), fs.promises.stat(ndjsonPath)]);
    return n.mtimeMs >= j.mtimeMs;
  } catch {
    return false;
  }
}

// this is needed bc the jsons are technically streamed
// so we gotta make sure that we aren't making ndjsons w nothingburgers
async function waitForStableSize(p: string): Promise<boolean> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    let size: number;
    try {
      size = (await fs.promises.stat(p)).size;
    } catch {
      return false;
    }
    if (size === last && size > 0) return true;
    last = size;
    await new Promise(r => setTimeout(r, STABLE_POLL_MS));
  }
  return true;
}

async function extract(jsonPath: string): Promise<void> {
  if (inFlight.has(jsonPath)) return;
  const ndjsonPath = ndjsonPathFor(jsonPath);
  if (await ndjsonIsFresh(jsonPath, ndjsonPath)) return;

  inFlight.add(jsonPath);
  try {
    if (!(await waitForStableSize(jsonPath))) return;
    if (await ndjsonIsFresh(jsonPath, ndjsonPath)) return;
    console.error(`Extracting: ${path.relative(root, jsonPath)} → ${path.basename(ndjsonPath)}`);
    const ws = fs.createWriteStream(ndjsonPath, { encoding: "utf8" });
    try {
      await processFile(jsonPath, ws);
    } finally {
      ws.end();
      await new Promise<void>(resolve => ws.on("finish", resolve));
    }
  } catch (err) {
    console.error(`Failed to extract ${jsonPath}:`, err);
  } finally {
    inFlight.delete(jsonPath);
  }
}

function schedule(jsonPath: string): void {
  clearTimeout(debounceTimers.get(jsonPath));
  debounceTimers.set(jsonPath, setTimeout(() => {
    debounceTimers.delete(jsonPath);
    void extract(jsonPath);
  }, DEBOUNCE_MS));
}

async function* walkLogs(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkLogs(full);
    else if (entry.isFile() && isLogFile(full)) yield full;
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(root)) {
    console.error(`Watch folder does not exist: ${root}`);
    process.exit(1);
  }

  // one pass as we startup just in case
  let caughtUp = 0;
  for await (const jsonPath of walkLogs(root)) {
    if (!(await ndjsonIsFresh(jsonPath, ndjsonPathFor(jsonPath)))) {
      await extract(jsonPath);
      caughtUp++;
    }
  }
  console.error(`Watching ${root} for new logs (processed ${caughtUp} logs on startup).`);

  // warning that i think this doesnt work on linux on old versions of node
  // shld be fine though
  fs.watch(root, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const full = path.resolve(root, filename);
    if (isLogFile(full)) schedule(full);
  });
}

main().catch((err: unknown) => {
  console.error("watch-logs failed:", err);
  process.exit(1);
});
