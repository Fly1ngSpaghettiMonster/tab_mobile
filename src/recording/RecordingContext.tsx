import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import TabGps, { type GpsFix } from '../../modules/tab-gps';
import { createJourney, deleteJourney, finishJourney, insertSample, saveShareSession, setShareStatus, type ShareSession } from '../db/database';
import { computeStats, isAccurate, TrackFilter, type GpsSample, type JourneyStats } from '../geo/stats';
import { closeAndRecord, createSession, type CloseReason } from '../share/api';
import { ShareClient, type ShareState } from '../share/ShareClient';
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
// How long stopping a shared trip waits for the last samples to upload.
const SHARE_DRAIN_MS = 3_000;

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

/** Where to show the user on the map: filtered, and held still while standing still. */
export type DisplayPosition = { latitude: number; longitude: number; accuracyMeters: number | null };

type RecordingContextValue = {
  permission: PermissionState;
  requestPermission: () => Promise<void>;
  gpsEnabled: boolean;
  lastFix: GpsFix | null;
  /** Position for the map arrow and camera (see DisplayPosition). */
  position: DisplayPosition | null;
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
  /** Live sharing of the current recording, or null when not shared. */
  share: ShareState | null;
  /** Creates a share link for the current recording and starts uploading its samples. */
  startSharing: () => Promise<void>;
  /** Stops sharing; the link stops working. Recording continues. */
  stopSharing: () => Promise<void>;
};

const RecordingContext = createContext<RecordingContextValue | null>(null);

export function RecordingProvider({ children }: { children: ReactNode }) {
  const [permission, setPermission] = useState<PermissionState>('unknown');
  const [gpsEnabled, setGpsEnabled] = useState(() => TabGps.isLocationEnabled());
  const [lastFix, setLastFix] = useState<GpsFix | null>(null);
  const [position, setPosition] = useState<DisplayPosition | null>(null);
  const [bearing, setBearing] = useState(0);
  const [satellites, setSatellites] = useState({ used: 0, inView: 0 });
  const [journeyId, setJourneyId] = useState<number | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [share, setShare] = useState<ShareState | null>(null);

  // Refs so the native event handlers always see the current recording state.
  const journeyIdRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);
  const samplesRef = useRef<GpsSample[]>([]);
  const logKeyRef = useRef(0);
  const startedAtRef = useRef<string | null>(null);
  const shareRef = useRef<{ client: ShareClient; session: ShareSession } | null>(null);
  // Filters every fix (recording or not) for the map arrow, with the same filter as the route.
  const displayFilterRef = useRef(new TrackFilter());

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

    // Accurate fixes go through the filter, so the arrow holds still while standing still;
    // coarse (Wi-Fi/cell) fixes are shown as they are, with their large accuracy circle.
    const filtered = displayFilterRef.current.push(sample);
    if (filtered) {
      // While standing still, keep the same object: no re-render and no camera move at all.
      setPosition((prev) =>
        filtered.stationary && prev
          ? prev
          : { latitude: filtered.latitude, longitude: filtered.longitude, accuracyMeters: sample.accuracyMeters },
      );
    } else {
      setPosition({ latitude: sample.latitude, longitude: sample.longitude, accuracyMeters: sample.accuracyMeters });
    }

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
      shareRef.current?.client.notify();
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
    const startedAt = new Date(now).toISOString();
    const id = await createJourney(startedAt, LOCATION_SOURCE);
    startedAtRef.current = startedAt;
    sequenceRef.current = 0;
    samplesRef.current = [];
    journeyIdRef.current = id;
    setJourneyId(id);
    setStartedAtMs(now);
    setSamples([]);
    await TabGps.startForegroundService('TAB is recording your trip', 'Tap to open the app.');
  }, []);

  const endShare = useCallback(async (reason: CloseReason) => {
    const current = shareRef.current;
    if (!current) return;
    shareRef.current = null;
    setShare(null);
    // When the trip ends, give the last samples a moment to reach the viewers.
    if (reason === 'ended') await current.client.drain(SHARE_DRAIN_MS);
    await current.client.stop();
    // The server request runs in the background, so stopping never waits on the network.
    closeAndRecord(current.session, reason);
  }, []);

  const startSharing = useCallback(async () => {
    const journeyId = journeyIdRef.current;
    if (journeyId == null || shareRef.current) return;
    const created = await createSession(journeyId, startedAtRef.current ?? new Date().toISOString(), LOCATION_SOURCE);
    if (journeyIdRef.current !== journeyId || shareRef.current) {
      // Recording stopped (or sharing started twice) while the request was in flight.
      closeAndRecord({ ...created, journeyId, lastAckedSequence: -1, status: 'open', createdAtUtc: new Date().toISOString() }, 'ended');
      return;
    }
    const session: ShareSession = {
      ...created,
      journeyId,
      lastAckedSequence: -1,
      status: 'open',
      createdAtUtc: new Date().toISOString(),
    };
    await saveShareSession(session);
    const client = new ShareClient({
      session,
      // Everything recorded so far is uploaded too, so viewers see the whole trip.
      getSamples: () => samplesRef.current,
      onState: (state) => {
        if (shareRef.current?.client === client) setShare(state);
      },
      onClosedByServer: () => {
        if (shareRef.current?.client !== client) return;
        shareRef.current = null;
        setShare(null);
        setShareStatus(session.sessionId, 'closed').catch(() => undefined);
      },
    });
    shareRef.current = { client, session };
    client.start();
  }, []);

  const stopSharing = useCallback(() => endShare('revoked'), [endShare]);

  const stop = useCallback(async () => {
    const id = journeyIdRef.current;
    if (id == null) return null;
    await endShare('ended');
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
    startedAtRef.current = null;
    samplesRef.current = [];
    setSamples([]);
    return saved;
  }, [endShare]);

  const liveStats = useMemo(() => computeStats(samples, Date.now()), [samples]);

  const value = useMemo<RecordingContextValue>(
    () => ({
      permission,
      requestPermission,
      gpsEnabled,
      lastFix,
      position,
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
      share,
      startSharing,
      stopSharing,
    }),
    [
      permission,
      requestPermission,
      gpsEnabled,
      lastFix,
      position,
      bearing,
      satellites,
      journeyId,
      startedAtMs,
      samples,
      liveStats,
      log,
      start,
      stop,
      share,
      startSharing,
      stopSharing,
    ],
  );

  return <RecordingContext.Provider value={value}>{children}</RecordingContext.Provider>;
}

export function useRecording(): RecordingContextValue {
  const ctx = useContext(RecordingContext);
  if (!ctx) throw new Error('useRecording must be used inside RecordingProvider');
  return ctx;
}
