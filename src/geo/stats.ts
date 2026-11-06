export type GpsSample = {
  journeyId: number;
  sequence: number;
  timestampUtc: string;
  latitude: number;
  longitude: number;
  speedMps: number | null;
  accuracyMeters: number | null;
  altitudeMeters: number | null;
  heading: number | null;
  // Where the fix came from and how good it was, as reported by the device.
  provider: string | null;
  satellitesUsed: number | null;
  satellitesInView: number | null;
  speedAccuracyMps: number | null;
  bearingAccuracyDeg: number | null;
};

export type JourneyStats = {
  distanceMeters: number;
  durationSeconds: number;
  avgSpeedMps: number;
  movingAvgSpeedMps: number;
  maxSpeedMps: number;
};

// Fixes worse than this are kept in the log but ignored for the route and statistics.
export const MAX_ACCURACY_METERS = 25;
// Anything implying a faster movement than this is treated as a glitch: a bad fix that jumps a
// few hundred metres in a second implies thousands of km/h. Set to the top speed of the fastest
// production cars (~470 km/h), so no real car trip is ever filtered out.
export const MAX_PLAUSIBLE_SPEED_MPS = 470 / 3.6;
// Below this speed we treat the device as standing still, so GPS jitter while
// parked or waiting at a light does not add distance (~1.8 km/h).
const STATIONARY_SPEED_MPS = 0.5;
// GPS speeds with a worse reported uncertainty are not trusted for the maximum.
const MAX_SPEED_ACCURACY_MPS = 3;
// Below this speed the car is considered stopped (for the moving average).
const MOVING_THRESHOLD_MPS = 1 / 3.6;
// Smallest expected change of speed per second, used as the filter's process noise.
const MIN_PROCESS_NOISE_MPS = 3;

const EARTH_RADIUS_M = 6371000;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function timeMs(s: GpsSample): number {
  return Date.parse(s.timestampUtc);
}

export function isAccurate(s: Pick<GpsSample, 'accuracyMeters'>): boolean {
  return s.accuracyMeters == null || s.accuracyMeters <= MAX_ACCURACY_METERS;
}

function validSpeed(v: number | null): number | null {
  return v != null && v >= 0 && v <= MAX_PLAUSIBLE_SPEED_MPS ? v : null;
}

/** A sample that passed filtering, with its smoothed position. */
export type TrackPoint = {
  sample: GpsSample;
  latitude: number;
  longitude: number;
  speedMps: number;
  /** Distance added by this point (0 while stationary). */
  segmentMeters: number;
};

/**
 * Turns raw samples into a clean track:
 * 1. drops inaccurate fixes and implausible jumps,
 * 2. smooths positions with a simple Kalman filter weighted by each fix's
 *    accuracy (a ±20 m fix barely moves the estimate if recent fixes were ±4 m),
 * 3. stops adding distance while standing still.
 * The raw samples stay untouched in the database.
 */
export function processTrack(samples: GpsSample[]): TrackPoint[] {
  const out: TrackPoint[] = [];
  let lat = 0;
  let lon = 0;
  let variance = -1; // m², negative = not initialised
  let lastTime = 0;
  let countedLat = 0;
  let countedLon = 0;

  for (const s of samples) {
    if (!isAccurate(s)) continue;
    const t = timeMs(s);
    const accuracy = Math.max(s.accuracyMeters ?? MAX_ACCURACY_METERS, 1);

    if (variance < 0) {
      lat = countedLat = s.latitude;
      lon = countedLon = s.longitude;
      variance = accuracy * accuracy;
      lastTime = t;
      out.push({ sample: s, latitude: lat, longitude: lon, speedMps: validSpeed(s.speedMps) ?? 0, segmentMeters: 0 });
      continue;
    }

    const dt = (t - lastTime) / 1000;
    if (dt <= 0) continue;
    const prev = out[out.length - 1];
    const jump = haversineMeters(prev.sample.latitude, prev.sample.longitude, s.latitude, s.longitude);
    if (jump / dt > MAX_PLAUSIBLE_SPEED_MPS) continue;

    const gpsSpeed = validSpeed(s.speedMps);
    // Trust measurements more the faster we move, so the line does not lag behind a car.
    const q = Math.max(MIN_PROCESS_NOISE_MPS, gpsSpeed ?? jump / dt);
    variance += dt * q * q;
    const gain = variance / (variance + accuracy * accuracy);
    lat += gain * (s.latitude - lat);
    lon += gain * (s.longitude - lon);
    variance *= 1 - gain;
    lastTime = t;

    const speed = gpsSpeed ?? haversineMeters(prev.latitude, prev.longitude, lat, lon) / dt;
    let segment = 0;
    if (speed >= STATIONARY_SPEED_MPS) {
      segment = haversineMeters(countedLat, countedLon, lat, lon);
      countedLat = lat;
      countedLon = lon;
    }
    out.push({ sample: s, latitude: lat, longitude: lon, speedMps: speed, segmentMeters: segment });
  }
  return out;
}

/**
 * Statistics of a track. Gaps that were filled along the road network count with the road
 * length instead of the straight line between the fixes on either side.
 */
/** Bump when computeStats or its thresholds change, so stored trips are recalculated. */
export const STATS_VERSION = 2;

export function computeStats(
  samples: GpsSample[],
  endTimeMs?: number,
  gapFills: { fromSequence: number; toSequence: number; lengthMeters: number }[] = [],
): JourneyStats {
  const points = processTrack(samples);
  const fillLength = new Map(gapFills.map((f) => [`${f.fromSequence}-${f.toSequence}`, f.lengthMeters]));
  let distance = 0;
  let maxSpeed = 0;
  let movingSeconds = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const filled = i > 0 ? fillLength.get(`${points[i - 1].sample.sequence}-${p.sample.sequence}`) : undefined;
    const segment = filled ?? p.segmentMeters;
    distance += segment;
    const speedTrusted = p.sample.speedAccuracyMps == null || p.sample.speedAccuracyMps <= MAX_SPEED_ACCURACY_MPS;
    if (speedTrusted) maxSpeed = Math.max(maxSpeed, p.speedMps);
    if (i > 0) {
      const seconds = (timeMs(p.sample) - timeMs(points[i - 1].sample)) / 1000;
      // Moving if the fix says so, or if the distance covered since the previous fix says so:
      // after a long gap (tunnel, underground) the speed at its end can be zero.
      if (p.speedMps >= MOVING_THRESHOLD_MPS || segment / seconds >= MOVING_THRESHOLD_MPS) movingSeconds += seconds;
    }
  }
  const start = samples.length ? timeMs(samples[0]) : 0;
  const end = endTimeMs ?? (samples.length ? timeMs(samples[samples.length - 1]) : 0);
  const duration = Math.max(0, (end - start) / 1000);
  return {
    distanceMeters: distance,
    durationSeconds: duration,
    // Spec: average speed = accepted distance / total elapsed time, stops included.
    avgSpeedMps: duration > 0 ? distance / duration : 0,
    movingAvgSpeedMps: movingSeconds > 0 ? distance / movingSeconds : 0,
    maxSpeedMps: maxSpeed,
  };
}

export const kmh = (mps: number | null | undefined) => (mps == null ? '–' : (mps * 3.6).toFixed(1));
export const km = (m: number) => (m / 1000).toFixed(2);

export function formatDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
