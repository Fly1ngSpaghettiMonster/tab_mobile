import {
  Camera,
  GeoJSONSource,
  type CameraRef,
  Layer,
  Map as MapView,
  Marker,
  type LngLatBounds,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';

import type { GapFill } from '../geo/gapFill';
import { approximatePath, findGaps, gapKey, isGap, liveCoarseLines, type Gap } from '../geo/gaps';
import { BearingSmoother, buildRoute, PlaybackClock, poseAt, routeUpTo, type Pose, type Route } from '../geo/playback';
import { speedColorExpression, speedScale, type SpeedStop } from '../geo/speedColors';
import { smoothLine, type SmoothedLine } from '../geo/spline';
import { processTrack, type GpsSample, type TrackPoint } from '../geo/stats';
import { colors, MAP_STYLE_URL } from '../theme';

export type MapPosition = {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Direction of travel; the map is rotated so this points up. */
  bearing: number;
};

type Props = {
  samples: GpsSample[];
  style?: StyleProp<ViewStyle>;
  /** Live mode: the camera follows this position, heading-up. */
  position?: MapPosition | null;
  /** Review mode: colour the route by speed and frame the whole trip. */
  colorBySpeed?: boolean;
  /** Review mode: GPS gaps replaced by road paths (drawn dashed). */
  gapFills?: GapFill[];
  /** Review mode: the trip's colour scale (see speedColors.ts). */
  speedStops?: SpeedStop[];
};

const DEFAULT_SPEED_STOPS = speedScale(50, 130);
// Number of colour steps the route is split into (matches the legend's resolution).
const SPEED_COLOR_STEPS = 40;

const ROUTE_BASE_COLOR = '#8a96a3';
const LINE_LAYOUT = { 'line-cap': 'round', 'line-join': 'round' } as const;
const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };
// Without a track to play back (not recording, or only coarse fixes) the camera glides to each
// new position for most of the ~1 s until the next one.
const FOLLOW_ANIMATION_MS = 900;
// A single finger moving further than this on the map is a pan (stops following); anything else
// (taps, pinches, double-tap zoom) keeps following.
const PAN_THRESHOLD_PX = 12;
// The live track is played back while the newest fix is part of it; a newer fix this much later
// that is not (a coarse Wi-Fi/cell fix in a GPS gap) is shown directly instead.
const MAX_PLAYBACK_LAG_MS = 3000;
const INITIAL_LIVE_ZOOM = 16;

type LineFeatures = GeoJSON.FeatureCollection<GeoJSON.LineString>;
const lineFeatures = (lines: [number, number][][]): LineFeatures => ({
  type: 'FeatureCollection',
  features: lines
    .filter((coordinates) => coordinates.length >= 2)
    .map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })),
});

/** Continuous runs of track points (split at gaps), each with its smoothed line. */
type Stretch = { points: TrackPoint[]; line: SmoothedLine };

export function TripMap({ samples, style, position, colorBySpeed, gapFills, speedStops }: Props) {
  const speedColor = useMemo(() => speedColorExpression(speedStops ?? DEFAULT_SPEED_STOPS), [speedStops]);
  const live = position !== undefined;
  // Live: forward filter only, so points already passed by the played-back arrow never shift when
  // a new fix arrives. Review: smoothed with the fixes after each point as well.
  const points = useMemo(() => processTrack(samples, { smooth: !live }), [samples, live]);

  // Review mode: all gaps, including stretches without accurate fixes at the start or end.
  const gaps = useMemo<Gap[]>(() => (colorBySpeed ? findGaps(points, samples) : []), [colorBySpeed, points, samples]);

  // The track split at gaps; each piece is drawn as a smooth curve through its points.
  const stretches = useMemo<Stretch[]>(() => {
    const gapKeys = new Set(gaps.filter((g) => !g.edge).map((g) => gapKey(g.from.sample.sequence, g.to.sample.sequence)));
    const isBreak = (a: TrackPoint, b: TrackPoint) =>
      colorBySpeed ? gapKeys.has(gapKey(a.sample.sequence, b.sample.sequence)) : isGap(a, b);
    const parts: TrackPoint[][] = [];
    let current: TrackPoint[] = [];
    points.forEach((p, i) => {
      if (i > 0 && isBreak(points[i - 1], p)) {
        parts.push(current);
        current = [];
      }
      current.push(p);
    });
    if (current.length) parts.push(current);
    return parts.map((pts) => ({ points: pts, line: smoothLine(pts.map((p) => [p.longitude, p.latitude])) }));
  }, [points, gaps, colorBySpeed]);

  const routeLines = useMemo<LineFeatures>(() => lineFeatures(stretches.map((s) => s.line.coords)), [stretches]);

  // Gaps: review mode draws filled ones along the road or rail line, the rest as a dotted line
  // through the coarse fixes; live mode draws everything without accurate fixes dotted.
  const gapLines = useMemo(() => {
    if (!colorBySpeed) return { filled: lineFeatures([]), unfilled: lineFeatures(liveCoarseLines(points, samples)) };
    const fillByKey = new Map((gapFills ?? []).map((f) => [gapKey(f.fromSequence, f.toSequence), f]));
    const filled: [number, number][][] = [];
    const unfilled: [number, number][][] = [];
    for (const gap of gaps) {
      const fill = fillByKey.get(gapKey(gap.from.sample.sequence, gap.to.sample.sequence));
      if (fill) filled.push(fill.path);
      else unfilled.push(approximatePath(samples, gap.from, gap.to));
    }
    return { filled: lineFeatures(filled), unfilled: lineFeatures(unfilled) };
  }, [colorBySpeed, gapFills, gaps, points, samples]);

  // Speed-coloured route: consecutive segments of similar speed are joined into one line.
  // One feature per GPS sample would be only a few metres long, and MapLibre drops such
  // sub-pixel features when zoomed out, making the whole route disappear.
  const speedSegments = useMemo<LineFeatures>(() => {
    const stops = speedStops ?? DEFAULT_SPEED_STOPS;
    const bucketKmh = Math.max(stops[stops.length - 1].kmh / SPEED_COLOR_STEPS, 0.5);
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    for (const { points: pts, line } of stretches) {
      // A run covers the curve between two of its points; neighbouring runs share their end point.
      let run: { bucket: number; from: number; to: number; kmhSum: number; count: number } | null = null;
      const flush = () => {
        if (run) {
          const coordinates = line.coords.slice(line.index[run.from], line.index[run.to] + 1);
          if (coordinates.length >= 2) {
            features.push({ type: 'Feature', properties: { kmh: run.kmhSum / run.count }, geometry: { type: 'LineString', coordinates } });
          }
        }
        run = null;
      };
      for (let i = 1; i < pts.length; i++) {
        const kmh = pts[i].speedMps * 3.6;
        const bucket = Math.floor(kmh / bucketKmh);
        if (!run || run.bucket !== bucket) {
          flush();
          run = { bucket, from: i - 1, to: i, kmhSum: 0, count: 0 };
        }
        run.to = i;
        run.kmhSum += kmh;
        run.count++;
      }
      flush();
    }
    return { type: 'FeatureCollection', features };
  }, [stretches, speedStops]);

  // Grey line under the whole trip, including filled gaps, so the route is always visible from
  // start to end whatever the zoom level.
  const baseLine = useMemo<LineFeatures>(
    () => lineFeatures([...stretches.map((s) => s.line.coords), ...gapLines.filled.features.map((f) => f.geometry.coordinates as [number, number][])]),
    [stretches, gapLines],
  );

  // Start and end of the trip: at a coarse position if recording started or ended without GPS.
  const ends = useMemo(() => {
    const leading = gaps.find((g) => g.edge === 'start' || g.edge === 'both');
    const trailing = [...gaps].reverse().find((g) => g.edge === 'end' || g.edge === 'both');
    const first = leading?.from ?? points[0];
    const last = trailing?.to ?? points[points.length - 1];
    return { first, last };
  }, [gaps, points]);

  const bounds = useMemo<LngLatBounds | undefined>(() => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    const extend = (lon: number, lat: number) => {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    };
    for (const p of points) extend(p.longitude, p.latitude);
    // Paths through gaps can bend away from the GPS points (e.g. a curved tunnel).
    for (const f of [...gapLines.filled.features, ...gapLines.unfilled.features]) {
      for (const [lon, lat] of f.geometry.coordinates) extend(lon, lat);
    }
    return w < e || s < n ? [w, s, e, n] : undefined;
  }, [points, gapLines]);

  // Live mode: the track is played back slightly in the past (see playback.ts), so the arrow, the
  // end of the line and the camera move together and continuously between fixes.
  const route = useMemo<Route | null>(() => (live ? buildRoute(points) : null), [live, points]);
  const lastSample = samples[samples.length - 1];
  const playback =
    route != null &&
    route.times.length > 0 &&
    lastSample != null &&
    Date.parse(lastSample.timestampUtc) - route.times[route.times.length - 1] <= MAX_PLAYBACK_LAG_MS;

  const hasFix = position != null;
  const lat = position?.latitude;
  const lon = position?.longitude;
  const bearing = position?.bearing;

  // Follow mode: panning pauses following (the recenter button brings it back), zooming keeps
  // following and recenters when the fingers are lifted. The camera is not moved mid-gesture.
  const [following, setFollowing] = useState(true);
  const [gesturing, setGesturing] = useState(false);
  const cameraRef = useRef<CameraRef>(null);
  // Read by the playback loop every frame.
  const followRef = useRef(false);
  followRef.current = live && following && !gesturing;
  // Bumped to move the camera back to the position even if it has not changed.
  const [recenterCount, setRecenterCount] = useState(0);
  const touch = useRef<{ x: number; y: number; multi: boolean; moved: boolean } | null>(null);
  // Current zoom, for sizing the accuracy circle drawn over the map.
  const [zoom, setZoom] = useState(INITIAL_LIVE_ZOOM);
  // The same, read by the playback loop every frame.
  const zoomRef = useRef(INITIAL_LIVE_ZOOM);

  // Gestures are read from the touches themselves: the playback moves the camera every frame,
  // and the map reports those moves much like the user's.
  const onTouchStart = (e: GestureResponderEvent) => {
    const t = e.nativeEvent;
    if (!touch.current) {
      touch.current = { x: t.pageX, y: t.pageY, multi: false, moved: false };
      setGesturing(true);
    }
    if (t.touches.length > 1) touch.current.multi = true;
  };
  const onTouchMove = (e: GestureResponderEvent) => {
    const g = touch.current;
    const t = e.nativeEvent;
    if (!g) return;
    if (t.touches.length > 1) g.multi = true;
    else if (Math.hypot(t.pageX - g.x, t.pageY - g.y) > PAN_THRESHOLD_PX) g.moved = true;
  };
  const onTouchEnd = (e: GestureResponderEvent) => {
    const g = touch.current;
    if (!g || e.nativeEvent.touches.length > 0) return;
    touch.current = null;
    setGesturing(false);
    if (g.moved && !g.multi) setFollowing(false);
    else setRecenterCount((n) => n + 1);
  };
  const onRegionDidChange = (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    const newZoom = e.nativeEvent.zoom;
    zoomRef.current = newZoom;
    setZoom((z) => (Math.abs(z - newZoom) > 0.01 ? newZoom : z));
  };
  const recenter = () => {
    setFollowing(true);
    setRecenterCount((n) => n + 1);
  };

  const initialView = useMemo(
    () => (hasFix ? { center: [lon!, lat!] as [number, number], zoom: INITIAL_LIVE_ZOOM } : { zoom: 3 }),
    // Only read once, when the camera mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFix],
  );
  // Without playback: glide the camera to each new position.
  useEffect(() => {
    if (!live || playback || !following || gesturing || lat == null || lon == null) return;
    try {
      cameraRef.current?.easeTo({ center: [lon, lat], bearing, duration: FOLLOW_ANIMATION_MS, easing: 'linear' });
    } catch {
      // The native camera is not ready yet (just mounted); the next fix moves it.
    }
  }, [live, playback, lat, lon, bearing, following, gesturing, recenterCount]);

  const { first, last } = ends;
  const hasLine = routeLines.features.length > 0;
  // While following, the camera centre is the position, so the arrow is drawn at the centre of
  // the view: the map moves underneath it.
  const puckOverlay = live && position != null && following && !gesturing;

  return (
    <View
      style={[styles.map, style]}
      onTouchStart={live ? onTouchStart : undefined}
      onTouchMove={live ? onTouchMove : undefined}
      onTouchEnd={live ? onTouchEnd : undefined}
      onTouchCancel={live ? onTouchEnd : undefined}>
      <MapView
        style={styles.map}
        mapStyle={MAP_STYLE_URL}
        compass={false}
        logo={false}
        touchPitch={false}
        // Heading-up follow mode: the app controls the rotation.
        touchRotate={!live}
        onRegionDidChange={live ? onRegionDidChange : undefined}>
        {live ? (
          // Remount when the first fix arrives so the initial view zooms in on it.
          <Camera ref={cameraRef} key={hasFix ? 'fix' : 'nofix'} initialViewState={initialView} />
        ) : bounds ? (
          <Camera bounds={bounds} padding={FIT_PADDING} />
        ) : first ? (
          <Camera center={[first.longitude, first.latitude]} zoom={15} />
        ) : null}

        {playback && (
          <LiveRoute
            route={route}
            cameraRef={cameraRef}
            followRef={followRef}
            zoomRef={zoomRef}
            recenterCount={recenterCount}
            accuracyMeters={position?.accuracyMeters ?? null}
            showMarker={!puckOverlay}
          />
        )}

        {hasLine && !colorBySpeed && !playback && (
          <GeoJSONSource id="route" data={routeLines}>
            <Layer
              id="route-line"
              type="line"
              layout={LINE_LAYOUT}
              paint={{ 'line-color': colors.primary, 'line-width': 5 }}
            />
          </GeoJSONSource>
        )}

        {colorBySpeed && baseLine.features.length > 0 && (
          <GeoJSONSource id="route-base" data={baseLine} tolerance={0}>
            <Layer
              id="route-base-line"
              type="line"
              layout={LINE_LAYOUT}
              paint={{ 'line-color': ROUTE_BASE_COLOR, 'line-width': 3 }}
            />
          </GeoJSONSource>
        )}

        {hasLine && colorBySpeed && (
          <GeoJSONSource id="speed-route" data={speedSegments} tolerance={0}>
            <Layer
              id="speed-route-line"
              type="line"
              layout={LINE_LAYOUT}
              paint={{ 'line-color': speedColor as never, 'line-width': 6 }}
            />
          </GeoJSONSource>
        )}

        {gapLines.unfilled.features.length > 0 && (
          <GeoJSONSource id="gaps-unfilled" data={gapLines.unfilled} tolerance={0}>
            <Layer
              id="gaps-unfilled-line"
              type="line"
              layout={LINE_LAYOUT}
              paint={{ 'line-color': colors.textMuted, 'line-width': 4, 'line-dasharray': [0.5, 2] }}
            />
          </GeoJSONSource>
        )}

        {colorBySpeed && gapLines.filled.features.length > 0 && (
          <GeoJSONSource id="gaps-filled" data={gapLines.filled} tolerance={0}>
            <Layer
              id="gaps-filled-line"
              type="line"
              paint={{ 'line-color': colors.accent, 'line-width': 5, 'line-dasharray': [2, 1.5] }}
            />
          </GeoJSONSource>
        )}

        {colorBySpeed && first && (
          <Marker id="start" lngLat={[first.longitude, first.latitude]}>
            <View style={[styles.dot, { backgroundColor: '#43a047' }]} />
          </Marker>
        )}
        {colorBySpeed && last && last !== first && (
          <Marker id="end" lngLat={[last.longitude, last.latitude]}>
            <View style={[styles.dot, { backgroundColor: colors.primary }]} />
          </Marker>
        )}

        {position && !puckOverlay && !playback && <PositionMarker position={position} />}
      </MapView>
      {puckOverlay && <CenteredPuck accuracyMeters={position.accuracyMeters} latitude={position.latitude} zoom={zoom} />}
      {live && hasFix && !following && (
        <Pressable style={styles.recenter} onPress={recenter} accessibilityLabel="Recenter on my position">
          <Text style={styles.recenterText}>◎</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The live route played back slightly in the past: every frame the car's pose is computed from the
 * playback clock, and the line is drawn exactly up to it while the camera (and so the centred
 * arrow) moves to it. Lives in its own component so that only it re-renders every frame.
 */
function LiveRoute(props: {
  route: Route;
  cameraRef: RefObject<CameraRef | null>;
  followRef: RefObject<boolean>;
  zoomRef: RefObject<number>;
  recenterCount: number;
  accuracyMeters: number | null;
  showMarker: boolean;
}) {
  const { route, cameraRef, followRef, zoomRef, recenterCount, accuracyMeters, showMarker } = props;
  const [pose, setPose] = useState<(Pose & { bearing: number }) | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  // Set to make the next frame move the camera even if the pose has not changed.
  const forceCamera = useRef(true);
  useEffect(() => {
    forceCamera.current = true;
  }, [recenterCount]);

  useEffect(() => {
    const clock = new PlaybackClock();
    const bearing = new BearingSmoother();
    let shown: (Pose & { bearing: number }) | null = null;
    let wasFollowing = false;
    let lastFrameMs = performance.now();
    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = now - lastFrameMs;
      lastFrameMs = now;
      const r = routeRef.current;
      const n = r.times.length;
      if (n === 0) return;
      const p = poseAt(r, clock.tick(now, r.times[n - 1]));
      if (!p) return;
      const next = { ...p, bearing: bearing.update(p.course, p.gpsBearing, zoomRef.current, dt) };
      const moved =
        !shown ||
        next.index !== shown.index ||
        next.longitude !== shown.longitude ||
        next.latitude !== shown.latitude ||
        next.bearing !== shown.bearing;
      const following = followRef.current;
      if (following && (moved || !wasFollowing || forceCamera.current)) {
        try {
          cameraRef.current?.jumpTo({ center: [next.longitude, next.latitude], bearing: next.bearing });
          forceCamera.current = false;
        } catch {
          // The native camera is not ready yet; try again next frame.
        }
      }
      wasFollowing = following;
      if (moved) {
        shown = next;
        setPose(next);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [cameraRef, followRef, zoomRef]);

  // The passed part of the route only changes when the car passes a fix (or new fixes arrive);
  // only the short head up to the car changes every frame.
  const index = pose?.index ?? -1;
  const done = useMemo(() => lineFeatures(routeUpTo(route, Math.min(index, route.points.length - 1))), [route, index]);
  const head = useMemo(() => lineFeatures(pose && pose.head.length >= 2 ? [pose.head] : []), [pose]);

  return (
    <>
      <GeoJSONSource id="route" data={done}>
        <Layer id="route-line" type="line" layout={LINE_LAYOUT} paint={{ 'line-color': colors.primary, 'line-width': 5 }} />
      </GeoJSONSource>
      <GeoJSONSource id="route-head" data={head}>
        <Layer id="route-head-line" type="line" layout={LINE_LAYOUT} paint={{ 'line-color': colors.primary, 'line-width': 5 }} />
      </GeoJSONSource>
      {showMarker && pose && (
        <PositionMarker position={{ latitude: pose.latitude, longitude: pose.longitude, accuracyMeters, bearing: pose.bearing }} />
      )}
    </>
  );
}

// MapLibre draws the world 512 px wide at zoom 0.
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const metersPerPixel = (latitude: number, zoom: number) =>
  (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);

/** Position arrow and accuracy circle fixed at the centre of the map view (follow mode). */
function CenteredPuck({ accuracyMeters, latitude, zoom }: { accuracyMeters: number | null; latitude: number; zoom: number }) {
  const radius = (accuracyMeters ?? 0) / metersPerPixel(latitude, zoom);
  return (
    <View style={styles.overlay} pointerEvents="none">
      {radius > 17 && (
        <View
          style={[styles.accuracy, { width: 2 * radius, height: 2 * radius, borderRadius: radius, marginLeft: -radius, marginTop: -radius }]}
        />
      )}
      <View style={[styles.puck, styles.centered]}>
        <View style={styles.arrow} />
      </View>
    </View>
  );
}

/** Current position: an accuracy circle in metres plus an arrow pointing in the direction of travel. */
function PositionMarker({ position }: { position: MapPosition }) {
  const accuracyCircle = useMemo<GeoJSON.Feature<GeoJSON.Point>>(
    () => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Point', coordinates: [position.longitude, position.latitude] },
    }),
    [position.longitude, position.latitude],
  );
  // Circle radius is in pixels; convert metres to pixels at zoom 22 and let it scale with zoom.
  const radiusAtZoom22 = (position.accuracyMeters ?? 0) / metersPerPixel(position.latitude, 22);

  return (
    <>
      <GeoJSONSource id="accuracy" data={accuracyCircle}>
        <Layer
          id="accuracy-circle"
          type="circle"
          paint={{
            'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 0, 0, 22, radiusAtZoom22],
            'circle-color': colors.accent,
            'circle-opacity': 0.15,
            'circle-stroke-color': colors.accent,
            'circle-stroke-width': 1,
            'circle-stroke-opacity': 0.4,
          }}
        />
      </GeoJSONSource>
      <Marker id="position" lngLat={[position.longitude, position.latitude]} anchor="center">
        {/* The map rotates with the bearing, so the arrow always points up. */}
        <View style={styles.puck}>
          <View style={styles.arrow} />
        </View>
      </Marker>
    </>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  recenter: {
    position: 'absolute',
    right: 16,
    top: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  recenterText: { fontSize: 26, color: colors.primary },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 3, borderColor: '#fff' },
  overlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  accuracy: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    backgroundColor: 'rgba(2, 158, 225, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(2, 158, 225, 0.4)',
  },
  centered: { position: 'absolute' },
  puck: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  arrow: {
    width: 0,
    height: 0,
    marginBottom: 3,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.primary,
  },
});
