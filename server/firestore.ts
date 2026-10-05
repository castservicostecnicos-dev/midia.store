import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc, setLogLevel, Firestore } from 'firebase/firestore';
import fs from 'fs';
import path from 'path';

// Silence benign internal @firebase/firestore gRPC idle stream disconnect messages in Node.js
setLogLevel('silent');

let firestoreInstance: Firestore | null = null;
let lastSyncTimestamp: string | null = null;
let lastSyncError: string | null = null;
let isSyncing = false;
let isSyncEnabled = false;
let pendingDataToSync: any = null;
let syncDebounceTimer: NodeJS.Timeout | null = null;

export interface FirebaseConfigShape {
  projectId: string;
  apiKey: string;
  appId?: string;
  authDomain?: string;
  firestoreDatabaseId?: string;
}

export type FirestoreLoadResult =
  | { status: 'found'; data: any }
  | { status: 'not_found' }
  | { status: 'error'; error: string }
  | { status: 'unconfigured' };

/**
 * Retrieve Firebase credentials from file or environment variables
 */
export function getFirebaseConfig(): FirebaseConfigShape | null {
  // 1. Try firebase-applet-config.json file
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.projectId && config.apiKey) {
        return config;
      }
    } catch (e: any) {
      console.warn('[Firebase] Error reading firebase-applet-config.json:', e?.message || e);
    }
  }

  // 2. Try FIREBASE_CONFIG or FIREBASE_CONFIG_JSON env vars
  const envJson = process.env.FIREBASE_CONFIG || process.env.FIREBASE_CONFIG_JSON;
  if (envJson) {
    try {
      const config = JSON.parse(envJson);
      if (config.projectId && config.apiKey) {
        return config;
      }
    } catch (e: any) {
      console.warn('[Firebase] Error parsing FIREBASE_CONFIG env var:', e?.message || e);
    }
  }

  // 3. Try individual env variables
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_API_KEY) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      apiKey: process.env.FIREBASE_API_KEY,
      appId: process.env.FIREBASE_APP_ID || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID}.firebaseapp.com`,
      firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || 'ai-studio-mdiaindoorinterl-1935d034-8db3-4c85-92b4-7fdc30c577b5',
    };
  }

  return null;
}

export function getFirestoreDb(): Firestore | null {
  if (firestoreInstance) {
    return firestoreInstance;
  }

  try {
    const config = getFirebaseConfig();
    if (!config) {
      console.warn('[Firebase] No Firebase credentials found in file or environment variables.');
      return null;
    }

    const app = getApps().length > 0
      ? getApp()
      : initializeApp({
          projectId: config.projectId,
          apiKey: config.apiKey,
          appId: config.appId,
          authDomain: config.authDomain,
        });

    firestoreInstance = config.firestoreDatabaseId
      ? getFirestore(app, config.firestoreDatabaseId)
      : getFirestore(app);

    console.log(`[Firebase Firestore] Connected to project: ${config.projectId} (${config.firestoreDatabaseId || 'default'})`);
    return firestoreInstance;
  } catch (err: any) {
    console.error('[Firebase Firestore] Failed to initialize Firestore:', err?.message || err);
    lastSyncError = err?.message || 'Initialization failed';
    return null;
  }
}

/**
 * Enable live two-way sync after server boot completes
 */
export function enableFirestoreSync() {
  isSyncEnabled = true;
  console.log('[Firebase Firestore] Live synchronization is now ACTIVE.');
}

/**
 * Load database snapshot from Firebase Firestore with explicit status
 */
export async function loadDatabaseFromFirestore(): Promise<FirestoreLoadResult> {
  const db = getFirestoreDb();
  if (!db) {
    return { status: 'unconfigured' };
  }

  try {
    const targetDoc = doc(db, 'app_data', 'indoor_media_db');
    const snap = await Promise.race([
      getDoc(targetDoc),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Firestore read timeout after 5s')), 5000)
      ),
    ]);

    if (!snap.exists()) {
      console.log('[Firebase Firestore] Document app_data/indoor_media_db does not exist yet (first initialization).');
      return { status: 'not_found' };
    }

    const docData = snap.data();
    if (!docData || !docData.data) {
      console.warn('[Firebase Firestore] Snapshot document is empty.');
      return { status: 'not_found' };
    }

    const parsed = JSON.parse(docData.data);
    lastSyncTimestamp = docData.updated_at || new Date().toISOString();
    console.log(`[Firebase Firestore] Successfully retrieved data snapshot! Companies: ${parsed.companies?.length || 0}, Players: ${parsed.players?.length || 0}, Users: ${parsed.users?.length || 0}`);
    return { status: 'found', data: parsed };
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('[Firebase Firestore] Error reading from Firestore:', msg);
    lastSyncError = msg;
    return { status: 'error', error: msg };
  }
}

/**
 * Save database snapshot directly to Firebase Firestore
 */
export async function saveDatabaseToFirestoreNow(data: any): Promise<boolean> {
  const db = getFirestoreDb();
  if (!db) return false;

  // Safety validation: verify minimum database structure to prevent accidental empty overwrites
  if (!data || !Array.isArray(data.users) || !data.users.some((u: any) => u.role === 'admin')) {
    console.error('[Firebase Firestore] ABORTED save to Firestore: data is invalid or missing required admin user!');
    return false;
  }

  try {
    const targetDoc = doc(db, 'app_data', 'indoor_media_db');
    const sanitized = JSON.parse(JSON.stringify(data));
    const now = new Date().toISOString();

    await setDoc(targetDoc, {
      version: 1,
      updated_at: now,
      stats: {
        companies: sanitized.companies?.length || 0,
        players: sanitized.players?.length || 0,
        users: sanitized.users?.length || 0,
        playlists: sanitized.playlists?.length || 0,
        media: sanitized.media?.length || 0,
      },
      data: JSON.stringify(sanitized),
    });

    lastSyncTimestamp = now;
    lastSyncError = null;
    console.log(`[Firebase Firestore] Database synced successfully at ${now} (Companies: ${sanitized.companies?.length || 0})`);
    return true;
  } catch (err: any) {
    console.error('[Firebase Firestore] Failed to save database to Firestore:', err?.message || err);
    lastSyncError = err?.message || 'Failed to save to Firestore';
    return false;
  }
}

/**
 * Queue debounced background sync to Firestore
 */
export function queueFirestoreSync(data: any) {
  if (!isSyncEnabled) {
    console.log('[Firebase Firestore] Sync is paused during initial startup.');
    return;
  }

  pendingDataToSync = data;

  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }

  syncDebounceTimer = setTimeout(async () => {
    if (isSyncing || !pendingDataToSync) return;

    isSyncing = true;
    const toSave = pendingDataToSync;
    pendingDataToSync = null;

    try {
      await saveDatabaseToFirestoreNow(toSave);
    } finally {
      isSyncing = false;
      // If new data arrived while saving, trigger another sync
      if (pendingDataToSync && isSyncEnabled) {
        queueFirestoreSync(pendingDataToSync);
      }
    }
  }, 1000);
}

export function getFirestoreSyncStatus() {
  const isConfigured = !!getFirestoreDb();
  return {
    configured: isConfigured,
    provider: 'Firebase Firestore',
    lastSyncTimestamp,
    lastSyncError,
    isSyncing,
    isSyncEnabled,
  };
}
