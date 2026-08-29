const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const dotenv = require('dotenv');

dotenv.config();

const { db, getSetting } = require('./db');
const setupRoutes = require('./routes/setup');
const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const photoRoutes = require('./routes/photos');
const shareRoutes = require('./routes/shares');
const adminRoutes = require('./routes/admin');
const { handleWebDAV } = require('./webdav');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

// Global Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// WebDAV mount point for Android sync
app.use('/webdav', handleWebDAV);

// API Routes
app.use('/api/setup', setupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/admin', adminRoutes);

// Storage info helper endpoint
app.get('/api/info', (req, res) => {
  res.json({
    appName: getSetting('app_name') || 'CloudMe',
    version: '1.0.0',
    isSetupCompleted: getSetting('setup_completed') === 'true'
  });
});

// Serve Static Frontend Assets & PWA
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Fallback to index.html for SPA routing (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/webdav')) {
    return res.sendFile(path.join(publicDir, 'index.html'));
  }
  res.status(404).json({ error: 'Endpoint tidak ditemukan' });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

server.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`🚀 CloudMe Cloud Storage Server is running!`);
  console.log(`🌐 Web Interface : http://localhost:${PORT}`);
  console.log(`📂 WebDAV Sync   : http://localhost:${PORT}/webdav`);
  console.log(`💻 Platform      : ${process.platform} (${process.arch})`);
  console.log(`====================================================`);
});
