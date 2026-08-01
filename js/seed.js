// Reset — built-in seed template. Ships so the app is useful in the first 10 seconds.
import { uid, now } from './util.js';

export const SEED_KEY = 'full-house-reset';
export const SEED_VERSION = 2; // bump whenever the built-in definition below changes

// Full House Reset — ordered: start machines first (run in background), tidy before
// vacuum, vacuum before mop. Spec §7 (+ user-added pool tidy after the fire).
// [stableSlug, title, estMinutes, photoMode, detail]. Slugs are stable across versions
// so estimate-learning survives migrations.
const BLOCKS = [
  ['launch', 'Launch', 25, 'both', 'Open all windows. Start laundry load 1. Load and run the dishwasher. Walk the house with a bin bag — all trash out, bins to the curb.'],
  ['burn-pile', 'Gather the burn pile', 25, 'both', 'Rake leaves, drag trimmings, build the pile. Clear anything flammable within a few metres.'],
  ['fire', 'Light the fire', 60, 'none', 'The outdoor blocks below happen while this burns, so you stay outside with it. Check the wind first — if it\'s gusty, skip and do the outdoor blocks anyway.'],
  ['pool', 'Pool tidy', 20, 'both', 'Gather the pool things — nets, brushes, toys, floats — and tidy up around the pool. You\'re already outside.'],
  ['balcony', 'Balcony, yard & storage', 25, 'both', 'Sweep the balcony, wipe the railing, tidy the storage area, put stray tools back.'],
  ['hang-laundry-1', 'Hang laundry 1', 20, 'none', 'Hang load 1, start load 2. You\'re already outside.'],
  ['litter', 'Litter trays', 20, 'both', 'Empty fully, scrub with hot water, dry, refill. Sweep the scattered litter around them.'],
  ['kitchen-counters', 'Kitchen counters', 30, 'both', 'Clear everything off, wipe down, degrease the hob and backsplash. Unload the dishwasher, hand-wash the rest.'],
  ['fridge', 'Fridge', 30, 'both', 'Shelf by shelf. Toss expired, wipe each shelf and the door seals, wipe the freezer front. Skip the full freezer today.'],
  ['kitchen-finish', 'Kitchen finish', 25, 'both', 'Scrub the sink and tap, microwave inside, appliance fronts, wipe the bin inside and out.'],
  ['bathrooms', 'Bathrooms', 30, 'both', 'Toilet, shower/tub, sink, mirror, fixtures. Fresh towels. Split the time if there\'s a second bathroom.'],
  ['bedrooms-1-2', 'Bedrooms 1 & 2', 25, 'both', 'Strip and remake beds, clothes into drawers or the wash, clear nightstands and dressers.'],
  ['bedroom-3-hall', 'Bedroom 3 & hallway', 25, 'both', 'Same treatment. Hallway: shoes lined up, surfaces cleared, cobwebs off the corners.'],
  ['living', 'Living room', 25, 'both', 'Cushions straightened, surfaces cleared, dust top-down — shelves, TV, tables, skirting last.'],
  ['vacuum', 'Vacuum everything', 30, 'both', 'Furthest room back toward the door. Under furniture where you can reach, corners, edges.'],
  ['mop', 'Mop & finish', 30, 'both', 'All hard floors, same back-to-front path. Hang laundry 2 while floors dry. Close windows.'],
];

export const SEED_NAME = 'Full House Reset';
export const SEED_DESCRIPTION = 'A full-day deep clean, ordered so the machines run while you work.';

export function seedBlocks() {
  return BLOCKS.map(([slug, title, estimatedMinutes, photoMode, detail], i) => ({
    id: `fhr-${slug}`,
    title,
    detail,
    estimatedMinutes,
    order: i,
    photoMode,     // 'both' | 'before' | 'after' | 'none'
    tags: [],
  }));
}

export function buildSeedTemplate() {
  const ts = now();
  return {
    id: uid(),
    seedKey: SEED_KEY,
    seedVersion: SEED_VERSION,
    name: SEED_NAME,
    description: SEED_DESCRIPTION,
    isBuiltIn: true,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncedAt: null,
    blocks: seedBlocks(),
  };
}
