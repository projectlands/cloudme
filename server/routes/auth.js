const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, getSetting } = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

// Register (if enabled)
router.post('/register', (req, res) => {
  const allowReg = getSetting('allow_registration') !== 'false';
  if (!allowReg) {
    return res.status(403).json({ error: 'Registrasi publik dinonaktifkan oleh Administrator.' });
  }

  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Semua kolom wajib diisi.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username.trim(), email.trim());
    if (existing) {
      return res.status(400).json({ error: 'Username atau Email sudah terdaftar.' });
    }

    const userId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const passwordHash = bcrypt.hashSync(password, 10);
    const apiKey = 'cme_' + crypto.randomBytes(24).toString('hex');
    const defaultQuota = parseInt(getSetting('default_quota_bytes') || '53687091200', 10);

    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, storage_quota_bytes, api_key)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(userId, username.trim(), email.trim(), passwordHash, defaultQuota, apiKey);

    // Create user storage directory
    const storageRoot = getSetting('storage_root') || path.join(__dirname, '..', '..', 'data', 'storage');
    const userDir = path.join(storageRoot, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const token = jwt.sign({ id: userId, username: username.trim(), role: 'user' }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      user: {
        id: userId,
        username: username.trim(),
        email: email.trim(),
        role: 'user',
        quotaBytes: defaultQuota,
        apiKey
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Gagal mendaftar: ' + err.message });
  }
});

// Login
router.post('/login', (req, res) => {
  const { usernameOrEmail, password } = req.body;
  if (!usernameOrEmail || !password) {
    return res.status(400).json({ error: 'Username/email dan password wajib diisi.' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(usernameOrEmail.trim(), usernameOrEmail.trim());
    if (!user) {
      return res.status(401).json({ error: 'Kredensial login salah.' });
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Kredensial login salah.' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        quotaBytes: user.storage_quota_bytes,
        apiKey: user.api_key
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Gagal login: ' + err.message });
  }
});

// Current User Profile & Quota Usage
router.get('/me', authMiddleware, (req, res) => {
  try {
    const usedResult = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as used_bytes FROM files WHERE user_id = ? AND is_trashed = 0').get(req.user.id);
    const fileCount = db.prepare('SELECT COUNT(*) as total FROM files WHERE user_id = ? AND is_folder = 0 AND is_trashed = 0').get(req.user.id);
    const photoCount = db.prepare(`
      SELECT COUNT(*) as total FROM files f 
      WHERE f.user_id = ? AND f.is_folder = 0 AND f.is_trashed = 0 
      AND (f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%')
    `).get(req.user.id);

    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        role: req.user.role,
        quotaBytes: req.user.storage_quota_bytes,
        usedBytes: usedResult.used_bytes,
        apiKey: req.user.api_key,
        stats: {
          totalFiles: fileCount.total,
          totalMedia: photoCount.total
        }
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Regenerate API Key (for Android Mobile Sync)
router.post('/regenerate-api-key', authMiddleware, (req, res) => {
  try {
    const newApiKey = 'cme_' + crypto.randomBytes(24).toString('hex');
    db.prepare('UPDATE users SET api_key = ? WHERE id = ?').run(newApiKey, req.user.id);
    res.json({ apiKey: newApiKey });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
