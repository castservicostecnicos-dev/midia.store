import React, { useState, useEffect } from 'react';
import {
  Folder,
  FileText,
  Camera,
  UploadCloud,
  ExternalLink,
  RefreshCw,
  Search,
  Plus,
  Edit2,
  Trash2,
  Copy,
  Check,
  Building2,
  ChevronRight,
  ChevronDown,
  Sparkles,
  Download,
  LogOut,
  X,
  AlertCircle,
  HelpCircle,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import { Company, DriveDocument, DriveCategory, DriveSettings } from '../types';
import {
  initAuth,
  requestGoogleLogin,
  logoutGoogle,
  ensureClientFolders,
  uploadFileToDrive,
  deleteDriveFile,
  getCachedToken,
  hasActiveSession,
} from '../lib/googleDrive';

interface GoogleDriveFileManagerProps {
  companies: Company[];
  currentCompanyId?: string;
  isDevAdmin?: boolean;
  showToast: (type: 'success' | 'error' | 'info', message: string) => void;
}

export const GoogleDriveFileManager: React.FC<GoogleDriveFileManagerProps> = ({
  companies,
  currentCompanyId,
  isDevAdmin = false,
  showToast,
}) => {
  // Google Drive Auth & Settings State
  const [driveSettings, setDriveSettings] = useState<DriveSettings>({
    connected: false,
    account_email: 'cast.servicostecnicos@gmail.com',
    account_name: 'Cast Serviços Técnicos',
    root_folder_name: 'MÍDIA INDOOR - ARQUIVOS DO SISTEMA',
  });
  const [isConnectingDrive, setIsConnectingDrive] = useState(false);
  const [hasTokenInMemory, setHasTokenInMemory] = useState(false);

  // Selected Company / Client Filter
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(
    currentCompanyId || 'all'
  );

  // Data State
  const [documents, setDocuments] = useState<DriveDocument[]>([]);
  const [loading, setLoading] = useState(true);

  // Filter & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  // Upload Modal State
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<string | null>(null);
  const [uploadTargetCompanyId, setUploadTargetCompanyId] = useState<string>(
    currentCompanyId || companies[0]?.id || ''
  );
  const [uploadCategory, setUploadCategory] = useState<DriveCategory>('photo');
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadDescription, setUploadDescription] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // Document Edit Modal
  const [editDocModalOpen, setEditDocModalOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<DriveDocument | null>(null);
  const [docEditForm, setDocEditForm] = useState<{
    title: string;
    description: string;
    category: DriveCategory;
    status: 'draft' | 'approved' | 'in_progress' | 'completed';
    company_id: string;
  }>({
    title: '',
    description: '',
    category: 'photo',
    status: 'completed',
    company_id: '',
  });

  // Hierarchy Sync State
  const [isSyncingHierarchy, setIsSyncingHierarchy] = useState(false);

  // Copied code feedback
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Confirmation Modal
  const [confirmData, setConfirmData] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    action: () => void;
  }>({
    isOpen: false,
    title: '',
    message: '',
    action: () => {},
  });

  // Tree View Expand / Collapse
  const [treeExpanded, setTreeExpanded] = useState(true);
  const [renderHelpModalOpen, setRenderHelpModalOpen] = useState(false);

  // Load Settings & Documents
  const loadData = async () => {
    try {
      setLoading(true);
      const [settingsRes, docsRes] = await Promise.all([
        api.getDriveSettings().catch(() => ({ status: 'ok', settings: driveSettings })),
        api.getDriveDocuments({
          companyId: !isDevAdmin && currentCompanyId ? currentCompanyId : undefined,
        }).catch(() => ({ status: 'ok', documents: [] })),
      ]);

      if (settingsRes.settings) {
        setDriveSettings(settingsRes.settings);
      }
      if (docsRes.documents) {
        setDocuments(docsRes.documents);
      }
      setHasTokenInMemory(hasActiveSession());
    } catch (err: any) {
      console.error('Error loading Drive manager data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    // Listen for OAuth callbacks
    initAuth(
      (user, token) => {
        setHasTokenInMemory(true);
        const updated = {
          connected: true,
          account_email: user.email || undefined,
          account_name: user.displayName || undefined,
          account_photo: user.photoURL || undefined,
          access_token: token,
          token_expiry: Date.now() + 3500 * 1000,
        };
        setDriveSettings((prev) => ({ ...prev, ...updated }));
        api.updateDriveSettings(updated).catch(() => {});
        showToast('success', `Google Drive conectado com sucesso: ${user.email}`);
      },
      () => {
        setIsConnectingDrive(false);
      }
    );
  }, [currentCompanyId]);

  // Handle Google Login / Account Selection
  const handleConnectGoogleDrive = async () => {
    try {
      setIsConnectingDrive(true);
      const res = await requestGoogleLogin();
      if (!res) {
        // User closed the popup, cancel without error
        return;
      }
      if (res.accessToken && res.user) {
        setHasTokenInMemory(true);
        const updated = {
          connected: true,
          account_email: res.user.email || undefined,
          account_name: res.user.displayName || undefined,
          account_photo: res.user.photoURL || undefined,
          access_token: res.accessToken,
          token_expiry: Date.now() + 3500 * 1000,
        };
        setDriveSettings((prev) => ({ ...prev, ...updated }));
        await api.updateDriveSettings(updated).catch(() => {});
        showToast('success', `Conta Google central vinculada com sucesso: ${res.user.email}!`);
        // Pre-create folder hierarchy for companies
        setTimeout(() => {
          handleSyncAllClientFolders();
        }, 500);
      }
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user' && !err?.message?.includes('popup-closed-by-user')) {
        showToast('error', err.message || 'Falha ao conectar conta Google.');
      }
    } finally {
      setIsConnectingDrive(false);
    }
  };

  const handleDisconnectDrive = () => {
    setConfirmData({
      isOpen: true,
      title: 'Desconectar Google Drive',
      message:
        'Deseja desconectar a conta do Google Drive atual? Você poderá reconectar ou escolher outra conta a qualquer momento.',
      action: async () => {
        logoutGoogle();
        setHasTokenInMemory(false);
        const updated: Partial<DriveSettings> = {
          connected: false,
          account_email: undefined,
          account_name: undefined,
          account_photo: undefined,
        };
        setDriveSettings((prev) => ({ ...prev, ...updated }));
        await api.updateDriveSettings(updated);
        showToast('info', 'Conta do Google Drive desconectada.');
        setConfirmData((p) => ({ ...p, isOpen: false }));
      },
    });
  };

  // Sync / Ensure folders on Google Drive for all Clients (Empresas)
  const handleSyncAllClientFolders = async () => {
    const token = getCachedToken();
    if (!token) {
      showToast('error', 'Faça login no Google Drive primeiro para sincronizar as pastas.');
      handleConnectGoogleDrive();
      return;
    }

    const clientsToSync = isDevAdmin
      ? companies
      : companies.filter((c) => c.id === currentCompanyId);

    if (clientsToSync.length === 0) {
      showToast('info', 'Nenhum cliente disponível para sincronizar.');
      return;
    }

    try {
      setIsSyncingHierarchy(true);
      showToast('info', `Criando estrutura no Google Drive para ${clientsToSync.length} cliente(s)...`);

      let rootFolderUrl = '';

      for (const client of clientsToSync) {
        const clientName = client.trade_name || client.legal_name || 'Cliente';
        const structure = await ensureClientFolders(
          token,
          clientName,
          driveSettings.root_folder_name
        );
        rootFolderUrl = structure.rootFolder.webViewLink;

        // Persist folder link in company record if updated
        if (!client.drive_folder_id || client.drive_folder_id !== structure.clientFolder.id) {
          await api.updateCompany(client.id, {
            drive_folder_id: structure.clientFolder.id,
            drive_folder_url: structure.clientFolder.webViewLink,
          }).catch(() => {});
        }
      }

      // Update Drive Settings with root folder info
      const settingsUpdate = {
        root_folder_url: rootFolderUrl,
        last_synced_at: new Date().toISOString(),
      };
      setDriveSettings((prev) => ({ ...prev, ...settingsUpdate }));
      await api.updateDriveSettings(settingsUpdate);

      showToast(
        'success',
        `Pastas organizadas no Drive com sucesso! Cada cliente possui suas subpastas de Fotos com Código Único e Documentos.`
      );
      loadData();
    } catch (err: any) {
      console.error('Sync error:', err);
      showToast('error', `Erro ao sincronizar pastas no Drive: ${err.message}`);
    } finally {
      setIsSyncingHierarchy(false);
    }
  };

  // Upload File directly to Google Drive in the respective category folder
  const handleUploadToDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!uploadFile) {
      showToast('error', 'Selecione um arquivo ou foto para enviar.');
      return;
    }

    const token = getCachedToken();
    if (!token) {
      showToast('error', 'Conecte o Google Drive antes de realizar o envio.');
      handleConnectGoogleDrive();
      return;
    }

    const targetCompany = companies.find((c) => c.id === uploadTargetCompanyId);
    if (!targetCompany) {
      showToast('error', 'Selecione um cliente válido.');
      return;
    }

    try {
      setIsUploading(true);

      // 1. Ensure folder structure on Drive: Root -> [Nome do Cliente] -> [Fotos / Documentos]
      const clientName = targetCompany.trade_name || targetCompany.legal_name || 'Cliente';
      const structure = await ensureClientFolders(
        token,
        clientName,
        driveSettings.root_folder_name
      );

      // Determine category folder on Drive and code prefix
      let targetFolder = structure.categoryFolders.documents;
      let prefix = 'DOC';
      if (uploadCategory === 'photo') {
        targetFolder = structure.categoryFolders.photos;
        prefix = 'FOTO';
      }

      // Generate Unique Code (e.g., FOTO-DRO-3F8E)
      const randHash = Math.random().toString(36).substring(2, 6).toUpperCase();
      const cliCode = targetCompany.trade_name
        ? targetCompany.trade_name.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'CLI')
        : 'CLI';
      const uniqueCode = `${prefix}-${cliCode}-${randHash}`;

      // 2. Upload file directly to Drive
      const sanitizedFileName = `${uniqueCode}_${uploadFile.name.replace(/\s+/g, '_')}`;
      const uploadRes = await uploadFileToDrive(
        token,
        uploadFile,
        sanitizedFileName,
        targetFolder.id,
        uploadDescription || `Arquivo vinculado ao cliente ${clientName} com código único ${uniqueCode}`
      );

      // 3. Save Document in DB
      await api.createDriveDocument({
        unique_code: uniqueCode,
        company_id: targetCompany.id,
        category: uploadCategory,
        title: uploadTitle.trim() || uploadFile.name,
        description: uploadDescription.trim(),
        file_name: uploadFile.name,
        file_size: uploadFile.size,
        mime_type: uploadFile.type,
        drive_file_id: uploadRes.id,
        drive_folder_id: targetFolder.id,
        drive_view_url: uploadRes.webViewLink,
        drive_download_url: uploadRes.webContentLink,
        status: 'completed',
      });

      // Update company folder URL if not yet set
      if (!targetCompany.drive_folder_url) {
        await api.updateCompany(targetCompany.id, {
          drive_folder_id: structure.clientFolder.id,
          drive_folder_url: structure.clientFolder.webViewLink,
        }).catch(() => {});
      }

      showToast(
        'success',
        `Arquivo salvo no Google Drive com sucesso! Código único: ${uniqueCode}`
      );

      // Reset modal
      setUploadModalOpen(false);
      setUploadFile(null);
      setFilePreview(null);
      setUploadTitle('');
      setUploadDescription('');
      loadData();
    } catch (err: any) {
      console.error('Upload to Drive error:', err);
      showToast('error', `Erro ao enviar arquivo para o Drive: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Edit Document metadata / details
  const handleOpenEditDoc = (doc: DriveDocument) => {
    setEditingDoc(doc);
    setDocEditForm({
      title: doc.title,
      description: doc.description || '',
      category: doc.category,
      status: doc.status,
      company_id: doc.company_id,
    });
    setEditDocModalOpen(true);
  };

  const handleSaveDocEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDoc) return;

    try {
      await api.updateDriveDocument(editingDoc.id, {
        title: docEditForm.title.trim(),
        description: docEditForm.description.trim(),
        category: docEditForm.category,
        status: docEditForm.status,
        company_id: docEditForm.company_id,
      });

      showToast('success', 'Documento atualizado com sucesso!');
      setEditDocModalOpen(false);
      setEditingDoc(null);
      loadData();
    } catch (err: any) {
      showToast('error', `Erro ao atualizar documento: ${err.message}`);
    }
  };

  // Delete Document (DB + Google Drive)
  const handleDeleteDocument = (doc: DriveDocument) => {
    setConfirmData({
      isOpen: true,
      title: 'Excluir Arquivo / Foto',
      message: `Tem certeza que deseja excluir o item "${doc.title}" (${doc.unique_code})? Ele será removido do sistema e da pasta correspondente no Google Drive.`,
      action: async () => {
        try {
          // Delete from Google Drive if token available
          const token = getCachedToken();
          if (token && doc.drive_file_id) {
            await deleteDriveFile(token, doc.drive_file_id).catch((e) =>
              console.warn('Drive file deletion warning:', e)
            );
          }

          // Delete from DB
          await api.deleteDriveDocument(doc.id);
          showToast('success', `Documento ${doc.unique_code} excluído com sucesso.`);
          setConfirmData((p) => ({ ...p, isOpen: false }));
          loadData();
        } catch (err: any) {
          showToast('error', `Erro ao excluir documento: ${err.message}`);
        }
      },
    });
  };

  // Copy code helper
  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(code);
    showToast('info', `Código único copiado: ${code}`);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  // Filtered Documents
  const filteredDocuments = documents.filter((doc) => {
    // Company / Client filter
    if (selectedCompanyId !== 'all' && doc.company_id !== selectedCompanyId) {
      return false;
    }

    // Category filter
    if (selectedCategory !== 'all' && doc.category !== selectedCategory) {
      return false;
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const comp = companies.find((c) => c.id === doc.company_id);
      const matchCode = doc.unique_code?.toLowerCase().includes(q);
      const matchTitle = doc.title?.toLowerCase().includes(q);
      const matchDesc = doc.description?.toLowerCase().includes(q);
      const matchFile = doc.file_name?.toLowerCase().includes(q);
      const matchClient =
        comp?.trade_name?.toLowerCase().includes(q) ||
        comp?.legal_name?.toLowerCase().includes(q);
      if (!matchCode && !matchTitle && !matchDesc && !matchFile && !matchClient) {
        return false;
      }
    }

    return true;
  });

  const activeCompany = companies.find((c) => c.id === selectedCompanyId);
  const totalPhotos = documents.filter((d) => d.category === 'photo').length;
  const totalDocs = documents.filter((d) => d.category === 'document').length;

  return (
    <div className="space-y-6 animate-fade-in text-slate-100">
      {/* ========================================================================= */}
      {/* 1. CABEÇALHO DO GOOGLE DRIVE: CONEXÃO, CONTA E SINCRONIZAÇÃO              */}
      {/* ========================================================================= */}
      <div className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-800 p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-blue-600/5 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div className="flex items-start gap-4">
            <div className="p-3.5 rounded-2xl bg-blue-600/20 text-blue-400 border border-blue-500/30 shrink-0">
              <Folder className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-xl font-black text-white tracking-tight">
                Google Drive
              </h2>
            </div>
          </div>

          {/* Account Status and Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 shrink-0">
            {driveSettings.connected && driveSettings.account_email ? (
              <div className="flex items-center gap-3 bg-slate-800/80 border border-slate-700/60 p-2 pl-3 rounded-2xl">
                {driveSettings.account_photo ? (
                  <img
                    src={driveSettings.account_photo}
                    alt="Avatar"
                    referrerPolicy="no-referrer"
                    className="w-8 h-8 rounded-full border border-blue-400/40 object-cover"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-blue-600/30 text-blue-300 flex items-center justify-center font-bold text-xs">
                    {driveSettings.account_name?.substring(0, 2).toUpperCase() || 'GD'}
                  </div>
                )}
                <div className="text-left pr-2">
                  <div className="text-xs font-bold text-white flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span>{driveSettings.account_name || 'Conta Conectada'}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 font-mono">
                    {driveSettings.account_email}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleConnectGoogleDrive}
                  disabled={isConnectingDrive}
                  title="Reconectar / Atualizar token da conta Google"
                  className="p-2 rounded-xl bg-slate-700/60 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors text-xs font-semibold cursor-pointer"
                >
                  <RefreshCw className={`w-4 h-4 ${isConnectingDrive ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={handleDisconnectDrive}
                  title="Desconectar Drive"
                  className="p-2 rounded-xl bg-rose-900/30 hover:bg-rose-900/50 text-rose-300 hover:text-rose-200 transition-colors cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleConnectGoogleDrive}
                disabled={isConnectingDrive}
                className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-bold uppercase tracking-wider shadow-lg shadow-blue-500/20 transition-all cursor-pointer"
              >
                {isConnectingDrive ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Conectando...</span>
                  </>
                ) : (
                  <>
                    <Folder className="w-4 h-4" />
                    <span>Conectar Conta Google Central</span>
                  </>
                )}
              </button>
            )}

            {/* Sync Folders on Drive Button */}
            <button
              type="button"
              onClick={handleSyncAllClientFolders}
              disabled={isSyncingHierarchy}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-slate-700 hover:border-slate-600 bg-slate-800/80 hover:bg-slate-800 text-slate-200 hover:text-white text-xs font-bold uppercase tracking-wider transition-all cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncingHierarchy ? 'animate-spin text-blue-400' : 'text-slate-400'}`} />
              <span>Sincronizar Pastas</span>
            </button>

            {/* Open Root Folder in Drive */}
            {driveSettings.root_folder_url && (
              <a
                href={driveSettings.root_folder_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl border border-blue-500/40 bg-blue-600/10 hover:bg-blue-600/20 text-blue-300 text-xs font-bold uppercase tracking-wider transition-all"
              >
                <span>Pasta Raiz</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Status Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 pt-5 border-t border-slate-800/80 text-xs">
          <div>
            <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
              Meus Clientes
            </span>
            <span className="text-lg font-extrabold text-white mt-0.5 block">
              {companies.length} empresa(s)
            </span>
          </div>

          <div>
            <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
              Fotos com Código
            </span>
            <span className="text-lg font-extrabold text-pink-400 mt-0.5 block">
              {totalPhotos} foto(s)
            </span>
          </div>

          <div>
            <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
              Documentos & Arquivos
            </span>
            <span className="text-lg font-extrabold text-blue-400 mt-0.5 block">
              {totalDocs} arquivo(s)
            </span>
          </div>

          <div>
            <span className="text-[10px] uppercase font-bold text-slate-400 block tracking-wider">
              Status do Drive
            </span>
            <span
              className={`inline-flex items-center gap-1.5 text-xs font-bold mt-1 ${
                hasTokenInMemory
                  ? 'text-emerald-400'
                  : driveSettings.connected
                  ? 'text-amber-400'
                  : 'text-slate-500'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  hasTokenInMemory
                    ? 'bg-emerald-400 animate-pulse'
                    : driveSettings.connected
                    ? 'bg-amber-400'
                    : 'bg-slate-600'
                }`}
              />
              {hasTokenInMemory
                ? 'Sessão Ativa & Pronta'
                : driveSettings.connected
                ? 'Conectado (clique para autorizar envio)'
                : 'Aguardando Login'}
            </span>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. ÁRVORE VISUAL DO DRIVE (Root -> [Nome do Cliente] -> Pastas)           */}
      {/* ========================================================================= */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setTreeExpanded(!treeExpanded)}
            className="flex items-center gap-2 text-left font-bold text-sm text-white hover:text-blue-400 transition-colors"
          >
            {treeExpanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
            <Folder className="w-4 h-4 text-blue-400" />
            <span>Pastas no Google Drive</span>
          </button>
        </div>

        {treeExpanded && (
          <div className="bg-slate-950/60 rounded-xl p-4 border border-slate-800/80 font-mono text-xs text-slate-300 space-y-2">
            {/* Root */}
            <div className="flex items-center gap-2 font-bold text-blue-400">
              <Folder className="w-4 h-4 text-blue-400" />
              <span>📁 {driveSettings.root_folder_name || 'MÍDIA INDOOR - ARQUIVOS DO SISTEMA'}</span>
              <span className="text-[10px] text-slate-500 font-sans font-normal">(Pasta Raiz)</span>
            </div>

            {/* Level 1: Clientes */}
            <div className="pl-6 border-l-2 border-slate-800 ml-2 space-y-3">
              {(isDevAdmin ? companies : companies.filter((c) => c.id === currentCompanyId)).map((client) => {
                const clientDocs = documents.filter((d) => d.company_id === client.id);
                const photoCount = clientDocs.filter((d) => d.category === 'photo').length;
                const docCount = clientDocs.filter((d) => d.category === 'document').length;

                return (
                  <div key={client.id} className="space-y-1.5">
                    <div className="flex items-center justify-between bg-slate-900/80 p-2 rounded-lg border border-slate-800">
                      <div className="flex items-center gap-2 text-white font-semibold">
                        <Building2 className="w-3.5 h-3.5 text-indigo-400" />
                        <span>📁 {client.trade_name || client.legal_name}</span>
                        <span className="text-[11px] text-slate-400 font-sans">
                          ({clientDocs.length} arquivos: {photoCount} fotos, {docCount} docs)
                        </span>
                      </div>
                      {client.drive_folder_url && (
                        <a
                          href={client.drive_folder_url}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 transition-colors font-sans"
                        >
                          <span>Abrir no Drive</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>

                    {/* Subpastas de cada cliente */}
                    <div className="pl-6 border-l-2 border-slate-800/60 ml-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-sans">
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-900/40 border border-slate-800/80 text-pink-300">
                        <Camera className="w-3.5 h-3.5 text-pink-400" />
                        <span>📸 Fotos com Código Único ({photoCount})</span>
                      </div>
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-slate-900/40 border border-slate-800/80 text-blue-300">
                        <FileText className="w-3.5 h-3.5 text-blue-400" />
                        <span>📄 Documentos e Arquivos ({docCount})</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* 3. GERENCIADOR DE ARQUIVOS: FILTROS, UPLOAD E LISTAGEM                     */}
      {/* ========================================================================= */}
      <div className="space-y-4">
        {/* Barra de Ações e Filtros */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900 p-4 rounded-2xl border border-slate-800">
          <div className="flex flex-wrap items-center gap-3 flex-1">
            {/* Seletor de Cliente (se for DEV) */}
            {isDevAdmin && (
              <div className="min-w-[200px]">
                <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                  Filtrar por Cliente
                </label>
                <select
                  value={selectedCompanyId}
                  onChange={(e) => setSelectedCompanyId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">Todos os Clientes ({companies.length})</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.trade_name || c.legal_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Filtro por Categoria */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Categoria de Arquivo
              </label>
              <div className="flex items-center gap-1 bg-slate-800 p-1 rounded-xl border border-slate-700">
                {[
                  { id: 'all', label: 'Todos' },
                  { id: 'photo', label: '📸 Fotos' },
                  { id: 'document', label: '📄 Documentos' },
                ].map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      selectedCategory === cat.id
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Busca Instantânea */}
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
                Busca Rápida
              </label>
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Buscar por código (ex: FOTO-DRO-XXXX), título ou cliente..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Botão Novo Upload */}
          <div className="self-end lg:self-center">
            <button
              type="button"
              onClick={() => {
                setUploadTargetCompanyId(
                  selectedCompanyId !== 'all' ? selectedCompanyId : companies[0]?.id || ''
                );
                setUploadModalOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white text-xs font-bold uppercase tracking-wider shadow-lg shadow-blue-500/20 transition-all cursor-pointer whitespace-nowrap"
            >
              <UploadCloud className="w-4 h-4" />
              <span>Enviar Foto / Arquivo</span>
            </button>
          </div>
        </div>

        {/* Lista de Documentos & Fotos */}
        {loading ? (
          <div className="flex items-center justify-center p-12 bg-slate-900 rounded-2xl border border-slate-800">
            <RefreshCw className="w-6 h-6 text-blue-400 animate-spin mr-3" />
            <span className="text-sm text-slate-400">Carregando arquivos do Google Drive...</span>
          </div>
        ) : filteredDocuments.length === 0 ? (
          <div className="p-12 text-center bg-slate-900 rounded-2xl border border-slate-800">
            <UploadCloud className="w-12 h-12 text-slate-600 mx-auto mb-3" />
            <div className="text-slate-300 font-semibold text-sm">Nenhum arquivo encontrado</div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredDocuments.map((doc) => {
              const comp = companies.find((c) => c.id === doc.company_id);
              const isPhoto = doc.category === 'photo';

              return (
                <div
                  key={doc.id}
                  className="rounded-2xl border border-slate-800 bg-slate-900 hover:border-slate-700 transition-all p-4 flex flex-col justify-between shadow-sm space-y-3"
                >
                  {/* Top Bar: Unique Code & Category */}
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handleCopyCode(doc.unique_code)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono font-bold text-blue-300 border border-slate-700 transition-colors"
                      title="Clique para copiar o código único"
                    >
                      <span>{doc.unique_code}</span>
                      {copiedCode === doc.unique_code ? (
                        <Check className="w-3 h-3 text-emerald-400" />
                      ) : (
                        <Copy className="w-3 h-3 text-slate-400" />
                      )}
                    </button>

                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                        isPhoto
                          ? 'bg-pink-500/20 text-pink-300 border border-pink-500/30'
                          : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                      }`}
                    >
                      {isPhoto ? '📸 Foto Única' : '📄 Documento'}
                    </span>
                  </div>

                  {/* Title and Client */}
                  <div>
                    <h4 className="font-bold text-white text-sm line-clamp-1" title={doc.title}>
                      {doc.title}
                    </h4>
                    <div className="text-xs text-slate-400 mt-0.5 flex items-center gap-1">
                      <Building2 className="w-3 h-3 text-slate-500 shrink-0" />
                      <span className="truncate">{comp?.trade_name || comp?.legal_name || 'Cliente'}</span>
                    </div>
                  </div>

                  {/* Description if present */}
                  {doc.description && (
                    <p className="text-xs text-slate-300 bg-slate-950/60 p-2.5 rounded-xl border border-slate-800/80 line-clamp-2">
                      {doc.description}
                    </p>
                  )}

                  {/* Metadata and Drive links */}
                  <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                    <div>
                      {doc.file_size && (
                        <span>{(doc.file_size / 1024).toFixed(1)} KB • </span>
                      )}
                      <span>
                        {new Date(doc.created_at).toLocaleDateString('pt-BR', {
                          day: '2-digit',
                          month: '2-digit',
                          year: '2-digit',
                        })}
                      </span>
                    </div>

                    <div className="flex items-center gap-1">
                      {doc.drive_view_url && (
                        <a
                          href={doc.drive_view_url}
                          target="_blank"
                          rel="noreferrer"
                          title="Abrir no Google Drive"
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-blue-600/30 text-slate-300 hover:text-blue-300 border border-slate-700 transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}

                      {doc.drive_download_url && (
                        <a
                          href={doc.drive_download_url}
                          download
                          title="Baixar arquivo"
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}

                      <button
                        type="button"
                        onClick={() => handleOpenEditDoc(doc)}
                        title="Editar detalhes"
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDeleteDocument(doc)}
                        title="Excluir"
                        className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/40 text-slate-300 hover:text-rose-300 border border-slate-700 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ========================================================================= */}
      {/* MODAL 1: Upload para Google Drive com Código Único                        */}
      {/* ========================================================================= */}
      {uploadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <UploadCloud className="w-5 h-5 text-blue-400" />
                Upload para o Google Drive
              </h3>
              <button
                type="button"
                onClick={() => setUploadModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleUploadToDrive} className="space-y-4">
              {/* Target Company / Client */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Cliente Vinculado *
                </label>
                <select
                  required
                  value={uploadTargetCompanyId}
                  onChange={(e) => setUploadTargetCompanyId(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.trade_name || c.legal_name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Tipo de Arquivo / Pasta de Destino *
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'photo', label: '📸 Foto com Código Único' },
                    { id: 'document', label: '📄 Documento / Arquivo Geral' },
                  ].map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setUploadCategory(cat.id as DriveCategory)}
                      className={`px-3 py-2.5 rounded-xl text-xs font-semibold text-left transition-all border ${
                        uploadCategory === cat.id
                          ? 'bg-blue-600/20 border-blue-500 text-blue-300'
                          : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:text-white'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Title */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Título do Arquivo / Foto *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Foto do Ponto Comercial / Contrato"
                  value={uploadTitle}
                  onChange={(e) => setUploadTitle(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Descrição / Observações (editável a qualquer momento)
                </label>
                <textarea
                  rows={2}
                  placeholder="Observações adicionais ou notas de edição..."
                  value={uploadDescription}
                  onChange={(e) => setUploadDescription(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* File Dropzone */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Arquivo ou Foto *
                </label>
                <div className="border-2 border-dashed border-slate-700 hover:border-blue-500 rounded-xl p-4 text-center cursor-pointer transition-colors bg-slate-800/40">
                  <input
                    type="file"
                    id="file-upload-input"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setUploadFile(file);
                        if (!uploadTitle) {
                          setUploadTitle(file.name.replace(/\.[^/.]+$/, ''));
                        }
                        if (file.type.startsWith('image/')) {
                          const reader = new FileReader();
                          reader.onload = (re) => {
                            setFilePreview(re.target?.result as string);
                          };
                          reader.readAsDataURL(file);
                        } else {
                          setFilePreview(null);
                        }
                      }
                    }}
                  />
                  <label htmlFor="file-upload-input" className="cursor-pointer block">
                    {filePreview ? (
                      <div className="space-y-2">
                        <img
                          src={filePreview}
                          alt="Preview"
                          className="max-h-32 mx-auto rounded-lg object-cover"
                        />
                        <div className="text-xs text-emerald-400 font-medium">
                          {uploadFile?.name} ({(uploadFile!.size / 1024).toFixed(1)} KB)
                        </div>
                      </div>
                    ) : uploadFile ? (
                      <div className="flex items-center justify-center gap-2 text-sm text-emerald-400 font-medium">
                        <FileText className="w-5 h-5" />
                        <span>
                          {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)} KB)
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-1 text-slate-400">
                        <UploadCloud className="w-8 h-8 mx-auto text-slate-500" />
                        <div className="text-sm font-medium">Clique ou arraste a foto ou documento aqui</div>
                        <div className="text-xs text-slate-500">Imagens (JPG, PNG, WebP), PDFs ou Documentos</div>
                      </div>
                    )}
                  </label>
                </div>
              </div>

              {/* Modal Buttons */}
              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setUploadModalOpen(false)}
                  disabled={isUploading}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isUploading || !uploadFile}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50"
                >
                  {isUploading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Enviando para o Drive...</span>
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-4 h-4" />
                      <span>Enviar & Salvar</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL 2: Editar Detalhes do Documento / Foto Salva                        */}
      {/* ========================================================================= */}
      {editDocModalOpen && editingDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Edit2 className="w-5 h-5 text-blue-400" />
                Editar: <span className="font-mono text-sm text-blue-400">{editingDoc.unique_code}</span>
              </h3>
              <button
                type="button"
                onClick={() => setEditDocModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveDocEdit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Título do Arquivo *
                </label>
                <input
                  type="text"
                  required
                  value={docEditForm.title}
                  onChange={(e) => setDocEditForm({ ...docEditForm, title: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Cliente Vinculado *
                </label>
                <select
                  value={docEditForm.company_id}
                  onChange={(e) => setDocEditForm({ ...docEditForm, company_id: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.trade_name || c.legal_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Categoria
                  </label>
                  <select
                    value={docEditForm.category}
                    onChange={(e) =>
                      setDocEditForm({ ...docEditForm, category: e.target.value as DriveCategory })
                    }
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="photo">Foto com Código</option>
                    <option value="document">Documento / Arquivo Geral</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                    Status
                  </label>
                  <select
                    value={docEditForm.status}
                    onChange={(e) =>
                      setDocEditForm({
                        ...docEditForm,
                        status: e.target.value as 'draft' | 'approved' | 'in_progress' | 'completed',
                      })
                    }
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="completed">Concluído</option>
                    <option value="approved">Aprovado</option>
                    <option value="in_progress">Em Andamento</option>
                    <option value="draft">Rascunho</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Descrição / Notas
                </label>
                <textarea
                  rows={3}
                  value={docEditForm.description}
                  onChange={(e) => setDocEditForm({ ...docEditForm, description: e.target.value })}
                  className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditDocModalOpen(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
                >
                  Salvar Alterações
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL DE CONFIRMAÇÃO DE EXCLUSÃO                                         */}
      {/* ========================================================================= */}
      {confirmData.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-rose-400">
              <AlertCircle className="w-6 h-6 shrink-0" />
              <h3 className="text-lg font-bold text-white">{confirmData.title}</h3>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">{confirmData.message}</p>
            <div className="pt-3 flex items-center justify-end gap-3 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setConfirmData((p) => ({ ...p, isOpen: false }))}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmData.action}
                className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold transition-colors cursor-pointer"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
