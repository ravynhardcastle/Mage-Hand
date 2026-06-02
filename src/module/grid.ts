import { isActorAtZeroHp } from "./actor-status";

export type SceneGridInfo = {
  sizeX: number;
  sizeY: number;
  paddingX: number;
  paddingY: number;
  widthCells: number;
  heightCells: number;
};

export function getSceneGridInfo(scene: Scene, silent: boolean = false): SceneGridInfo | undefined {
  const grid = scene.grid;
  if (grid.type !== 1) {
    if (!silent) ui.notifications?.warn("DNDModel.SceneCalc.GridTypeWarning");
    return undefined;
  }
  return {
    sizeX: grid.sizeX,
    sizeY: grid.sizeY,
    paddingX: scene.dimensions.sceneX,
    paddingY: scene.dimensions.sceneY,
    widthCells: Math.floor(scene.dimensions.sceneWidth / grid.sizeX),
    heightCells: Math.floor(scene.dimensions.sceneHeight / grid.sizeY),
  };
}

export type PixelToGridOptions = { round?: boolean; silent?: boolean };

export function pixelToGrid(pixelX: number, pixelY: number, scene: Scene, opts: PixelToGridOptions = {}): { x: number; y: number } | undefined {
  const info = getSceneGridInfo(scene, opts.silent);
  if (!info) return undefined;
  const op = opts.round ? Math.round : Math.floor;
  const gridX = op((pixelX - info.paddingX) / info.sizeX);
  const gridY = op((pixelY - info.paddingY) / info.sizeY);
  if (gridX >= 0 && gridX < info.widthCells && gridY >= 0 && gridY < info.heightCells) {
    return { x: gridX, y: gridY };
  }
  if (!opts.silent) console.warn(`Pixel position (${pixelX}, ${pixelY}) is out of bounds for scene ${scene.id}`);
  return undefined;
}

export function gridToPixel(gridX: number, gridY: number, scene: Scene): { x: number; y: number } | undefined {
  const info = getSceneGridInfo(scene);
  if (!info) return undefined;
  if (gridX >= 0 && gridX < info.widthCells && gridY >= 0 && gridY < info.heightCells) {
    return { x: gridX * info.sizeX + info.paddingX, y: gridY * info.sizeY + info.paddingY };
  }
  console.warn(`Grid position (${gridX}, ${gridY}) is out of bounds for scene ${scene.id}`);
  return undefined;
}

export type GridRect = {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function gridRectsOverlap(a: GridRect, b: GridRect): boolean {
  return (a.x < b.x + b.width) && (a.x + a.width > b.x) && (a.y < b.y + b.height) && (a.y + a.height > b.y);
}

// Min cells you'd have to step through to get from any cell in `a` to any cell in `b`.
// 0 means overlapping or adjacent-corner; 1 means orthogonally/diagonally adjacent.
export function gridRectChebyshevDistance(a: GridRect, b: GridRect): number {
  const aR = a.x + a.width - 1;
  const aB = a.y + a.height - 1;
  const bR = b.x + b.width - 1;
  const bB = b.y + b.height - 1;
  const dx = a.x > bR ? a.x - bR : (b.x > aR ? b.x - aR : 0);
  const dy = a.y > bB ? a.y - bB : (b.y > aB ? b.y - aB : 0);
  return Math.max(dx, dy);
}

export function toGridRect(
  source: { x: number; y: number; width: number; height: number },
  scene: Scene,
  opts: { useCanvasGrid?: boolean } = {}
): GridRect | null {
  let topLeft: { x: number; y: number } | undefined;
  if (opts.useCanvasGrid) {
    const grid = canvas?.grid;
    const canvasScene = canvas?.scene ?? null;
    if (grid && canvasScene && canvasScene.id === scene.id) {
      const offset = grid.getOffset({ x: source.x, y: source.y });
      const canonicalTopLeft = grid.getTopLeftPoint(offset);
      topLeft = pixelToGrid(canonicalTopLeft.x, canonicalTopLeft.y, scene);
    }
  }
  topLeft ??= pixelToGrid(source.x, source.y, scene, { round: true, silent: true });
  if (!topLeft) return null;
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(1, Math.ceil(source.width)),
    height: Math.max(1, Math.ceil(source.height)),
  };
}

export function destinationIsOccupied(scene: Scene, dest: GridRect, movingTokenId: string): boolean {
  for (const token of scene.tokens) {
    if (token.id === movingTokenId) continue;
    if (isActorAtZeroHp(token.actor ?? undefined)) continue;
    const tokenRect = toGridRect(token, scene, { useCanvasGrid: true });
    if (!tokenRect) continue;
    if (gridRectsOverlap(dest, tokenRect)) {
      return true;
    }
  }
  return false;
}

export function getTokenPixelRect(token: TokenDocument, scene: Scene): GridRect {
  return {
    x: token.x,
    y: token.y,
    width: Math.max(1, Math.ceil(token.width)) * scene.grid.sizeX,
    height: Math.max(1, Math.ceil(token.height)) * scene.grid.sizeY,
  };
}

export function getTokenCenter(token: TokenDocument, scene: Scene): { x: number; y: number } {
  return {
    x: token.x + (Math.max(1, Math.ceil(token.width)) * scene.grid.sizeX) / 2,
    y: token.y + (Math.max(1, Math.ceil(token.height)) * scene.grid.sizeY) / 2,
  };
}

// Returns the edge or corner anchor on `caster`'s footprint whose outward direction best aligns
// with the angle to `target`. Used for orienting cones/rays/lines emanating from the caster.
export function chooseEdgeOrCornerAnchorForTarget(
  caster: TokenDocument,
  target: TokenDocument,
  scene: Scene,
): { x: number; y: number; direction: number } {
  const w = Math.max(1, Math.ceil(caster.width)) * scene.grid.sizeX;
  const h = Math.max(1, Math.ceil(caster.height)) * scene.grid.sizeY;
  const left = caster.x;
  const top = caster.y;
  const right = left + w;
  const bottom = top + h;

  const candidates = [
    { x: left + (w / 2), y: top, direction: 270 },
    { x: right, y: top + (h / 2), direction: 0 },
    { x: left + (w / 2), y: bottom, direction: 90 },
    { x: left, y: top + (h / 2), direction: 180 },
    { x: left, y: top, direction: 225 },
    { x: right, y: top, direction: 315 },
    { x: right, y: bottom, direction: 45 },
    { x: left, y: bottom, direction: 135 },
  ];

  const targetCenter = getTokenCenter(target, scene);

  const angleToTarget = (fromX: number, fromY: number) => {
    const dx = targetCenter.x - fromX;
    const dy = targetCenter.y - fromY;
    const deg = Math.toDegrees(Math.atan2(dy, dx));
    return (deg + 360) % 360;
  };
  const angleDiff = (a: number, b: number) => {
    const diff = Math.abs(a - b) % 360;
    return diff > 180 ? 360 - diff : diff;
  };

  let best = candidates[0] ?? { x: left + (w / 2), y: top, direction: 270 };
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const targetAngle = angleToTarget(candidate.x, candidate.y);
    const diff = angleDiff(candidate.direction, targetAngle);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }

  return best;
}

export function tokenOverlapsToken(scene: Scene, movingToken: TokenDocument): boolean {
  const moverRect = getTokenPixelRect(movingToken, scene);
  for (const token of scene.tokens) {
    if (token.id === movingToken.id) continue;
    if (isActorAtZeroHp(token.actor ?? undefined)) continue;
    const tokenRect = getTokenPixelRect(token, scene);
    if (gridRectsOverlap(moverRect, tokenRect)) {
      return true;
    }
  }
  return false;
}

export function getMovementGridPositions(
  oldPos: { x: number; y: number },
  newPos: { x: number; y: number },
  scene: Scene
): { x: number; y: number }[] {
  const dx = newPos.x - oldPos.x;
  const dy = newPos.y - oldPos.y;
  const distancePx = Math.sqrt(dx * dx + dy * dy);
  if (distancePx === 0) return [];

  const grid = canvas?.grid;
  if (!grid) return [];

  const startOffset = grid.getOffset(oldPos);
  const endOffset = grid.getOffset(newPos);

  const pathOffsets = grid.getDirectPath([startOffset, endOffset]);

  const gridCells: { x: number; y: number }[] = [];
  const seen = new Set<string>();

  for (const offset of pathOffsets) {
    // Convert grid offset back to our grid coordinate system
    const topLeft = grid.getTopLeftPoint(offset);
    const gridPos = pixelToGrid(topLeft.x, topLeft.y, scene);
    if (!gridPos) continue;

    const key = `${gridPos.x},${gridPos.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      gridCells.push(gridPos);
    }
  }

  return gridCells;
}
