import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type LngLatBounds,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from 'react-native';

import { processTrack, type GpsSample } from '../geo/stats';
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
};

// Slow segments are red, fast ones blue (km/h).
const SPEED_COLOR = [
  'interpolate',
  ['linear'],
  ['get', 'kmh'],
  0, colors.danger,
  30, '#f9a825',
  60, '#43a047',
  100, colors.accent,
  130, colors.primary,
] as const;

const LINE_LAYOUT = { 'line-cap': 'round', 'line-join': 'round' } as const;
const FIT_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };
// GPS fixes arrive about once a second; gliding for most of that interval makes the camera move
// continuously from fix to fix instead of jumping.
const FOLLOW_ANIMATION_MS = 900;
// A gesture that changed the zoom by more than this counts as zooming, not panning.
const ZOOM_GESTURE_THRESHOLD = 0.05;

export function TripMap({ samples, style, position, colorBySpeed }: Props) {
  const points = useMemo(() => processTrack(samples), [samples]);
  const live = position !== undefined;

  const routeLine = useMemo<GeoJSON.Feature<GeoJSON.LineString>>(
    () => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: points.map((p) => [p.longitude, p.latitude]) },
    }),
    [points],
  );

  // One feature per segment so each one can get its own colour.
  const speedSegments = useMemo<GeoJSON.FeatureCollection<GeoJSON.LineString>>(() => {
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      features.push({
        type: 'Feature',
        properties: { kmh: b.speedMps * 3.6 },
        geometry: {
          type: 'LineString',
          coordinates: [
            [a.longitude, a.latitude],
            [b.longitude, b.latitude],
          ],
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }, [points]);

  const bounds = useMemo<LngLatBounds | undefined>(() => {
    if (points.length < 2) return undefined;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of points) {
      w = Math.min(w, p.longitude);
      e = Math.max(e, p.longitude);
      s = Math.min(s, p.latitude);
      n = Math.max(n, p.latitude);
    }
    return [w, s, e, n];
  }, [points]);

  // Camera props must only change when the position really changes: while the camera moves, the
  // native map sends JS an event on every frame. Re-sending the stop on every render kept it
  // animating constantly and flooded the JS thread; one glide per GPS fix is cheap (~14% JS CPU
  // measured in a dev build, versus ~7% for instant jumps).
  const hasFix = position != null;
  const lat = position?.latitude;
  const lon = position?.longitude;
  const bearing = position?.bearing;

  // Follow mode: panning pauses following (the recenter button brings it back), zooming keeps
  // following and recenters when the pinch ends. No camera updates are sent mid-gesture.
  const [following, setFollowing] = useState(true);
  const [gesturing, setGesturing] = useState(false);
  // Bumped to re-send the follow stop even if the position has not changed.
  const [recenterCount, setRecenterCount] = useState(0);
  const gestureStartZoom = useRef<number | null>(null);

  const onRegionWillChange = (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    // A finger gesture is reported as a user interaction that is not animated; the native map
    // also flags the app's own camera moves as user interaction, but those are animated.
    if (!e.nativeEvent.userInteraction || e.nativeEvent.animated) return;
    gestureStartZoom.current = e.nativeEvent.zoom;
    setGesturing(true);
  };
  const onRegionDidChange = (e: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    const startZoom = gestureStartZoom.current;
    if (startZoom == null) return;
    gestureStartZoom.current = null;
    setGesturing(false);
    if (Math.abs(e.nativeEvent.zoom - startZoom) > ZOOM_GESTURE_THRESHOLD) {
      setRecenterCount((n) => n + 1);
    } else {
      setFollowing(false);
    }
  };
  const recenter = () => {
    setFollowing(true);
    setRecenterCount((n) => n + 1);
  };

  const initialView = useMemo(
    () => (hasFix ? { center: [lon!, lat!] as [number, number], zoom: 16 } : { zoom: 3 }),
    // Only read once, when the camera mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasFix],
  );
  const followStop = useMemo(
    () =>
      following && !gesturing && lat != null && lon != null
        ? {
            center: [lon, lat] as [number, number],
            bearing,
            duration: FOLLOW_ANIMATION_MS,
            easing: 'linear' as const,
          }
        : {},
    // recenterCount forces a new stop object, so the camera jumps back even when standing still.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lat, lon, bearing, following, gesturing, recenterCount],
  );

  const first = points[0];
  const last = points[points.length - 1];
  const hasLine = points.length >= 2;

  return (
    <View style={[styles.map, style]}>
      <Map
        style={styles.map}
        mapStyle={MAP_STYLE_URL}
        compass={false}
        logo={false}
        touchPitch={false}
        // Heading-up follow mode: the app controls the rotation.
        touchRotate={!live}
        onRegionWillChange={live ? onRegionWillChange : undefined}
        onRegionDidChange={live ? onRegionDidChange : undefined}>
        {live ? (
          // Remount when the first fix arrives so the initial view zooms in on it.
          <Camera key={hasFix ? 'fix' : 'nofix'} initialViewState={initialView} {...followStop} />
        ) : bounds ? (
          <Camera bounds={bounds} padding={FIT_PADDING} />
        ) : first ? (
          <Camera center={[first.longitude, first.latitude]} zoom={15} />
        ) : null}

        {hasLine && !colorBySpeed && (
          <GeoJSONSource id="route" data={routeLine}>
            <Layer
              id="route-line"
              type="line"
              layout={LINE_LAYOUT}
              paint={{ 'line-color': colors.primary, 'line-width': 5 }}
            />
          </GeoJSONSource>
        )}

        {hasLine && colorBySpeed && (
          <GeoJSONSource id="speed-route" data={speedSegments}>
            <Layer
              id="speed-route-line"
              type="line"
              layout={LINE_LAYOUT}
              paint={{ 'line-color': SPEED_COLOR as never, 'line-width': 6 }}
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

        {position && <PositionMarker position={position} />}
      </Map>
      {live && hasFix && !following && (
        <Pressable style={styles.recenter} onPress={recenter} accessibilityLabel="Recenter on my position">
          <Text style={styles.recenterText}>◎</Text>
        </Pressable>
      )}
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
  const metersPerPixelAtZoom22 = 0.0373 * Math.cos((position.latitude * Math.PI) / 180);
  const radiusAtZoom22 = (position.accuracyMeters ?? 0) / metersPerPixelAtZoom22;

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
