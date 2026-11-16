'use client';

import { ArrowLeft, Camera, CameraOff, CheckCircle2, CloudDownload, CloudOff, History, Keyboard, LogOut, RefreshCw, ShieldAlert, WifiOff, XCircle } from 'lucide-react';
import jsQR from 'jsqr';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  dequeue, enqueue, isDurable, loadManifest, lookup, Manifest, markUsed, queue as readQueue, QueuedScan, saveManifest, sha256Hex, usedOnDevice,
} from '@/components/scanner/offline';
import { Button, cn, Drawer, Spinner, StatusBadge } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, number, relative } from '@/lib/format';
import { useQuery } from '@/lib/hooks';

interface ScanEvent {
  id: string;
  name: string;
  startsAt: string;
  status: string;
  venue: { name: string; city: string } | null;
}
interface Session {
  eventId: string;
  eventName: string;
  gate: string;
}
interface Outcome {
  admitted: boolean;
  title: string;
  detail: string;
  offline: boolean;
  ticket?: { reference: string; category: string; holderName: string | null; brand?: string };
}

const SESSION_KEY = 'ctp.scan.session';
const DEVICE_KEY = 'ctp.scan.device';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del: (k: string) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } },
};

function deviceId(): string {
  let id = store.get(DEVICE_KEY);
  if (!id) {
    id = `gate-${crypto.randomUUID().slice(0, 8)}`;
    store.set(DEVICE_KEY, id);
  }
  return id;
}

const buzz = (pattern: number | number[]) => { try { navigator.vibrate?.(pattern); } catch { /* not supported */ } };

/** Turns the API's scan response into what the gate steward needs to read at a glance. */
function describe(res: any): Outcome {
  const ticket = res.ticket ? { reference: res.ticket.reference, category: res.ticket.category, holderName: res.ticket.holderName, brand: res.ticket.brand } : undefined;
  switch (res.result) {
    case 'ADMITTED':
      return { admitted: true, title: 'ADMIT', detail: 'Valid ticket. Admit one.', offline: false, ticket };
    case 'ALREADY_USED':
      return {
        admitted: false, title: 'ALREADY USED', offline: false, ticket,
        detail: res.firstScan ? `First scanned ${dateTime(res.firstScan.at)}${res.firstScan.gate ? ` at ${res.firstScan.gate}` : ''}. Do not admit.` : 'This ticket has already been scanned. Do not admit.',
      };
    case 'WRONG_EVENT':
      return { admitted: false, title: 'WRONG EVENT', offline: false, ticket, detail: res.ticket?.event ? `This ticket is for "${res.ticket.event}". Do not admit.` : 'This ticket is for a different event. Do not admit.' };
    case 'NOT_VALID':
      return { admitted: false, title: 'NOT VALID', offline: false, ticket, detail: res.ticket?.status ? `Ticket is ${String(res.ticket.status).toLowerCase()}. Do not admit.` : res.message };
    case 'INVALID_TOKEN':
      return { admitted: false, title: 'NOT RECOGNISED', offline: false, detail: 'This is not a ticket for this platform. Do not admit.' };
    default:
      return { admitted: false, title: 'DO NOT ADMIT', offline: false, ticket, detail: res.message ?? 'Ticket could not be validated.' };
  }
}

// ───────────────────────── Event selection ─────────────────────────

function SelectEvent({ onStart }: { onStart: (s: Session) => void }) {
  const { user, logout, can } = useAuth();
  const events = useQuery<ScanEvent[]>('/v1/scanner/events', undefined, { scoped: false });
  const [eventId, setEventId] = useState('');
  const [gate, setGate] = useState('');
  const chosen = events.data?.find((e) => e.id === eventId);
  const hasPortal = user.permissions.some((p) => p !== 'tickets.scan');

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-ink-950 px-5 pb-8 pt-6 text-white">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Ticket scanner</h1>
          <p className="text-sm text-slate-400">{user.fullName}</p>
        </div>
        <div className="flex items-center gap-1">
          {hasPortal && can('tickets.scan') && <Link href="/" className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-ink-800">Portal</Link>}
          <button onClick={logout} aria-label="Sign out" className="grid h-11 w-11 place-items-center rounded-lg text-slate-300 hover:bg-ink-800"><LogOut className="h-5 w-5" /></button>
        </div>
      </header>

      <h2 className="mb-3 mt-8 text-sm font-medium uppercase tracking-wide text-slate-400">Choose the event you are scanning</h2>
      <div className="flex-1 space-y-2 overflow-y-auto">
        {events.loading && <div className="grid place-items-center py-10"><Spinner className="text-slate-400" /></div>}
        {events.error && (
          <div className="rounded-xl bg-red-950 p-4 text-sm text-red-200">
            {events.error.message}
            <button onClick={events.reload} className="mt-2 block font-semibold underline">Try again</button>
          </div>
        )}
        {events.data?.map((e) => (
          <button
            key={e.id}
            onClick={() => setEventId(e.id)}
            aria-pressed={eventId === e.id}
            className={cn('block w-full rounded-xl border-2 p-4 text-left transition-colors', eventId === e.id ? 'border-accent-500 bg-ink-800' : 'border-ink-700 bg-ink-900 hover:border-ink-600')}
          >
            <span className="block text-base font-semibold leading-snug">{e.name}</span>
            <span className="mt-1 block text-sm text-slate-400">{dateTime(e.startsAt)}{e.venue ? ` · ${e.venue.name}` : ''}</span>
          </button>
        ))}
        {events.data && !events.data.length && (
          <p className="rounded-xl bg-ink-900 p-4 text-sm text-slate-300">No events are assigned to you for scanning right now. Ask a supervisor to assign you to the event.</p>
        )}
      </div>

      <label className="mt-5 block">
        <span className="mb-1.5 block text-sm font-medium text-slate-300">Gate or entrance (optional)</span>
        <input value={gate} onChange={(e) => setGate(e.target.value)} maxLength={60} placeholder="For example Gate A" className="h-12 w-full rounded-xl border-0 bg-ink-800 px-4 text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500" />
      </label>
      <button
        disabled={!chosen}
        onClick={() => chosen && onStart({ eventId: chosen.id, eventName: chosen.name, gate: gate.trim() })}
        className="mt-4 h-14 w-full rounded-xl bg-accent-600 text-lg font-semibold text-white transition-colors hover:bg-accent-700 disabled:opacity-40"
      >
        Start scanning
      </button>
    </div>
  );
}

// ───────────────────────── Scanning ─────────────────────────

function Scanner({ session, onExit }: { session: Session; onExit: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const busy = useRef(false);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const overlayUntil = useRef(0);
  const device = useRef('');
  const syncRunning = useRef(false);
  const submitRef = useRef<(code: string) => void>(() => undefined);

  const [camera, setCamera] = useState<'starting' | 'on' | 'denied' | 'unavailable' | 'off'>('starting');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [working, setWorking] = useState(false);
  const [manual, setManual] = useState(false);
  const [code, setCode] = useState('');
  const [online, setOnline] = useState(true);
  const [netFail, setNetFail] = useState(false);
  const [manifest, setManifest] = useState<{ generatedAt: string; count: number } | null>(null);
  const [pending, setPending] = useState(0);
  const [durable, setDurable] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'warn' | 'bad'; text: string } | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const offline = !online || netFail;
  const stats = useQuery<any>(`/v1/scanner/events/${session.eventId}/stats`, undefined, { scoped: false, refreshMs: 15_000 });
  const history = useQuery<any[]>(historyOpen ? `/v1/scanner/events/${session.eventId}/history` : null, undefined, { scoped: false });

  // ── Local state on start ──
  useEffect(() => {
    device.current = deviceId();
    setOnline(navigator.onLine);
    void loadManifest(session.eventId).then(setManifest);
    void readQueue().then((q) => setPending(q.length));
    void isDurable().then(setDurable);
  }, [session.eventId]);

  // ── Sync of offline scans ──
  const sync = useCallback(async () => {
    if (syncRunning.current) return;
    const q = await readQueue();
    if (!q.length) return;
    syncRunning.current = true;
    setSyncing(true);
    let synced = 0;
    const found: string[] = [];
    try {
      const byEvent = new Map<string, QueuedScan[]>();
      for (const s of q) byEvent.set(s.eventId, [...(byEvent.get(s.eventId) ?? []), s]);
      for (const [eventId, scans] of byEvent) {
        for (let i = 0; i < scans.length; i += 100) {
          const batch = scans.slice(i, i + 100);
          const res = await api.post<{ synced: number; conflicts: number; results: { clientScanId: string; result: string; reference: string | null }[] }>('/v1/scanner/sync', {
            eventId, deviceId: device.current,
            scans: batch.map((s) => ({ clientScanId: s.clientScanId, token: s.token, scannedAt: s.scannedAt, ...(s.gate ? { gate: s.gate } : {}) })),
          });
          synced += res.synced;
          found.push(...res.results.filter((r) => r.result !== 'ADMITTED').map((r) => `${r.reference ?? 'Unrecognised code'} (${r.result.toLowerCase().replace(/_/g, ' ')})`));
          setPending(await dequeue(batch.map((s) => s.clientScanId)));
        }
      }
      setNetFail(false);
      setConflicts((c) => [...c, ...found]);
      setNotice(found.length
        ? { tone: 'bad', text: `${synced} offline scan${synced === 1 ? '' : 's'} synced. ${found.length} could not be confirmed: report these entries to a supervisor.` }
        : { tone: 'info', text: `${synced} offline scan${synced === 1 ? '' : 's'} synced. No duplicate entries found.` });
      stats.reload();
    } catch (e) {
      if (e instanceof ApiError) setNotice({ tone: 'bad', text: `Sync failed: ${e.message}` });
      else setNetFail(true); // still no connection; the queue is kept
    } finally {
      syncRunning.current = false;
      setSyncing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const up = () => { setOnline(true); setNetFail(false); void sync(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    if (navigator.onLine) void sync();
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, [sync]);

  // While the browser says "online" but requests fail, probe every 20s and sync when it works again.
  useEffect(() => {
    if (!netFail || !online) return;
    const t = setInterval(async () => {
      try {
        await api.get(`/v1/scanner/events/${session.eventId}/stats`);
        setNetFail(false);
        void sync();
      } catch (e) {
        if (e instanceof ApiError) setNetFail(false);
      }
    }, 20_000);
    return () => clearInterval(t);
  }, [netFail, online, session.eventId, sync]);

  const prepareOffline = async () => {
    setPreparing(true);
    try {
      const m = await api.get<Manifest>(`/v1/scanner/events/${session.eventId}/manifest`);
      await saveManifest(m);
      setManifest({ generatedAt: m.generatedAt, count: m.tickets.length });
      setNotice({ tone: 'info', text: `Offline list ready: ${number(m.tickets.length)} tickets. Download it again before the gates open to pick up late sales.` });
    } catch (e) {
      setNotice({ tone: 'bad', text: e instanceof ApiError ? e.message : 'Could not download the offline list. Check the connection and try again.' });
    } finally {
      setPreparing(false);
    }
  };

  // ── Validation ──
  const show = useCallback((o: Outcome) => {
    overlayUntil.current = Date.now() + 2500;
    setOutcome(o);
    buzz(o.admitted ? 120 : [220, 90, 220]);
    setTimeout(() => { if (Date.now() >= overlayUntil.current - 50) setOutcome(null); }, 2500);
  }, []);

  const validateOffline = useCallback(async (token: string, hash: string): Promise<Outcome> => {
    if (!(await loadManifest(session.eventId))) {
      return { admitted: false, offline: true, title: 'CANNOT VERIFY', detail: 'No connection, and no offline list was downloaded for this event. Do not admit on this scan; send the guest to a supervisor.' };
    }
    const entry = lookup(session.eventId, hash);
    if (!entry) {
      return { admitted: false, offline: true, title: 'NOT ON OFFLINE LIST', detail: 'Not a ticket for this event, or it was sold or changed after the list was downloaded. Do not admit; send the guest to a supervisor.' };
    }
    const ticket = { reference: entry.r, category: entry.c, holderName: entry.n };
    if (entry.s !== 'VALID' || (await usedOnDevice(session.eventId)).has(hash)) {
      return { admitted: false, offline: true, title: 'ALREADY USED', detail: 'This ticket was already scanned. Do not admit.', ticket };
    }
    // Mark used on this device first, then queue for the server.
    await markUsed(session.eventId, hash);
    setPending(await enqueue({ clientScanId: crypto.randomUUID(), eventId: session.eventId, token, scannedAt: new Date().toISOString(), gate: session.gate || undefined }));
    return { admitted: true, offline: true, title: 'ADMIT', detail: 'Checked against the offline list. Will be confirmed when this device syncs.', ticket };
  }, [session]);

  const submit = useCallback(async (raw: string) => {
    const token = raw.trim();
    if (busy.current || token.length < 8 || token.length > 200) return;
    busy.current = true;
    setWorking(true);
    try {
      const hash = await sha256Hex(token);
      if (!navigator.onLine) {
        show(await validateOffline(token, hash));
        return;
      }
      try {
        const res = await api.post('/v1/scanner/scan', { eventId: session.eventId, token, deviceId: device.current, ...(session.gate ? { gate: session.gate } : {}) });
        setNetFail(false);
        if (res.admitted) await markUsed(session.eventId, hash); // so this device still refuses it if it goes offline later
        show(describe(res));
        stats.reload();
        if (pending > 0) void sync();
      } catch (e) {
        if (e instanceof ApiError) {
          show({ admitted: false, offline: false, title: e.status === 403 ? 'NOT AUTHORISED' : 'COULD NOT CHECK', detail: `${e.message} Do not admit on this scan.` });
        } else {
          setNetFail(true);
          show(await validateOffline(token, hash));
        }
      }
    } finally {
      busy.current = false;
      setWorking(false);
    }
  }, [session, show, validateOffline, pending, sync, stats]);

  // The camera loop starts once; it always calls the latest submit through this ref.
  submitRef.current = (c: string) => void submit(c);

  // ── Camera ──
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let wake: { release?: () => Promise<void> } | null = null;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera('unavailable');
        setManual(true);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        setCamera('on');
        try { wake = await (navigator as any).wakeLock?.request('screen'); } catch { /* not supported */ }
        timer = setInterval(() => {
          const c = canvas.current;
          if (!c || v.readyState < 2 || busy.current || Date.now() < overlayUntil.current || document.hidden) return;
          const scale = Math.min(1, 640 / v.videoWidth);
          const w = Math.floor(v.videoWidth * scale);
          const h = Math.floor(v.videoHeight * scale);
          if (!w || !h) return;
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          if (!ctx) return;
          ctx.drawImage(v, 0, 0, w, h);
          const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
          const text = found?.data?.trim();
          if (!text) return;
          // The same code stays in view for a while: submit it once, then ignore it for 5 seconds.
          if (text === last.current.code && Date.now() - last.current.at < 5000) return;
          last.current = { code: text, at: Date.now() };
          submitRef.current(text);
        }, 125);
      } catch (e) {
        const name = (e as DOMException)?.name;
        setCamera(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
        setManual(true);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void wake?.release?.().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = stats.data;

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-ink-950 text-white">
      <header className="flex items-center gap-2 px-3 pb-2 pt-3">
        <button onClick={onExit} aria-label="Change event" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-ink-800"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold leading-tight">{session.eventName}</div>
          <div className="truncate text-xs text-slate-400">{session.gate || 'No gate set'} · {offline ? 'Offline' : 'Live'}</div>
        </div>
        <button onClick={() => setHistoryOpen(true)} aria-label="Scan history" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-ink-800"><History className="h-5 w-5" /></button>
      </header>

      {offline && (
        <div role="status" className="mx-3 mb-2 flex gap-2.5 rounded-xl bg-amber-400 px-3.5 py-3 text-sm font-medium leading-snug text-amber-950">
          <WifiOff className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            {manifest
              ? <>Offline: this device cannot see scans made at other gates or refunds made since the list was downloaded at {dateTime(manifest.generatedAt)}. Duplicate entry is only detected after syncing.</>
              : <>Offline, and no offline list was downloaded for this event. Tickets cannot be verified on this device until the connection returns.</>}
          </span>
        </div>
      )}
      {!durable && (
        <div className="mx-3 mb-2 rounded-xl bg-red-900 px-3.5 py-2.5 text-xs text-red-100">This browser cannot store data. Offline scans are kept only while this page stays open: do not close or reload it before syncing.</div>
      )}

      <div className="relative mx-3 aspect-square overflow-hidden rounded-2xl bg-black">
        <video ref={video} playsInline muted className={cn('h-full w-full object-cover', camera !== 'on' && 'hidden')} />
        <canvas ref={canvas} className="hidden" />
        {camera === 'on' && (
          <>
            <div className="pointer-events-none absolute inset-[14%] rounded-2xl border-4 border-white/80" />
            <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-sm font-medium text-white drop-shadow">Hold the QR code inside the frame</div>
          </>
        )}
        {camera === 'starting' && <div className="absolute inset-0 grid place-items-center text-slate-300"><div className="flex flex-col items-center gap-3"><Camera className="h-8 w-8" /><span className="text-sm">Starting camera</span></div></div>}
        {(camera === 'denied' || camera === 'unavailable') && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center">
            <div>
              <CameraOff className="mx-auto h-9 w-9 text-slate-400" />
              <p className="mt-3 text-base font-semibold">{camera === 'denied' ? 'Camera access was blocked' : 'No camera available'}</p>
              <p className="mt-1.5 text-sm text-slate-300">
                {camera === 'denied'
                  ? 'Allow camera access for this site in your browser settings, then reload. Until then, type the code printed under the QR.'
                  : 'The camera needs a secure (https) connection and a device with a camera. You can type ticket codes instead.'}
              </p>
            </div>
          </div>
        )}
        {working && <div className="absolute inset-0 grid place-items-center bg-black/50"><Spinner className="h-10 w-10 text-white" /></div>}
      </div>

      <div className="grid grid-cols-2 gap-2 px-3 pt-3">
        <div className="rounded-xl bg-ink-900 px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Admitted</div>
          <div className="text-3xl font-bold tabular-nums text-emerald-400">{s ? number(s.admitted) : '-'}</div>
        </div>
        <div className="rounded-xl bg-ink-900 px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-400">Still to arrive</div>
          <div className="text-3xl font-bold tabular-nums">{s ? number(s.remaining) : '-'}</div>
        </div>
      </div>
      {s?.byCategory?.length > 1 && (
        <ul className="mx-3 mt-2 divide-y divide-ink-800 rounded-xl bg-ink-900 text-sm">
          {s.byCategory.map((c: any) => (
            <li key={c.name} className="flex items-center justify-between gap-3 px-4 py-2"><span className="truncate text-slate-200">{c.name}</span><span className="shrink-0 tabular-nums text-slate-400"><span className="font-semibold text-emerald-400">{number(c.admitted)}</span> in · {number(c.remaining)} to come</span></li>
          ))}
        </ul>
      )}
      {offline && stats.data && <p className="mx-3 mt-1 text-xs text-slate-500">Counters were last updated before the connection dropped.</p>}

      {notice && (
        <button onClick={() => setNotice(null)} className={cn('mx-3 mt-3 rounded-xl px-3.5 py-3 text-left text-sm', notice.tone === 'bad' ? 'bg-red-900 text-red-50' : notice.tone === 'warn' ? 'bg-amber-900 text-amber-50' : 'bg-ink-800 text-slate-200')}>
          {notice.text} <span className="underline">Dismiss</span>
        </button>
      )}
      {conflicts.length > 0 && (
        <div className="mx-3 mt-2 rounded-xl border-2 border-red-500 bg-red-950 px-3.5 py-3 text-sm text-red-50">
          <div className="flex items-center gap-2 font-semibold"><ShieldAlert className="h-4 w-4" /> Report to a supervisor</div>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 font-mono text-xs">{conflicts.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <button onClick={() => setConflicts([])} className="mt-2 text-xs underline">I have reported these</button>
        </div>
      )}

      <div className="mt-auto space-y-2 px-3 pb-5 pt-4">
        {manual && (
          <form onSubmit={(e) => { e.preventDefault(); void submit(code); setCode(''); }} className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="Ticket code" placeholder="Paste or type the QR code text"
              className="h-14 min-w-0 flex-1 rounded-xl border-0 bg-ink-800 px-4 font-mono text-base text-white placeholder:font-sans placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-accent-500" />
            <button type="submit" disabled={code.trim().length < 8 || working} className="h-14 shrink-0 rounded-xl bg-accent-600 px-5 text-base font-semibold disabled:opacity-40">Check</button>
          </form>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button onClick={() => setManual((m) => !m)} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-ink-800 text-sm font-medium text-slate-100 hover:bg-ink-700">
            <Keyboard className="h-4 w-4" /> {manual ? 'Hide manual entry' : 'Enter code'}
          </button>
          <button onClick={prepareOffline} disabled={preparing || !online} className="flex h-12 items-center justify-center gap-2 rounded-xl bg-ink-800 text-sm font-medium text-slate-100 hover:bg-ink-700 disabled:opacity-40">
            {preparing ? <Spinner className="h-4 w-4 text-white" /> : <CloudDownload className="h-4 w-4" />} {manifest ? 'Refresh offline list' : 'Prepare offline mode'}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-ink-900 px-3.5 py-2.5 text-xs text-slate-300">
          <span className="min-w-0">
            <span className="block">{manifest ? `Offline list: ${number(manifest.count)} tickets, downloaded ${relative(manifest.generatedAt)}` : 'Offline list: not downloaded'}</span>
            <span className={cn('block font-semibold', pending ? 'text-amber-300' : 'text-slate-400')}>{pending ? `${pending} scan${pending === 1 ? '' : 's'} waiting to sync` : 'Nothing waiting to sync'}</span>
          </span>
          {pending > 0 && (
            <button onClick={() => void sync()} disabled={syncing || !online} className="flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-amber-400 px-3 text-sm font-semibold text-amber-950 disabled:opacity-50">
              {syncing ? <Spinner className="h-4 w-4 text-amber-950" /> : online ? <RefreshCw className="h-4 w-4" /> : <CloudOff className="h-4 w-4" />} Sync
            </button>
          )}
        </div>
      </div>

      {outcome && (
        <button
          onClick={() => { overlayUntil.current = 0; setOutcome(null); }}
          role="alert"
          aria-live="assertive"
          className={cn('fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center text-white', outcome.admitted ? 'bg-emerald-600' : 'bg-red-700')}
        >
          {outcome.admitted ? <CheckCircle2 className="h-28 w-28" strokeWidth={2.2} /> : <XCircle className="h-28 w-28" strokeWidth={2.2} />}
          <span className="mt-4 text-5xl font-black tracking-tight">{outcome.title}</span>
          <span className="mt-3 max-w-xs text-lg font-medium leading-snug">{outcome.detail}</span>
          {outcome.ticket && (
            <span className="mt-6 w-full max-w-xs rounded-2xl bg-black/20 px-5 py-4">
              <span className="block text-2xl font-bold">{outcome.ticket.category}</span>
              {outcome.ticket.holderName && <span className="mt-1 block text-lg">{outcome.ticket.holderName}</span>}
              <span className="mt-1 block font-mono text-sm opacity-90">{outcome.ticket.reference}{outcome.ticket.brand ? ` · ${outcome.ticket.brand}` : ''}</span>
            </span>
          )}
          {outcome.offline && <span className="mt-4 rounded-full bg-amber-400 px-3 py-1 text-sm font-bold text-amber-950">OFFLINE CHECK</span>}
          <span className="mt-6 text-sm opacity-80">Tap to scan the next ticket</span>
        </button>
      )}

      <Drawer open={historyOpen} onClose={() => setHistoryOpen(false)} title="Your scans for this event">
        {history.loading && <div className="grid place-items-center py-10"><Spinner /></div>}
        {history.error && <p className="text-sm text-red-600">{offline ? 'History is not available offline.' : history.error.message}</p>}
        {history.data && !history.data.length && <p className="py-8 text-center text-sm text-slate-500">No scans yet.</p>}
        <ul className="divide-y divide-slate-100">
          {history.data?.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-900">{h.holderName ?? h.reference ?? 'Unrecognised code'}</div>
                <div className="truncate text-xs text-slate-500">{[h.category, h.reference, h.gate, dateTime(h.scannedAt, 'time')].filter(Boolean).join(' · ')}{h.offline ? ' · offline' : ''}</div>
              </div>
              <StatusBadge status={h.result} />
            </li>
          ))}
        </ul>
        {history.data && <Button variant="secondary" size="sm" onClick={history.reload}>Refresh</Button>}
      </Drawer>
    </div>
  );
}

export default function ScanPage() {
  const { can, user } = useAuth();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = store.get(SESSION_KEY);
      if (saved) setSession(JSON.parse(saved) as Session);
    } catch {
      /* ignore a corrupt saved session */
    }
    setReady(true);
  }, []);

  if (!can('tickets.scan')) {
    const hasPortal = user.permissions.length > 0;
    return (
      <div className="grid min-h-[100dvh] place-items-center bg-ink-950 px-6 text-center text-white">
        <div className="max-w-sm">
          <ShieldAlert className="mx-auto h-12 w-12 text-amber-400" />
          <h1 className="mt-4 text-2xl font-semibold">No scanner access</h1>
          <p className="mt-2 text-slate-300">Your account is not permitted to scan tickets. Ask an administrator for the Ticket Scanner role.</p>
          {hasPortal && <Link href="/" className="mt-6 inline-block rounded-xl bg-accent-600 px-5 py-3 font-semibold">Back to the portal</Link>}
        </div>
      </div>
    );
  }
  if (!ready) return <div className="grid min-h-[100dvh] place-items-center bg-ink-950"><Spinner className="text-slate-400" /></div>;

  return (
    <div className="min-h-[100dvh] bg-ink-950">
      {session ? (
        <Scanner key={session.eventId} session={session} onExit={() => { store.del(SESSION_KEY); setSession(null); }} />
      ) : (
        <SelectEvent onStart={(s) => { store.set(SESSION_KEY, JSON.stringify(s)); setSession(s); }} />
      )}
    </div>
  );
}
