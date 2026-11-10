import { listUnclosedShareSessions, setShareStatus, type ShareSession } from '../db/database';
import { TAB_API_KEY, TAB_API_URL } from './config';

export type CloseReason = 'ended' | 'revoked';

const REQUEST_TIMEOUT_MS = 10_000;

async function request(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${TAB_API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Creates a sharing session on the backend; returns its id, owner token and the link to share. */
export async function createSession(
  journeyId: number,
  startedAtUtc: string,
  locationSource: string,
): Promise<{ sessionId: string; ownerToken: string; viewerUrl: string }> {
  if (!TAB_API_KEY) throw new Error('EXPO_PUBLIC_TAB_API_KEY is not set, so sharing is unavailable.');
  const res = await request('/api/sessions', {
    method: 'POST',
    headers: { 'X-Api-Key': TAB_API_KEY },
    body: JSON.stringify({ clientTripId: String(journeyId), startedAtUtc, locationSource }),
  });
  if (!res.ok) throw new Error(`Could not start sharing (HTTP ${res.status}).`);
  return res.json();
}

/** Closes a session on the backend: the share link stops working and viewers are disconnected. */
export async function closeSession(sessionId: string, ownerToken: string, reason: CloseReason): Promise<void> {
  const res = await request(`/api/sessions/${sessionId}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ reason }),
  });
  // 401: the server no longer knows this session (e.g. deleted after retention), so it is closed anyway.
  if (!res.ok && res.status !== 401) throw new Error(`Close failed (HTTP ${res.status})`);
}

/** Closes a session on the server and records the outcome locally; failures are retried on next start. */
export async function closeAndRecord(session: ShareSession, reason: CloseReason): Promise<void> {
  await setShareStatus(session.sessionId, 'closing');
  try {
    await closeSession(session.sessionId, session.ownerToken, reason);
    await setShareStatus(session.sessionId, 'closed');
  } catch (e) {
    console.warn('Closing share session failed; will retry on next start', e);
  }
}

/**
 * Closes sessions left open by a crash, a force-stop or a failed close request.
 * Runs at startup, when no recording (and so no sharing) can be active.
 */
export async function closeLeftoverShareSessions(): Promise<void> {
  for (const s of await listUnclosedShareSessions()) {
    await closeAndRecord(s, s.status === 'open' ? 'ended' : 'revoked');
  }
}
