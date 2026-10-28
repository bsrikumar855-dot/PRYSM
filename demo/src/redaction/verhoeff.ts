// The Verhoeff check-digit algorithm, used to tell a real Aadhaar-shaped number from 12 random digits.
const D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function at(table: readonly (readonly number[])[], row: number, col: number): number {
  return table[row]?.[col] ?? 0;
}

function checksum(digits: string): number {
  let c = 0;
  // Walk the digits right to left; callers pass digits only.
  for (let i = 0; i < digits.length; i += 1) {
    const digit = Number(digits.charAt(digits.length - 1 - i));
    c = at(D, c, at(P, i % 8, digit));
  }
  return c;
}

/** True when `digits` (digits only) ends in a correct Verhoeff check digit. */
export function verhoeffValid(digits: string): boolean {
  return /^\d+$/.test(digits) && checksum(digits) === 0;
}

/** The check digit to append to `digits` (digits only). Used to build synthetic test numbers. */
export function verhoeffCheckDigit(digits: string): number {
  return INV[checksum(`${digits}0`)] ?? 0;
}
