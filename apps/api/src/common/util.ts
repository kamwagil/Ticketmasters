import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import * as ExcelJS from 'exceljs';

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number = 25;
  /** Free-text search. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  /** Restrict to one brand (validated against the caller's brand access). */
  @IsOptional() @IsUUID() brandId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  /** csv | xlsx: return the full filtered result as a file instead of a page. */
  @IsOptional() @IsString() format?: string;
}

export function paging(q: PageQuery) {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 25;
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

export function paged<T>(items: T[], total: number, q: PageQuery) {
  const { page, pageSize } = paging(q);
  return { items, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export function dateRange(q: { from?: string; to?: string }): { gte?: Date; lte?: Date } | undefined {
  if (!q.from && !q.to) return undefined;
  return { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
}

export const normEmail = (e: string) => e.trim().toLowerCase();
export function normPhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  return digits.length >= 7 ? digits : null;
}

export function formatWhen(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(date);
  } catch {
    return date.toISOString();
  }
}

// ── Money (integer minor units only) ──

/** amount × bps / 10000, rounded half-up, in BigInt arithmetic. */
export function percentOf(amountMinor: bigint, bps: number): bigint {
  return (amountMinor * BigInt(bps) + 5000n) / 10000n;
}

export function formatMoney(minor: bigint | number, currency: string, minorUnits = 2): string {
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const div = 10n ** BigInt(minorUnits);
  const whole = (abs / div).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = minorUnits ? '.' + (abs % div).toString().padStart(minorUnits, '0') : '';
  return `${neg ? '-' : ''}${currency} ${whole}${frac}`;
}

// ── Exports ──

export type ExportColumn<T> = { header: string; value: (row: T) => unknown };
export const EXPORT_LIMIT = 50_000;

function cell(v: unknown): string | number | Date {
  if (v === null || v === undefined) return '';
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date || typeof v === 'number') return v;
  return String(v);
}

/** Neutralises spreadsheet formula injection in exported text cells. */
const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export async function sendExport<T>(res: Response, format: string, filename: string, columns: ExportColumn<T>[], rows: T[]) {
  if (format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Export');
    ws.addRow(columns.map((c) => c.header)).font = { bold: true };
    for (const r of rows) ws.addRow(columns.map((c) => { const v = cell(c.value(r)); return typeof v === 'string' ? safeText(v) : v; }));
    ws.columns.forEach((c) => (c.width = 22));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    return;
  }
  const esc = (v: unknown) => {
    const c = cell(v);
    const s = c instanceof Date ? c.toISOString() : typeof c === 'string' ? safeText(c) : String(c);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => esc(c.value(r))).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}
