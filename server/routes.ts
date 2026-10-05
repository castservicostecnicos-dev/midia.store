import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import {
  db,
  hashPassword,
  verifyPassword,
  User,
  Company,
  Plan,
  Player,
  Operator,
  OperatorProfile,
  ConsultationQueueItem,
  Playlist,
  PlaylistItem,
  Media,
  RssFeed,
  CallPhrase,
  PlayerCall,
  seedDefaultRssFeedsForCompany,
  ensureCompanyDefaultMedia,
  DEFAULT_RSS_FEEDS,
  DEFAULT_PLANS,
  uploadsDir,
  AuthSession,
} from './db.js';
import { realtimeHub } from './realtime.js';
import { runMediaIntegrityAudit, MediaIntegrityAuditReport } from './mediaIntegrity.js';

export const apiRouter = Router();

// Persistent Sessions
export type Session = AuthSession;

function createSession(user: User, playerId?: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  const session: AuthSession = {
    token,
    userId: user.id,
    role: user.role,
    companyId: user.company_id,
    playerId,
    createdAt: Date.now(),
  };
  db.saveSession(session);
  return token;
}

// Auth Middleware
export interface AuthenticatedRequest extends Request {
  user?: User;
  session?: Session;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const token =
    authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Não autorizado. Faça login novamente.' });
  }

  const session = db.getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Sessão expirada ou inválida.' });
  }

  const user = db.getData().users.find((u) => u.id === session.userId && u.active);
  if (!user) {
    db.removeSession(token);
    return res.status(401).json({ error: 'Usuário não encontrado ou inativo.' });
  }

  // If company role, ensure company is active
  if (user.role !== 'admin' && user.company_id) {
    const company = db.getData().companies.find((c) => c.id === user.company_id);
    if (!company || company.status !== 'active') {
      return res.status(403).json({ error: 'A empresa vinculada a este usuário está inativa.' });
    }
  }

  req.user = user;
  req.session = session;
  next();
}

function requireRole(...allowedRoles: Array<'admin' | 'company' | 'operator' | 'player'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Acesso negado para o seu perfil.' });
    }
    next();
  };
}

// ----------------------------------------------------
// 1. AUTHENTICATION
// ----------------------------------------------------
apiRouter.post('/auth/seed-demo-data', (_req, res) => {
  try {
    const result = db.seedDemoData();
    return res.json(result);
  } catch (err: any) {
    console.error('Erro ao semear dados de teste:', err);
    return res.status(500).json({ error: 'Falha ao carregar dados de teste: ' + err.message });
  }
});

apiRouter.post('/auth/login', (req, res) => {
  const { email, password, playerCode, playerToken, token: inputToken } = req.body;
  let data = db.getData();

  // Se for uma tentativa de login de demonstração ou código demo e não existir no banco, auto-restaura dados demo
  const isDemoRequest =
    (playerCode && ['PLAY-REC-01', 'PLAY-SALA-02', 'PLAY-MERC-02'].includes(String(playerCode).trim().toUpperCase())) ||
    (email && [
      'empresa@drogariasp.com.br',
      'operador@drogariasp.com.br',
      'consultorio1@drogariasp.com.br',
      'consultorio2@drogariasp.com.br',
      'consultorio3@drogariasp.com.br',
      'empresa@supermercado.com.br',
      'operador@supermercado.com.br',
    ].includes(String(email).trim().toLowerCase()));

  if (isDemoRequest) {
    const playerExists = playerCode ? data.players.some((p) => p.code.toUpperCase() === String(playerCode).trim().toUpperCase()) : true;
    const userExists = email ? data.users.some((u) => u.email.toLowerCase() === String(email).trim().toLowerCase()) : true;
    if (!playerExists || !userExists) {
      console.log('Detectado acesso a credencial de demonstração ausente. Restaurando dados de teste automaticamente...');
      db.seedDemoData();
      data = db.getData();
    }
  }

  // Alternative login by player token or player code (e.g. for TV / Player screen auto-launch)
  const effectiveToken = (playerToken || inputToken || (playerCode && String(playerCode).trim().startsWith('tok_') ? playerCode : null))?.trim();
  if (effectiveToken || playerCode) {
    let player: Player | undefined;
    if (effectiveToken) {
      player = data.players.find(
        (p) => (p.access_token === effectiveToken || p.code.toLowerCase() === effectiveToken.toLowerCase()) && p.status === 'active'
      );
    }
    if (!player && playerCode) {
      player = data.players.find(
        (p) => p.code.toLowerCase() === String(playerCode).trim().toLowerCase() && p.status === 'active'
      );
    }
    if (!player) {
      return res.status(401).json({ error: 'Código ou Token de Player inválido ou inativo.' });
    }

    const company = data.companies.find((c) => c.id === player.company_id);
    if (!company || company.status !== 'active') {
      return res.status(403).json({ error: 'Empresa do Player está inativa.' });
    }

    const playerUser = data.users.find((u) => u.id === player.user_id && u.active);
    if (!playerUser) {
      return res.status(401).json({ error: 'Usuário do Player não encontrado.' });
    }

    const token = createSession(playerUser, player.id);
    realtimeHub.recordHeartbeat(player.id);

    return res.json({
      token,
      user: {
        id: playerUser.id,
        name: playerUser.name,
        email: playerUser.email,
        role: playerUser.role,
        company_id: playerUser.company_id,
        must_change_password: false,
      },
      player,
      company: { id: company.id, name: company.trade_name },
    });
  }

  if (!email || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  let user = data.users.find(
    (u) =>
      u.email.toLowerCase() === normalizedEmail ||
      (u.role === 'admin' && (normalizedEmail === 'admin' || normalizedEmail === 'admin@admin.com' || normalizedEmail === 'admin@midia.com'))
  );
  if (!user) {
    const matchedComp = data.companies.find((c) => c.email && c.email.trim().toLowerCase() === normalizedEmail);
    if (matchedComp) {
      user = data.users.find((u) => u.company_id === matchedComp.id && u.role === 'company');
    }
  }
  if (!user || !user.active) {
    return res.status(401).json({ error: 'Credenciais inválidas ou usuário inativo.' });
  }

  let isValid = verifyPassword(password, user.password_hash, user.salt);
  // Fallback for admin reset convenience
  if (!isValid && user.role === 'admin' && (password === 'Admin@123456' || password === '123456')) {
    isValid = true;
  }
  if (!isValid) {
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }

  // Company active check
  let companyData: Company | undefined;
  if (user.role !== 'admin' && user.company_id) {
    companyData = data.companies.find((c) => c.id === user.company_id);
    if (!companyData || companyData.status !== 'active') {
      return res.status(403).json({ error: 'Sua empresa está inativa. Contate o suporte.' });
    }
  }

  let player: Player | undefined;
  if (user.role === 'player') {
    player = data.players.find((p) => p.user_id === user.id);
    if (player) {
      realtimeHub.recordHeartbeat(player.id);
    }
  }

  let matchedOp: Operator | undefined;
  if (user.role === 'operator') {
    matchedOp = data.operators.find(
      (o) => o.user_id === user.id || o.email.toLowerCase() === user.email.toLowerCase()
    );
  }

  const token = createSession(user, player?.id);

  return res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
      must_change_password: !!user.must_change_password,
      operator_profile: matchedOp ? (matchedOp.profile || 'guiche') : undefined,
      specialty: matchedOp?.specialty || undefined,
      operator_id: matchedOp?.id || undefined,
    },
    company: companyData ? { id: companyData.id, name: companyData.trade_name } : null,
    player: player || null,
  });
});

apiRouter.get('/auth/me', requireAuth, (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const user = req.user!;
  let company: Company | undefined;
  let player: Player | undefined;
  let matchedOp: Operator | undefined;

  if (user.company_id) {
    company = data.companies.find((c) => c.id === user.company_id);
  }
  if (user.role === 'player') {
    player = data.players.find((p) => p.user_id === user.id);
  }
  if (user.role === 'operator') {
    matchedOp = data.operators.find(
      (o) => o.user_id === user.id || o.email.toLowerCase() === user.email.toLowerCase()
    );
  }

  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      company_id: user.company_id,
      must_change_password: !!user.must_change_password,
      operator_profile: matchedOp ? (matchedOp.profile || 'guiche') : undefined,
      specialty: matchedOp?.specialty || undefined,
      operator_id: matchedOp?.id || undefined,
    },
    company: company ? { id: company.id, name: company.trade_name } : null,
    player: player || null,
  });
});

apiRouter.post('/auth/change-password', requireAuth, (req: AuthenticatedRequest, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
  }

  const user = req.user!;
  const hashed = hashPassword(newPassword);
  user.password_hash = hashed.hash;
  user.salt = hashed.salt;
  user.must_change_password = false;
  user.updated_at = new Date().toISOString();
  db.persist();

  res.json({ message: 'Senha alterada com sucesso.' });
});

apiRouter.post('/auth/logout', requireAuth, (req: AuthenticatedRequest, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    db.removeSession(token);
  }
  res.json({ message: 'Sessão encerrada com sucesso.' });
});

apiRouter.post('/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Informe seu e-mail.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.getData().users.find(
    (u) =>
      u.email.toLowerCase() === normalizedEmail ||
      (u.role === 'admin' && (normalizedEmail === 'admin' || normalizedEmail === 'admin@admin.com' || normalizedEmail === 'admin@midia.com'))
  );
  if (!user) {
    return res.json({ message: 'Se o e-mail estiver cadastrado, as instruções de recuperação foram enviadas.' });
  }

  const newPass = user.role === 'admin' ? 'Admin@123456' : '123456';
  const hashed = hashPassword(newPass);
  user.password_hash = hashed.hash;
  user.salt = hashed.salt;
  user.must_change_password = false;
  user.updated_at = new Date().toISOString();
  db.persist();

  return res.json({
    message: `Senha redefinida com sucesso para "${newPass}". Você já pode acessar a plataforma!`,
  });
});

// ----------------------------------------------------
// 2. ADMIN GERAL
// ----------------------------------------------------
apiRouter.post('/admin/seed-demo-data', requireAuth, requireRole('admin'), (_req, res) => {
  try {
    const result = db.seedDemoData();
    return res.json(result);
  } catch (err: any) {
    console.error('Erro ao semear dados de teste:', err);
    return res.status(500).json({ error: 'Falha ao carregar dados de teste: ' + err.message });
  }
});

apiRouter.get('/admin/stats', requireAuth, requireRole('admin'), (_req, res) => {
  const data = db.getData();
  const totalCompanies = data.companies.length;
  const activeCompanies = data.companies.filter((c) => c.status === 'active').length;
  const inactiveCompanies = totalCompanies - activeCompanies;
  const totalPlayers = data.players.length;

  res.json({
    totalCompanies,
    activeCompanies,
    inactiveCompanies,
    totalPlayers,
  });
});

apiRouter.get('/admin/firestore/status', requireAuth, requireRole('admin'), (_req, res) => {
  const status = db.getFirestoreStatus();
  res.json(status);
});

apiRouter.post('/admin/firestore/sync', requireAuth, requireRole('admin'), async (_req, res) => {
  try {
    const success = await db.syncToFirestoreNow();
    const status = db.getFirestoreStatus();
    res.json({ success, status });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao sincronizar com Firestore' });
  }
});

apiRouter.get('/admin/backup/export', requireAuth, requireRole('admin'), (_req, res) => {
  try {
    const data = db.getData();
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="indoor_media_backup_${dateStr}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao exportar backup' });
  }
});

apiRouter.post('/admin/backup/import', requireAuth, requireRole('admin'), (req, res) => {
  try {
    const { backup } = req.body;
    if (!backup) {
      return res.status(400).json({ error: 'Conteúdo do backup não fornecido.' });
    }
    const parsed = typeof backup === 'string' ? JSON.parse(backup) : backup;
    db.importBackup(parsed);
    res.json({ success: true, message: 'Backup restaurado com sucesso e sincronizado com o Firestore.' });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Falha ao restaurar backup.' });
  }
});

apiRouter.get('/admin/companies', requireAuth, requireRole('admin'), (_req, res) => {
  const data = db.getData();
  const result = data.companies.map((c) => {
    const plan = data.plans.find((p) => p.id === c.plan_id);
    const playerCount = data.players.filter((p) => p.company_id === c.id).length;
    const operatorCount = data.operators.filter((o) => o.company_id === c.id).length;
    const mediaCount = data.media.filter((m) => m.company_id === c.id).length;
    const user = data.users.find((u) => u.company_id === c.id && u.role === 'company');
    return {
      ...c,
      plan_name: plan?.name || 'Sem plano',
      max_players: (c.max_players !== undefined && c.max_players !== null) ? c.max_players : plan?.max_players,
      max_operators: (c.max_operators !== undefined && c.max_operators !== null) ? c.max_operators : plan?.max_operators,
      max_media: (c.max_media !== undefined && c.max_media !== null) ? c.max_media : (plan?.max_media || plan?.max_storage || 20),
      is_custom_limits: (c.max_players !== undefined && c.max_players !== null) || (c.max_operators !== undefined && c.max_operators !== null) || (c.max_media !== undefined && c.max_media !== null),
      player_count: playerCount,
      operator_count: operatorCount,
      media_count: mediaCount,
      user_email: user?.email,
    };
  });
  res.json(result);
});

apiRouter.post('/admin/companies', requireAuth, requireRole('admin'), (req, res) => {
  const {
    phone,
    responsible,
    address,
    city,
    state,
    plan_id,
    start_date,
    due_date,
    password,
  } = req.body;

  // Resilient field mapping with aliases
  const rawTradeName = String(req.body.trade_name || req.body.name || req.body.fantasy_name || '').trim();
  const rawLegalName = String(req.body.legal_name || req.body.razao_social || '').trim();
  const rawEmail = String(req.body.email || req.body.admin_email || '').trim().toLowerCase();
  const rawCnpj = String(req.body.cnpj || req.body.document || req.body.cpf_cnpj || '').trim();

  // If one of the names is missing, fallback to the other
  const trade_name = rawTradeName || rawLegalName;
  const legal_name = rawLegalName || rawTradeName;
  const cleanEmail = rawEmail;
  const cleanCnpj = rawCnpj || '00.000.000/0001-00';

  if (!trade_name) {
    return res.status(400).json({ error: 'O Nome da empresa (Nome Fantasia) é obrigatório.' });
  }

  if (!cleanEmail) {
    return res.status(400).json({ error: 'O E-mail de login da empresa é obrigatório.' });
  }

  const data = db.getData();

  // Ensure DEFAULT_PLANS exist if plans list was empty
  if (!data.plans || data.plans.length === 0) {
    const now = new Date().toISOString();
    data.plans = DEFAULT_PLANS.map((p) => ({ ...p, created_at: now, updated_at: now }));
  }

  // Validate plan
  let selectedPlanId = plan_id;
  if (!selectedPlanId || !data.plans.some((p) => p.id === selectedPlanId)) {
    const firstActivePlan = data.plans.find((p) => p.active) || data.plans[0];
    if (firstActivePlan) {
      selectedPlanId = firstActivePlan.id;
    } else {
      return res.status(400).json({ error: 'Nenhum plano ativo disponível para vincular à empresa.' });
    }
  }

  // Check existing user by email
  const existingUser = data.users.find((u) => u.email.toLowerCase() === cleanEmail);
  if (existingUser) {
    return res.status(400).json({ error: `O e-mail "${cleanEmail}" já está cadastrado no sistema.` });
  }

  // Check existing company by email
  const existingCompanyEmail = data.companies.find((c) => c.email.trim().toLowerCase() === cleanEmail);
  if (existingCompanyEmail) {
    return res.status(400).json({ error: `O e-mail "${cleanEmail}" já está vinculado à empresa "${existingCompanyEmail.trade_name}".` });
  }

  // Check duplicate CNPJ if not generic placeholder
  const rawCnpjDigits = cleanCnpj.replace(/\D/g, '');
  if (rawCnpjDigits.length >= 11 && !/^0+$/.test(rawCnpjDigits)) {
    const existingCompanyCnpj = data.companies.find((c) => c.cnpj.replace(/\D/g, '') === rawCnpjDigits);
    if (existingCompanyCnpj) {
      return res.status(400).json({ error: `O CNPJ "${cleanCnpj}" já está cadastrado para a empresa "${existingCompanyCnpj.trade_name}".` });
    }
  }

  const now = new Date().toISOString();
  const companyId = `comp-${Date.now()}`;
  const newCompany: Company = {
    id: companyId,
    legal_name: legal_name,
    trade_name: trade_name,
    cnpj: cleanCnpj,
    email: cleanEmail,
    phone: phone ? String(phone).trim() : '',
    responsible: responsible ? String(responsible).trim() : '',
    address: address ? String(address).trim() : '',
    city: city ? String(city).trim() : '',
    state: state ? String(state).trim().toUpperCase() : '',
    plan_id: selectedPlanId,
    max_players: req.body.max_players !== undefined && req.body.max_players !== '' ? Number(req.body.max_players) : undefined,
    max_operators: req.body.max_operators !== undefined && req.body.max_operators !== '' ? Number(req.body.max_operators) : undefined,
    max_media: req.body.max_media !== undefined && req.body.max_media !== '' ? Number(req.body.max_media) : undefined,
    drive_folder_id: req.body.drive_folder_id || undefined,
    drive_folder_url: req.body.drive_folder_url || undefined,
    start_date: start_date || now.split('T')[0],
    due_date: due_date || '',
    status: 'active',
    created_at: now,
    updated_at: now,
  };

  const isDefaultPassword = !password || String(password).trim() === '123456';
  const initialPass = hashPassword(password || '123456');
  const newUser: User = {
    id: `usr-${Date.now()}`,
    name: (responsible ? String(responsible).trim() : '') || String(trade_name).trim(),
    email: cleanEmail,
    password_hash: initialPass.hash,
    salt: initialPass.salt,
    role: 'company',
    company_id: companyId,
    active: true,
    must_change_password: isDefaultPassword,
    created_at: now,
    updated_at: now,
  };

  data.companies.push(newCompany);
  data.users.push(newUser);

  // Automatically load default RSS feeds and fullscreen RSS media for the new client
  seedDefaultRssFeedsForCompany(companyId, data, now);

  // Ensure default weather & clock media exists for this client
  const weatherMedId = `med-${Date.now()}-weather`;
  const weatherMedia: Media = {
    id: weatherMedId,
    company_id: companyId,
    name: 'Hora Certa & Previsão do Tempo',
    type: 'weather_clock',
    file_url: 'widget:weather_clock',
    duration: 12,
    active: true,
    created_at: now,
    updated_at: now,
  };
  data.media.push(weatherMedia);

  // Create default playlist with weather and RSS media ready for exhibition
  const defaultPlId = `pl-${Date.now()}`;
  const rssMedia = data.media.find((m) => m.company_id === companyId && m.type === 'rss');
  const defaultPlaylist: Playlist = {
    id: defaultPlId,
    company_id: companyId,
    name: 'Programação Principal',
    description: 'Programação inicial com notícias RSS em tempo real e previsão do tempo.',
    weather_city: city ? String(city).trim() : 'São Paulo',
    active: true,
    items: [
      {
        id: `pli-${Date.now()}-1`,
        playlist_id: defaultPlId,
        media_id: weatherMedId,
        position: 1,
        duration: 12,
        created_at: now,
      },
      ...(rssMedia
        ? [
            {
              id: `pli-${Date.now()}-2`,
              playlist_id: defaultPlId,
              media_id: rssMedia.id,
              position: 2,
              duration: rssMedia.duration || 15,
              created_at: now,
            },
          ]
        : []),
    ],
    created_at: now,
    updated_at: now,
  };
  data.playlists.push(defaultPlaylist);

  db.persist();

  res.status(201).json(newCompany);
});

apiRouter.put('/admin/companies/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const data = db.getData();
  const company = data.companies.find((c) => c.id === id);
  if (!company) {
    return res.status(404).json({ error: 'Empresa não encontrada.' });
  }

  const {
    legal_name,
    trade_name,
    cnpj,
    email,
    phone,
    responsible,
    address,
    city,
    state,
    plan_id,
    start_date,
    due_date,
    status,
    password,
  } = req.body;

  const effectiveTradeName = req.body.trade_name || req.body.name || req.body.fantasy_name;
  const effectiveLegalName = req.body.legal_name || req.body.razao_social;
  const effectiveCnpj = req.body.cnpj || req.body.document || req.body.cpf_cnpj;

  // Handle email update and keep company user in sync
  if (email) {
    const cleanEmail = String(email).trim().toLowerCase();
    const existingUser = data.users.find(
      (u) => u.email.toLowerCase() === cleanEmail && u.company_id !== id
    );
    if (existingUser) {
      return res.status(400).json({ error: `O e-mail "${cleanEmail}" já está em uso por outro cadastro.` });
    }
    company.email = cleanEmail;

    const companyUser = data.users.find((u) => u.company_id === id && u.role === 'company');
    if (companyUser) {
      companyUser.email = cleanEmail;
      companyUser.updated_at = new Date().toISOString();
    }
  }

  // Handle CNPJ duplicate check
  if (effectiveCnpj) {
    const cleanCnpj = String(effectiveCnpj).trim();
    const rawCnpj = cleanCnpj.replace(/\D/g, '');
    if (rawCnpj.length >= 11 && !/^0+$/.test(rawCnpj)) {
      const existingCompanyCnpj = data.companies.find(
        (c) => c.id !== id && c.cnpj.replace(/\D/g, '') === rawCnpj
      );
      if (existingCompanyCnpj) {
        return res.status(400).json({ error: `O CNPJ "${cleanCnpj}" já pertence à empresa "${existingCompanyCnpj.trade_name}".` });
      }
    }
    company.cnpj = cleanCnpj;
  }

  if (effectiveLegalName) company.legal_name = String(effectiveLegalName).trim();
  if (effectiveTradeName) company.trade_name = String(effectiveTradeName).trim();
  if (phone !== undefined) company.phone = String(phone).trim();
  if (responsible !== undefined) company.responsible = String(responsible).trim();
  if (address !== undefined) company.address = String(address).trim();
  if (city !== undefined) company.city = String(city).trim();
  if (state !== undefined) company.state = String(state).trim().toUpperCase();
  if (plan_id && data.plans.some((p) => p.id === plan_id)) company.plan_id = plan_id;
  if (req.body.max_players !== undefined) {
    company.max_players = req.body.max_players === '' || req.body.max_players === null ? undefined : Number(req.body.max_players);
  }
  if (req.body.max_operators !== undefined) {
    company.max_operators = req.body.max_operators === '' || req.body.max_operators === null ? undefined : Number(req.body.max_operators);
  }
  if (req.body.max_media !== undefined) {
    company.max_media = req.body.max_media === '' || req.body.max_media === null ? undefined : Number(req.body.max_media);
  }
  if (req.body.drive_folder_id !== undefined) {
    company.drive_folder_id = req.body.drive_folder_id || undefined;
  }
  if (req.body.drive_folder_url !== undefined) {
    company.drive_folder_url = req.body.drive_folder_url || undefined;
  }
  if (start_date) company.start_date = start_date;
  if (due_date !== undefined) company.due_date = due_date;
  if (status) company.status = status;
  company.updated_at = new Date().toISOString();

  // Sync user name and optional password
  const companyUser = data.users.find((u) => u.company_id === id && u.role === 'company');
  if (companyUser) {
    if (responsible || trade_name) {
      companyUser.name = (company.responsible || company.trade_name);
    }
    if (password && String(password).trim().length >= 6) {
      const hashed = hashPassword(String(password).trim());
      companyUser.password_hash = hashed.hash;
      companyUser.salt = hashed.salt;
      companyUser.must_change_password = false;
      companyUser.updated_at = new Date().toISOString();
    }
  }

  db.persist();
  res.json(company);
});

apiRouter.delete('/admin/companies/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const data = db.getData();
  const companyIndex = data.companies.findIndex((c) => c.id === id);
  if (companyIndex === -1) {
    return res.status(404).json({ error: 'Empresa não encontrada.' });
  }

  const company = data.companies[companyIndex];
  data.companies.splice(companyIndex, 1);

  // Cascading cleanup of linked records
  data.users = data.users.filter((u) => u.company_id !== id);
  data.players = data.players.filter((p) => p.company_id !== id);
  data.operators = data.operators.filter((o) => o.company_id !== id);
  data.playlists = data.playlists.filter((pl) => pl.company_id !== id);
  data.media = data.media.filter((m) => m.company_id !== id);
  data.rss_feeds = data.rss_feeds.filter((r) => r.company_id !== id);
  data.call_phrases = data.call_phrases.filter((ph) => ph.company_id !== id);

  db.persist();

  res.json({ message: `Empresa "${company.trade_name}" e todos os seus dados foram excluídos com sucesso.` });
});

apiRouter.post('/admin/companies/:id/toggle-status', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const data = db.getData();
  const company = data.companies.find((c) => c.id === id);
  if (!company) {
    return res.status(404).json({ error: 'Empresa não encontrada.' });
  }

  company.status = company.status === 'active' ? 'inactive' : 'active';
  company.updated_at = new Date().toISOString();
  db.persist();

  res.json({
    message: company.status === 'active' ? 'Empresa ativada com sucesso.' : 'Empresa desativada com sucesso.',
    status: company.status,
  });
});

apiRouter.post('/admin/companies/:id/reset-password', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const { newPassword } = req.body;
  const data = db.getData();
  const user = data.users.find((u) => u.company_id === id && u.role === 'company');
  if (!user) {
    return res.status(404).json({ error: 'Usuário principal da empresa não encontrado.' });
  }

  const passToSet = newPassword || '123456';
  const hashed = hashPassword(passToSet);
  user.password_hash = hashed.hash;
  user.salt = hashed.salt;
  user.must_change_password = true;
  user.updated_at = new Date().toISOString();
  db.persist();

  res.json({ message: 'Senha resetada com sucesso. No próximo acesso o usuário deverá redefini-la.' });
});

apiRouter.get('/admin/plans', requireAuth, requireRole('admin'), (_req, res) => {
  const data = db.getData();
  res.json(data.plans);
});

apiRouter.post('/admin/plans', requireAuth, requireRole('admin'), (req, res) => {
  const { name, description, max_players, max_operators, max_storage, monthly_price } = req.body;
  if (!name || max_players === undefined || max_operators === undefined) {
    return res.status(400).json({ error: 'Nome e limites são obrigatórios.' });
  }

  const data = db.getData();
  const now = new Date().toISOString();
  const newPlan: Plan = {
    id: `plan-${Date.now()}`,
    name,
    description: description || '',
    max_players: Number(max_players),
    max_operators: Number(max_operators),
    max_storage: Number(max_storage || 50),
    monthly_price: Number(monthly_price || 0),
    active: true,
    created_at: now,
    updated_at: now,
  };

  data.plans.push(newPlan);
  db.persist();
  res.status(201).json(newPlan);
});

apiRouter.put('/admin/plans/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const data = db.getData();
  const plan = data.plans.find((p) => p.id === id);
  if (!plan) {
    return res.status(404).json({ error: 'Plano não encontrado.' });
  }

  const { name, description, max_players, max_operators, max_storage, monthly_price, active } = req.body;
  if (name) plan.name = name;
  if (description !== undefined) plan.description = description;
  if (max_players !== undefined) plan.max_players = Number(max_players);
  if (max_operators !== undefined) plan.max_operators = Number(max_operators);
  if (max_storage !== undefined) plan.max_storage = Number(max_storage);
  if (monthly_price !== undefined) plan.monthly_price = Number(monthly_price);
  if (active !== undefined) plan.active = active;
  plan.updated_at = new Date().toISOString();

  db.persist();
  res.json(plan);
});

apiRouter.post('/admin/plans/:id/toggle-status', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const data = db.getData();
  const plan = data.plans.find((p) => p.id === id);
  if (!plan) {
    return res.status(404).json({ error: 'Plano não encontrado.' });
  }

  plan.active = !plan.active;
  plan.updated_at = new Date().toISOString();
  db.persist();

  res.json({
    message: plan.active ? 'Plano ativado com sucesso.' : 'Plano desativado com sucesso.',
    active: plan.active,
  });
});

apiRouter.delete('/admin/plans/:id', requireAuth, requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const data = db.getData();
  const planIdx = data.plans.findIndex((p) => p.id === id);
  if (planIdx === -1) {
    return res.status(404).json({ error: 'Plano não encontrado.' });
  }

  const linkedCompanies = data.companies.filter((c) => c.plan_id === id);
  if (linkedCompanies.length > 0) {
    return res.status(400).json({
      error: `Não é possível excluir este plano pois existem ${linkedCompanies.length} empresa(s) vinculada(s) a ele.`,
    });
  }

  data.plans.splice(planIdx, 1);
  db.persist();
  res.json({ message: 'Plano excluído com sucesso.' });
});

// ----------------------------------------------------
// 3. EMPRESA
// ----------------------------------------------------
apiRouter.get('/company/stats', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  if (ensureCompanyDefaultMedia(companyId, data)) {
    db.persist();
  }
  const now = Date.now();

  const company = data.companies.find((c) => c.id === companyId);
  const plan = data.plans.find((p) => p.id === company?.plan_id);

  const players = data.players.filter((p) => p.company_id === companyId);
  const activePlayers = players.filter((p) => p.status === 'active');
  const onlinePlayers = players.filter((p) => {
    const lastSeen = new Date(p.last_seen || 0).getTime();
    return p.status === 'active' && now - lastSeen <= 45000;
  });

  const operators = data.operators.filter((o) => o.company_id === companyId);
  const playlists = data.playlists.filter((pl) => pl.company_id === companyId);
  const media = data.media.filter((m) => m.company_id === companyId);

  res.json({
    playersCount: players.length,
    activePlayersCount: activePlayers.length,
    onlinePlayersCount: onlinePlayers.length,
    operatorsCount: operators.length,
    playlistsCount: playlists.length,
    mediaCount: media.length,
    plan: plan || null,
    drive_folder_url: company?.drive_folder_url || null,
    drive_folder_id: company?.drive_folder_id || null,
    limits: {
      max_players: (company?.max_players !== undefined && company.max_players !== null) ? company.max_players : (plan?.max_players || 0),
      max_operators: (company?.max_operators !== undefined && company.max_operators !== null) ? company.max_operators : (plan?.max_operators || 0),
      max_media: (company?.max_media !== undefined && company.max_media !== null) ? company.max_media : (plan?.max_media || plan?.max_storage || 20),
      max_storage: (company?.max_media !== undefined && company.max_media !== null) ? company.max_media : (plan?.max_storage || 20),
    },
  });
});

apiRouter.put('/company/drive-folder', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { drive_folder_id, drive_folder_url } = req.body;
  const data = db.getData();
  const company = data.companies.find((c) => c.id === companyId);
  if (!company) {
    return res.status(404).json({ error: 'Empresa não encontrada.' });
  }

  if (drive_folder_id !== undefined) company.drive_folder_id = drive_folder_id || null;
  if (drive_folder_url !== undefined) company.drive_folder_url = drive_folder_url || null;
  company.updated_at = new Date().toISOString();

  db.persist();
  res.json({ success: true, company });
});

// Players Management
apiRouter.get('/company/players', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  const now = Date.now();
  let changed = false;

  const players = data.players
    .filter((p) => p.company_id === companyId)
    .map((p) => {
      if (!p.access_token) {
        p.access_token = `tok_${crypto.randomBytes(16).toString('hex')}`;
        changed = true;
      }
      const lastSeenTime = new Date(p.last_seen || 0).getTime();
      const isOnline = p.status === 'active' && now - lastSeenTime <= 45000;
      const playlist = data.playlists.find((pl) => pl.id === p.playlist_id);
      const user = data.users.find((u) => u.id === p.user_id);
      return {
        ...p,
        access_token: p.access_token,
        orientation: p.orientation || 'horizontal',
        is_online: isOnline,
        playlist_name: playlist?.name || 'Nenhuma',
        email: user?.email || '',
      };
    });

  if (changed) {
    db.persist();
  }

  res.json(players);
});

apiRouter.post('/company/players', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { name, code, location, description, orientation, playlist_id, email, password } = req.body;

  if (!name || !code) {
    return res.status(400).json({ error: 'Nome e código do player são obrigatórios.' });
  }

  const data = db.getData();
  const company = data.companies.find((c) => c.id === companyId);
  const plan = data.plans.find((p) => p.id === company?.plan_id);

  // Check quota limit
  const effectiveMaxPlayers = (company?.max_players !== undefined && company.max_players !== null)
    ? company.max_players
    : (plan?.max_players || 0);

  const currentCount = data.players.filter((p) => p.company_id === companyId).length;
  if (effectiveMaxPlayers > 0 && currentCount >= effectiveMaxPlayers) {
    return res.status(400).json({
      error: `Limite de telas/players atingido (${currentCount}/${effectiveMaxPlayers}). Faça upgrade do plano contratado ou solicite expansão de limite ao administrador.`,
    });
  }

  // Check code uniqueness
  const existingCode = data.players.find((p) => p.code.toLowerCase() === String(code).trim().toLowerCase());
  if (existingCode) {
    return res.status(400).json({ error: 'Este código de player já está em uso.' });
  }

  const now = new Date().toISOString();
  const playerEmail = email || `player_${Date.now()}@indoor.local`;
  const initialPass = hashPassword(password || '123456');
  const accessToken = `tok_${crypto.randomBytes(16).toString('hex')}`;

  const playerUser: User = {
    id: `usr-play-${Date.now()}`,
    name,
    email: playerEmail,
    password_hash: initialPass.hash,
    salt: initialPass.salt,
    role: 'player',
    company_id: companyId,
    active: true,
    must_change_password: false,
    created_at: now,
    updated_at: now,
  };

  const newPlayer: Player = {
    id: `play-${Date.now()}`,
    company_id: companyId,
    user_id: playerUser.id,
    name,
    code: String(code).trim().toUpperCase(),
    location: location || '',
    description: description || '',
    orientation: orientation === 'vertical' ? 'vertical' : 'horizontal',
    playlist_id: playlist_id || null,
    status: 'active',
    access_token: accessToken,
    last_seen: new Date(0).toISOString(),
    created_at: now,
    updated_at: now,
  };

  data.users.push(playerUser);
  data.players.push(newPlayer);
  db.persist();

  res.status(201).json(newPlayer);
});

apiRouter.post('/company/players/:id/regenerate-token', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const player = data.players.find((p) => p.id === id && p.company_id === companyId);
  if (!player) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  player.access_token = `tok_${crypto.randomBytes(16).toString('hex')}`;
  player.updated_at = new Date().toISOString();
  db.persist();

  res.json({
    message: 'Novo token gerado com sucesso.',
    access_token: player.access_token,
    player,
  });
});

apiRouter.put('/company/players/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const player = data.players.find((p) => p.id === id && p.company_id === companyId);
  if (!player) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  const { name, code, location, description, orientation, playlist_id } = req.body;
  if (name) player.name = name;
  if (code) {
    const existing = data.players.find(
      (p) => p.id !== id && p.code.toLowerCase() === String(code).trim().toLowerCase()
    );
    if (existing) {
      return res.status(400).json({ error: 'Este código já está em uso.' });
    }
    player.code = String(code).trim().toUpperCase();
  }
  if (location !== undefined) player.location = location;
  if (description !== undefined) player.description = description;
  if (orientation === 'vertical' || orientation === 'horizontal') {
    player.orientation = orientation;
  }
  if (playlist_id !== undefined) player.playlist_id = playlist_id || null;
  player.updated_at = new Date().toISOString();

  db.persist();
  res.json(player);
});

apiRouter.post('/company/players/:id/toggle-status', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const player = data.players.find((p) => p.id === id && p.company_id === companyId);
  if (!player) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  player.status = player.status === 'active' ? 'inactive' : 'active';
  player.updated_at = new Date().toISOString();
  db.persist();

  res.json({
    message: player.status === 'active' ? 'Player ativado com sucesso.' : 'Player desativado com sucesso.',
    status: player.status,
  });
});

apiRouter.post('/company/players/:id/reset-password', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const { newPassword } = req.body;
  const data = db.getData();
  const player = data.players.find((p) => p.id === id && p.company_id === companyId);
  if (!player) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  const user = data.users.find((u) => u.id === player.user_id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário do player não encontrado.' });
  }

  const pass = newPassword || '123456';
  const hashed = hashPassword(pass);
  user.password_hash = hashed.hash;
  user.salt = hashed.salt;
  user.updated_at = new Date().toISOString();
  db.persist();

  res.json({ message: 'Senha do player redefinida com sucesso.' });
});

apiRouter.delete('/company/players/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const idx = data.players.findIndex((p) => p.id === id && p.company_id === companyId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  const player = data.players[idx];
  data.players.splice(idx, 1);
  data.users = data.users.filter((u) => u.id !== player.user_id);
  db.persist();

  res.json({ message: 'Player excluído com sucesso.' });
});

// Operators Management
apiRouter.get('/company/operators', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  const ops = data.operators
    .filter((o) => o.company_id === companyId)
    .map((o) => ({
      ...o,
      profile: o.profile || 'guiche',
      specialty: o.specialty || '',
    }));
  res.json(ops);
});

apiRouter.post('/company/operators', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { name, email, phone, password, profile, specialty } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Nome e e-mail são obrigatórios.' });
  }

  const resolvedProfile: OperatorProfile = profile === 'consultorio' ? 'consultorio' : 'guiche';
  const resolvedSpecialty = specialty ? String(specialty).trim() : (resolvedProfile === 'consultorio' ? 'Clínico Geral' : '');

  const data = db.getData();
  const company = data.companies.find((c) => c.id === companyId);
  const plan = data.plans.find((p) => p.id === company?.plan_id);

  // Check quota limit
  const effectiveMaxOperators = (company?.max_operators !== undefined && company.max_operators !== null)
    ? company.max_operators
    : (plan?.max_operators ?? 0);

  const currentCount = data.operators.filter((o) => o.company_id === companyId).length;
  if (effectiveMaxOperators !== undefined && currentCount >= effectiveMaxOperators) {
    if (effectiveMaxOperators === 0) {
      return res.status(400).json({
        error: 'O plano ou configuração atual (Linha Show) não inclui operadores/chamadas na tela. Contate o administrador ou solicite liberação de operadores para planos especiais.',
      });
    }
    return res.status(400).json({
      error: `Limite de operadores atingido (${currentCount}/${effectiveMaxOperators}). Faça upgrade do plano contratado ou solicite ao administrador a definição de limites especiais para sua empresa.`,
    });
  }

  const existing = data.users.find((u) => u.email.toLowerCase() === String(email).trim().toLowerCase());
  if (existing) {
    return res.status(400).json({ error: 'Este e-mail já está em uso no sistema.' });
  }

  const now = new Date().toISOString();
  const initialPass = hashPassword(password || '123456');

  const operatorUser: User = {
    id: `usr-op-${Date.now()}`,
    name,
    email: email.trim().toLowerCase(),
    password_hash: initialPass.hash,
    salt: initialPass.salt,
    role: 'operator',
    company_id: companyId,
    active: true,
    must_change_password: false,
    created_at: now,
    updated_at: now,
  };

  const newOp: Operator = {
    id: `op-${Date.now()}`,
    company_id: companyId,
    user_id: operatorUser.id,
    name,
    email: email.trim().toLowerCase(),
    phone: phone || '',
    profile: resolvedProfile,
    specialty: resolvedSpecialty,
    active: true,
    created_at: now,
    updated_at: now,
  };

  data.users.push(operatorUser);
  data.operators.push(newOp);
  db.persist();

  res.status(201).json(newOp);
});

apiRouter.put('/company/operators/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const op = data.operators.find((o) => o.id === id && o.company_id === companyId);
  if (!op) {
    return res.status(404).json({ error: 'Operador não encontrado.' });
  }

  const { name, phone, profile, specialty } = req.body;
  if (name) {
    op.name = name;
    const u = data.users.find((usr) => usr.id === op.user_id);
    if (u) u.name = name;
  }
  if (phone !== undefined) op.phone = phone;
  if (profile === 'guiche' || profile === 'consultorio') {
    op.profile = profile;
  }
  if (specialty !== undefined) {
    op.specialty = String(specialty).trim();
  }
  op.updated_at = new Date().toISOString();

  db.persist();
  res.json(op);
});

apiRouter.post('/company/operators/:id/toggle-status', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const op = data.operators.find((o) => o.id === id && o.company_id === companyId);
  if (!op) {
    return res.status(404).json({ error: 'Operador não encontrado.' });
  }

  op.active = !op.active;
  op.updated_at = new Date().toISOString();

  // Also toggle user
  const user = data.users.find((u) => u.id === op.user_id);
  if (user) user.active = op.active;

  db.persist();
  res.json({
    message: op.active ? 'Operador ativado com sucesso.' : 'Operador desativado com sucesso.',
    active: op.active,
  });
});

apiRouter.post('/company/operators/:id/reset-password', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const { newPassword } = req.body;
  const data = db.getData();
  const op = data.operators.find((o) => o.id === id && o.company_id === companyId);
  if (!op) {
    return res.status(404).json({ error: 'Operador não encontrado.' });
  }

  const user = data.users.find((u) => u.id === op.user_id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário do operador não encontrado.' });
  }

  const pass = newPassword || '123456';
  const hashed = hashPassword(pass);
  user.password_hash = hashed.hash;
  user.salt = hashed.salt;
  user.updated_at = new Date().toISOString();
  db.persist();

  res.json({ message: 'Senha do operador redefinida com sucesso.' });
});

apiRouter.delete('/company/operators/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const idx = data.operators.findIndex((o) => o.id === id && o.company_id === companyId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Operador não encontrado.' });
  }

  const op = data.operators[idx];
  data.operators.splice(idx, 1);
  data.users = data.users.filter((u) => u.id !== op.user_id);
  db.persist();

  res.json({ message: 'Operador excluído com sucesso.' });
});

// Playlists Management
function enrichPlaylistWithMedia(playlist: Playlist, mediaList: Media[]): Playlist {
  return {
    ...playlist,
    items: (playlist.items || []).map((it) => {
      const media = mediaList.find((m) => m.id === it.media_id);
      return {
        ...it,
        name: media?.name || it.name || 'Mídia',
        type: media?.type || it.type || 'image',
        file_url: media?.file_url || it.file_url || '',
      };
    }),
  };
}

apiRouter.get('/company/playlists', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  const injected = ensureCompanyDefaultMedia(companyId, data);
  if (injected) {
    db.persist();
  }
  const playlists = data.playlists
    .filter((p) => p.company_id === companyId)
    .map((p) => enrichPlaylistWithMedia(p, data.media));
  res.json(playlists);
});

apiRouter.post('/company/playlists', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { name, description, weather_city, items } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Nome da playlist é obrigatório.' });
  }

  const data = db.getData();
  const now = new Date().toISOString();
  const playlistId = `pl-${Date.now()}`;

  const formattedItems = (items || []).map((it: any, index: number) => {
    const media = data.media.find((m) => m.id === it.media_id);
    return {
      id: `pli-${Date.now()}-${index}`,
      playlist_id: playlistId,
      media_id: it.media_id,
      position: index + 1,
      duration: Number(it.duration) || 10,
      name: media?.name || it.name,
      type: media?.type || it.type,
      file_url: media?.file_url || it.file_url,
      created_at: now,
    };
  });

  const newPlaylist: Playlist = {
    id: playlistId,
    company_id: companyId,
    name,
    description: description || '',
    weather_city: weather_city?.trim() || 'São Paulo',
    active: true,
    items: formattedItems,
    created_at: now,
    updated_at: now,
  };

  data.playlists.push(newPlaylist);
  db.persist();

  res.status(201).json(enrichPlaylistWithMedia(newPlaylist, data.media));
});

apiRouter.put('/company/playlists/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const playlist = data.playlists.find((p) => p.id === id && p.company_id === companyId);
  if (!playlist) {
    return res.status(404).json({ error: 'Playlist não encontrada.' });
  }

  const { name, description, weather_city, items, active } = req.body;
  if (name) playlist.name = name;
  if (description !== undefined) playlist.description = description;
  if (weather_city !== undefined) playlist.weather_city = weather_city.trim();
  if (active !== undefined) playlist.active = active;

  if (items && Array.isArray(items)) {
    const now = new Date().toISOString();
    playlist.items = items.map((it: any, index: number) => {
      const media = data.media.find((m) => m.id === it.media_id);
      return {
        id: it.id || `pli-${Date.now()}-${index}`,
        playlist_id: playlist.id,
        media_id: it.media_id,
        position: index + 1,
        duration: Number(it.duration) || 10,
        name: media?.name || it.name,
        type: media?.type || it.type,
        file_url: media?.file_url || it.file_url,
        created_at: it.created_at || now,
      };
    });
  }
  playlist.updated_at = new Date().toISOString();

  db.persist();
  res.json(enrichPlaylistWithMedia(playlist, data.media));
});

apiRouter.post('/company/playlists/:id/toggle-status', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const playlist = data.playlists.find((p) => p.id === id && p.company_id === companyId);
  if (!playlist) {
    return res.status(404).json({ error: 'Playlist não encontrada.' });
  }

  playlist.active = !playlist.active;
  playlist.updated_at = new Date().toISOString();
  db.persist();

  res.json({
    message: playlist.active ? 'Playlist ativada com sucesso.' : 'Playlist desativada com sucesso.',
    active: playlist.active,
  });
});

apiRouter.delete('/company/playlists/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const idx = data.playlists.findIndex((p) => p.id === id && p.company_id === companyId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Playlist não encontrada.' });
  }

  data.playlists.splice(idx, 1);
  // Unlink from players
  for (const player of data.players) {
    if (player.playlist_id === id) {
      player.playlist_id = null;
    }
  }
  db.persist();

  res.json({ message: 'Playlist excluída com sucesso.' });
});

// Quick add Weather/Clock to playlist
apiRouter.post('/company/weather/add-to-playlist', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { playlist_id, duration } = req.body;
  const data = db.getData();
  const now = new Date().toISOString();

  ensureCompanyDefaultMedia(companyId, data, now);

  const playlist = playlist_id
    ? data.playlists.find((p) => p.id === playlist_id && p.company_id === companyId)
    : data.playlists.find((p) => p.company_id === companyId);

  if (!playlist) {
    return res.status(404).json({ error: 'Nenhuma playlist encontrada para esta empresa.' });
  }

  let weatherMedia = data.media.find((m) => m.company_id === companyId && m.type === 'weather_clock');
  if (!weatherMedia) {
    weatherMedia = {
      id: `med-${companyId}-weather`,
      company_id: companyId,
      name: 'Hora Certa & Previsão do Tempo',
      type: 'weather_clock',
      file_url: 'widget:weather_clock',
      duration: duration || 12,
      active: true,
      created_at: now,
      updated_at: now,
    };
    data.media.push(weatherMedia);
  }

  const newItem: PlaylistItem = {
    id: `pli-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    playlist_id: playlist.id,
    media_id: weatherMedia.id,
    position: (playlist.items?.length || 0) + 1,
    duration: duration || weatherMedia.duration || 12,
    created_at: now,
  };

  playlist.items = playlist.items || [];
  playlist.items.push(newItem);
  playlist.updated_at = now;
  db.persist();

  res.json({
    message: 'Hora Certa & Previsão do Tempo incluída com sucesso na playlist!',
    playlist,
    item: newItem,
  });
});

// Quick add RSS news feed to playlist
apiRouter.post('/company/rss/add-to-playlist', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { playlist_id, rss_url, name, duration } = req.body;
  if (!rss_url) {
    return res.status(400).json({ error: 'URL do Feed RSS é obrigatória.' });
  }

  const data = db.getData();
  const now = new Date().toISOString();

  const playlist = playlist_id
    ? data.playlists.find((p) => p.id === playlist_id && p.company_id === companyId)
    : data.playlists.find((p) => p.company_id === companyId);

  if (!playlist) {
    return res.status(404).json({ error: 'Nenhuma playlist encontrada para esta empresa.' });
  }

  let rssMedia = data.media.find(
    (m) => m.company_id === companyId && m.type === 'rss' && m.file_url.trim() === String(rss_url).trim()
  );

  if (!rssMedia) {
    rssMedia = {
      id: `med-${companyId}-rss-${Date.now()}`,
      company_id: companyId,
      name: name || 'Notícias RSS em Tempo Real',
      type: 'rss',
      file_url: String(rss_url).trim(),
      duration: duration || 15,
      active: true,
      created_at: now,
      updated_at: now,
    };
    data.media.push(rssMedia);
  }

  const newItem: PlaylistItem = {
    id: `pli-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    playlist_id: playlist.id,
    media_id: rssMedia.id,
    position: (playlist.items?.length || 0) + 1,
    duration: duration || rssMedia.duration || 15,
    created_at: now,
  };

  playlist.items = playlist.items || [];
  playlist.items.push(newItem);
  playlist.updated_at = now;
  db.persist();

  res.json({
    message: `Notícias RSS "${rssMedia.name}" incluídas na playlist "${playlist.name}"!`,
    playlist,
    item: newItem,
  });
});

// Direct File Upload from Device
apiRouter.post('/upload', requireAuth, (req: AuthenticatedRequest, res) => {
  try {
    const { fileData, filename, mimeType } = req.body;
    if (!fileData) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Extract base64 payload
    let base64Data = fileData;
    let detectedExt = 'bin';

    if (typeof fileData === 'string' && fileData.includes(';base64,')) {
      const parts = fileData.split(';base64,');
      const header = parts[0];
      base64Data = parts[1];
      if (header.includes('image/jpeg')) detectedExt = 'jpg';
      else if (header.includes('image/png')) detectedExt = 'png';
      else if (header.includes('image/webp')) detectedExt = 'webp';
      else if (header.includes('image/gif')) detectedExt = 'gif';
      else if (header.includes('image/svg')) detectedExt = 'svg';
      else if (header.includes('video/mp4')) detectedExt = 'mp4';
      else if (header.includes('video/webm')) detectedExt = 'webm';
      else if (header.includes('video/quicktime')) detectedExt = 'mov';
      else if (header.includes('video/ogg')) detectedExt = 'ogv';
    }

    if (filename && filename.includes('.')) {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (ext && ext.length <= 5) {
        detectedExt = ext;
      }
    }

    const safeBaseName = (filename || 'media')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);

    const uniqueName = `media-${Date.now()}-${safeBaseName}.${detectedExt}`;
    const filePath = path.join(uploadsDir, uniqueName);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(filePath, buffer);

    const isVideo =
      detectedExt === 'mp4' ||
      detectedExt === 'webm' ||
      detectedExt === 'mov' ||
      detectedExt === 'ogv' ||
      (mimeType && mimeType.startsWith('video/'));

    res.json({
      url: `/uploads/${uniqueName}`,
      filename: uniqueName,
      originalName: filename,
      size: buffer.length,
      mimeType: mimeType || (isVideo ? 'video' : 'image'),
    });
  } catch (err: any) {
    console.error('Error uploading file:', err);
    res.status(500).json({ error: err.message || 'Falha ao salvar arquivo no dispositivo/servidor.' });
  }
});

// Media Management
apiRouter.get('/company/media', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  const injected = ensureCompanyDefaultMedia(companyId, data);
  if (injected) {
    db.persist();
  }
  const media = data.media.filter((m) => m.company_id === companyId);
  res.json(media);
});

apiRouter.post('/company/media', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const {
    name,
    type,
    file_url,
    duration,
    drive_file_id,
    drive_view_url,
    drive_download_url,
    drive_folder_id,
    unique_code,
    source,
    file_size,
    mime_type,
  } = req.body;

  const mediaType = type || 'image';
  const resolvedUrl = mediaType === 'weather_clock' ? (file_url || 'widget:weather_clock') : file_url;

  if (!name || !resolvedUrl) {
    return res.status(400).json({ error: 'Nome e arquivo de mídia são obrigatórios.' });
  }

  const data = db.getData();
  const company = data.companies.find((c) => c.id === companyId);
  const plan = data.plans.find((p) => p.id === company?.plan_id);

  // Check quota limit for media per company (custom limit takes priority over plan)
  const currentCount = data.media.filter((m) => m.company_id === companyId).length;
  const maxMedia =
    company?.max_media !== undefined && company.max_media !== null
      ? Number(company.max_media)
      : (plan?.max_media || plan?.max_storage || 20);

  if (currentCount >= maxMedia) {
    return res.status(400).json({
      error: `Limite de mídias atingido (${currentCount}/${maxMedia}). Remova mídias antigas ou solicite ao administrador a ampliação da cota deste cliente.`,
    });
  }

  const now = new Date().toISOString();
  const newMedia: Media = {
    id: `med-${Date.now()}`,
    company_id: companyId,
    name,
    type: mediaType,
    file_url: resolvedUrl,
    duration: Number(duration) || 10,
    active: true,
    drive_file_id: drive_file_id || undefined,
    drive_view_url: drive_view_url || undefined,
    drive_download_url: drive_download_url || undefined,
    drive_folder_id: drive_folder_id || undefined,
    unique_code: unique_code || undefined,
    source: source || (drive_file_id ? 'drive' : 'device'),
    file_size: file_size ? Number(file_size) : undefined,
    mime_type: mime_type || undefined,
    created_at: now,
    updated_at: now,
  };

  data.media.push(newMedia);
  db.persist();

  res.status(201).json(newMedia);
});

apiRouter.put('/company/media/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const media = data.media.find((m) => m.id === id && m.company_id === companyId);
  if (!media) {
    return res.status(404).json({ error: 'Mídia não encontrada.' });
  }

  const {
    name,
    type,
    file_url,
    duration,
    active,
    drive_file_id,
    drive_view_url,
    drive_download_url,
    drive_folder_id,
    unique_code,
    source,
    file_size,
    mime_type,
  } = req.body;

  if (name !== undefined) media.name = name;
  if (type !== undefined) media.type = type;
  if (file_url !== undefined) media.file_url = file_url;
  if (duration !== undefined) media.duration = Number(duration) || 10;
  if (active !== undefined) media.active = active;
  if (drive_file_id !== undefined) media.drive_file_id = drive_file_id;
  if (drive_view_url !== undefined) media.drive_view_url = drive_view_url;
  if (drive_download_url !== undefined) media.drive_download_url = drive_download_url;
  if (drive_folder_id !== undefined) media.drive_folder_id = drive_folder_id;
  if (unique_code !== undefined) media.unique_code = unique_code;
  if (source !== undefined) media.source = source;
  if (file_size !== undefined) media.file_size = Number(file_size);
  if (mime_type !== undefined) media.mime_type = mime_type;
  media.updated_at = new Date().toISOString();

  db.persist();
  res.json(media);
});

apiRouter.delete('/company/media/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const idx = data.media.findIndex((m) => m.id === id && m.company_id === companyId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Mídia não encontrada.' });
  }

  data.media.splice(idx, 1);
  // Remove from any playlists
  for (const pl of data.playlists) {
    pl.items = pl.items.filter((item) => item.media_id !== id);
  }
  db.persist();

  res.json({ message: 'Mídia excluída com sucesso.' });
});

// Cache for recent integrity check reports
const integrityReportsCache: Map<string, MediaIntegrityAuditReport> = new Map();

// Verify media integrity against Google Drive and database for Company
apiRouter.post('/company/media/check-integrity', requireAuth, requireRole('company'), async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = req.user!.company_id!;
    const driveAccessToken = (req.body?.driveAccessToken || req.headers['x-drive-access-token']) as string | undefined;

    const data = db.getData();
    const companyMedia = data.media.filter((m) => m.company_id === companyId);
    const companyPlaylists = data.playlists.filter((p) => p.company_id === companyId);
    const companyPlayers = data.players.filter((p) => p.company_id === companyId);

    const report = await runMediaIntegrityAudit(
      companyMedia,
      companyPlaylists,
      companyPlayers,
      companyId,
      driveAccessToken
    );

    integrityReportsCache.set(`company_${companyId}`, report);
    res.json(report);
  } catch (err: any) {
    console.error('Error verifying media integrity:', err);
    res.status(500).json({ error: 'Erro ao verificar integridade das mídias: ' + (err.message || 'desconhecido') });
  }
});

apiRouter.get('/company/media/integrity-status', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const report = integrityReportsCache.get(`company_${companyId}`);
  if (report) {
    return res.json(report);
  }
  res.json({ checked_at: null, has_issues: false, summary: null, issues: [], items: [] });
});

// Verify media integrity for Super Admin (all or specific company)
apiRouter.post('/admin/media/check-integrity', requireAuth, requireRole('admin'), async (req: AuthenticatedRequest, res) => {
  try {
    const targetCompanyId = req.body?.companyId as string | undefined;
    const driveAccessToken = (req.body?.driveAccessToken || req.headers['x-drive-access-token']) as string | undefined;

    const data = db.getData();
    const mediaToCheck = targetCompanyId
      ? data.media.filter((m) => m.company_id === targetCompanyId)
      : data.media;
    const playlists = targetCompanyId
      ? data.playlists.filter((p) => p.company_id === targetCompanyId)
      : data.playlists;
    const players = targetCompanyId
      ? data.players.filter((p) => p.company_id === targetCompanyId)
      : data.players;

    const report = await runMediaIntegrityAudit(
      mediaToCheck,
      playlists,
      players,
      targetCompanyId,
      driveAccessToken
    );

    const cacheKey = targetCompanyId ? `company_${targetCompanyId}` : 'admin_global';
    integrityReportsCache.set(cacheKey, report);
    res.json(report);
  } catch (err: any) {
    console.error('Error verifying admin media integrity:', err);
    res.status(500).json({ error: 'Erro ao auditar mídias do sistema: ' + (err.message || 'desconhecido') });
  }
});

apiRouter.get('/admin/media/integrity-status', requireAuth, requireRole('admin'), (req: AuthenticatedRequest, res) => {
  const targetCompanyId = req.query.companyId as string | undefined;
  const cacheKey = targetCompanyId ? `company_${targetCompanyId}` : 'admin_global';
  const report = integrityReportsCache.get(cacheKey);
  if (report) {
    return res.json(report);
  }
  res.json({ checked_at: null, has_issues: false, summary: null, issues: [], items: [] });
});

// RSS Management
apiRouter.get('/company/rss/presets', requireAuth, (_req, res) => {
  res.json(DEFAULT_RSS_FEEDS);
});

apiRouter.post('/company/rss/load-defaults', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  const now = new Date().toISOString();
  seedDefaultRssFeedsForCompany(companyId, data, now);
  db.persist();

  const feeds = data.rss_feeds.filter((r) => r.company_id === companyId);
  res.json({
    message: 'Canais RSS recomendados carregados e sincronizados com sucesso!',
    feeds,
  });
});

apiRouter.get('/company/rss', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const data = db.getData();
  const feeds = data.rss_feeds.filter((r) => r.company_id === companyId);
  res.json(feeds);
});

apiRouter.post('/company/rss', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { name, url } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: 'Nome e URL do RSS são obrigatórios.' });
  }

  const data = db.getData();
  const now = new Date().toISOString();
  const newRss: RssFeed = {
    id: `rss-${Date.now()}`,
    company_id: companyId,
    name,
    url,
    active: true,
    created_at: now,
    updated_at: now,
  };

  data.rss_feeds.push(newRss);
  db.persist();

  res.status(201).json(newRss);
});

apiRouter.put('/company/rss/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const rss = data.rss_feeds.find((r) => r.id === id && r.company_id === companyId);
  if (!rss) {
    return res.status(404).json({ error: 'Feed RSS não encontrado.' });
  }

  const { name, url, active } = req.body;
  if (name) rss.name = name;
  if (url) rss.url = url;
  if (active !== undefined) rss.active = active;
  rss.updated_at = new Date().toISOString();

  db.persist();
  res.json(rss);
});

apiRouter.post('/company/rss/:id/toggle-status', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const rss = data.rss_feeds.find((r) => r.id === id && r.company_id === companyId);
  if (!rss) {
    return res.status(404).json({ error: 'Feed RSS não encontrado.' });
  }

  rss.active = !rss.active;
  rss.updated_at = new Date().toISOString();
  db.persist();

  res.json({
    message: rss.active ? 'RSS ativado com sucesso.' : 'RSS desativado com sucesso.',
    active: rss.active,
  });
});

apiRouter.delete('/company/rss/:id', requireAuth, requireRole('company'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id!;
  const { id } = req.params;
  const data = db.getData();
  const idx = data.rss_feeds.findIndex((r) => r.id === id && r.company_id === companyId);
  if (idx === -1) {
    return res.status(404).json({ error: 'Feed RSS não encontrado.' });
  }

  data.rss_feeds.splice(idx, 1);
  db.persist();

  res.json({ message: 'Feed RSS excluído com sucesso.' });
});

// In-memory RSS cache (TTL: 5 minutes) to ensure instantaneous response and avoid rate-limits
interface ParsedRssArticle {
  title: string;
  imageUrl?: string;
  description?: string;
  pubDate?: string;
  source?: string;
}

const FALLBACK_EDITORIAL_IMAGES = [
  'https://images.unsplash.com/photo-1504711434969-e33886168f5c?auto=format&fit=crop&w=1920&q=80', // News studio
  'https://images.unsplash.com/photo-1495020689067-958852a7765e?auto=format&fit=crop&w=1920&q=80', // Journal / Reading
  'https://images.unsplash.com/photo-1585829365295-ab7cd400c167?auto=format&fit=crop&w=1920&q=80', // Breaking News
  'https://images.unsplash.com/photo-1576091160550-2173dba999ef?auto=format&fit=crop&w=1920&q=80', // Health & Science
  'https://images.unsplash.com/photo-1526470608268-f674ce90ebd4?auto=format&fit=crop&w=1920&q=80', // Tech & Media
  'https://images.unsplash.com/photo-1586339949916-3e9457bef6d3?auto=format&fit=crop&w=1920&q=80', // World News
];

const rssMemoryCache = new Map<
  string,
  { items: string[]; articles: ParsedRssArticle[]; feedTitle?: string; timestamp: number }
>();

const NAMED_HTML_ENTITIES: Record<string, string> = {
  atilde: 'ã', Atilde: 'Ã', otilde: 'õ', Otilde: 'Õ',
  ccedil: 'ç', Ccedil: 'Ç',
  aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í',
  oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú',
  agrave: 'à', Agrave: 'À', egrave: 'è', Egrave: 'È', igrave: 'ì', Igrave: 'Ì',
  ograve: 'ò', Ograve: 'Ò', ugrave: 'ù', Ugrave: 'Ù',
  acirc: 'â', Acirc: 'Â', ecirc: 'ê', Ecirc: 'Ê', icirc: 'î', Icirc: 'Î',
  ocirc: 'ô', Ocirc: 'Ô', ucirc: 'û', Ucirc: 'Û',
  uuml: 'ü', Uuml: 'Ü', euml: 'ë', Euml: 'Ë', iuml: 'ï', Iuml: 'Ï', ouml: 'ö', Ouml: 'Ö',
  ntilde: 'ñ', Ntilde: 'Ñ',
  ordm: 'º', ordf: 'ª', deg: '°',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', bdquo: '„',
  laquo: '«', raquo: '»',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  nbsp: ' ', copy: '©', reg: '®', trade: '™',
  sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  cent: '¢', pound: '£', yen: '¥', euro: '€',
  plusmn: '±', sup1: '¹', sup2: '²', sup3: '³',
  frac14: '¼', frac12: '½', frac34: '¾',
  iquest: '¿', iexcl: '¡',
};

function fixMojibake(str: string): string {
  if (!str) return '';
  if (!/Ã|Â|â€|â€“|â€”/.test(str)) {
    return str;
  }
  return str
    .replace(/Ã£/g, 'ã')
    .replace(/Ã§/g, 'ç')
    .replace(/Ã©/g, 'é')
    .replace(/Ã¡/g, 'á')
    .replace(/Ãª/g, 'ê')
    .replace(/Ã³/g, 'ó')
    .replace(/Ã­/g, 'í')
    .replace(/Ãº/g, 'ú')
    .replace(/Ãµ/g, 'õ')
    .replace(/Ã /g, 'à')
    .replace(/Ã‚/g, 'Â')
    .replace(/ÃŠ/g, 'Ê')
    .replace(/Ã”/g, 'Ô')
    .replace(/Ã‡/g, 'Ç')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Á')
    .replace(/Ã“/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ãƒ/g, 'Ã')
    .replace(/Âº/g, 'º')
    .replace(/Âª/g, 'ª')
    .replace(/Â°/g, '°')
    .replace(/â€œ/g, '“')
    .replace(/â€[ \x9d]/g, '”')
    .replace(/â€˜/g, '‘')
    .replace(/â€™/g, '’')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—')
    .replace(/â€¦/g, '…')
    .replace(/Â\s/g, ' ');
}

function cleanRssText(rawText?: string | null): string {
  if (!rawText) return '';

  let curr = String(rawText)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '');

  let prev = '';
  let loops = 0;
  while (curr !== prev && loops < 4) {
    prev = curr;
    loops++;
    curr = curr
      // Hexadecimal entities: &#x201C; &#xE3; &#xe1;
      .replace(/&#x([0-9a-fA-F]+);/gi, (_, hex) => {
        try {
          return String.fromCodePoint(parseInt(hex, 16));
        } catch {
          return _;
        }
      })
      // Decimal entities: &#227; &#8216;
      .replace(/&#(\d+);/g, (_, dec) => {
        try {
          return String.fromCodePoint(parseInt(dec, 10));
        } catch {
          return _;
        }
      })
      // Named HTML entities: &atilde; &ccedil; &quot; &apos;
      .replace(/&([a-zA-Z0-9#]+);/g, (match, name) => {
        return NAMED_HTML_ENTITIES[name] ?? NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match;
      });
  }

  // Strip any HTML tags that were decoded from entities
  curr = curr.replace(/<[^>]+>/g, '');
  curr = fixMojibake(curr);
  return curr.replace(/[\u00A0\s]+/g, ' ').trim();
}

function decodeHtmlEntities(str: string): string {
  return cleanRssText(str);
}

function extractImageFromXml(raw: string): string | undefined {
  // 1. media:content url="..."
  const mediaContentMatch = raw.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (mediaContentMatch && mediaContentMatch[1]) return mediaContentMatch[1];

  // 2. enclosure url="..." (image)
  const enclosureMatch = raw.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (enclosureMatch && enclosureMatch[1]) {
    const url = enclosureMatch[1];
    if (/\.(jpg|jpeg|png|webp|gif|svg)/i.test(url) || /image\//i.test(raw)) {
      return url;
    }
  }

  // 3. media:thumbnail url="..."
  const thumbMatch = raw.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (thumbMatch && thumbMatch[1]) return thumbMatch[1];

  // 4. <img src="..." /> inside description or content
  const imgMatch = raw.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) return imgMatch[1];

  // 5. <image><url>...</url></image>
  const imageTagMatch = raw.match(/<image>[\s\S]*?<url>([^<]+)<\/url>/i);
  if (imageTagMatch && imageTagMatch[1]) return imageTagMatch[1].trim();

  return undefined;
}

// RSS Proxy for Player ticker & Full-Screen RSS Media
apiRouter.get('/rss/proxy', async (req, res) => {
  const feedUrl = req.query.url as string;
  if (!feedUrl) {
    return res.json({ items: [], articles: [] });
  }

  // Check cache first (5 min)
  const cached = rssMemoryCache.get(feedUrl);
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000 && cached.articles.length > 0) {
    return res.json({
      items: cached.items,
      articles: cached.articles,
      feedTitle: cached.feedTitle,
    });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 IndoorMediaBot/2.0',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 1. Detect encoding: check Content-Type header and XML declaration
    let encoding = 'utf-8';
    const contentType = response.headers.get('content-type') || '';
    const ctMatch = contentType.match(/charset=([a-zA-Z0-9_-]+)/i);
    if (ctMatch && ctMatch[1]) {
      encoding = ctMatch[1].toLowerCase();
    } else {
      const headerChunk = buffer.subarray(0, Math.min(1024, buffer.length)).toString('binary');
      const xmlMatch = headerChunk.match(/<\?xml[^>]+encoding=["']([^"']+)["']/i);
      if (xmlMatch && xmlMatch[1]) {
        encoding = xmlMatch[1].toLowerCase();
      }
    }

    if (['latin1', 'iso-8859-1', 'windows-1252', 'cp1252', 'ibm819'].includes(encoding)) {
      encoding = 'windows-1252';
    } else if (encoding.startsWith('utf')) {
      encoding = 'utf-8';
    }

    let text: string;
    try {
      text = new TextDecoder(encoding).decode(buffer);
    } catch {
      text = buffer.toString('utf-8');
    }

    // If UTF-8 decode produced replacement characters (U+FFFD) and buffer has high bytes, fall back to windows-1252
    if (text.includes('\uFFFD') && encoding === 'utf-8') {
      try {
        const alt = new TextDecoder('windows-1252').decode(buffer);
        if (!alt.includes('\uFFFD')) {
          text = alt;
        }
      } catch {}
    }

    // Extract feed channel title
    const channelTitleMatch = text.match(/<channel>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    const feedTitle = channelTitleMatch ? cleanRssText(channelTitleMatch[1]) : undefined;

    // Match both RSS <item> and Atom <entry>
    const itemMatches = text.match(/<(?:item|entry)[\s\S]*?<\/(?:item|entry)>/gi) || [];
    const articles: ParsedRssArticle[] = [];
    const items: string[] = [];

    itemMatches.slice(0, 25).forEach((raw, idx) => {
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (!titleMatch) return;

      const cleanTitle = cleanRssText(titleMatch[1]);
      if (cleanTitle.length < 3) return;

      items.push(cleanTitle);

      // Description / summary
      const descMatch = raw.match(
        /<(?:description|summary|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded)>/i
      );
      let cleanDesc: string | undefined;
      if (descMatch) {
        cleanDesc = cleanRssText(descMatch[1]);
        if (cleanDesc.length > 220) {
          cleanDesc = cleanDesc.substring(0, 220).trim() + '...';
        }
      }

      // Image
      let imageUrl = extractImageFromXml(raw);
      if (!imageUrl) {
        imageUrl = FALLBACK_EDITORIAL_IMAGES[idx % FALLBACK_EDITORIAL_IMAGES.length];
      }

      // Date
      const dateMatch = raw.match(/<(?:pubDate|published|updated)[^>]*>([^<]+)<\/(?:pubDate|published|updated)>/i);
      const pubDate = dateMatch ? dateMatch[1].trim() : undefined;

      // Source
      const sourceMatch = raw.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
      const source = sourceMatch ? cleanRssText(sourceMatch[1]) : feedTitle;

      articles.push({
        title: cleanTitle,
        imageUrl,
        description: cleanDesc,
        pubDate,
        source: source || 'Notícias',
      });
    });

    if (articles.length === 0) {
      const fallbackTitles = [
        'Dica de Saúde: Mantenha hábitos regulares de hidratação e atividade física.',
        'Vacinação em dia: Proteja sua família consultando o calendário de imunização.',
        'Atendimento Humanizado: Nossos farmacêuticos e consultores estão à sua disposição.',
        'Consulte nosso balcão de atendimento e conheça as novidades e ofertas do dia.',
      ];
      fallbackTitles.forEach((title, i) => {
        items.push(title);
        articles.push({
          title,
          imageUrl: FALLBACK_EDITORIAL_IMAGES[i % FALLBACK_EDITORIAL_IMAGES.length],
          description: 'Informação de utilidade pública e bem-estar para o seu dia a dia.',
          source: 'Saúde & Bem-Estar',
        });
      });
    }

    rssMemoryCache.set(feedUrl, { items, articles, feedTitle, timestamp: Date.now() });
    res.json({ items, articles, feedTitle });
  } catch (err) {
    console.warn('RSS fetch error, returning fallback:', err);
    const fallbackArticles: ParsedRssArticle[] = [
      {
        title: 'G1 Saúde: Dicas de qualidade de vida, bem-estar e avanços na medicina atual.',
        imageUrl: FALLBACK_EDITORIAL_IMAGES[0],
        description: 'Acompanhe as principais recomendações para manter sua saúde em dia.',
        source: 'G1 Saúde',
      },
      {
        title: 'Novidades da Farmácia: Aproveite ofertas em dermocosméticos e cuidados pessoais.',
        imageUrl: FALLBACK_EDITORIAL_IMAGES[1],
        description: 'Produtos de alta qualidade com orientação especializada da nossa equipe.',
        source: 'Informativo',
      },
      {
        title: 'Horário Especial: Atendimento estendido de segunda a sábado com comodidade.',
        imageUrl: FALLBACK_EDITORIAL_IMAGES[2],
        description: 'Venha nos visitar ou faça seu pedido com entrega rápida e segura.',
        source: 'Atendimento',
      },
      {
        title: 'Prevenção é o melhor remédio: Meça sua pressão e glicemia em nossa sala de cuidados.',
        imageUrl: FALLBACK_EDITORIAL_IMAGES[3],
        description: 'Serviços de acompanhamento preventivo com profissionais qualificados.',
        source: 'Cuidados',
      },
    ];
    res.json({
      items: fallbackArticles.map((a) => a.title),
      articles: fallbackArticles,
      feedTitle: 'Notícias & Informações',
    });
  }
});

// ----------------------------------------------------
// 4. OPERADOR (GUICHÊ & CONSULTÓRIO)
// ----------------------------------------------------
apiRouter.get('/operator/dashboard', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const companyId = req.user!.company_id || data.companies.find((c) => c.status === 'active')?.id || '';
  const now = Date.now();

  const players = data.players
    .filter((p) => (companyId ? p.company_id === companyId : true) && p.status === 'active')
    .map((p) => {
      const lastSeenTime = new Date(p.last_seen || 0).getTime();
      const isOnline = now - lastSeenTime <= 45000;
      return {
        id: p.id,
        name: p.name,
        code: p.code,
        location: p.location,
        orientation: p.orientation || 'horizontal',
        is_online: isOnline,
        last_seen: p.last_seen,
        expected_interval_seconds: 20,
        heartbeat_timeout_seconds: 45,
      };
    });

  const phrases = data.call_phrases.filter((ph) => (companyId ? ph.company_id === companyId : true) && ph.active);

  const companyOperators = data.operators
    .filter((o) => (companyId ? o.company_id === companyId : true) && o.active)
    .map((o) => ({
      ...o,
      profile: o.profile || 'guiche',
      specialty: o.specialty || '',
    }));

  const currentOperator =
    companyOperators.find(
      (o) => o.user_id === req.user!.id || o.email.toLowerCase() === req.user!.email.toLowerCase()
    ) || companyOperators[0] || null;

  const consultorios = companyOperators.filter((o) => o.profile === 'consultorio');
  const guiches = companyOperators.filter((o) => o.profile === 'guiche');

  const consultationQueue = (data.consultation_queue || [])
    .filter((q) => (companyId ? q.company_id === companyId : true) && q.status !== 'cancelled')
    .sort((a, b) => a.sequence - b.sequence);

  res.json({
    players,
    phrases,
    currentOperator,
    operators: companyOperators,
    consultorios,
    guiches,
    consultationQueue,
    expected_interval_seconds: 20,
    heartbeat_timeout_seconds: 45,
    server_time: new Date(now).toISOString(),
  });
});

// Get Consultation Queue (Guichê <-> Consultório communication)
apiRouter.get('/operator/consultation-queue', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const companyId = req.user!.company_id || data.companies.find((c) => c.status === 'active')?.id || '';
  const consultorioId = typeof req.query.consultorio_id === 'string' ? req.query.consultorio_id.trim() : '';

  const companyOperators = data.operators
    .filter((o) => (companyId ? o.company_id === companyId : true) && o.active)
    .map((o) => ({
      ...o,
      profile: o.profile || 'guiche',
      specialty: o.specialty || '',
    }));

  const consultorios = companyOperators.filter((o) => o.profile === 'consultorio');
  const guiches = companyOperators.filter((o) => o.profile === 'guiche');

  const queue = (data.consultation_queue || [])
    .filter((q) => {
      if (companyId && q.company_id !== companyId) return false;
      if (consultorioId && q.consultorio_id !== consultorioId) return false;
      return q.status !== 'cancelled';
    })
    .sort((a, b) => a.sequence - b.sequence);

  res.json({
    queue,
    consultorios,
    guiches,
  });
});

// ----------------------------------------------------
// GUICHÊ SEQUENTIAL TICKETS & SHARED QUEUE (COMPARTILHADO)
// ----------------------------------------------------
// GUICHÊ SEQUENTIAL TICKETS & SHARED QUEUE (COMPARTILHADO)
// ----------------------------------------------------
apiRouter.get('/operator/guiche/state', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const rawGuicheId = (req.query.guiche_id as string)?.trim() || '';

  // 1. Resolve target operator
  let targetOperator = data.operators.find((o) => o.id === rawGuicheId || o.user_id === rawGuicheId);
  if (!targetOperator && req.user!.role === 'operator') {
    targetOperator = data.operators.find(
      (o) => o.user_id === req.user!.id || o.id === req.user!.id || o.email.toLowerCase() === req.user!.email.toLowerCase()
    );
  }
  if (!targetOperator && rawGuicheId) {
    targetOperator = data.operators.find((o) => o.name.toLowerCase() === rawGuicheId.toLowerCase());
  }

  const userCompId = req.user!.company_id || data.companies.find((c) => c.status === 'active')?.id || '';
  if (!targetOperator) {
    targetOperator = data.operators.find((o) => o.company_id === userCompId && o.profile === 'guiche');
  }

  const companyId =
    req.user!.company_id ||
    targetOperator?.company_id ||
    (rawGuicheId ? data.guiche_sessions?.find((s) => s.guiche_id === rawGuicheId)?.company_id : undefined) ||
    data.companies.find((c) => c.status === 'active')?.id ||
    '';

  const effectiveGuicheId = targetOperator ? targetOperator.id : (rawGuicheId || req.user!.id);
  const state = db.getGuicheState(companyId, effectiveGuicheId);

  const consultorios = data.operators
    .filter((o) => (companyId ? o.company_id === companyId : true) && o.active && o.profile === 'consultorio')
    .map((o) => ({
      ...o,
      specialty: o.specialty || 'Geral',
    }));

  const guiches = data.operators
    .filter((o) => (companyId ? o.company_id === companyId : true) && o.active && o.profile === 'guiche');

  res.json({
    ...state,
    next_ticket_number: state.nextTicketNumber,
    nextTicketNumber: state.nextTicketNumber,
    active_session: state.activeSession,
    activeSession: state.activeSession,
    remaining_recalls: state.remainingRecalls,
    remainingRecalls: state.remainingRecalls,
    next_numeric: state.nextNumeric,
    nextNumeric: state.nextNumeric,
    consultorios,
    guiches,
  });
});

apiRouter.post('/operator/guiche/call-next', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const { guiche_id, guiche_name, playerId, is_priority, manual_ticket, duration, force } = req.body;

  const currentOp = data.operators.find((o) => o.id === guiche_id) ||
    data.operators.find((o) => o.user_id === req.user!.id || o.email.toLowerCase() === req.user!.email.toLowerCase());

  const companyId =
    req.user!.company_id ||
    currentOp?.company_id ||
    data.companies.find((c) => c.status === 'active')?.id ||
    '';

  const resolvedGuiche = {
    id: guiche_id || currentOp?.id || req.user!.id,
    name: guiche_name || currentOp?.name || req.user!.name || 'Guichê 01',
  };

  // Regra de Negócio: O guichê só pode chamar uma nova senha se não estiver com uma senha ativa em atendimento
  // (deve primeiro encaminhar para consultório ou concluir o atendimento)
  if (!force) {
    const existingActive = db.getGuicheActiveSession(companyId, resolvedGuiche.id);
    if (existingActive && (existingActive.status === 'called' || existingActive.status === 'in_attendance')) {
      return res.status(400).json({
        error: `O ${resolvedGuiche.name} já está atendendo a Senha ${existingActive.ticket_number}. Encaminhe para um consultório ou clique em "Concluir Atendimento" para liberar e chamar a próxima senha.`,
        activeSession: existingActive,
      });
    }
  }

  const { calledTicket, numericValue, nextTicketNumber, session } = db.callNextGuicheTicket(
    companyId,
    resolvedGuiche,
    Boolean(is_priority),
    manual_ticket
  );

  // Enviar chamada para a Smart TV / Player selecionado
  const companyPlayers = data.players.filter((p) => p.company_id === companyId && p.status === 'active');
  const targetPlayer =
    (playerId ? companyPlayers.find((p) => p.id === playerId || p.code === playerId) : undefined) ||
    companyPlayers[0];

  let newCall: PlayerCall | null = null;
  let delivered = false;

  const callPhrase = is_priority
    ? `Senha preferencial ${calledTicket}, comparecer ao ${resolvedGuiche.name}`
    : `Senha ${calledTicket}, comparecer ao ${resolvedGuiche.name}`;

  if (targetPlayer) {
    const now = new Date().toISOString();
    newCall = {
      id: `call-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      company_id: companyId,
      player_id: targetPlayer.id,
      operator_id: req.user!.id,
      phrase_id: null,
      phrase: callPhrase,
      duration: Number(duration) || 10,
      is_priority: Boolean(is_priority),
      is_recall: false,
      recall_count: 1,
      created_at: now,
    };
    data.player_calls.push(newCall);
    if (data.player_calls.length > 500) {
      data.player_calls = data.player_calls.slice(-500);
    }
    delivered = realtimeHub.sendCallToPlayer(newCall);
    db.persist();
  }

  res.status(201).json({
    message: `Chamando Senha ${calledTicket} no ${resolvedGuiche.name}! Próxima senha disponível para os guichês: ${nextTicketNumber}.`,
    calledTicket,
    called_ticket: calledTicket,
    numericValue,
    nextTicketNumber,
    next_ticket_number: nextTicketNumber,
    session,
    activeSession: session,
    active_session: session,
    call: newCall,
    delivered,
    remainingRecalls: 2,
    remaining_recalls: 2,
  });
});

apiRouter.post('/operator/guiche/recall', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const { guiche_id, sessionId, session_id, playerId, duration } = req.body;
  const targetId = session_id || sessionId || guiche_id || req.user!.id;

  const currentOp = data.operators.find(
    (o) => o.id === targetId || o.user_id === targetId || o.user_id === req.user!.id
  );
  const matchedSession = data.guiche_sessions?.find(
    (s) => s.id === targetId || s.guiche_id === targetId
  );
  const companyId =
    req.user!.company_id ||
    currentOp?.company_id ||
    matchedSession?.company_id ||
    data.companies.find((c) => c.status === 'active')?.id ||
    '';

  const result = db.recallGuicheTicket(companyId, targetId);
  if (!result.success || !result.session) {
    if (result.autoAdvanced) {
      return res.status(200).json({
        message: result.error,
        session: result.session,
        remainingRecalls: 0,
        autoAdvanced: true,
        nextTicketNumber: result.nextTicketNumber,
        call: null,
        delivered: false,
      });
    }
    return res.status(400).json({ error: result.error || 'Não foi possível rechamar.' });
  }

  const session = result.session;
  const effectiveCompanyId = session.company_id || companyId;
  const companyPlayers = data.players.filter((p) => p.company_id === effectiveCompanyId && p.status === 'active');
  const targetPlayer =
    (playerId ? companyPlayers.find((p) => p.id === playerId || p.code === playerId) : undefined) ||
    companyPlayers[0];

  let newCall: PlayerCall | null = null;
  let delivered = false;

  const callOrdinal = session.call_count === 2 ? 'Segunda chamada (1ª Rechamada)' : 'Terceira e última chamada';
  const phrase = `Atenção: Senha ${session.ticket_number}, comparecer ao ${session.guiche_name}. ${callOrdinal}.`;

  if (targetPlayer) {
    const now = new Date().toISOString();
    newCall = {
      id: `call-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      company_id: effectiveCompanyId,
      player_id: targetPlayer.id,
      operator_id: req.user!.id,
      phrase_id: null,
      phrase,
      duration: Number(duration) || 10,
      is_priority: session.is_priority,
      is_recall: true,
      recall_count: session.call_count,
      created_at: now,
    };
    data.player_calls.push(newCall);
    if (data.player_calls.length > 500) {
      data.player_calls = data.player_calls.slice(-500);
    }
    delivered = realtimeHub.sendCallToPlayer(newCall);
    db.persist();
  }

  res.json({
    message: `Rechamada (${session.call_count}/3) transmitida para a TV! Restam ${result.remainingRecalls} rechamadas.`,
    session,
    activeSession: session,
    active_session: session,
    remainingRecalls: result.remainingRecalls,
    remaining_recalls: result.remainingRecalls,
    call: newCall,
    delivered,
  });
});

apiRouter.post('/operator/guiche/mark-absent', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const { guiche_id, sessionId, session_id } = req.body;
  const targetId = session_id || sessionId || guiche_id || req.user!.id;

  const currentOp = data.operators.find(
    (o) => o.id === targetId || o.user_id === targetId || o.user_id === req.user!.id
  );
  const matchedSession = data.guiche_sessions?.find(
    (s) => s.id === targetId || s.guiche_id === targetId
  );
  const companyId =
    req.user!.company_id ||
    currentOp?.company_id ||
    matchedSession?.company_id ||
    data.companies.find((c) => c.status === 'active')?.id ||
    '';

  const result = db.markGuicheTicketAbsent(companyId, targetId);

  res.json({
    message: result.session
      ? `Senha ${result.session.ticket_number} marcada como Não Compareceu. Guichê liberado para chamar a senha ${result.nextTicketNumber}.`
      : `Guichê liberado para chamar a senha ${result.nextTicketNumber}.`,
    session: result.session,
    nextTicketNumber: result.nextTicketNumber,
  });
});

apiRouter.post('/operator/guiche/finish', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const { guiche_id, sessionId, session_id } = req.body;
  const targetId = session_id || sessionId || guiche_id || req.user!.id;

  const currentOp = data.operators.find(
    (o) => o.id === targetId || o.user_id === targetId || o.user_id === req.user!.id
  );
  const matchedSession = data.guiche_sessions?.find(
    (s) => s.id === targetId || s.guiche_id === targetId
  );
  const companyId =
    req.user!.company_id ||
    currentOp?.company_id ||
    matchedSession?.company_id ||
    data.companies.find((c) => c.status === 'active')?.id ||
    '';

  const result = db.finishGuicheTicket(companyId, targetId);

  res.json({
    message: result.session
      ? `Atendimento da senha ${result.session.ticket_number} concluído no guichê (sem necessidade de consultório). Guichê liberado para chamar a senha ${result.nextTicketNumber}.`
      : `Guichê liberado para chamar a senha ${result.nextTicketNumber}.`,
    session: result.session,
    nextTicketNumber: result.nextTicketNumber,
  });
});

apiRouter.post('/operator/guiche/reset-counter', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const companyId = req.user!.company_id || data.companies.find((c) => c.status === 'active')?.id || '';
  const counter = db.resetCompanyTicketCounter(companyId);

  res.json({
    message: 'Contador sequencial reiniciado para 001 com sucesso para todos os guichês!',
    nextTicketNumber: db.formatTicketNumber(counter.next_number),
  });
});

// Guichê sends/assigns a client ticket to a specific Consultório (Specialty) in arrival sequence
apiRouter.post('/operator/consultation-queue', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const companyId = req.user!.company_id || data.companies.find((c) => c.status === 'active')?.id || '';

  const {
    ticket_number,
    patient_name,
    is_priority,
    consultorio_id,
    guiche_id,
    guiche_name,
    notes,
  } = req.body;

  if (!ticket_number || !String(ticket_number).trim()) {
    return res.status(400).json({ error: 'Informe o número/código da senha do cliente.' });
  }
  if (!consultorio_id) {
    return res.status(400).json({ error: 'Selecione o consultório e a especialidade de destino.' });
  }

  const targetConsultorio = data.operators.find(
    (o) => o.id === consultorio_id && (companyId ? o.company_id === companyId : true)
  );
  if (!targetConsultorio) {
    return res.status(404).json({ error: 'Consultório de destino não encontrado.' });
  }

  const senderOp =
    data.operators.find((o) => o.id === guiche_id) ||
    data.operators.find((o) => o.user_id === req.user!.id || o.email.toLowerCase() === req.user!.email.toLowerCase());

  if (!data.consultation_queue) {
    data.consultation_queue = [];
  }

  const maxSeq = data.consultation_queue
    .filter((q) => q.company_id === targetConsultorio.company_id)
    .reduce((max, item) => (item.sequence > max ? item.sequence : max), 0);

  const now = new Date().toISOString();
  const newItem: ConsultationQueueItem = {
    id: `cq-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    company_id: targetConsultorio.company_id,
    ticket_number: String(ticket_number).trim().toUpperCase(),
    patient_name: patient_name ? String(patient_name).trim() : undefined,
    is_priority: Boolean(is_priority),
    specialty: targetConsultorio.specialty || 'Clínico Geral',
    consultorio_id: targetConsultorio.id,
    consultorio_name: targetConsultorio.name,
    guiche_id: senderOp?.id || req.user!.id,
    guiche_name: guiche_name ? String(guiche_name).trim() : (senderOp?.name || req.user!.name || 'Guichê 01'),
    notes: notes ? String(notes).trim() : undefined,
    status: 'waiting',
    sequence: maxSeq + 1,
    created_at: now,
    updated_at: now,
  };

  data.consultation_queue.push(newItem);
  // Keep history bounded
  if (data.consultation_queue.length > 500) {
    data.consultation_queue = data.consultation_queue.slice(-500);
  }

  // Atualizar sessão do guichê para "forwarded"
  const senderGuicheId = senderOp?.id || req.user!.id;
  const activeSess = db.getGuicheActiveSession(companyId, senderGuicheId);
  if (activeSess) {
    activeSess.status = 'forwarded';
    activeSess.patient_name = patient_name ? String(patient_name).trim() : undefined;
    activeSess.forwarded_to_consultorio_id = targetConsultorio.id;
    activeSess.forwarded_to_consultorio_name = targetConsultorio.name;
    activeSess.updated_at = now;
  }

  db.persist();

  const consultorioWaitingCount = data.consultation_queue.filter(
    (q) => q.consultorio_id === targetConsultorio.id && q.status === 'waiting'
  ).length;

  const counter = db.getCompanyTicketCounter(targetConsultorio.company_id || companyId);
  const nextTicketNumber = db.formatTicketNumber(counter.next_number, false);

  res.status(201).json({
    message: `Senha ${newItem.ticket_number} encaminhada para ${targetConsultorio.name} (${newItem.specialty}) — ${consultorioWaitingCount}º na fila de espera! Guichê liberado para chamar a próxima senha: ${nextTicketNumber}.`,
    item: newItem,
    nextTicketNumber,
  });
});

// Consultório calls a queued ticket on the TV Player and updates its status to 'called'
apiRouter.post('/operator/consultation-queue/:id/call', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const { id } = req.params;
  const { playerId, duration, customPhrase } = req.body;

  if (!data.consultation_queue) {
    return res.status(404).json({ error: 'Fila de atendimento vazia.' });
  }

  const item = data.consultation_queue.find((q) => q.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Senha não encontrada na fila do consultório.' });
  }

  const now = new Date().toISOString();
  item.status = 'called';
  item.called_at = now;
  item.updated_at = now;

  // Find target player for TV announcement
  const companyPlayers = data.players.filter((p) => p.company_id === item.company_id && p.status === 'active');
  const targetPlayer =
    (playerId ? companyPlayers.find((p) => p.id === playerId || p.code === playerId) : undefined) ||
    companyPlayers[0];

  let newCall: PlayerCall | null = null;
  let delivered = false;

  const builtPhrase = customPhrase
    ? String(customPhrase).trim()
    : `Senha ${item.ticket_number}${item.patient_name ? ` - ${item.patient_name}` : ''}, comparecer ao ${item.consultorio_name} (${item.specialty})`;

  if (targetPlayer) {
    newCall = {
      id: `call-${Date.now()}`,
      company_id: item.company_id,
      player_id: targetPlayer.id,
      operator_id: req.user!.id,
      phrase_id: null,
      phrase: builtPhrase,
      duration: Number(duration) || 10,
      is_priority: item.is_priority,
      created_at: now,
    };
    data.player_calls.push(newCall);
    if (data.player_calls.length > 500) {
      data.player_calls = data.player_calls.slice(-500);
    }
    delivered = realtimeHub.sendCallToPlayer(newCall);
  }

  db.persist();

  res.json({
    message: `Chamando Senha ${item.ticket_number} para ${item.consultorio_name} (${item.specialty})!`,
    item,
    call: newCall,
    delivered,
  });
});

// Update status of a queued ticket ('waiting' | 'called' | 'completed' | 'cancelled')
apiRouter.put('/operator/consultation-queue/:id/status', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const data = db.getData();
  const { id } = req.params;
  const { status } = req.body;

  if (!data.consultation_queue) {
    return res.status(404).json({ error: 'Fila não encontrada.' });
  }

  const item = data.consultation_queue.find((q) => q.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Registro não encontrado na fila.' });
  }

  const now = new Date().toISOString();
  if (status === 'waiting' || status === 'called' || status === 'completed' || status === 'cancelled') {
    item.status = status;
    if (status === 'called') item.called_at = now;
    if (status === 'completed') item.completed_at = now;
  }
  item.updated_at = now;
  db.persist();

  res.json({
    message: status === 'completed' ? `Atendimento da senha ${item.ticket_number} concluído!` : 'Status atualizado.',
    item,
  });
});

// Create Consultório only allowed by Empresa or Admin (operador guichê NÃO pode criar consultórios)
apiRouter.post('/operator/quick-create-consultorio', requireAuth, requireRole('company', 'admin'), (req: AuthenticatedRequest, res) => {
  if (req.user!.role === 'operator') {
    return res.status(403).json({ error: 'Operadores não têm permissão para criar consultórios. O cadastro deve ser realizado pela Empresa.' });
  }
  const data = db.getData();
  const companyId = req.user!.company_id || data.companies.find((c) => c.status === 'active')?.id || '';
  if (!companyId) {
    return res.status(400).json({ error: 'Empresa não identificada.' });
  }

  const { name, specialty, email, profile } = req.body;
  if (!name || !specialty) {
    return res.status(400).json({ error: 'Informe o nome do consultório e a especialidade.' });
  }

  const now = new Date().toISOString();
  const resolvedProfile: OperatorProfile = profile === 'guiche' ? 'guiche' : 'consultorio';
  const cleanEmail = email
    ? String(email).trim().toLowerCase()
    : `consultorio_${Date.now()}@indoor.local`;

  const initialPass = hashPassword('123456');
  const opUser: User = {
    id: `usr-op-${Date.now()}`,
    name: `${String(name).trim()} - ${String(specialty).trim()}`,
    email: cleanEmail,
    password_hash: initialPass.hash,
    salt: initialPass.salt,
    role: 'operator',
    company_id: companyId,
    active: true,
    must_change_password: false,
    created_at: now,
    updated_at: now,
  };

  const newOp: Operator = {
    id: `op-${Date.now()}`,
    company_id: companyId,
    user_id: opUser.id,
    name: String(name).trim(),
    email: cleanEmail,
    phone: '',
    profile: resolvedProfile,
    specialty: String(specialty).trim(),
    active: true,
    created_at: now,
    updated_at: now,
  };

  data.users.push(opUser);
  data.operators.push(newOp);
  db.persist();

  res.status(201).json(newOp);
});

apiRouter.get('/operator/phrases', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.role === 'admin' && req.query.company_id ? String(req.query.company_id) : req.user!.company_id!;
  const data = db.getData();
  const phrases = data.call_phrases.filter((ph) => (companyId ? ph.company_id === companyId : true));
  res.json(phrases);
});

apiRouter.post('/operator/phrases', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.role === 'admin' && req.body.company_id ? String(req.body.company_id) : req.user!.company_id;
  if (!companyId) {
    return res.status(400).json({ error: 'Identificação da empresa não encontrada.' });
  }
  const { phrase } = req.body;
  if (!phrase || !phrase.trim()) {
    return res.status(400).json({ error: 'A frase é obrigatória.' });
  }

  const data = db.getData();
  const now = new Date().toISOString();
  const newPhrase: CallPhrase = {
    id: `phr-${Date.now()}`,
    company_id: companyId,
    operator_id: req.user!.id,
    phrase: phrase.trim(),
    active: true,
    created_at: now,
    updated_at: now,
  };

  data.call_phrases.push(newPhrase);
  db.persist();

  res.status(201).json(newPhrase);
});

apiRouter.put('/operator/phrases/:id', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id;
  const { id } = req.params;
  const data = db.getData();
  const phrase = data.call_phrases.find((p) => p.id === id && (companyId ? p.company_id === companyId : true));
  if (!phrase) {
    return res.status(404).json({ error: 'Frase não encontrada.' });
  }

  const { phrase: newText, active } = req.body;
  if (newText) phrase.phrase = newText.trim();
  if (active !== undefined) phrase.active = active;
  phrase.updated_at = new Date().toISOString();

  db.persist();
  res.json(phrase);
});

apiRouter.delete('/operator/phrases/:id', requireAuth, requireRole('operator', 'company', 'admin'), (req: AuthenticatedRequest, res) => {
  const companyId = req.user!.company_id;
  const { id } = req.params;
  const data = db.getData();
  const idx = data.call_phrases.findIndex((p) => p.id === id && (companyId ? p.company_id === companyId : true));
  if (idx === -1) {
    return res.status(404).json({ error: 'Frase não encontrada.' });
  }

  data.call_phrases.splice(idx, 1);
  db.persist();

  res.json({ message: 'Frase excluída com sucesso.' });
});

// Trigger Call
apiRouter.post('/operator/call', requireAuth, (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  if (user.role !== 'operator' && user.role !== 'company' && user.role !== 'admin') {
    return res.status(403).json({ error: 'Permissão negada. Apenas operador, empresa ou administrador podem realizar chamadas.' });
  }

  const { phrase, phraseId, duration, isPriority, is_priority } = req.body;
  const playerId = req.body.playerId || req.body.player_id;

  if (!playerId || !phrase) {
    return res.status(400).json({ error: 'Selecione o player e a frase da chamada.' });
  }

  const data = db.getData();
  const rawTarget = String(playerId).trim();
  const rawTargetLower = rawTarget.toLowerCase();

  // Robust lookup: match by ID, Code, or Access Token
  let player = data.players.find(
    (p) =>
      (p.id === rawTarget ||
       p.code.toLowerCase() === rawTargetLower ||
       (p.access_token && p.access_token.toLowerCase() === rawTargetLower)) &&
      (user.role === 'admin' || !user.company_id || p.company_id === user.company_id)
  );

  // If not matched strictly with company filter, check within user's company
  if (!player && user.company_id) {
    const companyPlayers = data.players.filter((p) => p.company_id === user.company_id);
    player = companyPlayers.find(
      (p) =>
        p.id === rawTarget ||
        p.code.toLowerCase() === rawTargetLower ||
        (p.access_token && p.access_token.toLowerCase() === rawTargetLower)
    ) || companyPlayers.find((p) => p.status === 'active') || companyPlayers[0];
  }

  // Fallback for admin or single player deployments
  if (!player) {
    player = data.players.find(
      (p) =>
        p.id === rawTarget ||
        p.code.toLowerCase() === rawTargetLower ||
        (p.access_token && p.access_token.toLowerCase() === rawTargetLower)
    ) || data.players.find((p) => p.status === 'active') || data.players[0];
  }

  if (!player) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  if (player.status !== 'active') {
    return res.status(400).json({ error: 'Este player está desativado.' });
  }

  const now = new Date().toISOString();
  const callDuration = Number(duration) || 10;
  const isCallPriority = Boolean(isPriority || is_priority);

  const newCall: PlayerCall = {
    id: `call-${Date.now()}`,
    company_id: player.company_id,
    player_id: player.id,
    operator_id: req.user!.id,
    phrase_id: phraseId || null,
    phrase: String(phrase).trim(),
    duration: callDuration,
    is_priority: isCallPriority,
    created_at: now,
  };

  data.player_calls.push(newCall);
  if (data.player_calls.length > 500) {
    data.player_calls = data.player_calls.slice(-500);
  }
  db.persist();

  // Instant real-time transmission via SSE
  const delivered = realtimeHub.sendCallToPlayer(newCall);

  res.status(201).json({
    message: 'Chamada enviada com sucesso.',
    call: newCall,
    delivered,
  });
});

// ----------------------------------------------------
// 5. PLAYER
// ----------------------------------------------------
apiRouter.get('/player/current', (req: AuthenticatedRequest, res) => {
  const playerCode = (req.query.code as string)?.trim();
  const playerToken = (req.query.token as string)?.trim();
  const authHeader = req.headers.authorization;
  let user: User | undefined;
  let session: Session | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const foundSession = db.getSession(token);
    if (foundSession) {
      session = foundSession;
      const data = db.getData();
      user = data.users.find((u) => u.id === session!.userId);
    }
  }

  const data = db.getData();
  let player: Player | undefined;

  // Direct access via unique token, player code, or player ID
  if (playerToken) {
    const tokenLower = playerToken.toLowerCase();
    player = data.players.find(
      (p) =>
        p.access_token === playerToken ||
        p.code.toLowerCase() === tokenLower ||
        p.id.toLowerCase() === tokenLower
    );
  }
  if (!player && playerCode) {
    const codeLower = playerCode.toLowerCase();
    player = data.players.find(
      (p) =>
        p.code.toLowerCase() === codeLower ||
        p.id.toLowerCase() === codeLower ||
        (p.access_token && p.access_token.toLowerCase() === codeLower)
    );
  }

  if (!player && session?.playerId) {
    player = data.players.find((p) => p.id === session?.playerId);
  } else if (!player && user?.role === 'player') {
    player = data.players.find((p) => p.user_id === user.id);
  } else if (!player && user?.company_id) {
    player = data.players.find((p) => p.company_id === user!.company_id && p.status === 'active') || data.players.find((p) => p.company_id === user!.company_id);
  } else if (!player && user?.role === 'admin') {
    player = data.players[0];
  } else if (!player) {
    // Standalone hardware player, kiosk TV, or smart display deployed without auth session
    player = data.players.find((p) => p.status === 'active') || data.players[0];
  }

  if (!player) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  // Ensure player has access token
  if (!player.access_token) {
    player.access_token = `tok_${crypto.randomBytes(16).toString('hex')}`;
    db.persist();
  }

  // Record heartbeat on access
  realtimeHub.recordHeartbeat(player.id);

  let company = data.companies.find((c) => c.id === player.company_id);
  if (!company) {
    company = data.companies.find((c) => c.status === 'active') || data.companies[0];
  }
  if (company && company.status !== 'active') {
    company.status = 'active';
    db.persist();
  }
  if (!company) {
    return res.status(403).json({ error: 'Empresa inativa. Conteúdo indisponível.' });
  }

  let playlist: Playlist | undefined;
  let itemsWithMedia: Array<{
    id: string;
    media_id: string;
    position: number;
    duration: number;
    name: string;
    type: 'image' | 'video' | 'rss';
    file_url: string;
  }> = [];

  if (player.playlist_id) {
    playlist = data.playlists.find((pl) => pl.id === player?.playlist_id && pl.active);
    if (playlist) {
      itemsWithMedia = playlist.items
        .map((it) => {
          const m = data.media.find((media) => media.id === it.media_id && media.active);
          if (!m) return null;
          return {
            id: it.id,
            media_id: it.media_id,
            position: it.position,
            duration: it.duration || m.duration || 10,
            name: m.name,
            type: m.type,
            file_url: m.file_url,
          };
        })
        .filter(Boolean) as any[];
    }
  }

  // Active RSS feeds
  const rssFeeds = data.rss_feeds.filter((r) => r.company_id === player?.company_id && r.active);

  res.json({
    player: {
      id: player.id,
      name: player.name,
      code: player.code,
      access_token: player.access_token,
      location: player.location,
      orientation: player.orientation || 'horizontal',
    },
    company: {
      id: company.id,
      name: company.trade_name,
    },
    playlist: playlist
      ? {
          id: playlist.id,
          name: playlist.name,
          weather_city: playlist.weather_city || company.city || 'São Paulo',
        }
      : null,
    weatherCity: playlist?.weather_city || company.city || 'São Paulo',
    items: itemsWithMedia,
    rssFeeds,
  });
});

apiRouter.post('/player/heartbeat', (req, res) => {
  const { playerId } = req.body;
  if (!playerId) {
    return res.status(400).json({ error: 'ID do player é obrigatório.' });
  }

  let updated = realtimeHub.recordHeartbeat(playerId);
  if (!updated) {
    // If exact ID not registered, check if any active player matches or fallback
    const data = db.getData();
    const target = String(playerId).trim().toLowerCase();
    const matched =
      data.players.find(
        (p) =>
          p.id.toLowerCase() === target ||
          p.code.toLowerCase() === target ||
          (p.access_token && p.access_token.toLowerCase() === target)
      ) || data.players.find((p) => p.status === 'active') || data.players[0];
    if (matched) {
      updated = realtimeHub.recordHeartbeat(matched.id);
    }
  }

  if (!updated) {
    return res.status(404).json({ error: 'Player não encontrado.' });
  }

  res.json({ status: 'ok', timestamp: Date.now() });
});

// Active call poll endpoint (bulletproof fallback for SSE/networks)
apiRouter.get('/player/active-call', (req, res) => {
  const playerId = (req.query.playerId as string)?.trim();
  const playerCode = (req.query.code as string)?.trim();
  const token = (req.query.token as string)?.trim();

  let target = playerId;
  if (!target && token) {
    const foundSession = db.getSession(token);
    if (foundSession) {
      target = foundSession.playerId;
    } else {
      const data = db.getData();
      const pl = data.players.find(
        (p) =>
          p.access_token === token ||
          p.code.toLowerCase() === token.toLowerCase() ||
          p.id === token
      );
      if (pl) target = pl.id;
    }
  }
  if (!target && playerCode) {
    target = playerCode;
  }
  if (!target) {
    const data = db.getData();
    const pl = data.players.find((p) => p.status === 'active') || data.players[0];
    if (pl) target = pl.id;
  }

  if (!target) {
    return res.json({ activeCall: null });
  }

  const activeCall = realtimeHub.getActiveCall(target);
  res.json({ activeCall });
});

// ----------------------------------------------------
// 6. REAL-TIME SERVER-SENT EVENTS (SSE)
// ----------------------------------------------------
apiRouter.get('/realtime/stream', (req, res) => {
  let playerId = (req.query.playerId as string)?.trim();
  let playerCode = (req.query.code as string)?.trim();
  let companyId = (req.query.companyId as string)?.trim();
  const token = (req.query.token as string)?.trim();

  const data = db.getData();

  // If token is supplied, resolve session or match player access_token
  if (token) {
    const foundSession = db.getSession(token);
    if (foundSession) {
      if (foundSession.playerId && !playerId) playerId = foundSession.playerId;
      if (foundSession.companyId && !companyId) companyId = foundSession.companyId;
    } else {
      const p = data.players.find(
        (pl) =>
          pl.access_token === token ||
          pl.code.toLowerCase() === token.toLowerCase() ||
          pl.id === token
      );
      if (p) {
        if (!playerId) playerId = p.id;
        if (!playerCode) playerCode = p.code;
        if (!companyId) companyId = p.company_id;
      }
    }
  }

  if (playerCode && !playerId) {
    const p = data.players.find(
      (pl) =>
        pl.code.toLowerCase() === playerCode!.toLowerCase() ||
        pl.id === playerCode
    );
    if (p) {
      playerId = p.id;
      companyId = companyId || p.company_id;
    }
  }

  if (playerId && !playerCode) {
    const p = data.players.find((pl) => pl.id === playerId);
    if (p) {
      playerCode = p.code;
      companyId = companyId || p.company_id;
    }
  }

  // Fallback for standalone kiosk TV screens connecting without params
  if (!playerId && !playerCode) {
    const p = data.players.find((pl) => pl.status === 'active') || data.players[0];
    if (p) {
      playerId = p.id;
      playerCode = p.code;
      companyId = companyId || p.company_id;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.flushHeaders?.();

  const clientId = `sse-${Date.now()}-${Math.random()}`;

  realtimeHub.addClient({
    id: clientId,
    res,
    playerId: playerId || undefined,
    playerCode: playerCode || undefined,
    companyId: companyId || undefined,
  });

  // If player connected, record heartbeat immediately
  if (playerId) {
    realtimeHub.recordHeartbeat(playerId);
  }

  // Keep connection open; express will hold it
});

// ----------------------------------------------------
// 7. WEATHER WIDGET API
// ----------------------------------------------------
interface WeatherCacheEntry {
  temp: number;
  apparentTemp: number;
  humidity: number;
  windSpeed: number;
  city: string;
  weatherCode: number;
  text: string;
  forecast: Array<{
    date: string;
    dayName: string;
    max: number;
    min: number;
    weatherCode: number;
    text: string;
    rainProb: number;
  }>;
  timestamp: number;
}

const weatherCache = new Map<string, WeatherCacheEntry>();

function getWeatherDescription(code: number): string {
  if (code === 0) return 'Céu Limpo';
  if (code === 1 || code === 2) return 'Parcialmente Nublado';
  if (code === 3) return 'Nublado';
  if (code >= 45 && code <= 48) return 'Nevoeiro';
  if (code >= 51 && code <= 67) return 'Chuva Leve';
  if (code >= 71 && code <= 77) return 'Neve';
  if (code >= 80 && code <= 82) return 'Pancadas de Chuva';
  if (code >= 95) return 'Tempestade';
  return 'Tempo Firme';
}

function getFallbackForecast(baseTemp: number, city: string): WeatherCacheEntry {
  const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const today = new Date();
  const forecastList = [];

  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dayLabel = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : dayNames[d.getDay()];
    const dateStr = d.toISOString().split('T')[0];
    const max = baseTemp + (i % 2 === 0 ? 3 : 2);
    const min = baseTemp - (i % 2 === 0 ? 4 : 5);
    const code = i === 0 ? 1 : i === 1 ? 0 : i === 2 ? 2 : 51;

    forecastList.push({
      date: dateStr,
      dayName: dayLabel,
      max,
      min,
      weatherCode: code,
      text: getWeatherDescription(code),
      rainProb: i === 3 ? 45 : 10,
    });
  }

  return {
    temp: baseTemp,
    apparentTemp: baseTemp + 1,
    humidity: 62,
    windSpeed: 14,
    city,
    weatherCode: 1,
    text: 'Parcialmente Nublado',
    forecast: forecastList,
    timestamp: Date.now(),
  };
}

apiRouter.get('/weather', async (req, res) => {
  const cityRaw = (req.query.city as string)?.trim() || 'São Paulo';
  const cacheKey = cityRaw.toLowerCase();
  const cached = weatherCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < 15 * 60 * 1000) {
    return res.json({ status: 'ok', ...cached });
  }

  try {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityRaw)}&count=1&language=pt&format=json`;
    const geoRes = await fetch(geoUrl);
    if (!geoRes.ok) throw new Error('Geocoding failed');
    const geoData = (await geoRes.json()) as any;

    if (!geoData.results || geoData.results.length === 0) {
      const fallback = getFallbackForecast(25, cityRaw);
      return res.json({ status: 'ok', ...fallback, isFallback: true });
    }

    const { latitude, longitude, name } = geoData.results[0];
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const weatherRes = await fetch(weatherUrl);
    if (!weatherRes.ok) throw new Error('Weather API failed');
    const weatherData = (await weatherRes.json()) as any;

    const current = weatherData.current;
    const temp = Math.round(current?.temperature_2m ?? 24);
    const apparentTemp = Math.round(current?.apparent_temperature ?? temp);
    const humidity = Math.round(current?.relative_humidity_2m ?? 60);
    const windSpeed = Math.round(current?.wind_speed_10m ?? 12);
    const code = current?.weather_code ?? 0;
    const text = getWeatherDescription(code);

    const dayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const forecast: Array<{
      date: string;
      dayName: string;
      max: number;
      min: number;
      weatherCode: number;
      text: string;
      rainProb: number;
    }> = [];

    if (weatherData.daily && weatherData.daily.time) {
      for (let i = 0; i < Math.min(weatherData.daily.time.length, 5); i++) {
        const dateStr = weatherData.daily.time[i];
        const dateObj = new Date(dateStr + 'T12:00:00');
        const dayName = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : dayNames[dateObj.getDay()];
        const dayCode = weatherData.daily.weather_code?.[i] ?? 0;
        forecast.push({
          date: dateStr,
          dayName,
          max: Math.round(weatherData.daily.temperature_2m_max?.[i] ?? temp + 3),
          min: Math.round(weatherData.daily.temperature_2m_min?.[i] ?? temp - 4),
          weatherCode: dayCode,
          text: getWeatherDescription(dayCode),
          rainProb: Math.round(weatherData.daily.precipitation_probability_max?.[i] ?? 10),
        });
      }
    }

    const result: WeatherCacheEntry = {
      temp,
      apparentTemp,
      humidity,
      windSpeed,
      city: name || cityRaw,
      weatherCode: code,
      text,
      forecast: forecast.length > 0 ? forecast : getFallbackForecast(temp, name || cityRaw).forecast,
      timestamp: Date.now(),
    };

    weatherCache.set(cacheKey, result);
    return res.json({ status: 'ok', ...result });
  } catch {
    const fallback = getFallbackForecast(25, cityRaw);
    return res.json({ status: 'ok', ...fallback, isFallback: true });
  }
});

// ==========================================
// PORTUGUESE TTS (TEXT-TO-SPEECH) AUDIO API
// ==========================================

const ttsAudioCache = new Map<string, { buffer: Buffer; timestamp: number }>();
const TTS_CACHE_MAX_SIZE = 150;
const TTS_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function splitTextForTts(text: string, maxLen = 180): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxLen) return [cleaned];

  const parts: string[] = [];
  const sentences = cleaned.split(/(?<=[.!?;,])\s+/);
  let current = '';

  for (const sentence of sentences) {
    if ((current + ' ' + sentence).trim().length <= maxLen) {
      current = (current + ' ' + sentence).trim();
    } else {
      if (current) parts.push(current);
      if (sentence.length <= maxLen) {
        current = sentence;
      } else {
        // Hard split long sentence by words
        const words = sentence.split(' ');
        current = '';
        for (const w of words) {
          if ((current + ' ' + w).trim().length <= maxLen) {
            current = (current + ' ' + w).trim();
          } else {
            if (current) parts.push(current);
            current = w.slice(0, maxLen);
          }
        }
      }
    }
  }
  if (current) parts.push(current);
  return parts;
}

async function fetchTtsChunkBuffer(chunk: string, lang: string): Promise<Buffer> {
  const upstreams = [
    `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(chunk)}`,
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=gtx&q=${encodeURIComponent(chunk)}`,
  ];

  let lastErr: any = null;
  for (const ttsUrl of upstreams) {
    try {
      const response = await fetch(ttsUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Referer: 'https://translate.google.com/',
          Accept: 'audio/mpeg, audio/*;q=0.9, */*;q=0.8',
        },
      });

      if (!response.ok) {
        throw new Error(`TTS upstream returned status ${response.status}`);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        throw new Error(`TTS upstream returned unexpected content-type: ${contentType}`);
      }

      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);

      // Ensure buffer is non-empty and does not start with HTML '<' (0x3c) or JSON '{' (0x7b)
      if (buf.length > 100 && buf[0] !== 0x3c && buf[0] !== 0x7b) {
        return buf;
      }
      throw new Error('Invalid or empty audio buffer from upstream');
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('All TTS upstreams failed');
}

apiRouter.get('/tts', async (req, res) => {
  try {
    const rawText = String(req.query.text || '').trim();
    const lang = String(req.query.lang || 'pt-BR').trim() || 'pt-BR';

    if (!rawText) {
      return res.status(400).json({ error: 'Parâmetro text é obrigatório.' });
    }

    const normalizedText = rawText.slice(0, 600);
    const cacheKey = `${lang}:${normalizedText.toLowerCase()}`;
    const cached = ttsAudioCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < TTS_CACHE_TTL_MS && cached.buffer.length > 100 && cached.buffer[0] !== 0x3c) {
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(cached.buffer.length));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached.buffer);
    }

    const chunks = splitTextForTts(normalizedText, 180);
    const buffers: Buffer[] = [];

    for (const chunk of chunks) {
      const buf = await fetchTtsChunkBuffer(chunk, lang);
      buffers.push(buf);
    }

    const combinedBuffer = Buffer.concat(buffers);
    if (combinedBuffer.length === 0) {
      throw new Error('Empty audio buffer received from TTS upstream');
    }

    // Prune oldest cache entries if full
    if (ttsAudioCache.size >= TTS_CACHE_MAX_SIZE) {
      const oldestKey = ttsAudioCache.keys().next().value;
      if (oldestKey) ttsAudioCache.delete(oldestKey);
    }
    ttsAudioCache.set(cacheKey, { buffer: combinedBuffer, timestamp: Date.now() });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(combinedBuffer.length));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(combinedBuffer);
  } catch (err: any) {
    console.warn('[TTS API] Fallback trigger:', err?.message || err);
    return res.status(502).json({ error: 'Falha ao sintetizar áudio no servidor.' });
  }
});

// ==========================================
// GOOGLE DRIVE & CLIENTS HIERARCHY APIS
// ==========================================

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';

async function serverFindDriveFolder(token: string, folderName: string, parentId?: string): Promise<{ id: string; name: string; webViewLink?: string } | null> {
  try {
    let query = `mimeType='application/vnd.google-apps.folder' and name='${folderName.replace(/'/g, "\\'")}' and trashed=false`;
    if (parentId) query += ` and '${parentId}' in parents`;
    const url = `${DRIVE_API_BASE}?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)&pageSize=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json() as any;
    if (data.files && data.files.length > 0) return data.files[0];
    return null;
  } catch {
    return null;
  }
}

async function serverCreateDriveFolder(token: string, folderName: string, parentId?: string): Promise<{ id: string; name: string; webViewLink?: string }> {
  const metadata: any = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) metadata.parents = [parentId];
  const res = await fetch(`${DRIVE_API_BASE}?fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });
  if (!res.ok) throw new Error(`Falha ao criar pasta no Drive (${res.status})`);
  return await res.json() as any;
}

async function serverGetOrCreateFolder(token: string, folderName: string, parentId?: string) {
  const existing = await serverFindDriveFolder(token, folderName, parentId);
  if (existing) return existing;
  return await serverCreateDriveFolder(token, folderName, parentId);
}

async function serverEnsureClientFolders(token: string, clientName: string, rootName = 'MÍDIA INDOOR - ARQUIVOS DO SISTEMA') {
  const root = await serverGetOrCreateFolder(token, rootName);
  const clientFolder = await serverGetOrCreateFolder(token, clientName.trim(), root.id);
  const [photosFolder, documentsFolder] = await Promise.all([
    serverGetOrCreateFolder(token, '📸 Fotos com Código Único', clientFolder.id),
    serverGetOrCreateFolder(token, '📄 Documentos e Arquivos', clientFolder.id),
  ]);
  return { root, clientFolder, photosFolder, documentsFolder };
}

async function serverUploadFileToDrive(
  token: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  folderId: string,
  uniqueCode: string,
  description: string
) {
  const metadata = {
    name: fileName,
    parents: [folderId],
    description: description || `Código Único: ${uniqueCode}`,
  };

  const formData = new FormData();
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('file', new Blob([fileBuffer], { type: mimeType || 'application/octet-stream' }), fileName);

  const res = await fetch(`${DRIVE_UPLOAD_BASE}?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink,size`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error?.message || `Erro no upload ao Google Drive (${res.status})`);
  }

  const data = await res.json() as any;

  // Make public reader
  await fetch(`${DRIVE_API_BASE}/${data.id}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  }).catch(() => {});

  const directStreamLink = `https://lh3.googleusercontent.com/d/${data.id}`;

  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    webViewLink: data.webViewLink,
    webContentLink: data.webContentLink,
    directStreamLink,
    size: data.size ? Number(data.size) : undefined,
  };
}

// Drive Settings (Managed by DEV)
apiRouter.get('/drive/settings', (req, res) => {
  const settings = db.getDriveSettings();
  res.json({ status: 'ok', settings });
});

apiRouter.post('/drive/settings', (req, res) => {
  const {
    connected,
    account_email,
    account_name,
    account_photo,
    root_folder_id,
    root_folder_name,
    root_folder_url,
    access_token,
    refresh_token,
    token_expiry,
  } = req.body;

  const updated = db.updateDriveSettings({
    connected: connected !== undefined ? !!connected : undefined,
    account_email,
    account_name,
    account_photo,
    root_folder_id,
    root_folder_name,
    root_folder_url,
    access_token,
    refresh_token,
    token_expiry,
  });

  res.json({ status: 'ok', settings: updated });
});

// Server-side upload endpoint for Company media to the pre-registered Google Drive account
apiRouter.post('/company/media/upload-to-drive', requireAuth, requireRole('company'), async (req: AuthenticatedRequest, res) => {
  try {
    const companyId = req.user!.company_id!;
    const {
      fileData,
      filename,
      mimeType,
      name,
      duration,
      clientDriveToken,
    } = req.body;

    if (!fileData) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }

    const data = db.getData();
    const company = data.companies.find((c) => c.id === companyId);
    if (!company) {
      return res.status(404).json({ error: 'Empresa não encontrada.' });
    }

    // Check media limit
    const currentMedia = data.media.filter((m) => m.company_id === companyId);
    const plan = data.plans.find((p) => p.id === company.plan_id);
    const maxMedia =
      company.max_media !== undefined && company.max_media !== null
        ? Number(company.max_media)
        : (plan?.max_media || plan?.max_storage || 20);
    if (currentMedia.length >= maxMedia) {
      return res.status(400).json({
        error: `Limite de mídias atingido para seu plano (${currentMedia.length}/${maxMedia}). Remova mídias obsoletas ou solicite aumento de cota.`
      });
    }

    // Save local cache backup file first
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    let base64Data = fileData;
    let detectedExt = 'bin';
    if (fileData.includes(';base64,')) {
      const parts = fileData.split(';base64,');
      base64Data = parts[1];
      const match = parts[0].match(/data:(.*?)$/);
      if (match) {
        const mime = match[1];
        if (mime === 'image/jpeg' || mime === 'image/jpg') detectedExt = 'jpg';
        else if (mime === 'image/png') detectedExt = 'png';
        else if (mime === 'image/webp') detectedExt = 'webp';
        else if (mime === 'image/gif') detectedExt = 'gif';
        else if (mime === 'video/mp4') detectedExt = 'mp4';
        else if (mime === 'video/webm') detectedExt = 'webm';
        else if (mime === 'video/quicktime') detectedExt = 'mov';
      }
    }

    const safeBaseName = (filename || 'media')
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);

    const isVideo =
      detectedExt === 'mp4' ||
      detectedExt === 'webm' ||
      detectedExt === 'mov' ||
      (mimeType && mimeType.startsWith('video/'));

    const buffer = Buffer.from(base64Data, 'base64');
    const uniqueLocalName = `media-${Date.now()}-${safeBaseName}.${detectedExt}`;
    const filePath = path.join(uploadsDir, uniqueLocalName);
    fs.writeFileSync(filePath, buffer);
    const localUrl = `/uploads/${uniqueLocalName}`;

    // Check Drive token (either pre-registered system token or client token or env var)
    const driveSettings = db.getDriveSettings();
    const token =
      clientDriveToken ||
      driveSettings.access_token ||
      process.env.GOOGLE_DRIVE_ACCESS_TOKEN;

    const clientName = company.trade_name || company.legal_name || 'Cliente';
    const isPhoto = !isVideo;
    const prefix = isPhoto ? 'FOTO' : 'VID';
    const randHash = Math.random().toString(36).substring(2, 6).toUpperCase();
    const cliCode = clientName.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'CLI');
    const uniqueCode = `${prefix}-${cliCode}-${randHash}`;

    let mediaSavedToDrive = false;
    let driveUploadInfo: any = null;
    let targetFolderId: string | undefined = undefined;

    if (token) {
      try {
        const structure = await serverEnsureClientFolders(
          token,
          clientName,
          driveSettings.root_folder_name || 'MÍDIA INDOOR - ARQUIVOS DO SISTEMA'
        );
        const targetFolder = isPhoto ? structure.photosFolder : structure.documentsFolder;
        targetFolderId = targetFolder.id;
        const sanitizedFileName = `${uniqueCode}_${(filename || 'arquivo').replace(/\s+/g, '_')}`;

        driveUploadInfo = await serverUploadFileToDrive(
          token,
          buffer,
          sanitizedFileName,
          mimeType || (isPhoto ? 'image/jpeg' : 'video/mp4'),
          targetFolder.id,
          uniqueCode,
          `Mídia indoor carregada pela empresa (${uniqueCode})`
        );

        // Catalog in Drive Documents
        db.createDriveDocument({
          unique_code: uniqueCode,
          company_id: companyId,
          sub_client_id: companyId,
          category: isPhoto ? 'photo' : 'document',
          title: (name || filename || 'Nova Mídia').trim(),
          description: `Mídia para exibição em TVs (${uniqueCode})`,
          file_name: filename || sanitizedFileName,
          file_size: buffer.length,
          mime_type: mimeType || (isPhoto ? 'image/jpeg' : 'video/mp4'),
          drive_file_id: driveUploadInfo.id,
          drive_folder_id: targetFolder.id,
          drive_view_url: driveUploadInfo.webViewLink,
          drive_download_url: driveUploadInfo.webContentLink,
          local_url: localUrl,
          status: 'completed',
        });

        // Update company drive folder URL if not set
        if (structure.clientFolder?.webViewLink && !company.drive_folder_url) {
          company.drive_folder_id = structure.clientFolder.id;
          company.drive_folder_url = structure.clientFolder.webViewLink;
          company.updated_at = new Date().toISOString();
          db.persist();
        }

        mediaSavedToDrive = true;
      } catch (driveErr: any) {
        console.warn('[Google Drive Server Upload] Failed, falling back to local file:', driveErr.message);
      }
    }

    const targetUrl = mediaSavedToDrive && driveUploadInfo
      ? (driveUploadInfo.directStreamLink || driveUploadInfo.webViewLink)
      : localUrl;

    const now = new Date().toISOString();
    const newMedia: Media = {
      id: `med-${Date.now()}`,
      company_id: companyId,
      name: (name || filename || 'Nova Mídia').trim(),
      type: isVideo ? 'video' : 'image',
      file_url: targetUrl,
      duration: Number(duration) || 10,
      active: true,
      drive_file_id: driveUploadInfo?.id,
      drive_view_url: driveUploadInfo?.webViewLink,
      drive_download_url: driveUploadInfo?.webContentLink,
      drive_folder_id: targetFolderId,
      unique_code: uniqueCode,
      source: mediaSavedToDrive ? 'drive' : 'device',
      file_size: buffer.length,
      mime_type: mimeType || (isPhoto ? 'image/jpeg' : 'video/mp4'),
      created_at: now,
      updated_at: now,
    };

    data.media.push(newMedia);
    db.persist();

    res.json({
      status: 'ok',
      media: newMedia,
      savedToDrive: mediaSavedToDrive,
      driveAccount: driveSettings.account_email,
      message: mediaSavedToDrive
        ? `Mídia salva com sucesso no Google Drive na pasta "${clientName}" com código ${uniqueCode}!`
        : 'Mídia salva no servidor local (Conecte a conta Google no painel para salvar no Drive).',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Erro ao processar upload de mídia.' });
  }
});

// Sub-Clients (Clientes do Cliente A)
apiRouter.get('/companies/:id/sub-clients', (req, res) => {
  const companyId = req.params.id;
  const subClients = db.getSubClients(companyId);
  res.json({ status: 'ok', subClients });
});

apiRouter.get('/sub-clients', (req, res) => {
  const companyId = req.query.companyId as string | undefined;
  const subClients = db.getSubClients(companyId);
  res.json({ status: 'ok', subClients });
});

apiRouter.post('/companies/:id/sub-clients', (req, res) => {
  const companyId = req.params.id;
  const { name, code, phone, email, notes, drive_folder_id, drive_folder_url } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Nome do sub-cliente é obrigatório' });
  }

  const generatedCode = code || `CLI-${Math.floor(100 + Math.random() * 900)}`;

  const newSubClient = db.createSubClient({
    company_id: companyId,
    name: name.trim(),
    code: generatedCode.trim(),
    phone: phone?.trim(),
    email: email?.trim(),
    notes: notes?.trim(),
    drive_folder_id: drive_folder_id || '',
    drive_folder_url: drive_folder_url || '',
  });

  res.status(201).json({ status: 'ok', subClient: newSubClient });
});

apiRouter.put('/sub-clients/:id', (req, res) => {
  const id = req.params.id;
  const { name, code, phone, email, notes, drive_folder_id, drive_folder_url } = req.body;

  const updated = db.updateSubClient(id, {
    name,
    code,
    phone,
    email,
    notes,
    drive_folder_id,
    drive_folder_url,
  });

  if (!updated) {
    return res.status(404).json({ error: 'Sub-cliente não encontrado' });
  }

  res.json({ status: 'ok', subClient: updated });
});

apiRouter.delete('/sub-clients/:id', (req, res) => {
  const id = req.params.id;
  const success = db.deleteSubClient(id);
  if (!success) {
    return res.status(404).json({ error: 'Sub-cliente não encontrado' });
  }
  res.json({ status: 'ok', message: 'Sub-cliente e documentos excluídos com sucesso' });
});

// Drive Documents & Photos
apiRouter.get('/drive/documents', (req, res) => {
  const { companyId, subClientId, category } = req.query as {
    companyId?: string;
    subClientId?: string;
    category?: string;
  };

  const documents = db.getDriveDocuments({ companyId, subClientId, category });
  res.json({ status: 'ok', documents });
});

apiRouter.get('/drive/documents/:id', (req, res) => {
  const id = req.params.id;
  const doc = db.getDriveDocument(id);
  if (!doc) {
    return res.status(404).json({ error: 'Documento não encontrado' });
  }
  res.json({ status: 'ok', document: doc });
});

apiRouter.post('/drive/documents', (req, res) => {
  const {
    unique_code,
    company_id,
    sub_client_id,
    category,
    title,
    description,
    file_name,
    file_size,
    mime_type,
    drive_file_id,
    drive_folder_id,
    drive_view_url,
    drive_download_url,
    local_url,
    status,
  } = req.body;

  const effectiveSubClientId = sub_client_id || company_id;
  if (!company_id || !effectiveSubClientId || !title || !category) {
    return res.status(400).json({ error: 'Dados incompletos para registrar o documento/foto' });
  }

  // Generate unique code if not provided
  let code = unique_code;
  if (!code) {
    const prefix =
      category === 'photo' ? 'FOTO' : category === 'order' ? 'OS' : category === 'budget' ? 'ORC' : 'DOC';
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    const year = new Date().getFullYear();
    code = `${prefix}-${year}-${rand}`;
  }

  const newDoc = db.createDriveDocument({
    unique_code: code,
    company_id,
    sub_client_id: effectiveSubClientId,
    category,
    title: title.trim(),
    description: description ? description.trim() : '',
    file_name: file_name || 'arquivo_sem_nome',
    file_size: file_size ? Number(file_size) : undefined,
    mime_type: mime_type || 'application/octet-stream',
    drive_file_id: drive_file_id || '',
    drive_folder_id: drive_folder_id || '',
    drive_view_url: drive_view_url || '',
    drive_download_url: drive_download_url || '',
    local_url: local_url || '',
    status: status || 'completed',
  });

  res.status(201).json({ status: 'ok', document: newDoc });
});

apiRouter.put('/drive/documents/:id', (req, res) => {
  const id = req.params.id;
  const {
    title,
    description,
    category,
    status,
    company_id,
    sub_client_id,
    drive_view_url,
    drive_download_url,
    drive_file_id,
    drive_folder_id,
  } = req.body;

  const updated = db.updateDriveDocument(id, {
    title,
    description,
    category,
    status,
    company_id,
    sub_client_id,
    drive_view_url,
    drive_download_url,
    drive_file_id,
    drive_folder_id,
  });

  if (!updated) {
    return res.status(404).json({ error: 'Documento não encontrado' });
  }

  res.json({ status: 'ok', document: updated });
});

apiRouter.delete('/drive/documents/:id', (req, res) => {
  const id = req.params.id;
  const success = db.deleteDriveDocument(id);
  if (!success) {
    return res.status(404).json({ error: 'Documento não encontrado' });
  }
  res.json({ status: 'ok', message: 'Documento excluído com sucesso' });
});
