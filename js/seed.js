// Reset — built-in seed template. Ships so the app is useful in the first 10 seconds.
import { uid, now } from './util.js';

// Full House Reset — 15 blocks, ~6h15m. Ordered: start machines first (run in
// background), tidy before vacuum, vacuum before mop. Spec §7.
const BLOCKS = [
  ['Launch', 25, 'both', 'Open all windows. Start laundry load 1. Load and run the dishwasher. Walk the house with a bin bag — all trash out, bins to the curb.'],
  ['Gather the burn pile', 25, 'both', 'Rake leaves, drag trimmings, build the pile. Clear anything flammable within a few metres.'],
  ['Light the fire', 60, 'none', 'Blocks 4 and 5 happen while this burns, so you stay outside with it. Check the wind first — if it\'s gusty, skip and do 4–5 anyway.'],
  ['Balcony, yard & storage', 25, 'both', 'Sweep the balcony, wipe the railing, tidy the storage area, put stray tools back.'],
  ['Hang laundry 1', 20, 'none', 'Hang load 1, start load 2. You\'re already outside.'],
  ['Litter trays', 20, 'both', 'Empty fully, scrub with hot water, dry, refill. Sweep the scattered litter around them.'],
  ['Kitchen counters', 30, 'both', 'Clear everything off, wipe down, degrease the hob and backsplash. Unload the dishwasher, hand-wash the rest.'],
  ['Fridge', 30, 'both', 'Shelf by shelf. Toss expired, wipe each shelf and the door seals, wipe the freezer front. Skip the full freezer today.'],
  ['Kitchen finish', 25, 'both', 'Scrub the sink and tap, microwave inside, appliance fronts, wipe the bin inside and out.'],
  ['Bathrooms', 30, 'both', 'Toilet, shower/tub, sink, mirror, fixtures. Fresh towels. Split the time if there\'s a second bathroom.'],
  ['Bedrooms 1 & 2', 25, 'both', 'Strip and remake beds, clothes into drawers or the wash, clear nightstands and dressers.'],
  ['Bedroom 3 & hallway', 25, 'both', 'Same treatment. Hallway: shoes lined up, surfaces cleared, cobwebs off the corners.'],
  ['Living room', 25, 'both', 'Cushions straightened, surfaces cleared, dust top-down — shelves, TV, tables, skirting last.'],
  ['Vacuum everything', 30, 'both', 'Furthest room back toward the door. Under furniture where you can reach, corners, edges.'],
  ['Mop & finish', 30, 'both', 'All hard floors, same back-to-front path. Hang laundry 2 while floors dry. Close windows.'],
];

export function buildSeedTemplate() {
  const ts = now();
  return {
    id: uid(),
    name: 'Full House Reset',
    description: 'A full-day deep clean, ordered so the machines run while you work.',
    isBuiltIn: true,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncedAt: null,
    blocks: BLOCKS.map(([title, estimatedMinutes, photoMode, detail], i) => ({
      id: uid(),
      title,
      detail,
      estimatedMinutes,
      order: i,
      photoMode,     // 'both' | 'before' | 'after' | 'none'
      tags: [],
    })),
  };
}
