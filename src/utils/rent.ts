/**
 * Parsing for the optional `rentPaise` override carried by Rooms and Beds.
 *
 * Three states have to stay distinguishable on a PATCH-style update body:
 *   - key absent            -> 'absent'  (leave the stored value alone)
 *   - explicit null or ''   -> 'ok', null (clear the override, inherit again)
 *   - a non-negative number -> 'ok', value
 * Anything else is a 400.
 */
export type RentParseResult =
  | { kind: 'absent' }
  | { kind: 'ok'; value: number | null }
  | { kind: 'invalid'; message: string };

export function parseRentPaise(value: unknown): RentParseResult {
  if (value === undefined) return { kind: 'absent' };
  if (value === null || value === '') return { kind: 'ok', value: null };

  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    n = Number(value.replace(/,/g, '').trim());
  } else {
    return { kind: 'invalid', message: 'rentPaise must be a number or null.' };
  }

  if (!Number.isFinite(n)) {
    return { kind: 'invalid', message: 'rentPaise must be a number or null.' };
  }
  if (n < 0) {
    return { kind: 'invalid', message: 'rentPaise must be non-negative.' };
  }
  return { kind: 'ok', value: Math.round(n) };
}
