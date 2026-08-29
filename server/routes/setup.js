const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('crypto');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, getSetting, setSetting } = require('../db');

// Check setup status
router.get('/status', (req, res) => {
  const isCompleted = getSetting('setup_completed') === 'true';
  const appName = getSetting('app_name') || 'CloudMe';
  const defaultStorage = path.join(__dirname, '..', '..', 'data', 'storage');
  
  res.json({
    isCompleted,
    appName,
    defaultStoragePath: defaultStorage
  });
});

// Submit initial setup wizard
router.post('/complete', (req, res) => {
  const isCompleted = getSetting('setup_completed') === 'true';
  if (isCompleted) {
    return res.status(400).json({ error: 'Instalasi sudah selesai sebelumnya.' });
  }

  const {
    adminUsername,
    adminEmail,
    adminPassword,
    appName = 'CloudMe',
    storagePath,
    defaultQuotaGB = 50
  } = req.body;

  if (!adminUsername || !adminEmail || !adminPassword) {
    return res.status(400).json({ error: 'Mohon lengkapi username, email, dan password admin.' });
  }

  try {
    // 1. Configure Storage Directory
    const resolvedStorage = storagePath && storagePath.trim() !== '' 
      ? path.resolve(storagePath.trim())
      : path.join(__dirname, '..', '..', 'data', 'storage');

    if (!fs.existsSync(resolvedStorage)) {
      fs.mkdirSync(resolvedStorage, { recursive: true });
    }

    // 2. Create Admin User
    const adminId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const passwordHash = bcrypt.hashSync(adminPassword, 10);
    const apiKey = 'cme_' + crypto.randomBytes(24).toString('hex');
    const quotaBytes = (parseInt(defaultQuotaGB, 10) || 50) * 1024 * 1024 * 1024;

    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, storage_quota_bytes, api_key)
      VALUES (?, ?, ?, ?, 'admin', ?, ?)
    `).run(adminId, adminUsername.trim(), adminEmail.trim(), passwordHash, quotaBytes, apiKey);

    // Create user physical folder
    const userStorageDir = path.join(resolvedStorage, adminId);
    if (!fs.existsSync(userStorageDir)) {
      fs.mkdirSync(userStorageDir, { recursive: true });
    }

    // 3. Save Settings
    setSetting('setup_completed', 'true');
    setSetting('app_name', appName.trim());
    setSetting('storage_root', resolvedStorage);
    setSetting('default_quota_bytes', quotaBytes.toString());
    setSetting('allow_registration', 'true');

    res.json({
      success: true,
      message: 'Instalasi Web CloudMe berhasil diselesaikan!',
      admin: {
        username: adminUsername,
        email: adminEmail,
        role: 'admin'
      }
    });
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({ error: 'Gagal menyelesaikan instalasi: ' + err.message });
  }
});

module.exports = router;
