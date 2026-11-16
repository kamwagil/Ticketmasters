import { Notice } from './forms';
import { api, getBrand } from '@/lib/api';

/** Renders the brand's current policy text and version, as published in the central platform. */
export async function PolicyPage({ type, title }: { type: 'TERMS' | 'REFUND' | 'PRIVACY'; title: string }) {
  const [brand, res] = await Promise.all([getBrand(), api<Record<string, { version: number; content: string; publishedAt: string }>>('GET', '/brand/policies', { customer: false })]);
  const policy = res.ok ? res.data[type] : null;
  return (
    <article className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {policy ? (
        <>
          <p className="mb-6 mt-1 text-sm text-slate-500">
            {brand.ok ? brand.data.name : ''} · Version {policy.version} · Published {new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date(policy.publishedAt))}
          </p>
          <div className="card whitespace-pre-line leading-relaxed text-slate-700">{policy.content}</div>
        </>
      ) : (
        <div className="mt-6"><Notice kind="info">{res.ok ? 'This policy has not been published yet. Please contact us if you have a question.' : res.error.message}</Notice></div>
      )}
    </article>
  );
}
