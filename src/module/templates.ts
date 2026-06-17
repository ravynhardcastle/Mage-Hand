import { delayMs, isModuleActive } from "./foundry-helpers";
import { pixelToGrid } from "./grid";

let squareSwapDepth = 0;
let trueRectShape: unknown;
let trueRectCaptured = false;

// this is a weird thing to do, but walled templates gives us centered squares
// which are naturally really dope and better and more convenient than using rects
// so i hack them into rects temporarily
// realistically. this should probably be swapped to using rects everywhere
// but idk V14 changes this all so this'll all be gutted eventually anyways
function pushSquareSwap(): Map<string, unknown> | undefined {
  if (!isModuleActive("walledtemplates")) return undefined;
  const wtModule = game.modules?.get("walledtemplates");
  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
  const wtApi = (wtModule as any)?.api;
  const registry = wtApi?.WalledTemplateShape?.shapeCodeRegister as Map<string, unknown> | undefined;
  const squareClass = wtApi?.WalledTemplateSquare;
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any */
  if (!registry || !squareClass) return undefined;
  if (squareSwapDepth === 0) {
    if (!trueRectCaptured) {
      // i was having a bug where sometimes it'd hallucinate that squares are rectangles
      trueRectShape = registry.get("rect");
      trueRectCaptured = true;
    }
    registry.set("rect", squareClass);
  }
  squareSwapDepth++;
  return registry;
}

function popSquareSwap(registry: Map<string, unknown> | undefined): void {
  if (!registry) return;
  squareSwapDepth = Math.max(0, squareSwapDepth - 1);
  if (squareSwapDepth === 0 && trueRectCaptured) {
    registry.set("rect", trueRectShape);
  }
}

export function waitForDrawMeasuredTemplate(templateId: string, timeoutMs: number = 5000): Promise<foundry.canvas.placeables.MeasuredTemplate> {
  return new Promise((resolve, reject) => {
    const hookId = Hooks.on("refreshMeasuredTemplate", (template: foundry.canvas.placeables.MeasuredTemplate) => {
      if (template.document.id === templateId) {
        clearTimeout(timer);
        Hooks.off("refreshMeasuredTemplate", hookId);
        resolve(template);
      }
    });
    const timer = setTimeout(() => {
      Hooks.off("refreshMeasuredTemplate", hookId);
      reject(new Error(`waitForDrawMeasuredTemplate timed out for ${templateId}`));
    }, timeoutMs);
  });
}

export function scheduleTemplateCleanup(scene: Scene, templateId: string): void {
  const chrisPremadesActive = isModuleActive("chris-premades");
  const deleteDelayMs = chrisPremadesActive ? 175 : 0;

  void (async () => {
    if (deleteDelayMs > 0) {
      await delayMs(deleteDelayMs);
    }
    if (scene.templates.has(templateId)) {
      await scene.deleteEmbeddedDocuments("MeasuredTemplate", [templateId]);
    }
  })();
}

export type TemplateRangeSource = {
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
}

export async function withRangeTemplate<T>(
  scene: Scene,
  source: TemplateRangeSource,
  rangeUnits: number,
  useTemplate: (templateObj: foundry.canvas.placeables.MeasuredTemplate) => Promise<T> | T,
  sourceItem?: Item,
  ranged: boolean = false
): Promise<T | undefined> {
  if (!canvas?.scene || scene.id !== canvas.scene.id) return undefined;

  const gridSize = scene.grid.size;
  const gridDist = scene.grid.distance;

  // Token center in pixels
  const tokenWidthPx = source.width * gridSize;
  const tokenHeightPx = source.height * gridSize;
  const centerX = source.x + tokenWidthPx / 2;
  const centerY = source.y + tokenHeightPx / 2;

  const walledFlags = sourceItem ? getWalledTemplateFlagsFromItem(sourceItem) : undefined;

  let templateCreateData: Record<string, unknown>;
  let swappedRegistry: Map<string, unknown> | undefined;

  if (ranged) {
    const radiusUnits = rangeUnits + Math.max(source.width, source.height) * gridDist / 2;
    templateCreateData = {
      t: "circle" as const,
      distance: radiusUnits,
      x: centerX,
      y: centerY,
      elevation: source.elevation,
      borderColor: "#000000",
      fillColor: "#ffffff",
    };
  } else {
    // centered square via rect template + WalledTemplateSquare swap
    const halfReach = rangeUnits + Math.max(source.width, source.height) * gridDist / 2;
    templateCreateData = {
      t: "rect" as const,
      direction: 45,
      distance: halfReach,
      x: centerX,
      y: centerY,
      elevation: source.elevation,
      borderColor: "#000000",
      fillColor: "#ffffff",
    };

    swappedRegistry = pushSquareSwap();
  }

  if (walledFlags) {
    templateCreateData["flags"] = { walledtemplates: walledFlags };
  }

  const [templateDoc] = await scene.createEmbeddedDocuments("MeasuredTemplate", [templateCreateData]);

  if (!templateDoc) {
    popSquareSwap(swappedRegistry);
    return undefined;
  }

  try {
    const templateObj = await waitForDrawMeasuredTemplate(templateDoc.id);
    if (!templateObj.shape) return undefined;
    return await Promise.resolve(useTemplate(templateObj));
  } finally {
    popSquareSwap(swappedRegistry);
    scheduleTemplateCleanup(scene, templateDoc.id);
  }
}

export function getWalledTemplateFlagsFromItem(item: Item): Record<string, unknown> | undefined {
  if (!isModuleActive("walledtemplates")) return undefined;

  const moduleId = "walledtemplates";
  const flagKeys = [
    "wallsBlock",
    "wallRestriction",
    "noAutotarget",
    "hideBorder",
    "hideHighlighting",
    "showOnHover",
    "snapCenter",
    "snapCorner",
    "snapSideMidpoint",
    "addTokenSize",
    "attachToken",
    "rotateWithAttachedToken",
  ];

  const flags: Record<string, unknown> = {};
  for (const key of flagKeys) {
    const value = foundry.utils.getProperty(item, `flags.${moduleId}.${key}`);
    if (value !== undefined) flags[key] = value;
  }

  return Object.keys(flags).length > 0 ? flags : undefined;
}

export function getTemplateHighlightedGridPositions(
  templateObj: foundry.canvas.placeables.MeasuredTemplate,
  scene: Scene
): { x: number; y: number }[] {
  if (scene.grid.type !== 1) return [];

  const positions = (templateObj as foundry.canvas.placeables.MeasuredTemplate & {
    _getGridHighlightPositions: () => { x: number; y: number }[];
  })._getGridHighlightPositions();

  const highlighted = new Set<string>();
  const results: { x: number; y: number }[] = [];
  for (const position of positions) {
    const gridPos = pixelToGrid(position.x, position.y, scene, { silent: true });
    if (!gridPos) continue;
    const key = `${gridPos.x},${gridPos.y}`;
    if (highlighted.has(key)) continue;
    highlighted.add(key);
    results.push(gridPos);
  }

  return results;
}

export function getTokensInTemplate(templateObj: foundry.canvas.placeables.MeasuredTemplate, scene: Scene, tokens: TokenDocument[]): TokenDocument[] {
  if (scene.grid.type !== 1) return [];

  const highlightedPositions = getTemplateHighlightedGridPositions(templateObj, scene);
  const highlighted = new Set(highlightedPositions.map(position => `${position.x},${position.y}`));

  const hits: TokenDocument[] = [];
  for (const token of tokens) {
    const topLeft = pixelToGrid(token.x, token.y, scene);
    if (!topLeft) continue;
    const tokenWidth = token.width;
    const tokenHeight = token.height;
    let hit = false;
    for (let dx = 0; dx < tokenWidth; dx++) {
      for (let dy = 0; dy < tokenHeight; dy++) {
        const checkX = topLeft.x + dx;
        const checkY = topLeft.y + dy;
        if (highlighted.has(`${checkX},${checkY}`)) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      hits.push(token);
    }
  }

  return hits;
}
