import * as SQLite from 'expo-sqlite';

import type { GapFill } from '../geo/gapFill';
import { computeStats, STATS_VERSION, type GpsSample, type JourneyStats } from '../geo/stats';

export type Journey = JourneyStats & {
  id: number;
  startedAtUtc: string;
  endedAtUtc: string | null;
  name: string | null;
  /** How the samples were collected, e.g. "gps 1000ms". */
  locationSource: string | null;
  /** True once GPS gaps have been checked against the road network (see gapFill.ts). */
  gapsChecked: boolean;
  sampleCount: number;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

// All writes go through one queue, so a slow write can never overlap the next one and
// stopping a trip always runs after the last sample has been stored.
let writeQueue: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(write: (d: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const result = writeQueue.then(async () => write(await db()));
  writeQueue = result.catch(() => undefined);
  return result;
}

async function open(): Promise<SQLite.SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync('tab.db');
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS journeys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at_utc TEXT NOT NULL,
      ended_at_utc TEXT,
      distance_m REAL NOT NULL DEFAULT 0,
      duration_s REAL NOT NULL DEFAULT 0,
      avg_speed_mps REAL NOT NULL DEFAULT 0,
      moving_avg_speed_mps REAL NOT NULL DEFAULT 0,
      max_speed_mps REAL NOT NULL DEFAULT 0,
      name TEXT
    );
    CREATE TABLE IF NOT EXISTS gps_samples (
      journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      timestamp_utc TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      speed_mps REAL,
      accuracy_m REAL,
      altitude_m REAL,
      heading REAL,
      PRIMARY KEY (journey_id, sequence)
    );
  `);
  await migrate(database);
  return database;
}

const SCHEMA_VERSION = 4;

async function migrate(database: SQLite.SQLiteDatabase): Promise<void> {
  const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 2) {
    // v2: record where each fix came from and how good it was.
    await database.execAsync(`
      ALTER TABLE journeys ADD COLUMN location_source TEXT;
      ALTER TABLE gps_samples ADD COLUMN provider TEXT;
      ALTER TABLE gps_samples ADD COLUMN satellites_used INTEGER;
      ALTER TABLE gps_samples ADD COLUMN satellites_in_view INTEGER;
      ALTER TABLE gps_samples ADD COLUMN speed_accuracy_mps REAL;
      ALTER TABLE gps_samples ADD COLUMN bearing_accuracy_deg REAL;
    `);
  }
  if (version < 3) {
    // v3: GPS gaps filled along the road network after a trip.
    await database.execAsync(`
      ALTER TABLE journeys ADD COLUMN gaps_checked INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS gap_fills (
        journey_id INTEGER NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
        from_sequence INTEGER NOT NULL,
        to_sequence INTEGER NOT NULL,
        path TEXT NOT NULL,
        length_m REAL NOT NULL,
        tunnel INTEGER NOT NULL,
        PRIMARY KEY (journey_id, from_sequence)
      );
    `);
  }
  if (version < 4) {
    // v4: which version of the statistics formulas a trip's stored stats were computed with.
    await database.execAsync('ALTER TABLE journeys ADD COLUMN stats_version INTEGER NOT NULL DEFAULT 0;');
  }
  await database.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

type JourneyRow = {
  id: number;
  started_at_utc: string;
  ended_at_utc: string | null;
  distance_m: number;
  duration_s: number;
  avg_speed_mps: number;
  moving_avg_speed_mps: number;
  max_speed_mps: number;
  name: string | null;
  location_source: string | null;
  gaps_checked: number;
  sample_count: number;
};

type SampleRow = {
  journey_id: number;
  sequence: number;
  timestamp_utc: string;
  latitude: number;
  longitude: number;
  speed_mps: number | null;
  accuracy_m: number | null;
  altitude_m: number | null;
  heading: number | null;
  provider: string | null;
  satellites_used: number | null;
  satellites_in_view: number | null;
  speed_accuracy_mps: number | null;
  bearing_accuracy_deg: number | null;
};

const JOURNEY_SELECT = `
  SELECT j.*, (SELECT COUNT(*) FROM gps_samples s WHERE s.journey_id = j.id) AS sample_count
  FROM journeys j`;

function toJourney(r: JourneyRow): Journey {
  return {
    id: r.id,
    startedAtUtc: r.started_at_utc,
    endedAtUtc: r.ended_at_utc,
    name: r.name,
    locationSource: r.location_source,
    gapsChecked: r.gaps_checked === 1,
    distanceMeters: r.distance_m,
    durationSeconds: r.duration_s,
    avgSpeedMps: r.avg_speed_mps,
    movingAvgSpeedMps: r.moving_avg_speed_mps,
    maxSpeedMps: r.max_speed_mps,
    sampleCount: r.sample_count,
  };
}

function toSample(r: SampleRow): GpsSample {
  return {
    journeyId: r.journey_id,
    sequence: r.sequence,
    timestampUtc: r.timestamp_utc,
    latitude: r.latitude,
    longitude: r.longitude,
    speedMps: r.speed_mps,
    accuracyMeters: r.accuracy_m,
    altitudeMeters: r.altitude_m,
    heading: r.heading,
    provider: r.provider,
    satellitesUsed: r.satellites_used,
    satellitesInView: r.satellites_in_view,
    speedAccuracyMps: r.speed_accuracy_mps,
    bearingAccuracyDeg: r.bearing_accuracy_deg,
  };
}

export function createJourney(startedAtUtc: string, locationSource: string): Promise<number> {
  return enqueueWrite(async (d) => {
    const res = await d.runAsync(
      'INSERT INTO journeys (started_at_utc, location_source) VALUES (?, ?)',
      startedAtUtc,
      locationSource,
    );
    return res.lastInsertRowId;
  });
}

export function insertSample(s: GpsSample): Promise<void> {
  return enqueueWrite(async (d) => {
    await d.runAsync(
      `INSERT INTO gps_samples
        (journey_id, sequence, timestamp_utc, latitude, longitude, speed_mps, accuracy_m, altitude_m, heading,
         provider, satellites_used, satellites_in_view, speed_accuracy_mps, bearing_accuracy_deg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.journeyId,
      s.sequence,
      s.timestampUtc,
      s.latitude,
      s.longitude,
      s.speedMps,
      s.accuracyMeters,
      s.altitudeMeters,
      s.heading,
      s.provider,
      s.satellitesUsed,
      s.satellitesInView,
      s.speedAccuracyMps,
      s.bearingAccuracyDeg,
    );
  });
}

export function finishJourney(id: number, endedAtUtc: string, stats: JourneyStats): Promise<void> {
  return enqueueWrite(async (d) => {
    await d.runAsync(
      'UPDATE journeys SET ended_at_utc = ? WHERE id = ?',
      endedAtUtc,
      id,
    );
    await writeStats(d, id, stats);
  });
}

async function writeStats(d: SQLite.SQLiteDatabase, id: number, stats: JourneyStats): Promise<void> {
  await d.runAsync(
    `UPDATE journeys SET distance_m = ?, duration_s = ?, avg_speed_mps = ?, moving_avg_speed_mps = ?,
       max_speed_mps = ?, stats_version = ? WHERE id = ?`,
    stats.distanceMeters,
    stats.durationSeconds,
    stats.avgSpeedMps,
    stats.movingAvgSpeedMps,
    stats.maxSpeedMps,
    STATS_VERSION,
    id,
  );
}

export async function listJourneys(): Promise<Journey[]> {
  const d = await db();
  const rows = await d.getAllAsync<JourneyRow>(
    `${JOURNEY_SELECT} WHERE j.ended_at_utc IS NOT NULL ORDER BY j.started_at_utc DESC`,
  );
  return rows.map(toJourney);
}

export async function getJourney(id: number): Promise<Journey | null> {
  const d = await db();
  const row = await d.getFirstAsync<JourneyRow>(`${JOURNEY_SELECT} WHERE j.id = ?`, id);
  return row ? toJourney(row) : null;
}

export async function getSamples(journeyId: number): Promise<GpsSample[]> {
  const d = await db();
  const rows = await d.getAllAsync<SampleRow>(
    'SELECT * FROM gps_samples WHERE journey_id = ? ORDER BY sequence',
    journeyId,
  );
  return rows.map(toSample);
}

type GapFillRow = {
  from_sequence: number;
  to_sequence: number;
  path: string;
  length_m: number;
  tunnel: number;
};

export async function getGapFills(journeyId: number): Promise<GapFill[]> {
  const d = await db();
  const rows = await d.getAllAsync<GapFillRow>(
    'SELECT * FROM gap_fills WHERE journey_id = ? ORDER BY from_sequence',
    journeyId,
  );
  return rows.map((r) => ({
    fromSequence: r.from_sequence,
    toSequence: r.to_sequence,
    path: JSON.parse(r.path),
    lengthMeters: r.length_m,
    tunnel: r.tunnel === 1,
  }));
}

/** Replaces a journey's gap fills, updates its statistics and marks its gaps as checked. */
export function saveGapFills(journeyId: number, fills: GapFill[], stats: JourneyStats): Promise<void> {
  return enqueueWrite(async (d) => {
    await d.withTransactionAsync(async () => {
      await d.runAsync('DELETE FROM gap_fills WHERE journey_id = ?', journeyId);
      for (const f of fills) {
        await d.runAsync(
          'INSERT INTO gap_fills (journey_id, from_sequence, to_sequence, path, length_m, tunnel) VALUES (?, ?, ?, ?, ?, ?)',
          journeyId,
          f.fromSequence,
          f.toSequence,
          JSON.stringify(f.path),
          f.lengthMeters,
          f.tunnel ? 1 : 0,
        );
      }
      await d.runAsync('UPDATE journeys SET gaps_checked = 1 WHERE id = ?', journeyId);
      await writeStats(d, journeyId, stats);
    });
  });
}

export function deleteJourney(id: number): Promise<void> {
  return enqueueWrite(async (d) => {
    await d.runAsync('DELETE FROM journeys WHERE id = ?', id);
  });
}

/**
 * Finalizes journeys that were still open when the app was killed,
 * using the samples that had already been saved.
 */
export async function recoverUnfinishedJourneys(): Promise<void> {
  const d = await db();
  const open = await d.getAllAsync<{ id: number; started_at_utc: string }>(
    'SELECT id, started_at_utc FROM journeys WHERE ended_at_utc IS NULL',
  );
  for (const j of open) {
    const samples = await getSamples(j.id);
    if (samples.length === 0) {
      await deleteJourney(j.id);
      continue;
    }
    const endedAt = samples[samples.length - 1].timestampUtc;
    await finishJourney(j.id, endedAt, computeStats(samples));
  }
}

/**
 * Recalculates the statistics of trips stored with an older version of the formulas
 * (see STATS_VERSION), from their raw samples and gap fills.
 */
export async function refreshOutdatedStats(): Promise<void> {
  const d = await db();
  const outdated = await d.getAllAsync<{ id: number; ended_at_utc: string }>(
    'SELECT id, ended_at_utc FROM journeys WHERE ended_at_utc IS NOT NULL AND stats_version < ?',
    STATS_VERSION,
  );
  for (const j of outdated) {
    const [samples, fills] = await Promise.all([getSamples(j.id), getGapFills(j.id)]);
    const stats = computeStats(samples, Date.parse(j.ended_at_utc), fills);
    await enqueueWrite((w) => writeStats(w, j.id, stats));
  }
}
