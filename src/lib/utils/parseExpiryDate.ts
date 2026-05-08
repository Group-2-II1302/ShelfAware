/**
 * parseExpiryDate.ts
 *
 * Converts noisy OCR output into a clean "DD-MM-YYYY" string.
 * Returns null when no valid date can be confidently extracted.
 *
 * Supported input formats (detected in priority order):
 *   1. Separated 8-digit:  DD/MM/YYYY  |  YYYY-MM-DD  |  DD.MM.YYYY
 *   2. Separated 6-digit:  DD/MM/YY    |  MM/YYYY
 *   3. Month abbreviation: 26 MAY 2023 |  26 MAY 23   |  MAY 2023  | MAY23
 *   4. Pure digits 8:      DDMMYYYY    |  YYYYMMDD
 *   5. Pure digits 6:      YYMMDD      |  DDMMYY  (YYMMDD preferred – ISO food standard)
 *   6. Pure digits 4:      MMYY
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MONTH_ABBR: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Expand a 2-digit year: 00-50 → 2000-2050, 51-99 → 1951-1999.
 * Expiry dates should always be in the future, so 2000-2050 range is safe
 * for food products scanned now.
 */
function expandYear(yy: number): number {
  return yy <= 50 ? 2000 + yy : 1900 + yy;
}

/**
 * Validates calendar correctness and rejects implausible expiry years.
 * Floor is 2020: anything older is either already long-expired or OCR noise.
 * Ceiling is 2040: no realistic food product has a shelf-life beyond 14 years.
 */
function isValidDate(day: number, month: number, year: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (year < 2020 || year > 2040) return false;
  // Construct and round-trip to catch impossible days (e.g. Feb 30)
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

function fmt(day: number, month: number, year: number): string {
  return `${pad2(day)}-${pad2(month)}-${year}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract and normalise an expiry date from raw OCR text.
 * @returns "DD-MM-YYYY" or null
 */
export function parseExpiryDate(raw: string): string | null {
  if (!raw || raw.trim().length === 0) return null;

  // Normalise: uppercase, collapse non-alphanumeric runs to single space
  const s = raw
    .toUpperCase()
    .replace(/[^0-9A-Z.\-/:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // -------------------------------------------------------------------------
  // Strategy 1 – explicit separator, 4-digit year
  // Matches:  DD-MM-YYYY  |  DD/MM/YYYY  |  DD.MM.YYYY  |  YYYY-MM-DD
  // -------------------------------------------------------------------------
  const sep4yr = s.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (sep4yr) {
    const a = +sep4yr[1],
      b = +sep4yr[2],
      c = +sep4yr[3];
    // Try DD-MM-YYYY
    if (isValidDate(a, b, c)) return fmt(a, b, c);
    // Try MM-DD-YYYY (US style) only if day > 12
    if (a <= 12 && b > 12 && isValidDate(b, a, c)) return fmt(b, a, c);
  }

  // YYYY-MM-DD (ISO)
  const iso = s.match(/\b(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\b/);
  if (iso) {
    const [, y, m, d] = iso.map(Number);
    if (isValidDate(d, m, y)) return fmt(d, m, y);
  }

  // -------------------------------------------------------------------------
  // Strategy 2 – explicit separator, 2-digit year  (DD/MM/YY  or  MM/YY)
  // -------------------------------------------------------------------------
  const sep2yr = s.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2})\b/);
  if (sep2yr) {
    const [, dd, mm, yy] = sep2yr.map(Number);
    const year = expandYear(yy);
    if (isValidDate(dd, mm, year)) return fmt(dd, mm, year);
  }

  // MM/YYYY or YYYY/MM
  const monthYear = s.match(/\b(\d{2})[.\-/](\d{4})\b/);
  if (monthYear) {
    const a = +monthYear[1],
      b = +monthYear[2];
    if (a >= 1 && a <= 12 && b >= 2000 && b <= 2099) return fmt(1, a, b);
    if (b >= 1 && b <= 12 && a >= 2000 && a <= 2099) return fmt(1, b, a);
  }

  // -------------------------------------------------------------------------
  // Strategy 2b – space-separated digit groups: "06 02 27" / "6 2 2027"
  // Tesseract often reads dot-matrix dates with spaces rather than merging
  // the digits, so "06 02 27" arrives as three separate tokens.
  // -------------------------------------------------------------------------
  const spaceSep = s.match(/\b(\d{1,2})\s+(\d{1,2})\s+(\d{2,4})\b/);
  if (spaceSep) {
    const a = +spaceSep[1],
      b = +spaceSep[2],
      cRaw = +spaceSep[3];
    const year = cRaw < 100 ? expandYear(cRaw) : cRaw;
    // Try DD MM YY (most common on European food packaging)
    if (isValidDate(a, b, year)) return fmt(a, b, year);
    // Try MM DD YY (US style)
    if (isValidDate(b, a, year)) return fmt(b, a, year);
    // Try YY MM DD (ISO compact with spaces)
    const yearA = a < 100 ? expandYear(a) : a;
    if (isValidDate(cRaw, b, yearA)) return fmt(cRaw, b, yearA);
  }

  // -------------------------------------------------------------------------
  // Strategy 3 – month name abbreviation
  // -------------------------------------------------------------------------

  // "26 MAY 2023" or "26 MAY 23"
  const withDay = s.match(/\b(\d{1,2})\s+([A-Z]{3})\s+(\d{2,4})\b/);
  if (withDay) {
    const dd = +withDay[1];
    const month = MONTH_ABBR[withDay[2]];
    const yrRaw = withDay[3];
    if (month) {
      const year = yrRaw.length === 2 ? expandYear(+yrRaw) : +yrRaw;
      if (isValidDate(dd, month, year)) return fmt(dd, month, year);
    }
  }

  // "MAY 2023" or "MAY23"
  const monthOnly = s.match(/\b([A-Z]{3})\s*(\d{2,4})\b/);
  if (monthOnly) {
    const month = MONTH_ABBR[monthOnly[1]];
    const yrRaw = monthOnly[2];
    if (month) {
      const year = yrRaw.length === 2 ? expandYear(+yrRaw) : +yrRaw;
      if (isValidDate(1, month, year)) return fmt(1, month, year);
    }
  }

  // -------------------------------------------------------------------------
  // Strategy 4 – pure digit sequences
  // Extract ALL digit runs so we don't miss a number buried in noise.
  // -------------------------------------------------------------------------
  const runs = s.match(/\d+/g) ?? [];

  for (const run of runs) {
    // 8 digits: try DDMMYYYY then YYYYMMDD
    if (run.length === 8) {
      const dd = +run.slice(0, 2),
        mm = +run.slice(2, 4),
        yyyy = +run.slice(4, 8);
      const yyyy2 = +run.slice(0, 4),
        mm2 = +run.slice(4, 6),
        dd2 = +run.slice(6, 8);
      if (isValidDate(dd, mm, yyyy)) return fmt(dd, mm, yyyy);
      if (isValidDate(dd2, mm2, yyyy2)) return fmt(dd2, mm2, yyyy2);
    }

    // 6 digits: YYMMDD or DDMMYY — both can be structurally valid, so use a
    // plausible-year heuristic to pick the right one.
    // e.g. "060227": YYMMDD → 2006-02-27 (past, implausible for expiry)
    //                DDMMYY → 2027-02-06 (future, plausible) ← preferred
    if (run.length === 6) {
      const yy1 = +run.slice(0, 2),
        mm1 = +run.slice(2, 4),
        dd1 = +run.slice(4, 6);
      const dd2 = +run.slice(0, 2),
        mm2 = +run.slice(2, 4),
        yy2 = +run.slice(4, 6);

      const yearYYMMDD = expandYear(yy1);
      const yearDDMMYY = expandYear(yy2);

      const validYYMMDD = isValidDate(dd1, mm1, yearYYMMDD);
      const validDDMMYY = isValidDate(dd2, mm2, yearDDMMYY);

      if (validYYMMDD && validDDMMYY) {
        // Both parse as valid dates — prefer the one with a plausible expiry
        // year (within the window a food product is likely to be labelled).
        const plausibleYYMMDD = yearYYMMDD >= 2020 && yearYYMMDD <= 2040;
        const plausibleDDMMYY = yearDDMMYY >= 2020 && yearDDMMYY <= 2040;
        if (!plausibleYYMMDD && plausibleDDMMYY)
          return fmt(dd2, mm2, yearDDMMYY);
        // Both plausible (or neither): fall back to ISO YYMMDD
        return fmt(dd1, mm1, yearYYMMDD);
      }
      if (validYYMMDD) return fmt(dd1, mm1, yearYYMMDD);
      if (validDDMMYY) return fmt(dd2, mm2, yearDDMMYY);
    }

    // 4 digits: MMYY (month-year on packaging, e.g. "0526" → May 2026)
    if (run.length === 4) {
      const mm = +run.slice(0, 2),
        yy = +run.slice(2, 4);
      const year = expandYear(yy);
      if (mm >= 1 && mm <= 12 && year >= 2020 && year <= 2040)
        return fmt(1, mm, year);
    }
  }

  return null;
}

/**
 * Guard for the server: confirms the string is already in the
 * expected "DD-MM-YYYY" format with a calendar-valid date.
 */
export function isValidExpiryFormat(date: string): boolean {
  const m = date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return false;
  return isValidDate(+m[1], +m[2], +m[3]);
}
