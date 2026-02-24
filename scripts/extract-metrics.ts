import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chain } from "stream-chain";

const require = createRequire(import.meta.url);

// stream-json is CJS; pull the functions via require()
const { parser } = require("stream-json") as typeof import("stream-json");
const { pick } = require("stream-json/filters/Pick") as typeof import("stream-json/filters/Pick");
const { streamObject } = require("stream-json/streamers/StreamObject") as typeof import("stream-json/streamers/StreamObject");

// Adjust this type as we get more values we actually want to graph
type EncodedState = {
  version: number;
  round: number;
  entities: Array<{
    name: string;
    id: string | null; // tokenId
    actorId: string | null;
    x: number;
    y: number;
    disposition: number;
    system?: {
      attributes?: {
        hp?: { value?: number; max?: number };
      };
    };
  }>;
};

async function findNewestJsonLog(logDir: string): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter(e => e.isFile())
    .map(e => path.join(logDir, e.name))
    .filter(p => p.endsWith(".json"))
    .filter(p => !p.endsWith(".ndjson")); // just in case

  if (candidates.length === 0) return null;

  const [firstCandidate, ...restCandidates] = candidates;
  if (!firstCandidate) return null;

  let newestPath = firstCandidate;
  let newestMtime = -Infinity;

  for (const p of [firstCandidate, ...restCandidates]) {
    const st = await fs.promises.stat(p);
    if (st.mtimeMs > newestMtime) {
      newestMtime = st.mtimeMs;
      newestPath = p;
    }
  }

  return newestPath;
}

const inputArg = process.argv[2];
const outputArg = process.argv[3];

const autoMode = !inputArg;

const inputPath = autoMode
  ? await (async () => {
      const logDir = path.resolve(process.cwd(), "logs");
      const newest = await findNewestJsonLog(logDir);
      if (!newest) {
        console.error(`No .json logs found in: ${logDir}`);
        console.error("Usage:");
        console.error("  yarn extract:metrics                  # uses newest ./logs/*.json -> ./logs/*.ndjson");
        console.error("  yarn extract:metrics <log.json>       # writes to stdout");
        console.error("  yarn extract:metrics <log.json> <out.ndjson>");
        process.exit(1);
      }
      return newest;
    })()
  : path.resolve(process.cwd(), inputArg);

const outputPath =
  outputArg
    ? path.resolve(process.cwd(), outputArg)
    : autoMode
      ? inputPath.replace(/\.json$/i, ".ndjson")
      : null;

if (autoMode) {
  // Helpful signal when running without redirection
  console.error(`Using newest log: ${inputPath}`);
  console.error(`Writing: ${outputPath}`);
}

const outStream: NodeJS.WritableStream = outputPath
  ? fs.createWriteStream(outputPath, { encoding: "utf8" })
  : process.stdout;

const pipeline = chain([
  fs.createReadStream(inputPath),
  parser(),
  pick({ filter: "log" }),
  streamObject(),
]);

pipeline.on("data", (data: { key: string; value: unknown }) => {
  const turn = Number(data.key);
  if (!Number.isFinite(turn)) return;
  if (typeof data.value !== "string") return;

  let state: EncodedState;
  try {
    state = JSON.parse(data.value) as EncodedState;
  } catch {
    return;
  }

  for (const e of state.entities) {
    if (!e.id) continue;

    const hp = e.system?.attributes?.hp?.value ?? null;

    outStream.write(
      JSON.stringify({
        turn,
        round: state.round,
        tokenId: e.id,
        actorId: e.actorId,
        name: e.name,
        disposition: e.disposition,
        x: e.x,
        y: e.y,
        hp,
      }) + "\n"
    );
  }
});

pipeline.on("end", () => {
  if (outputPath && outStream !== process.stdout) {
    (outStream as fs.WriteStream).end();
  }
});

pipeline.on("error", (err: unknown) => {
  console.error("extract-metrics failed:", err);
  process.exit(1);
});