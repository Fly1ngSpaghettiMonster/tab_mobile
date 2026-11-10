import { getGapFills, getJourney, getSamples, saveGapFills } from '../db/database';
import { fetchOpenFreeMapTile, fillGap, type GapFill } from '../geo/gapFill';
import { findGaps } from '../geo/gaps';
import { computeStats, processTrack } from '../geo/stats';

export type GapResult = { gaps: number; fills: GapFill[] };

// One run per journey at a time: the trip screen and the stop flow may both ask for it.
const running = new Map<number, Promise<GapResult | null>>();

/**
 * Fills a finished journey's GPS gaps along the road or rail network and updates its statistics.
 * Resolves null when tiles could not be downloaded (e.g. offline); the journey then stays
 * unchecked and is retried the next time the trip is opened.
 */
export function processJourneyGaps(journeyId: number): Promise<GapResult | null> {
  let job = running.get(journeyId);
  if (!job) {
    job = run(journeyId).finally(() => running.delete(journeyId));
    running.set(journeyId, job);
  }
  return job;
}

async function run(journeyId: number): Promise<GapResult | null> {
  const journey = await getJourney(journeyId);
  if (!journey || !journey.endedAtUtc) return null;
  if (journey.gapsChecked) {
    const fills = await getGapFills(journeyId);
    return { gaps: countGaps(await getSamples(journeyId)), fills };
  }

  const samples = await getSamples(journeyId);
  const gaps = findGaps(processTrack(samples), samples);
  const fills: GapFill[] = [];
  try {
    for (const gap of gaps) {
      const fill = await fillGap(gap, fetchOpenFreeMapTile, (m) =>
        console.log(`[gaps] trip ${journeyId}, gap ${gap.from.sample.sequence}-${gap.to.sample.sequence}: ${m}`),
      );
      if (fill) fills.push(fill);
    }
  } catch (e) {
    console.warn(`[gaps] trip ${journeyId}: could not download map data, will retry later`, e);
    return null;
  }

  const stats = computeStats(samples, Date.parse(journey.endedAtUtc), fills);
  await saveGapFills(journeyId, fills, stats);
  return { gaps: gaps.length, fills };
}

function countGaps(samples: Awaited<ReturnType<typeof getSamples>>): number {
  return findGaps(processTrack(samples), samples).length;
}
