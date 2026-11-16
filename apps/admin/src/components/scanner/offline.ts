/**
 * Offline support for the gate scanner.
 *
 * Strategy for duplicate entry:
 *  1. Before going offline the device downloads a manifest: SHA-256 hashes of the event's live
 *     QR tokens with their status. Hashes cannot be turned back into working QR codes.
 *  2. Offline, a scanned code is hashed and looked up. It is admitted only if the manifest says
 *     VALID and this device has not already admitted it. It is marked used locally at once.
 *  3. Every offline admission is queued durably (IndexedDB) with a unique clientScanId and the
 *     time it happened.
 *  4. When the connection returns the queue is sent to /v1/scanner/sync. The server applies the
 *     scans in time order; any ticket that had already been used elsewhere comes back as
 *     OFFLINE_CONFLICT and raises an alert for a supervisor.
 *
 * Limitation (always shown to staff while offline): this device cannot see scans from other
 * gates, or refunds made after the manifest was downloaded, until it syncs.
 */

export interface ManifestTicket {
  /** SHA-256 hex of the QR text. */
  h: string;
  /** Ticket reference. */
  r: string;
  /** Category name. */
  c: string;
  /** Status when downloaded: VALID | USED. */
  s: string;
  /** Holder name. */
  n: string | null;
}
export interface Manifest {
  eventId: string;
  eventName: string;
  generatedAt: string;
  tickets: ManifestTicket[];
}
export interface QueuedScan {
  clientScanId: string;
  eventId: string;
  token: string;
  scannedAt: string;
  gate?: string;
}

const DB = 'ctp-scanner';
const STORE = 'kv';
const memory = new Map<string, unknown>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function read<T>(key: string): Promise<T | undefined> {
  if (memory.has(key)) return memory.get(key) as T;
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        if (req.result !== undefined) memory.set(key, req.result);
        resolve(req.result as T | undefined);
      };
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Writes to memory first (so the running session is always right) and then to IndexedDB. */
async function write(key: string, value: unknown): Promise<boolean> {
  memory.set(key, value);
  const db = await open();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** True when scans survive a page reload or a closed browser. */
export async function isDurable(): Promise<boolean> {
  return !!(await open());
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const index = new Map<string, Map<string, ManifestTicket>>();

export async function saveManifest(m: Manifest): Promise<void> {
  index.set(m.eventId, new Map(m.tickets.map((t) => [t.h, t])));
  await write(`manifest:${m.eventId}`, m);
}

export async function loadManifest(eventId: string): Promise<{ generatedAt: string; count: number } | null> {
  const m = await read<Manifest>(`manifest:${eventId}`);
  if (!m) return null;
  if (!index.has(eventId)) index.set(eventId, new Map(m.tickets.map((t) => [t.h, t])));
  return { generatedAt: m.generatedAt, count: m.tickets.length };
}

export function lookup(eventId: string, hash: string): ManifestTicket | undefined {
  return index.get(eventId)?.get(hash);
}

// ── Tickets this device has already admitted (online or offline) ──
export async function usedOnDevice(eventId: string): Promise<Set<string>> {
  return new Set((await read<string[]>(`used:${eventId}`)) ?? []);
}
export async function markUsed(eventId: string, hash: string): Promise<void> {
  const set = await usedOnDevice(eventId);
  if (set.has(hash)) return;
  set.add(hash);
  await write(`used:${eventId}`, [...set]);
}

// ── Queue of offline admissions waiting to be synced ──
export async function queue(): Promise<QueuedScan[]> {
  return (await read<QueuedScan[]>('queue')) ?? [];
}
export async function enqueue(scan: QueuedScan): Promise<number> {
  const q = [...(await queue()), scan];
  await write('queue', q);
  return q.length;
}
export async function dequeue(clientScanIds: string[]): Promise<number> {
  const drop = new Set(clientScanIds);
  const q = (await queue()).filter((s) => !drop.has(s.clientScanId));
  await write('queue', q);
  return q.length;
}
