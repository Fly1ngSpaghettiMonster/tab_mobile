import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import type { Gap } from './gaps';
import { MAX_PLAUSIBLE_SPEED_MPS } from './track';

/**
 * Fills GPS gaps (tunnels, underground stretches) after a trip by following the road network,
 * or the rail network for metro rides.
 *
 * Geometry comes from the same OpenMapTiles vector tiles the map shows: for each gap we
 * download the few zoom-14 tiles around it, build a small graph of roads (and one of rail lines)
 * and take the shortest path between the positions on either side of the gap.
 * A path is only used if it is plausible (not much longer than the straight line, possible
 * in the time the gap lasted, and consistent with any coarse Wi-Fi/cell fixes from the gap).
 */

export type NetworkMode = 'road' | 'rail';

export type GapFill = {
  fromSequence: number;
  toSequence: number;
  /** [longitude, latitude] pairs from the gap start to its end, along the roads or rails. */
  path: [number, number][];
  lengthMeters: number;
  /** True when the path goes through a road or rail line marked as a tunnel. */
  tunnel: boolean;
  /** Which network the path follows. */
  mode: NetworkMode;
};

export type TileFetcher = (z: number, x: number, y: number) => Promise<ArrayBuffer | null>;

const TILE_ZOOM = 14;
const MAX_TILES_PER_GAP = 60;
// Width of the strip around the gap's straight line that is searched for roads: first narrow,
// then (if that finds no connection) a fraction of the gap length.
const NARROW_MARGIN_METERS = 400;
const WIDE_MARGIN_FACTOR = 0.15;
// Metro stations and their exits can lie this far from the track, so a gap end at an accurate
// (street-level) fix may be snapped onto a rail line from further away than onto a road.
const MIN_RAIL_SNAP_METERS = 150;
// If at least this share of the fixes inside a gap saw no satellites, the gap was underground.
const UNDERGROUND_SHARE = 0.5;
// Line ends this close to another road are joined to it (roads split across tiles).
const JOIN_METERS = 8;
const GRID_CELL_METERS = 50;
// The road path may be at most this much longer than the straight line ...
const MAX_DETOUR_FACTOR = 2.5;
const MAX_DETOUR_EXTRA_METERS = 500;
// ... and must be drivable in the gap's duration (see MAX_PLAUSIBLE_SPEED_MPS).
// Coarse fixes inside the gap must mostly agree with the chosen path.
const COARSE_FIX_MAX_ACCURACY = 1000;
const COARSE_FIX_MIN_TOLERANCE_METERS = 150;
const COARSE_FIX_AGREEMENT = 0.7;

const DRIVABLE_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);
// Railways, and metro / light rail / tram lines (class "transit" in OpenMapTiles).
const RAIL_CLASSES = new Set(['rail', 'transit']);

// --- Geometry helpers: a local metric projection around the gap -------------------------

type XY = { x: number; y: number };

function makeProjection(lat0: number, lon0: number) {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (lon: number, lat: number): XY => ({ x: (lon - lon0) * mPerDegLon, y: (lat - lat0) * mPerDegLat }),
    toLonLat: (p: XY): [number, number] => [lon0 + p.x / mPerDegLon, lat0 + p.y / mPerDegLat],
  };
}

const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);

/** Closest point on segment ab to p, with t in [0, 1] along the segment. */
function projectOnSegment(p: XY, a: XY, b: XY): { point: XY; t: number; d: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  return { point, t, d: dist(p, point) };
}

// --- Tiles --------------------------------------------------------------------------------

function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

function tilePointToLonLat(z: number, tx: number, ty: number, px: number, py: number, extent: number) {
  const n = 2 ** z;
  const lon = ((tx + px / extent) / n) * 360 - 180;
  const merc = Math.PI * (1 - (2 * (ty + py / extent)) / n);
  const lat = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
  return [lon, lat] as [number, number];
}

type RoadLine = { coords: [number, number][]; oneway: number; tunnel: boolean; mode: NetworkMode };

function decodeLines(buffer: ArrayBuffer, z: number, x: number, y: number): RoadLine[] {
  const layer = new VectorTile(new PbfReader(buffer)).layers.transportation;
  if (!layer) return [];
  const lines: RoadLine[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 2) continue;
    const cls = String(f.properties.class);
    const mode: NetworkMode | null = DRIVABLE_CLASSES.has(cls) ? 'road' : RAIL_CLASSES.has(cls) ? 'rail' : null;
    if (!mode) continue;
    // One-way only matters on roads.
    const oneway = mode === 'road' ? Number(f.properties.oneway ?? 0) : 0;
    const tunnel = f.properties.brunnel === 'tunnel';
    for (const line of f.loadGeometry()) {
      if (line.length < 2) continue;
      lines.push({ coords: line.map((p) => tilePointToLonLat(z, x, y, p.x, p.y, layer.extent)), oneway, tunnel, mode });
    }
  }
  return lines;
}

// --- Road graph -----------------------------------------------------------------------------

type Edge = { to: number; length: number; tunnel: boolean };
type Segment = { a: number; b: number; oneway: number; tunnel: boolean };

class RoadGraph {
  nodes: XY[] = [];
  edges: Edge[][] = [];
  // Segments kept for snapping: node indices of both ends.
  segments: Segment[] = [];
  private nodeIndex = new Map<string, number>();
  // Spatial index of segments for snapping, built on first use (cell -> segment indices).
  private grid: Map<string, number[]> | null = null;

  node(p: XY): number {
    // Tiles share the same coordinate grid, so a vertex repeated in a neighbouring tile's
    // buffer area lands on exactly the same position; round to 0.1 m to merge them.
    const key = `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;
    let i = this.nodeIndex.get(key);
    if (i === undefined) {
      i = this.nodes.length;
      this.nodes.push(p);
      this.edges.push([]);
      this.nodeIndex.set(key, i);
    }
    return i;
  }

  link(a: number, b: number, oneway: number, tunnel: boolean) {
    if (a === b) return;
    const length = dist(this.nodes[a], this.nodes[b]);
    if (oneway >= 0) this.edges[a].push({ to: b, length, tunnel });
    if (oneway <= 0) this.edges[b].push({ to: a, length, tunnel });
  }

  addSegment(a: number, b: number, oneway: number, tunnel: boolean) {
    this.link(a, b, oneway, tunnel);
    this.segments.push({ a, b, oneway, tunnel });
  }

  private buildGrid(): Map<string, number[]> {
    const grid = new Map<string, number[]>();
    this.segments.forEach((seg, i) => {
      const a = this.nodes[seg.a];
      const b = this.nodes[seg.b];
      const x0 = Math.floor(Math.min(a.x, b.x) / GRID_CELL_METERS);
      const x1 = Math.floor(Math.max(a.x, b.x) / GRID_CELL_METERS);
      const y0 = Math.floor(Math.min(a.y, b.y) / GRID_CELL_METERS);
      const y1 = Math.floor(Math.max(a.y, b.y) / GRID_CELL_METERS);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = `${x},${y}`;
          const cell = grid.get(key);
          if (cell) cell.push(i);
          else grid.set(key, [i]);
        }
      }
    });
    return grid;
  }

  /** Inserts a node on the nearest segment within maxMeters of p, returning its index. */
  snap(p: XY, maxMeters: number, exclude?: Set<number>): number | null {
    this.grid ??= this.buildGrid();
    const candidates = new Set<number>();
    const r = Math.ceil(maxMeters / GRID_CELL_METERS);
    const cx = Math.floor(p.x / GRID_CELL_METERS);
    const cy = Math.floor(p.y / GRID_CELL_METERS);
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) this.grid.get(`${x},${y}`)?.forEach((i) => candidates.add(i));
    }
    let best: { seg: Segment; point: XY; d: number } | null = null;
    for (const i of candidates) {
      const seg = this.segments[i];
      if (exclude && (exclude.has(seg.a) || exclude.has(seg.b))) continue;
      const proj = projectOnSegment(p, this.nodes[seg.a], this.nodes[seg.b]);
      if (proj.d <= maxMeters && (!best || proj.d < best.d)) best = { seg, point: proj.point, d: proj.d };
    }
    if (!best) return null;
    const n = this.node(best.point);
    // Split the segment at the new node; the original edges stay, which is harmless.
    this.link(best.seg.a, n, best.seg.oneway, best.seg.tunnel);
    this.link(n, best.seg.b, best.seg.oneway, best.seg.tunnel);
    return n;
  }

  shortestPath(start: number, goal: number): { nodes: number[]; length: number; tunnelMeters: number } | null {
    const distTo = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const viaTunnel = new Uint8Array(this.nodes.length);
    distTo[start] = 0;
    const heap = new MinHeap();
    heap.push(start, 0);
    while (heap.size > 0) {
      const { id, priority } = heap.pop()!;
      if (priority > distTo[id]) continue;
      if (id === goal) break;
      for (const e of this.edges[id]) {
        const d = priority + e.length;
        if (d < distTo[e.to]) {
          distTo[e.to] = d;
          prev[e.to] = id;
          viaTunnel[e.to] = e.tunnel ? 1 : 0;
          heap.push(e.to, d);
        }
      }
    }
    if (!Number.isFinite(distTo[goal])) return null;
    const nodes: number[] = [];
    let tunnelMeters = 0;
    for (let n = goal; n !== -1; n = prev[n]) {
      nodes.push(n);
      if (viaTunnel[n] && prev[n] !== -1) tunnelMeters += distTo[n] - distTo[prev[n]];
    }
    return { nodes: nodes.reverse(), length: distTo[goal], tunnelMeters };
  }
}

class MinHeap {
  private ids: number[] = [];
  private priorities: number[] = [];

  get size() {
    return this.ids.length;
  }

  push(id: number, priority: number) {
    this.ids.push(id);
    this.priorities.push(priority);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): { id: number; priority: number } | undefined {
    if (this.ids.length === 0) return undefined;
    const top = { id: this.ids[0], priority: this.priorities[0] };
    const lastId = this.ids.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.ids.length > 0) {
      this.ids[0] = lastId;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.ids.length && this.priorities[l] < this.priorities[smallest]) smallest = l;
        if (r < this.ids.length && this.priorities[r] < this.priorities[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
  }
}

// --- Filling a gap --------------------------------------------------------------------------

/**
 * Tries to replace one gap with a road path, or a rail path (metro). Returns null when no
 * plausible path is found; throws when tiles cannot be downloaded (so the caller can retry later).
 */
export async function fillGap(
  gap: Gap,
  fetchTile: TileFetcher,
  log: (message: string) => void = () => {},
): Promise<GapFill | null> {
  // Roads and rail lines come from the same tiles; each tile is downloaded once.
  const tileCache = new Map<string, RoadLine[]>();
  const getLines = async (x: number, y: number) => {
    const key = `${x}/${y}`;
    let lines = tileCache.get(key);
    if (!lines) {
      const buffer = await fetchTile(TILE_ZOOM, x, y);
      lines = buffer ? decodeLines(buffer, TILE_ZOOM, x, y) : [];
      tileCache.set(key, lines);
    }
    return lines;
  };

  const road = await findPath(gap, 'road', getLines, (m) => log(`road: ${m}`));
  const rail = await findPath(gap, 'rail', getLines, (m) => log(`rail: ${m}`));
  if (road && rail) {
    // Both fit. Underground (no satellites seen) favours the path that runs in a tunnel, so a
    // metro ride follows the metro line rather than the street above it.
    const blind = gap.inner.filter((s) => (s.satellitesInView ?? 0) === 0).length;
    const underground = gap.inner.length > 0 && blind / gap.inner.length >= UNDERGROUND_SHARE;
    const pick = underground && rail.tunnelShare > road.tunnelShare ? rail : road;
    log(`both fit (underground: ${underground}); using ${pick.fill.mode}`);
    return pick.fill;
  }
  return (road ?? rail)?.fill ?? null;
}

type Candidate = { fill: GapFill; tunnelShare: number };

/** Shortest plausible path for a gap on one network (roads or rail lines). */
async function findPath(
  gap: Gap,
  mode: NetworkMode,
  getLines: (x: number, y: number) => Promise<RoadLine[]>,
  log: (message: string) => void,
): Promise<Candidate | null> {
  const a = gap.from;
  const b = gap.to;
  const proj = makeProjection((a.latitude + b.latitude) / 2, (a.longitude + b.longitude) / 2);
  const pa = proj.toXY(a.longitude, a.latitude);
  const pb = proj.toXY(b.longitude, b.latitude);
  const straight = dist(pa, pb);
  const seconds = (Date.parse(b.sample.timestampUtc) - Date.parse(a.sample.timestampUtc)) / 1000;
  const snap = gap.snapMeters.map((m) => (mode === 'rail' ? Math.max(m, MIN_RAIL_SNAP_METERS) : m));

  // Search a narrow strip along the gap first; lines such as long tunnels can curve far from
  // the straight line, so widen the strip if the narrow one does not connect the two ends.
  const margins = [NARROW_MARGIN_METERS, Math.max(NARROW_MARGIN_METERS, straight * WIDE_MARGIN_FACTOR)];
  for (const margin of new Set(margins)) {
    const tiles = corridorTiles(pa, pb, margin, proj);
    if (tiles.length > MAX_TILES_PER_GAP) {
      log(`gap too large: ${tiles.length} tiles`);
      return null;
    }

    const graph = new RoadGraph();
    const lineEnds: number[] = [];
    for (const { x, y } of tiles) {
      for (const line of await getLines(x, y)) {
        if (line.mode !== mode) continue;
        let prevNode = -1;
        line.coords.forEach(([lon, lat], i) => {
          const n = graph.node(proj.toXY(lon, lat));
          if (i > 0) graph.addSegment(prevNode, n, line.oneway, line.tunnel);
          if (i === 0 || i === line.coords.length - 1) lineEnds.push(n);
          prevNode = n;
        });
      }
    }
    log(`${margin.toFixed(0)} m strip: ${tiles.length} tiles, ${graph.segments.length} segments`);
    if (graph.segments.length === 0) continue;

    // Join loose line ends to nearby lines (tile clipping and simplification leave small breaks).
    for (const end of lineEnds) {
      const joined = graph.snap(graph.nodes[end], JOIN_METERS, new Set([end]));
      if (joined !== null) graph.link(end, joined, 0, false);
    }

    const start = graph.snap(pa, snap[0]);
    const goal = graph.snap(pb, snap[1]);
    if (start === null || goal === null) {
      log(`nothing within ${(start === null ? snap[0] : snap[1]).toFixed(0)} m of the gap ${start === null ? 'start' : 'end'}`);
      continue;
    }

    const route = graph.shortestPath(start, goal);
    if (!route) {
      log('no connection between gap start and end');
      continue;
    }
    const pathXY = [pa, ...route.nodes.map((n) => graph.nodes[n]), pb];
    const fill = checkRoute(gap, pathXY, route.tunnelMeters > 0, straight, seconds, proj, mode, log);
    return fill ? { fill, tunnelShare: route.length > 0 ? route.tunnelMeters / route.length : 0 } : null;
  }
  return null;
}

/** Plausibility checks for a path found for a gap; returns the fill or null. */
function checkRoute(
  gap: Gap,
  pathXY: XY[],
  tunnel: boolean,
  straight: number,
  seconds: number,
  proj: ReturnType<typeof makeProjection>,
  mode: NetworkMode,
  log: (message: string) => void,
): GapFill | null {
  let lengthMeters = 0;
  for (let i = 1; i < pathXY.length; i++) lengthMeters += dist(pathXY[i - 1], pathXY[i]);

  if (lengthMeters > Math.max(straight * MAX_DETOUR_FACTOR, straight + MAX_DETOUR_EXTRA_METERS)) {
    log(`path too long: ${lengthMeters.toFixed(0)} m vs ${straight.toFixed(0)} m straight`);
    return null;
  }
  if (lengthMeters / seconds > MAX_PLAUSIBLE_SPEED_MPS) {
    log(`path not possible in ${seconds} s`);
    return null;
  }

  const coarse = gap.inner.filter((s) => s.accuracyMeters != null && s.accuracyMeters <= COARSE_FIX_MAX_ACCURACY);
  if (coarse.length > 0) {
    let agreeing = 0;
    for (const s of coarse) {
      const p = proj.toXY(s.longitude, s.latitude);
      let nearest = Infinity;
      for (let i = 1; i < pathXY.length; i++) nearest = Math.min(nearest, projectOnSegment(p, pathXY[i - 1], pathXY[i]).d);
      if (nearest <= Math.max(1.5 * s.accuracyMeters!, COARSE_FIX_MIN_TOLERANCE_METERS)) agreeing++;
    }
    if (agreeing / coarse.length < COARSE_FIX_AGREEMENT) {
      log(`only ${agreeing}/${coarse.length} coarse fixes agree with the path`);
      return null;
    }
  }

  return {
    fromSequence: gap.from.sample.sequence,
    toSequence: gap.to.sample.sequence,
    path: pathXY.map((p) => proj.toLonLat(p)),
    lengthMeters,
    tunnel,
    mode,
  };
}

/** Zoom-14 tiles that come within `margin` metres of the straight line between a and b. */
function corridorTiles(a: XY, b: XY, margin: number, proj: ReturnType<typeof makeProjection>) {
  const [west, north] = proj.toLonLat({ x: Math.min(a.x, b.x) - margin, y: Math.max(a.y, b.y) + margin });
  const [east, south] = proj.toLonLat({ x: Math.max(a.x, b.x) + margin, y: Math.min(a.y, b.y) - margin });
  const t1 = lonLatToTile(west, north, TILE_ZOOM);
  const t2 = lonLatToTile(east, south, TILE_ZOOM);
  const tiles: { x: number; y: number }[] = [];
  for (let x = t1.x; x <= t2.x; x++) {
    for (let y = t1.y; y <= t2.y; y++) {
      const nw = proj.toXY(...tilePointToLonLat(TILE_ZOOM, x, y, 0, 0, 1));
      const se = proj.toXY(...tilePointToLonLat(TILE_ZOOM, x, y, 1, 1, 1));
      const center = { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 };
      const halfDiagonal = dist(nw, se) / 2;
      if (projectOnSegment(center, a, b).d <= margin + halfDiagonal) tiles.push({ x, y });
    }
  }
  return tiles;
}

// --- Tile download ----------------------------------------------------------------------------

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
let tileUrlTemplate: Promise<string> | null = null;

/** Downloads OpenFreeMap vector tiles (the same tiles the map uses). */
export const fetchOpenFreeMapTile: TileFetcher = async (z, x, y) => {
  if (!tileUrlTemplate) {
    tileUrlTemplate = fetch(TILEJSON_URL)
      .then((r) => r.json())
      .then((json: { tiles: string[] }) => json.tiles[0]);
    tileUrlTemplate.catch(() => (tileUrlTemplate = null));
  }
  const url = (await tileUrlTemplate).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const res = await fetch(url);
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Tile ${z}/${x}/${y}: HTTP ${res.status}`);
  return res.arrayBuffer();
};
