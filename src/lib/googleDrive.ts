import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize Firebase safely (avoid re-initialization)
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
// Google Drive scope for file & folder creation/management
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.setCustomParameters({
  prompt: 'select_account',
  login_hint: 'cast.servicostecnicos@gmail.com',
});

// Flag to track ongoing sign in flow
let isSigningIn = false;
const SESSION_TOKEN_KEY = 'mindoors_gdrive_access_token';
let cachedAccessToken: string | null = null;

export interface DriveAccountInfo {
  email: string;
  name: string;
  photoUrl?: string;
  uid: string;
}

export interface DriveFolderResult {
  id: string;
  name: string;
  webViewLink?: string;
}

export interface DriveUploadResult {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
  webContentLink?: string;
  directStreamLink?: string;
  size?: number;
}

export interface ClientHierarchyStructure {
  rootFolder: DriveFolderResult;
  clientFolder: DriveFolderResult;
  categoryFolders: {
    photos: DriveFolderResult;
    documents: DriveFolderResult;
  };
}

/**
 * Initialize Auth State Listener
 */
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const token = getCachedToken();
      if (token) {
        if (onAuthSuccess) onAuthSuccess(user, token);
      }
    } else {
      setCachedAccessToken(null);
      if (isSigningIn && onAuthFailure) {
        onAuthFailure();
      }
    }
  });
};

/**
 * Convert dataURL (base64) to Blob
 */
export const dataUrlToBlob = (dataUrl: string): Blob => {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
};

export const getDriveAuthFriendlyMessage = (error: any): string => {
  const code = error?.code || '';
  const message = error?.message || '';

  if (code === 'auth/popup-closed-by-user' || message.includes('popup-closed-by-user')) {
    return 'A janela do Google foi fechada antes de concluir o login.';
  }
  if (code === 'auth/popup-blocked' || message.includes('popup-blocked')) {
    return 'O navegador bloqueou a janela pop-up do Google. Permita pop-ups para este site e tente novamente.';
  }
  if (code === 'auth/cancelled-popup-request' || message.includes('cancelled-popup-request')) {
    return 'A solicitação de login foi cancelada.';
  }
  if (code === 'auth/unauthorized-domain' || message.includes('unauthorized-domain')) {
    return 'Domínio não autorizado no Firebase Authentication. Adicione este domínio nas configurações do Firebase.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Erro de rede ao conectar com o Google. Verifique sua conexão com a internet.';
  }
  return message || 'Não foi possível conectar com o Google Drive.';
};

/**
 * Sign In with Google via Popup to choose Google Drive account
 */
export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
} | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Não foi possível obter o token de acesso do Google Drive.');
    }

    cachedAccessToken = credential.accessToken;
    setCachedAccessToken(cachedAccessToken);
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    // If the user closed the popup or it was cancelled, handle gracefully without alarming error
    if (
      error?.code === 'auth/popup-closed-by-user' ||
      error?.code === 'auth/cancelled-popup-request' ||
      error?.message?.includes('popup-closed-by-user')
    ) {
      console.warn('Conexão Google Drive cancelada pelo usuário (janela fechada).');
      return null;
    }

    const friendlyMessage = getDriveAuthFriendlyMessage(error);
    console.warn('Erro ao conectar Google Drive:', friendlyMessage);
    const customErr = new Error(friendlyMessage);
    (customErr as any).code = error?.code;
    throw customErr;
  } finally {
    isSigningIn = false;
  }
};

/**
 * Get current in-memory or session access token
 */
export const getAccessToken = async (): Promise<string | null> => {
  return getCachedToken();
};

export const getCachedToken = (): string | null => {
  if (cachedAccessToken) return cachedAccessToken;
  try {
    const stored = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (stored) {
      cachedAccessToken = stored;
      return stored;
    }
  } catch {}
  return null;
};

export const hasActiveSession = (): boolean => {
  return !!getCachedToken();
};

export const requestGoogleLogin = googleSignIn;

/**
 * Set session access token (in-memory & sessionStorage)
 */
export const setCachedAccessToken = (token: string | null) => {
  cachedAccessToken = token;
  try {
    if (token) {
      sessionStorage.setItem(SESSION_TOKEN_KEY, token);
    } else {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
    }
  } catch {}
};

/**
 * Disconnect Google Drive account
 */
export const logoutGoogle = async () => {
  await signOut(auth);
  setCachedAccessToken(null);
};

// =========================================================================
// GOOGLE DRIVE API v3 HELPER FUNCTIONS
// =========================================================================

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * Search for an existing folder or file by name and parent
 */
export const findDriveFolder = async (
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<DriveFolderResult | null> => {
  let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`;
  if (parentId) {
    query += ` and '${parentId}' in parents`;
  }

  const url = `${DRIVE_API_BASE}?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)&pageSize=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || `Erro ao buscar pasta no Google Drive (${res.status})`
    );
  }

  const data = await res.json();
  if (data.files && data.files.length > 0) {
    return {
      id: data.files[0].id,
      name: data.files[0].name,
      webViewLink: data.files[0].webViewLink,
    };
  }
  return null;
};

/**
 * Create a new folder on Google Drive
 */
export const createDriveFolder = async (
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<DriveFolderResult> => {
  const metadata: { name: string; mimeType: string; parents?: string[] } = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };

  if (parentId) {
    metadata.parents = [parentId];
  }

  const res = await fetch(`${DRIVE_API_BASE}?fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metadata),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || `Erro ao criar pasta no Google Drive (${res.status})`
    );
  }

  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    webViewLink: data.webViewLink,
  };
};

/**
 * Get or Create a folder (avoids duplicates)
 */
export const getOrCreateDriveFolder = async (
  accessToken: string,
  folderName: string,
  parentId?: string
): Promise<DriveFolderResult> => {
  const existing = await findDriveFolder(accessToken, folderName, parentId);
  if (existing) {
    return existing;
  }
  return await createDriveFolder(accessToken, folderName, parentId);
};

/**
 * Automatically builds and ensures the folder hierarchy for a Client (Empresa):
 * 1. Root: [MÍDIA INDOOR - ARQUIVOS DO SISTEMA]
 * 2. Pasta do Cliente: {clientName}
 * 3. Subpastas separadoras por categoria:
 *    - 📸 Fotos com Código Único
 *    - 📄 Documentos e Arquivos
 */
export const ensureClientFolders = async (
  accessToken: string,
  clientName: string,
  customRootName: string = 'MÍDIA INDOOR - ARQUIVOS DO SISTEMA'
): Promise<ClientHierarchyStructure> => {
  // 1. Root folder
  const rootFolder = await getOrCreateDriveFolder(accessToken, customRootName);

  // 2. Pasta direta do Cliente (Empresa)
  const cleanName = (clientName || 'Cliente').trim();
  const clientFolder = await getOrCreateDriveFolder(
    accessToken,
    cleanName,
    rootFolder.id
  );

  // 3. Pastas separadoras por categoria dentro da pasta do cliente
  const [photosFolder, documentsFolder] = await Promise.all([
    getOrCreateDriveFolder(
      accessToken,
      '📸 Fotos com Código Único',
      clientFolder.id
    ),
    getOrCreateDriveFolder(
      accessToken,
      '📄 Documentos e Arquivos',
      clientFolder.id
    ),
  ]);

  return {
    rootFolder,
    clientFolder,
    categoryFolders: {
      photos: photosFolder,
      documents: documentsFolder,
    },
  };
};

export const ensureClientHierarchy = async (
  accessToken: string,
  companyName: string,
  _ignoredSubClientName?: string,
  customRootName?: string
): Promise<ClientHierarchyStructure> => {
  return ensureClientFolders(accessToken, companyName, customRootName);
};

/**
 * Upload a file directly to Google Drive into a designated folder with custom metadata
 */
export const uploadFileToDrive = async (
  accessToken: string,
  file: File | Blob,
  fileName: string,
  folderId: string,
  options?:
    | {
        description?: string;
        uniqueCode?: string;
      }
    | string
): Promise<DriveUploadResult> => {
  const desc =
    typeof options === 'string'
      ? options
      : options?.description || `Código Único: ${options?.uniqueCode || 'N/A'}`;

  const metadata = {
    name: fileName,
    parents: [folderId],
    description: desc,
  };

  const formData = new FormData();
  formData.append(
    'metadata',
    new Blob([JSON.stringify(metadata)], { type: 'application/json' })
  );
  formData.append('file', file);

  const url = `${DRIVE_UPLOAD_BASE}?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink,size`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || `Erro ao enviar arquivo para o Google Drive (${res.status})`
    );
  }

  const data = await res.json();

  // Set file as public reader so screens and TVs can display it directly
  await makeDriveFilePublic(accessToken, data.id).catch(() => {});

  const directStreamLink = getDriveDirectStreamUrl(data.id);

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    webContentLink: data.webContentLink,
    directStreamLink,
    size: data.size ? Number(data.size) : undefined,
  };
};

/**
 * Returns direct streaming URL for Google Drive media files
 */
export const getDriveDirectStreamUrl = (fileId: string): string => {
  return `https://lh3.googleusercontent.com/d/${fileId}`;
};

/**
 * Resolves any Google Drive web or view link to a direct streaming/image CDN URL.
 * Supports file/d/ID, open?id=ID, uc?id=ID, and passes other URLs intact.
 */
export const resolveMediaDisplayUrl = (url: string | undefined | null): string => {
  if (!url) return '';
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('widget:') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  // Local uploads when frontend is running on a separated static site
  if (trimmed.startsWith('/uploads/')) {
    const backendBase = import.meta.env.VITE_API_BASE_URL as string | undefined;
    if (backendBase && backendBase.startsWith('http')) {
      const origin = backendBase.replace(/\/api\/?$/, '');
      return `${origin}${trimmed}`;
    }
    return trimmed;
  }

  // Already a direct lh3 googleusercontent URL
  if (trimmed.includes('lh3.googleusercontent.com/d/')) {
    return trimmed;
  }

  // Google Drive standard links
  if (trimmed.includes('drive.google.com') || trimmed.includes('docs.google.com')) {
    const fileIdMatch =
      trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) ||
      trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
      trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (fileIdMatch && fileIdMatch[1]) {
      return `https://lh3.googleusercontent.com/d/${fileIdMatch[1]}`;
    }
  }

  return trimmed;
};

/**
 * Makes a Google Drive file accessible with public view permissions
 */
export const makeDriveFilePublic = async (
  accessToken: string,
  fileId: string
): Promise<boolean> => {
  try {
    const url = `${DRIVE_API_BASE}/${fileId}/permissions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role: 'reader',
        type: 'anyone',
      }),
    });
    return res.ok;
  } catch (err) {
    console.warn('[Google Drive] Could not set public permission:', err);
    return false;
  }
};

/**
 * List files inside a specific Google Drive folder
 */
export const listDriveFolderFiles = async (
  accessToken: string,
  folderId: string
): Promise<any[]> => {
  const query = `'${folderId}' in parents and trashed=false`;
  const url = `${DRIVE_API_BASE}?q=${encodeURIComponent(
    query
  )}&fields=files(id,name,mimeType,webViewLink,webContentLink,thumbnailLink,size,createdTime,description)&pageSize=100`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || `Erro ao listar arquivos do Google Drive (${res.status})`
    );
  }

  const data = await res.json();
  return data.files || [];
};

/**
 * Delete a file from Google Drive (Mandatory user confirmation handled by caller or dialog)
 */
export const deleteDriveFile = async (
  accessToken: string,
  fileId: string
): Promise<boolean> => {
  const url = `${DRIVE_API_BASE}/${fileId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(
      errorData.error?.message || `Erro ao excluir arquivo do Google Drive (${res.status})`
    );
  }

  return true;
};

/**
 * Extracts Google Drive File ID from URL
 */
export const extractDriveFileId = (url: string | undefined): string | null => {
  if (!url) return null;
  const lh3Match = url.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/);
  if (lh3Match && lh3Match[1]) return lh3Match[1];

  const driveFileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveFileMatch && driveFileMatch[1]) return driveFileMatch[1];

  const idParamMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParamMatch && idParamMatch[1]) return idParamMatch[1];

  return null;
};

/**
 * Checks a specific file in Google Drive to verify if it is active, trashed or missing
 */
export const verifyDriveFileStatus = async (
  accessToken: string,
  fileId: string
): Promise<{
  accessible: boolean;
  status: 'ok' | 'trashed' | 'not_found' | 'permission_denied' | 'error';
  name?: string;
  size?: number;
  message: string;
}> => {
  try {
    const url = `${DRIVE_API_BASE}/${fileId}?fields=id,name,trashed,size,mimeType,shared`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (res.ok) {
      const data = await res.json();
      if (data.trashed) {
        return {
          accessible: false,
          status: 'trashed',
          name: data.name,
          message: 'Arquivo foi movido para a Lixeira do Google Drive.',
        };
      }
      return {
        accessible: true,
        status: 'ok',
        name: data.name,
        size: data.size ? Number(data.size) : undefined,
        message: 'Arquivo ativo e íntegro no Google Drive.',
      };
    }

    if (res.status === 404) {
      return {
        accessible: false,
        status: 'not_found',
        message: 'Arquivo não encontrado ou excluído do Google Drive.',
      };
    }

    if (res.status === 403) {
      return {
        accessible: false,
        status: 'permission_denied',
        message: 'Acesso negado: permissões insuficientes ou link revogado no Google Drive.',
      };
    }

    return {
      accessible: false,
      status: 'error',
      message: `Google Drive respondeu com status ${res.status}.`,
    };
  } catch (err: any) {
    return {
      accessible: false,
      status: 'error',
      message: err.message || 'Erro ao conectar com Google Drive.',
    };
  }
};

