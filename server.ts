import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes.js';
import { db, uploadsDir } from './server/db.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Enable CORS so frontend can run as a separate static site if desired
  app.use(
    cors({
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['Content-Disposition'],
    })
  );

  // Serve persistent uploads folder
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use('/uploads', express.static(uploadsDir));
  app.use('/api/uploads', express.static(uploadsDir));

  // Middleware for body parsing
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // API health check
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'Indoor Media Server', timestamp: Date.now() });
  });

  // Mount API router
  app.use('/api', apiRouter);

  // Prevent unhandled /api/* routes from falling through to Vite SPA index.html
  app.use('/api/*', (req, res) => {
    res.status(404).json({ error: `Endpoint de API não encontrado: ${req.method} ${req.originalUrl}` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Indoor Media Server running on port ${PORT}`);
    // Initialize and restore database from Firebase Firestore in background after port is bound
    db.initFromFirestore().catch((err) => {
      console.error('[Startup] Failed to restore from Firestore:', err);
    });
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
