export function money(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return '';
  try {
    return new Intl.NumberFormat('en-KE', { style: 'currency', currency, currencyDisplay: 'code' }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** Formats in the EVENT's timezone, so the time is right wherever the server or buyer is. */
export function when(value: string | Date, timezone: string, style: 'full' | 'short' = 'full'): string {
  const opts: Intl.DateTimeFormatOptions = style === 'full'
    ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timezone }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(value));
  }
}

export const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

// ── Brand colours ──

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Whichever of white / near-black is easier to read on the given background. */
export const readableOn = (bg: string) => (contrast(bg, '#ffffff') >= contrast(bg, '#0f172a') ? '#ffffff' : '#0f172a');

/** A colour safe for text and focus rings on white: the brand colour if it has enough contrast, else dark slate. */
export const inkFor = (brandColor: string) => (rgb(brandColor) && contrast(brandColor, '#ffffff') >= 4.5 ? brandColor : '#0f172a');

export const safeColor = (c: string | null | undefined, fallback: string) => (rgb(c ?? '') ? (c as string) : fallback);

export const UNPAID = ['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'PAYMENT_PROCESSING'];
