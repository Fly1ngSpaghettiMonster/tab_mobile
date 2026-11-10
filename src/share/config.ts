// Set in .env.local (gitignored), e.g.:
//   EXPO_PUBLIC_TAB_API_URL=https://tab.aabder.xyz
//   EXPO_PUBLIC_TAB_API_KEY=<same value as TAB_API_KEY on the server>
// Expo inlines EXPO_PUBLIC_* at bundle time, so restart Metro after changing them.
export const TAB_API_URL = (process.env.EXPO_PUBLIC_TAB_API_URL ?? 'https://tab.aabder.xyz').replace(/\/+$/, '');
export const TAB_API_KEY = process.env.EXPO_PUBLIC_TAB_API_KEY ?? '';
