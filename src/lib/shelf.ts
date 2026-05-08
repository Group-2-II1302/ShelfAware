/**
 * Physical layout of a shelf. Hardware currently provides 6 weight scales
 * per shelf, grouped visually into two zones of 3 slots each.
 *
 * If hardware ever becomes modular (variable slot count, different zone
 * layouts), move these to a per-shelf database column or related table.
 */

export const SLOTS_PER_SHELF = 6;

export type ZoneId = 1 | 2;

export type ZoneLayout = {
  id: ZoneId;
  label: string;
  slotIndices: readonly number[];
};

export const ZONES: readonly ZoneLayout[] = [
  { id: 1, label: "Zone 1", slotIndices: [0, 1, 2] },
  { id: 2, label: "Zone 2", slotIndices: [3, 4, 5] },
] as const;

export function getZoneForSlot(scaleIndex: number): ZoneId {
  return scaleIndex < 3 ? 1 : 2;
}
