const jwt = require('jsonwebtoken');
const { db, getSetting } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'cloudme_super_secret_jwt_key_2026';

function authMiddleware(req, res, next) {
  let token = null;

  // Check Authorization Header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query && req.query.token) {
    // For direct image/video/download streaming via <img>, <video>, <a> links
    token = req.query.token;
  }

  // Check API Key (for Android Mobile Auto-Backup background sync)
  const apiKey = req.headers['x-api-key'] || (req.query && req.query.api_key);
  if (apiKey) {
    const user = db.prepare('SELECT id, username, email, role, storage_quota_bytes FROM users WHERE api_key = ?').get(apiKey);
    if (user) {
      req.user = user;
      return next();
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Akses ditolak. Token autentikasi tidak ditemukan.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, username, email, role, storage_quota_bytes FROM users WHERE id = ?').get(decoded.id);
    if (!user) {
      return res.status(401).json({ error: 'User tidak valid.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token kedaluwarsa atau tidak valid.' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Akses khusus Administrator.' });
  }
  next();
}

module.exports = {
  authMiddleware,
  adminOnly,
  JWT_SECRET
};
