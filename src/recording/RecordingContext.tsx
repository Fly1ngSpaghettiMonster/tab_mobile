import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import TabGps, { type GpsFix } from '../../modules/tab-gps';
import { createJourney, deleteJourney, finishJourney, insertSample } from '../db/database';
import { computeStats, isAccurate, type GpsSample, type JourneyStats } from '../geo/stats';
import { processJourneyGaps } from './gapProcessing';

const MAX_LOG_ENTRIES = 500;
const GPS_INTERVAL_MS = 1000;
// Stored with every journey so recordings made with different settings can be told apart.
export const LOCATION_SOURCE = `fused high-accuracy ${GPS_INTERVAL_MS}ms`;
// With at least this many satellites in the fix we call it a GNSS fix; otherwise it is Wi-Fi/cell.
const MIN_SATELLITES_FOR_GNSS = 4;

/** Where a fused fix most likely came from, judged by the satellites used at that moment. */
export function fixSource(satellitesUsed: number | null): 'gnss' | 'net' {
  return (satellitesUsed ?? 0) >= MIN_SATELLITES_FOR_GNSS ? 'gnss' : 'net';
}
// Only update the map bearing when moving fast enough for the GPS course to be meaningful.
const MIN_SPEED_FOR_BEARING_MPS = 1;

export type LogEntry = {
  key: number;
  timestampUtc: string;
  latitude: number;
  longitude: number;
  speedMps: number | null;
  accuracyMeters: number | null;
  provider: string;
  source: 'gnss' | 'net';
  satellitesUsed: number;
  satellitesInView: number;
  accepted: boolean;
  // Sequence number in the current journey, or null when not recording.
  sequence: number | null;
};

type PermissionState = 'unknown' | 'granted' | 'denied';

type RecordingContextValue = {
  permission: PermissionState;
  requestPermission: () => Promise<void>;
  gpsEnabled: boolean;
  lastFix: GpsFix | null;
  /** Direction of travel in degrees, kept while standing still. */
  bearing: number;
  satellites: { used: number; inView: number };
  isRecording: boolean;
  journeyId: number | null;
  startedAtMs: number | null;
  samples: GpsSample[];
  liveStats: JourneyStats;
  log: LogEntry[];
  clearLog: () => void;
  start: () => Promise<void>;
  /** Stops recording; resolves to the saved journey id, or null if nothing was recorded. */
  stop: () => Promise<number | null>;
};

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [gpsEnabled, setGpsEnabled] = useState(() => TabGps.isLocationEnabled());
  const [lastFix, setLastFix] = useState<GpsFix | null>(null);
  const [bearing, setBearing] = useState(0);
  const [satellites, setSatellites] = useState({ used: 0, inView: 0 });
  const [journeyId, setJourneyId] = useState<number | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  // Refs so the native event handlers always see the current recording state.
  const journeyIdRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const samplesRef = useRef<GpsSample[]>([]);
  const logKeyRef = useRef(0);

  const requestPermission = useCallback(async () => {
    const res = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    setPermission(res === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied');
  }, []);

  useEffect(() => {
    requestPermission();
  }, [requestPermission]);

  const handleFix = useCallback((fix: GpsFix) => {
    setLastFix(fix);
    // A fix means location is on, whatever was read before.
    setGpsEnabled(true);
    if (fix.bearing != null && (fix.speed ?? 0) >= MIN_SPEED_FOR_BEARING_MPS) setBearing(fix.bearing);

    const jid = journeyIdRef.current;
    const sample: GpsSample = {
      journeyId: jid ?? 0,
      sequence: jid != null ? sequenceRef.current++ : 0,
      timestampUtc: new Date(fix.timestamp).toISOString(),
      latitude: fix.latitude,
      longitude: fix.longitude,
      speedMps: fix.speed,
      accuracyMeters: fix.accuracy,
      altitudeMeters: fix.altitude,
      heading: fix.bearing,
      provider: fix.provider,
      satellitesUsed: fix.satellitesUsed,
      satellitesInView: fix.satellitesInView,
      speedAccuracyMps: fix.speedAccuracy,
      bearingAccuracyDeg: fix.bearingAccuracy,
    };

    const entry: LogEntry = {
      key: logKeyRef.current++,
      timestampUtc: sample.timestampUtc,
      latitude: sample.latitude,
      longitude: sample.longitude,
      speedMps: sample.speedMps,
      accuracyMeters: sample.accuracyMeters,
      provider: fix.provider,
      source: fixSource(fix.satellitesUsed),
      satellitesUsed: fix.satellitesUsed,
      satellitesInView: fix.satellitesInView,
      accepted: isAccurate(sample),
      sequence: jid != null ? sample.sequence : null,
    };
    setLog((prev) => [entry, ...prev].slice(0, MAX_LOG_ENTRIES));

    if (jid != null) {
      // Every raw sample is persisted immediately; filtering happens when stats are computed.
      samplesRef.current = [...samplesRef.current, sample];
      setSamples(samplesRef.current);
      insertSample(sample).catch((e) => console.warn('Failed to save sample', e));
    }
  }, []);

  useEffect(() => {
    const subs = [
      TabGps.addListener('onLocation', handleFix),
      TabGps.addListener('onGnssStatus', (s) =>
        // Skip re-rendering when nothing changed; this fires about once a second.
        setSatellites((prev) =>
          prev.used === s.satellitesUsed && prev.inView === s.satellitesInView
            ? prev
            : { used: s.satellitesUsed, inView: s.satellitesInView },
        ),
      ),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [handleFix]);

  // GPS runs while the app is visible, so the map shows the position even when not
  // recording. In the background it only keeps running during a recording, when the
  // foreground service keeps the process alive.
  useEffect(() => {
    if (permission !== 'granted') return;
    TabGps.ensureLocationSettings(GPS_INTERVAL_MS).catch((e) => console.warn('Location settings check failed', e));
    TabGps.startUpdates(GPS_INTERVAL_MS).catch((e) => console.warn('Failed to start GPS', e));
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setGpsEnabled(TabGps.isLocationEnabled());
        TabGps.startUpdates(GPS_INTERVAL_MS).catch((e) => console.warn('Failed to start GPS', e));
      } else if (state === 'background' && journeyIdRef.current == null) {
        TabGps.stopUpdates();
      }
    });
    return () => {
      sub.remove();
      TabGps.stopUpdates();
    };
  }, [permission]);

  const start = useCallback(async () => {
    if (journeyIdRef.current != null) return;
    // Android 13+ hides the recording notification unless this is granted; recording still works without it.
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }
    const now = Date.now();
    const id = await createJourney(new Date(now).toISOString(), LOCATION_SOURCE);
    sequenceRef.current = 0;
    samplesRef.current = [];
    journeyIdRef.current = id;
    setJourneyId(id);
    setStartedAtMs(now);
    setSamples([]);
    await TabGps.startForegroundService('TAB is recording your trip', 'Tap to open the app.');
  }, []);

  const stop = useCallback(async () => {
    const id = journeyIdRef.current;
    if (id == null) return null;
    journeyIdRef.current = null;
    await TabGps.stopForegroundService();

    const now = Date.now();
    let saved: number | null = id;
    const recorded = samplesRef.current;
    if (recorded.length === 0) {
      await deleteJourney(id);
      saved = null;
    } else {
      await finishJourney(id, new Date(now).toISOString(), computeStats(recorded, now));
      // Fill GPS gaps along roads in the background; the trip screen picks up the result.
      processJourneyGaps(id).catch((e) => console.warn('Gap processing failed', e));
    }

    setJourneyId(null);
    setStartedAtMs(null);
    samplesRef.current = [];
    setSamples([]);
    return saved;
  }, []);

  const liveStats = useMemo(() => computeStats(samples, Date.now()), [samples]);

  const value = useMemo<RecordingContextValue>(
    () => ({
      permission,
      requestPermission,
      gpsEnabled,
      lastFix,
      bearing,
      satellites,
      isRecording: journeyId != null,
      journeyId,
      startedAtMs,
      samples,
      liveStats,
      log,
      clearLog: () => setLog([]),
      start,
      stop,
    }),
    [
      permission,
      requestPermission,
      gpsEnabled,
      lastFix,
      bearing,
      satellites,
      journeyId,
      startedAtMs,
      samples,
      liveStats,
      log,
      start,
      stop,
    ],
  );

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording(): RecordingContextValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error('useRecording must be used inside RecordingProvider');
  return ctx;
}
