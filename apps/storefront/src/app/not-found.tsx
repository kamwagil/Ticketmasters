import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-slate-600">The page or event you are looking for does not exist or is no longer available.</p>
      <p className="mt-6"><Link href="/" className="btn-primary">Browse events</Link></p>
    </div>
  );
}
