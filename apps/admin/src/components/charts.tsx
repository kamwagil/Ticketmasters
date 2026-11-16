'use client';

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EmptyState } from './ui';

export const CHART_COLORS = ['#2a56e0', '#0d9488', '#d97706', '#9333ea', '#e11d48', '#0891b2', '#65a30d', '#64748b'];

const axis = { fontSize: 11, fill: '#64748b' };
const tooltipStyle = { borderRadius: 10, border: '1px solid #e2e8f0', boxShadow: '0 12px 32px rgba(15,23,42,.12)', fontSize: 12, padding: '8px 10px' };

export interface Series {
  key: string;
  label: string;
  color?: string;
}
interface ChartProps {
  data: Record<string, unknown>[];
  xKey: string;
  series: Series[];
  height?: number;
  /** Formats values in the tooltip and on the Y axis. */
  format?: (v: number) => string;
  formatX?: (v: string) => string;
  stacked?: boolean;
}

const compact = (v: number) => new Intl.NumberFormat('en-KE', { notation: 'compact', maximumFractionDigits: 1 }).format(v);

/** Time series as filled lines. One series per key (for revenue, one per currency: never a mixed sum). */
export function AreaSeries({ data, xKey, series, height = 260, format, formatX, stacked }: ChartProps) {
  if (!data.length) return <EmptyState title="No data for this period" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.22} />
              <stop offset="100%" stopColor={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="#eef2f7" vertical={false} />
        <XAxis dataKey={xKey} tick={axis} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} tickFormatter={formatX} minTickGap={24} />
        <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => compact(Number(v))} />
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (format ? format(Number(v)) : compact(Number(v)))} labelFormatter={(l) => (formatX ? formatX(String(l)) : String(l))} />
        {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => (
          <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stackId={stacked ? 'a' : undefined} stroke={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4 }} />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function BarSeries({ data, xKey, series, height = 260, format, formatX, stacked, horizontal }: ChartProps & { horizontal?: boolean }) {
  if (!data.length) return <EmptyState title="No data for this period" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
        <CartesianGrid stroke="#eef2f7" vertical={!!horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" tick={axis} tickLine={false} axisLine={false} tickFormatter={(v) => compact(Number(v))} />
            <YAxis type="category" dataKey={xKey} tick={axis} tickLine={false} axisLine={false} width={130} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} tick={axis} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} tickFormatter={formatX} minTickGap={16} />
            <YAxis tick={axis} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => compact(Number(v))} />
          </>
        )}
        <Tooltip cursor={{ fill: '#f1f5f9' }} contentStyle={tooltipStyle} formatter={(v) => (format ? format(Number(v)) : compact(Number(v)))} />
        {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? 'a' : undefined} fill={s.color ?? CHART_COLORS[i % CHART_COLORS.length]} radius={stacked ? 0 : [4, 4, 0, 0]} maxBarSize={44} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function Donut({ data, height = 220, format }: { data: { name: string; value: number; color?: string }[]; height?: number; format?: (v: number) => string }) {
  const shown = data.filter((d) => d.value > 0);
  if (!shown.length) return <EmptyState title="No data for this period" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={shown} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="86%" paddingAngle={2} stroke="none">
          {shown.map((d, i) => (
            <Cell key={d.name} fill={d.color ?? CHART_COLORS[i % CHART_COLORS.length]} />
          ))}
        </Pie>
        <Tooltip contentStyle={tooltipStyle} formatter={(v) => (format ? format(Number(v)) : compact(Number(v)))} />
        <Legend iconType="circle" iconSize={8} layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
