import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { recoverUnfinishedJourneys, refreshOutdatedStats } from '@/src/db/database';
import { RecordingProvider } from '@/src/recording/RecordingContext';
import { closeLeftoverShareSessions } from '@/src/share/api';
import { colors } from '@/src/theme';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: colors.accent, background: colors.background },
};

export default function RootLayout() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Before showing the UI: close any journey left open by a crash or force-stop, and
    // recalculate trips whose stored statistics come from an older version of the formulas.
    recoverUnfinishedJourneys()
      .then(refreshOutdatedStats)
      .catch((e) => console.warn('Recovery failed', e))
      .finally(() => {
        setReady(true);
        SplashScreen.hideAsync();
        // Share links of trips that ended without a clean stop; done in the background (needs network).
        closeLeftoverShareSessions().catch((e) => console.warn('Closing leftover shares failed', e));
      });
  }, []);

  if (!ready) return null;

  return (
    <ThemeProvider value={theme}>
      <RecordingProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.primary },
            headerTintColor: colors.onPrimary,
          }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="trip/[id]" options={{ title: 'Trip' }} />
        </Stack>
      </RecordingProvider>
    </ThemeProvider>
  );
}
