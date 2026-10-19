import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { StatTile } from '@/src/components/StatTile';
import { TripMap } from '@/src/components/TripMap';
import { getJourney, getSamples, type Journey } from '@/src/db/database';
import { formatDuration, km, kmh, type GpsSample } from '@/src/geo/stats';
import { colors } from '@/src/theme';

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [trip, setTrip] = useState<Journey | null>(null);
  const [samples, setSamples] = useState<GpsSample[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const journeyId = Number(id);
    Promise.all([getJourney(journeyId), getSamples(journeyId)])
      .then(([j, s]) => {
        setTrip(j);
        setSamples(s);
      })
      .finally(() => setLoading(false));
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
      <TripMap samples={samples} colorBySpeed style={styles.map} />
      <View style={styles.legend}>
        <Text style={styles.legendText}>slow</Text>
        <View style={styles.gradient}>
          {['#d32f2f', '#f9a825', '#43a047', colors.accent, colors.primary].map((c) => (
            <View key={c} style={[styles.gradientStop, { backgroundColor: c }]} />
          ))}
        </View>
        <Text style={styles.legendText}>fast</Text>
      </View>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  map: { flex: 0, height: '50%' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  legendText: { color: colors.textMuted, fontSize: 12 },
  gradient: { flex: 1, flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden' },
  gradientStop: { flex: 1 },
  stats: { padding: 12, gap: 8 },
  when: { color: colors.textMuted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
