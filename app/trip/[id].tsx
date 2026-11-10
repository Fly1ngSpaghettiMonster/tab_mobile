import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { StatTile } from '@/src/components/StatTile';
import { TripMap } from '@/src/components/TripMap';
import { getJourney, getSamples, type Journey } from '@/src/db/database';
import type { GapFill } from '@/src/geo/gapFill';
import { speedScale, type SpeedStop } from '@/src/geo/speedColors';
import { formatDuration, km, kmh, type GpsSample } from '@/src/geo/stats';
import { processJourneyGaps, type GapResult } from '@/src/recording/gapProcessing';
import { colors } from '@/src/theme';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [trip, setTrip] = useState<Journey | null>(null);
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [loading, setLoading] = useState(true);
  // undefined = still checking, null = could not check (offline), otherwise the result.
  const [gapResult, setGapResult] = useState<GapResult | null | undefined>(undefined);

  // Colour scale anchored at this trip's moving average (stops excluded), up to its max speed.
  const speedStops = useMemo(() => {
    if (!trip) return undefined;
    const average = trip.movingAvgSpeedMps > 0 ? trip.movingAvgSpeedMps : trip.avgSpeedMps;
    return speedScale(average * 3.6, trip.maxSpeedMps * 3.6);
  }, [trip]);

  useEffect(() => {
    const journeyId = Number(id);
    let cancelled = false;
    Promise.all([getJourney(journeyId), getSamples(journeyId)])
      .then(([j, s]) => {
        if (cancelled) return;
        setTrip(j);
        setSamples(s);
      })
      .finally(() => !cancelled && setLoading(false));
    // Fills GPS gaps along roads if not done yet (e.g. the phone was offline when the trip ended),
    // then reloads the trip so the statistics include the road distance.
    processJourneyGaps(journeyId)
      .then(async (result) => {
        if (cancelled) return;
        setGapResult(result);
        const j = await getJourney(journeyId);
        if (!cancelled) setTrip(j);
      })
      .catch(() => !cancelled && setGapResult(null));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (!trip) {
    return (
      <View style={styles.center}>
        <Text>Trip not found.</Text>
      </View>
    );
  }

  const started = new Date(trip.startedAtUtc);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: trip.name ?? started.toLocaleDateString() }} />
      <TripMap
        samples={samples}
        colorBySpeed
        gapFills={gapResult?.fills ?? NO_FILLS}
        speedStops={speedStops}
        style={styles.map}
      />
      {speedStops && <SpeedLegend stops={speedStops} />}
      <Text style={styles.gapStatus}>{gapStatusText(gapResult)}</Text>
      <ScrollView contentContainerStyle={styles.stats}>
        <Text style={styles.when}>
          {started.toLocaleString()} → {trip.endedAtUtc ? new Date(trip.endedAtUtc).toLocaleTimeString() : '…'}
        </Text>
        <View style={styles.grid}>
          <StatTile label="Distance" value={km(trip.distanceMeters)} unit="km" />
          <StatTile label="Duration" value={formatDuration(trip.durationSeconds)} />
          <StatTile label="Average speed" value={kmh(trip.avgSpeedMps)} unit="km/h" />
          <StatTile label="Moving average" value={kmh(trip.movingAvgSpeedMps)} unit="km/h" />
          <StatTile label="Max speed" value={kmh(trip.maxSpeedMps)} unit="km/h" />
          <StatTile label="GPS samples" value={String(trip.sampleCount)} />
        </View>
        <Text style={styles.when}>Location source: {trip.locationSource ?? 'fused (older recording)'}</Text>
      </ScrollView>
    </View>
  );
}

const NO_FILLS: GapFill[] = [];
const LEGEND_SLICES = 40;

/** Smooth colour bar of the trip's speed scale, with the km/h value under each stop. */
function SpeedLegend({ stops }: { stops: SpeedStop[] }) {
  const slices = useMemo(() => {
    // Stops are drawn evenly spaced, matching how the scale divides the colours.
    const segments = stops.length - 1;
    return Array.from({ length: LEGEND_SLICES }, (_, i) => {
      const pos = (i / (LEGEND_SLICES - 1)) * segments;
      const k = Math.min(Math.floor(pos), segments - 1);
      return mixColors(stops[k].color, stops[k + 1].color, pos - k);
    });
  }, [stops]);
  return (
    <View style={styles.legend}>
      <View style={styles.gradient}>
        {slices.map((c, i) => (
          <View key={i} style={[styles.gradientStop, { backgroundColor: c }]} />
        ))}
      </View>
      <View style={styles.legendLabels}>
        {stops.map((s, i) => (
          <Text key={i} style={[styles.legendText, i === 2 && styles.legendAverage]}>
            {Math.round(s.kmh)}
            {i === 2 ? ' avg' : ''}
            {i === stops.length - 1 ? ' km/h' : ''}
          </Text>
        ))}
      </View>
    </View>
  );
}

function mixColors(a: string, b: string, t: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
  const mixed = [0, 1, 2].map((i) => Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * t));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function gapStatusText(result: GapResult | null | undefined): string {
  if (result === undefined) return 'Checking GPS gaps against the road map…';
  if (result === null) return 'GPS gaps not checked yet (no internet); they will be checked next time.';
  if (result.gaps === 0) return 'No GPS gaps on this trip.';
  const tunnels = result.fills.filter((f) => f.tunnel).length;
  const rail = result.fills.filter((f) => f.mode === 'rail').length;
  const along = rail === 0 ? 'roads' : rail === result.fills.length ? 'rail lines' : 'roads and rail lines';
  const filled = `${result.fills.length} of ${result.gaps} GPS gap${result.gaps === 1 ? '' : 's'} followed along ${along}`;
  const tunnelText = tunnels > 0 ? ` (${tunnels} through a tunnel)` : '';
  return `${filled}${tunnelText} - dashed. Dotted grey: no matching road or rail line found.`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  map: { flex: 0, height: '50%' },
  legend: { paddingHorizontal: 12, paddingTop: 8, gap: 2 },
  legendLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  legendText: { color: colors.textMuted, fontSize: 12 },
  legendAverage: { color: colors.text, fontWeight: '600' },
  gapStatus: { color: colors.textMuted, fontSize: 12, paddingHorizontal: 12, paddingTop: 4 },
  gradient: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' },
  gradientStop: { flex: 1 },
  stats: { padding: 12, gap: 8 },
  when: { color: colors.textMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
