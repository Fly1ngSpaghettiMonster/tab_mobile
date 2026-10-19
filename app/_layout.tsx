import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { recoverUnfinishedJourneys } from '@/src/db/database';
import { RecordingProvider } from '@/src/recording/RecordingContext';
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
    // Close any journey left open by a crash or force-stop before showing the UI.
    recoverUnfinishedJourneys()
      .catch((e) => console.warn('Recovery failed', e))
      .finally(() => {
        setReady(true);
        SplashScreen.hideAsync();
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
