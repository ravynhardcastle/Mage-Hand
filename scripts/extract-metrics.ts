import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chain } from "stream-chain";

const require = createRequire(import.meta.url);

const { parser } = require("stream-json") as typeof import("stream-json");
const { pick } = require("stream-json/filters/Pick") as typeof import("stream-json/filters/Pick");
const { streamObject } = require("stream-json/streamers/StreamObject") as typeof import("stream-json/streamers/StreamObject");
const { streamValues } = require("stream-json/streamers/StreamValues") as typeof import("stream-json/streamers/StreamValues");

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

type AttackResultTarget = {
  name: string;
  tokenId: string;
  ac: number;
  hit: boolean;
  damageDealt: number;
};

type AttackResult = {
  attacker: string;
  attackerId: string;
  weapon: string;
  attackTotal: number;
  isCritical: boolean;
  isFumble: boolean;
  kind: "action" | "reaction";
  targets: AttackResultTarget[];
};

type TurnLogEntry = {
  round?: number;
  state: string | undefined;
  events: AttackResult[];
};

type EncounterMeta = {
  totalEnemyXp?: number;
  enemyCount?: number;
  partyLevels?: number[];
  difficulty2014?: {
    multiplier?: number;
    adjustedXp?: number;
    ratio?: number;
    rating?: string;
    thresholds?: { easy?: number; medium?: number; hard?: number; deadly?: number };
  };
  difficulty2024?: {
    ratio?: number;
    rating?: string;
    budget?: { low?: number; moderate?: number; high?: number };
  };
};

function extractEncounter(inputPath: string, isGzipped: boolean): Promise<EncounterMeta | undefined> {
  return new Promise((resolve, reject) => {
    const stages: unknown[] = [fs.createReadStream(inputPath)];
    if (isGzipped) stages.push(zlib.createGunzip());
    stages.push(parser(), pick({ filter: "encounter" }), streamValues());
    const pipeline = chain(stages as Parameters<typeof chain>[0]);

    let settled = false;
    pipeline.on("data", (data: { value: unknown }) => {
      if (settled) return;
      settled = true;
      resolve((data.value && typeof data.value === "object") ? data.value as EncounterMeta : undefined);
      pipeline.destroy();
    });
    pipeline.on("end", () => { if (!settled) { settled = true; resolve(undefined); } });
    pipeline.on("error", (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function encounterLine(meta: EncounterMeta): string {
  const d2014 = meta.difficulty2014 ?? {};
  const d2024 = meta.difficulty2024 ?? {};
  const partyLevels = Array.isArray(meta.partyLevels) ? meta.partyLevels : [];
  return JSON.stringify({
    type: "encounter",
    totalEnemyXp: meta.totalEnemyXp ?? null,
    enemyCount: meta.enemyCount ?? null,
    partySize: partyLevels.length,
    partyLevels,
    d2014_multiplier: d2014.multiplier ?? null,
    d2014_adjustedXp: d2014.adjustedXp ?? null,
    d2014_ratio: d2014.ratio ?? null,
    d2014_rating: d2014.rating ?? null,
    d2024_ratio: d2024.ratio ?? null,
    d2024_rating: d2024.rating ?? null,
  }) + "\n";
}

async function listJsonLogs(logDir: string): Promise<{ path: string; mtimeMs: number }[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(logDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter(e => e.isFile())
    .map(e => path.join(logDir, e.name))
    .filter(p => p.endsWith(".json") || p.endsWith(".json.gz"))
    .filter(p => !p.endsWith(".ndjson"));

  const withStats: { path: string; mtimeMs: number }[] = [];
  for (const p of candidates) {
    const st = await fs.promises.stat(p);
    withStats.push({ path: p, mtimeMs: st.mtimeMs });
  }

  // newest first
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats;
}

async function isGzipFile(p: string): Promise<boolean> {
  const fh = await fs.promises.open(p, "r");
  try {
    const buf = Buffer.alloc(2);
    await fh.read(buf, 0, 2, 0);
    return buf[0] === 0x1f && buf[1] === 0x8b;
  } finally {
    await fh.close();
  }
}

export function processFile(inputPath: string, outStream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const isGzipped = inputPath.endsWith(".gz") || await isGzipFile(inputPath);

      // metadata as first record
      const encounter = await extractEncounter(inputPath, isGzipped);
      if (encounter) outStream.write(encounterLine(encounter));

      const stages: unknown[] = [fs.createReadStream(inputPath)];
      if (isGzipped) stages.push(zlib.createGunzip());
      stages.push(parser(), pick({ filter: "log" }), streamObject());
      const pipeline = chain(stages as Parameters<typeof chain>[0]);

    pipeline.on("data", (data: { key: string; value: unknown }) => {
      const turn = Number(data.key);
      if (!Number.isFinite(turn)) return;

      let stateStr: string | undefined;
      let events: AttackResult[] = [];
      let entryRound: number | undefined;

      if (typeof data.value === "string") {
        stateStr = data.value;
      } else if (typeof data.value === "object" && data.value !== null) {
        const entry = data.value as TurnLogEntry;
        stateStr = entry.state;
        events = Array.isArray(entry.events) ? entry.events : [];
        if (typeof entry.round === "number") entryRound = entry.round;
      } else {
        return;
      }

      let stateRound: number | undefined;
      if (stateStr) {
        let state: EncodedState | undefined;
        try {
          state = JSON.parse(stateStr) as EncodedState;
        } catch {
          // skip unparseable state
        }

        if (state) {
          stateRound = state.round;
          for (const e of state.entities) {
            if (!e.id) continue;

            const hp = e.system?.attributes?.hp?.value ?? null;
            const hpMax = e.system?.attributes?.hp?.max ?? null;

            outStream.write(
              JSON.stringify({
                type: "state",
                turn,
                round: entryRound ?? state.round,
                tokenId: e.id,
                actorId: e.actorId,
                name: e.name,
                disposition: e.disposition,
                x: e.x,
                y: e.y,
                hp,
                hpMax,
              }) + "\n"
            );
          }
        }
      }

      const attackRound = entryRound ?? stateRound;
      for (const event of events) {
        for (const target of event.targets) {
          outStream.write(
            JSON.stringify({
              type: "attack",
              turn,
              round: attackRound,
              attacker: event.attacker,
              attackerId: event.attackerId,
              weapon: event.weapon,
              attackTotal: event.attackTotal,
              isCritical: event.isCritical,
              isFumble: event.isFumble,
              kind: event.kind,
              targetName: target.name,
              targetTokenId: target.tokenId,
              targetAC: target.ac,
              hit: target.hit,
              damageDealt: target.damageDealt,
            }) + "\n"
          );
        }
      }
    });

    pipeline.on("end", () => { resolve(); });
    pipeline.on("error", (err: unknown) => { reject(err instanceof Error ? err : new Error(String(err))); });
    })().catch((err: unknown) => { reject(err instanceof Error ? err : new Error(String(err))); });
  });
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
const args = process.argv.slice(2);
const flagAll = args.includes("--all");
const lastIdx = args.indexOf("--last");
const lastN = lastIdx !== -1 ? Number(args[lastIdx + 1]) : 0;
const dirIdx = args.indexOf("--dir");
const dirArg = dirIdx !== -1 ? args[dirIdx + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith("--")
  && (i === 0 || (args[i - 1] !== "--last" && args[i - 1] !== "--dir")));

if (flagAll || lastN > 0 || dirArg !== undefined) {
  const logDir = path.resolve(process.cwd(), dirArg ?? "logs");
  let logs = await listJsonLogs(logDir);

  if (logs.length === 0) {
    console.error(`No .json logs found in: ${logDir}`);
    process.exit(1);
  }

  if (lastN > 0) {
    logs = logs.slice(0, lastN);
  }

  let processed = 0;
  let skipped = 0;
  for (const log of logs) {
    const ndjsonPath = log.path.replace(/\.json(\.gz)?$/i, ".ndjson");

    if (flagAll && !lastN) {
      try {
        const ndjsonStat = await fs.promises.stat(ndjsonPath);
        if (ndjsonStat.mtimeMs >= log.mtimeMs) {
          skipped++;
          continue;
        }
      } catch {
        // .ndjson doesn't exist yet, will be created
      }
    }

    console.error(`Extracting: ${path.basename(log.path)} → ${path.basename(ndjsonPath)}`);
    const ws = fs.createWriteStream(ndjsonPath, { encoding: "utf8" });
    try {
      await processFile(log.path, ws);
    } finally {
      ws.end();
      await new Promise<void>((resolve) => ws.on("finish", resolve));
    }
    processed++;
  }

  console.error(`Done. Processed ${processed} file(s), skipped ${skipped}.`);
  process.exit(0);
}

const inputArg = positional[0];
const outputArg = positional[1];

const autoMode = !inputArg;

const inputPath = autoMode
  ? await (async () => {
      const logDir = path.resolve(process.cwd(), "logs");
      const logs = await listJsonLogs(logDir);
      if (logs.length === 0) {
        console.error(`No .json logs found in: ${logDir}`);
        console.error("Usage:");
        console.error("  yarn extract:metrics                  # uses newest ./logs/*.json -> ./logs/*.ndjson");
        console.error("  yarn extract:metrics <log.json>       # writes to stdout");
        console.error("  yarn extract:metrics <log.json> <out.ndjson>");
        console.error("  yarn extract:metrics --all            # batch-extract all logs");
        console.error("  yarn extract:metrics --last N         # batch-extract the N newest logs");
        console.error("  yarn extract:dir <folder>             # batch-extract all logs in <folder>");
        process.exit(1);
      }
      const newest = logs[0];
      if (!newest) {
        console.error("No .json logs found");
        process.exit(1);
      }
      return newest.path;
    })()
  : path.resolve(process.cwd(), inputArg);

const outputPath =
  outputArg
    ? path.resolve(process.cwd(), outputArg)
    : autoMode
      ? inputPath.replace(/\.json(\.gz)?$/i, ".ndjson")
      : null;

if (autoMode) {
  console.error(`Using newest log: ${inputPath}`);
  console.error(`Writing: ${outputPath}`);
}

const outStream: NodeJS.WritableStream = outputPath
  ? fs.createWriteStream(outputPath, { encoding: "utf8" })
  : process.stdout;

try {
  await processFile(inputPath, outStream);
} catch (err) {
  console.error("extract-metrics failed:", err);
  process.exit(1);
} finally {
  if (outputPath && outStream !== process.stdout) {
    (outStream as fs.WriteStream).end();
  }
}
}