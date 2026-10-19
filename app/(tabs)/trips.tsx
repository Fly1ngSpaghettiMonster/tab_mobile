import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { deleteJourney, listJourneys, type Journey } from '@/src/db/database';
import { formatDuration, km, kmh } from '@/src/geo/stats';
import { colors } from '@/src/theme';

export default function TripsScreen() {
  const router = useRouter();
  const [trips, setTrips] = useState<Journey[]>([]);

  const load = useCallback(() => {
    listJourneys().then(setTrips).catch((e) => console.warn('Failed to load trips', e));
  }, []);

  useFocusEffect(load);

  const confirmDelete = (trip: Journey) =>
    Alert.alert('Delete trip?', formatDate(trip.startedAtUtc), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteJourney(trip.id).then(load) },
    ]);

  return (
    <FlatList
      data={trips}
      keyExtractor={(t) => String(t.id)}
      contentContainerStyle={trips.length === 0 ? styles.emptyContainer : styles.list}
      ListEmptyComponent={<Text style={styles.empty}>No trips yet. Press Record on the map to start one.</Text>}
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => router.push(`/trip/${item.id}`)}
          onLongPress={() => confirmDelete(item)}>
          <View style={styles.rowHeader}>
            <Text style={styles.title}>{item.name ?? formatDate(item.startedAtUtc)}</Text>
            <Text style={styles.duration}>{formatDuration(item.durationSeconds)}</Text>
          </View>
          <Text style={styles.details}>
            {km(item.distanceMeters)} km · avg {kmh(item.avgSpeedMps)} km/h · max {kmh(item.maxSpeedMps)} km/h
          </Text>
        </Pressable>
      )}
    />
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  list: { padding: 12, gap: 8 },
  emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  empty: { color: colors.textMuted, textAlign: 'center' },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    borderLeftWidth: 4,
    borderLeftColor: colors.accent,
  },
  pressed: { opacity: 0.7 },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  title: { color: colors.primary, fontWeight: '700', fontSize: 16 },
  duration: { color: colors.text, fontVariant: ['tabular-nums'] },
  details: { color: colors.textMuted, marginTop: 4 },
});
