const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const archiver = require('archiver');
const { db, getSetting, getUserStorageDir } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// Helper: Check if an item is the root shared folder or a descendant of it
function isDescendantOf(childId, rootId, userId) {
  if (childId === rootId) return true;
  let currentId = childId;
  while (currentId) {
    const item = db.prepare('SELECT id, parent_id FROM files WHERE id = ? AND user_id = ? AND is_trashed = 0').get(currentId, userId);
    if (!item) return false;
    if (item.parent_id === rootId) return true;
    currentId = item.parent_id;
  }
  return false;
}

// Helper: Build breadcrumbs from current folder up to the shared root folder
function buildShareBreadcrumbs(currentFolderId, rootFolderId, userId) {
  const crumbs = [];
  let curr = currentFolderId;
  while (curr) {
    const folder = db.prepare('SELECT id, name, parent_id FROM files WHERE id = ? AND user_id = ?').get(curr, userId);
    if (!folder) break;
    crumbs.unshift({ id: folder.id, name: folder.name });
    if (folder.id === rootFolderId) break;
    curr = folder.parent_id;
  }
  return crumbs;
}

// -------------------------------------------------------------
// 1. POST /api/shares - Create Public Share Link (Single File, Folder, or Multiple Files)
// -------------------------------------------------------------
router.post('/', authMiddleware, async (req, res) => {
  const { fileId, fileIds, password, allowDownload = true, expiresInDays = null } = req.body;

  let targetFileIds = [];
  if (Array.isArray(fileIds) && fileIds.length > 0) {
    targetFileIds = fileIds;
  } else if (fileId) {
    targetFileIds = [fileId];
  }

  if (targetFileIds.length === 0) {
    return res.status(400).json({ error: 'File / Folder ID wajib disertakan.' });
  }

  try {
    const placeholders = targetFileIds.map(() => '?').join(',');
    const validFiles = db.prepare(`SELECT * FROM files WHERE id IN (${placeholders}) AND user_id = ? AND is_trashed = 0`).all(...targetFileIds, req.user.id);
    if (validFiles.length === 0) {
      return res.status(404).json({ error: 'Item tidak ditemukan atau tidak memiliki izin akses.' });
    }

    const shareId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(12).toString('hex');
    const passwordHash = password && password.trim() !== '' ? bcrypt.hashSync(password.trim(), 10) : null;

    let expiresAt = null;
    if (expiresInDays && parseInt(expiresInDays, 10) > 0) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(expiresInDays, 10));
      expiresAt = d.toISOString();
    }

    // Insert main share row (file_id references first valid file to satisfy FK)
    db.prepare(`
      INSERT INTO shares (id, file_id, user_id, token, password_hash, allow_download, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(shareId, validFiles[0].id, req.user.id, token, passwordHash, allowDownload ? 1 : 0, expiresAt);

    // Insert items into share_items
    const insertShareItem = db.prepare(`INSERT OR IGNORE INTO share_items (share_id, file_id) VALUES (?, ?)`);
    const insertMany = db.transaction((items) => {
      for (const f of items) {
        insertShareItem.run(shareId, f.id);
      }
    });
    insertMany(validFiles);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const shareUrl = `${protocol}://${host}/#share/${token}`;

    const isMulti = validFiles.length > 1;

    res.json({
      success: true,
      share: {
        id: shareId,
        token,
        shareUrl,
        isMulti,
        itemsCount: validFiles.length,
        isFolder: !isMulti && validFiles[0].is_folder === 1,
        isPasswordProtected: !!passwordHash,
        expiresAt
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. GET /api/shares/:token - Public Share Metadata
// -------------------------------------------------------------
router.get('/:token', (req, res) => {
  try {
    const share = db.prepare(`
      SELECT s.*, f.name, f.size_bytes, f.mime_type, f.is_folder, u.username as owner_name
      FROM shares s
      JOIN files f ON s.file_id = f.id
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ?
    `).get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Tautan berbagi tidak ditemukan atau sudah dihapus.' });
    }

    // Check expiration
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Tautan berbagi sudah kedaluwarsa.' });
    }

    // Increment view count
    db.prepare('UPDATE shares SET views_count = views_count + 1 WHERE token = ?').run(req.params.token);

    // Check multi items in share_items
    const shareItems = db.prepare(`
      SELECT f.id, f.name, f.size_bytes, f.mime_type, f.is_folder, f.updated_at
      FROM share_items si
      JOIN files f ON si.file_id = f.id
      WHERE si.share_id = ? AND f.is_trashed = 0
      ORDER BY f.is_folder DESC, f.name ASC
    `).all(share.id);

    const isMulti = shareItems.length > 1;

    if (isMulti) {
      const totalSizeBytes = shareItems.reduce((acc, item) => acc + (item.size_bytes || 0), 0);
      return res.json({
        token: share.token,
        isMulti: true,
        itemsCount: shareItems.length,
        name: `Koleksi Berbagi (${shareItems.length} berkas)`,
        sizeBytes: totalSizeBytes,
        mimeType: 'application/zip',
        isFolder: false,
        ownerName: share.owner_name,
        requiresPassword: !!share.password_hash,
        allowDownload: share.allow_download === 1,
        createdAt: share.created_at,
        expiresAt: share.expires_at,
        items: shareItems
      });
    }

    res.json({
      token: share.token,
      isMulti: false,
      name: share.name,
      sizeBytes: share.size_bytes,
      mimeType: share.mime_type,
      isFolder: share.is_folder === 1,
      ownerName: share.owner_name,
      requiresPassword: !!share.password_hash,
      allowDownload: share.allow_download === 1,
      createdAt: share.created_at,
      expiresAt: share.expires_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. GET /api/shares/:token/contents - Public Shared Folder Explorer
// -------------------------------------------------------------
router.get('/:token/contents', (req, res) => {
  const { folderId, password } = req.query;

  try {
    const share = db.prepare(`
      SELECT s.*, f.name, f.is_folder
      FROM shares s
      JOIN files f ON s.file_id = f.id
      WHERE s.token = ?
    `).get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Tautan berbagi tidak ditemukan.' });
    }

    if (share.is_folder !== 1) {
      return res.status(400).json({ error: 'Item yang dibagikan bukan folder.' });
    }

    if (share.password_hash) {
      if (!password || !bcrypt.compareSync(password, share.password_hash)) {
        return res.status(401).json({ error: 'Password link salah atau belum dimasukkan.' });
      }
    }

    const rootFolderId = share.file_id;
    const targetFolderId = (folderId && folderId.trim() !== '') ? folderId.trim() : rootFolderId;

    // Security check: Target folder must be the root folder or a descendant of the root folder
    if (!isDescendantOf(targetFolderId, rootFolderId, share.user_id)) {
      return res.status(403).json({ error: 'Akses folder tidak sah di luar direktori yang dibagikan.' });
    }

    const currentFolder = db.prepare('SELECT id, name, is_folder, parent_id, created_at FROM files WHERE id = ? AND user_id = ? AND is_trashed = 0').get(targetFolderId, share.user_id);
    if (!currentFolder) {
      return res.status(404).json({ error: 'Folder tidak ditemukan.' });
    }

    const items = db.prepare(`
      SELECT id, name, is_folder, size_bytes, mime_type, is_starred, created_at, updated_at
      FROM files
      WHERE user_id = ? AND parent_id = ? AND is_trashed = 0
      ORDER BY is_folder DESC, name ASC
    `).all(share.user_id, targetFolderId);

    const breadcrumbs = buildShareBreadcrumbs(targetFolderId, rootFolderId, share.user_id);

    res.json({
      rootFolderId,
      currentFolder,
      breadcrumbs,
      items
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 4. GET /api/shares/:token/download-zip - Download Entire Shared Folder as ZIP
// -------------------------------------------------------------
router.get('/:token/download-zip', (req, res) => {
  const { password } = req.query;

  try {
    const share = db.prepare(`
      SELECT s.*, f.name, f.is_folder
      FROM shares s
      JOIN files f ON s.file_id = f.id
      WHERE s.token = ?
    `).get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Tautan berbagi tidak ditemukan.' });
    }

    if (share.allow_download !== 1) {
      return res.status(403).json({ error: 'Pengunduhan dinonaktifkan untuk link ini.' });
    }

    if (share.password_hash) {
      if (!password || !bcrypt.compareSync(password, share.password_hash)) {
        return res.status(401).json({ error: 'Password salah atau belum dimasukkan.' });
      }
    }

    const rootFolderId = share.file_id;
    const userStorageDir = getUserStorageDir(share.user_id);

    // Recursively collect all descendant files with relative paths
    const filesToZip = [];

    function traverse(folderId, relativeDir) {
      const children = db.prepare('SELECT id, name, is_folder, disk_path FROM files WHERE user_id = ? AND parent_id = ? AND is_trashed = 0').all(share.user_id, folderId);
      for (const child of children) {
        const itemRelPath = relativeDir ? path.join(relativeDir, child.name) : child.name;
        if (child.is_folder) {
          traverse(child.id, itemRelPath);
        } else if (child.disk_path) {
          filesToZip.push({
            diskPath: path.join(userStorageDir, child.disk_path),
            zipPath: itemRelPath
          });
        }
      }
    }

    traverse(rootFolderId, '');

    const safeZipName = `${share.name.replace(/[^a-zA-Z0-9_\-\.]/g, '_')}_${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    for (const f of filesToZip) {
      if (fs.existsSync(f.diskPath)) {
        archive.file(f.diskPath, { name: f.zipPath });
      }
    }

    archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 5. GET /api/shares/:token/file/:fileId/download - Download file from shared folder
// -------------------------------------------------------------
router.get('/:token/file/:fileId/download', (req, res) => {
  const { password } = req.query;
  const { token, fileId } = req.params;

  try {
    const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
    if (!share) {
      return res.status(404).json({ error: 'Tautan berbagi tidak ditemukan.' });
    }

    if (share.allow_download !== 1) {
      return res.status(403).json({ error: 'Pengunduhan dinonaktifkan untuk link ini.' });
    }

    if (share.password_hash) {
      if (!password || !bcrypt.compareSync(password, share.password_hash)) {
        return res.status(401).json({ error: 'Password diperlukan.' });
      }
    }

    // Security check: fileId must be descendant of share.file_id OR be in share_items
    const inShareItems = db.prepare('SELECT 1 FROM share_items WHERE share_id = ? AND file_id = ?').get(share.id, fileId);
    if (!inShareItems && !isDescendantOf(fileId, share.file_id, share.user_id)) {
      return res.status(403).json({ error: 'Akses berkas tidak diizinkan.' });
    }

    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ? AND is_trashed = 0').get(fileId, share.user_id);
    if (!file || !file.disk_path) {
      return res.status(404).json({ error: 'Berkas tidak ditemukan.' });
    }

    const userStorageDir = getUserStorageDir(share.user_id);
    const filePath = path.join(userStorageDir, file.disk_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Berkas fisik tidak ditemukan di disk server.' });
    }

    res.download(filePath, file.name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 6. GET /api/shares/:token/file/:fileId/preview - Streaming Preview file from shared folder
// -------------------------------------------------------------
router.get('/:token/file/:fileId/preview', (req, res) => {
  const { password } = req.query;
  const { token, fileId } = req.params;

  try {
    const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
    if (!share) {
      return res.status(404).json({ error: 'Tautan berbagi tidak ditemukan.' });
    }

    if (share.password_hash) {
      if (!password || !bcrypt.compareSync(password, share.password_hash)) {
        return res.status(401).json({ error: 'Password diperlukan.' });
      }
    }

    // Security check: fileId must be descendant of share.file_id OR be in share_items
    const inShareItems = db.prepare('SELECT 1 FROM share_items WHERE share_id = ? AND file_id = ?').get(share.id, fileId);
    if (!inShareItems && !isDescendantOf(fileId, share.file_id, share.user_id)) {
      return res.status(403).json({ error: 'Akses berkas tidak diizinkan.' });
    }

    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ? AND is_trashed = 0').get(fileId, share.user_id);
    if (!file || !file.disk_path) {
      return res.status(404).json({ error: 'Berkas tidak ditemukan.' });
    }

    const userStorageDir = getUserStorageDir(share.user_id);
    const filePath = path.join(userStorageDir, file.disk_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Berkas fisik tidak ditemukan.' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': file.mime_type || 'application/octet-stream',
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': file.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 7. GET /api/shares/:token/qr - Generate QR Code image for mobile scan
// -------------------------------------------------------------
router.get('/:token/qr', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const shareUrl = `${protocol}://${host}/#share/${req.params.token}`;

    const qrPng = await qrcode.toBuffer(shareUrl, {
      width: 320,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    res.setHeader('Content-Type', 'image/png');
    res.send(qrPng);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 8. GET /api/shares/:token/download - Direct Single File Download
// -------------------------------------------------------------
router.get('/:token/download', (req, res) => {
  const { password } = req.query;

  try {
    const share = db.prepare(`
      SELECT s.*, f.name, f.disk_path, f.size_bytes, f.mime_type, f.is_folder
      FROM shares s
      JOIN files f ON s.file_id = f.id
      WHERE s.token = ?
    `).get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Tautan berbagi tidak ditemukan.' });
    }

    // If it's a folder, redirect to download-zip
    if (share.is_folder === 1) {
      return res.redirect(`/api/shares/${req.params.token}/download-zip${password ? `?password=${encodeURIComponent(password)}` : ''}`);
    }

    if (share.allow_download !== 1) {
      return res.status(403).json({ error: 'Pengunduhan file dinonaktifkan untuk link ini.' });
    }

    if (share.password_hash) {
      if (!password || !bcrypt.compareSync(password, share.password_hash)) {
        return res.status(401).json({ error: 'Password link salah atau belum dimasukkan.' });
      }
    }

    // Check if multi-item share
    const shareItems = db.prepare(`
      SELECT f.id, f.name, f.disk_path, f.is_folder
      FROM share_items si
      JOIN files f ON si.file_id = f.id
      WHERE si.share_id = ? AND f.is_trashed = 0
    `).all(share.id);

    const userStorageDir = getUserStorageDir(share.user_id);

    if (shareItems.length > 1) {
      const safeZipName = `CloudMe_Share_${share.token.slice(0, 8)}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeZipName}"`);

      const archive = archiver('zip', { zlib: { level: 5 } });
      archive.pipe(res);

      for (const item of shareItems) {
        if (item.disk_path) {
          const abs = path.join(userStorageDir, item.disk_path);
          if (fs.existsSync(abs)) {
            archive.file(abs, { name: item.name });
          }
        }
      }
      return archive.finalize();
    }
    const filePath = path.join(userStorageDir, share.disk_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File fisik tidak ditemukan.' });
    }

    res.download(filePath, share.name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 9. GET /api/shares/:token/preview - Direct Single File Preview
// -------------------------------------------------------------
router.get('/:token/preview', (req, res) => {
  const { password } = req.query;

  try {
    const share = db.prepare(`
      SELECT s.*, f.name, f.disk_path, f.size_bytes, f.mime_type, f.is_folder
      FROM shares s
      JOIN files f ON s.file_id = f.id
      WHERE s.token = ?
    `).get(req.params.token);

    if (!share) {
      return res.status(404).json({ error: 'Tautan tidak ditemukan.' });
    }

    if (share.password_hash) {
      if (!password || !bcrypt.compareSync(password, share.password_hash)) {
        return res.status(401).json({ error: 'Password diperlukan.' });
      }
    }

    const userStorageDir = getUserStorageDir(share.user_id);
    const filePath = path.join(userStorageDir, share.disk_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File fisik tidak ditemukan.' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const stream = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': share.mime_type || 'application/octet-stream',
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': share.mime_type || 'application/octet-stream',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 10. GET /api/shares/:token/qr - Generate QR Code image
// -------------------------------------------------------------
router.get('/:token/qr', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const origin = `${protocol}://${host}`;

    let targetUrl;
    if (req.params.token === 'test' || req.params.token === 'hub' || req.params.token === 'server') {
      targetUrl = origin;
    } else {
      const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token);
      targetUrl = share ? `${origin}/#share/${share.token}` : origin;
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    qrcode.toFileStream(res, targetUrl, {
      width: 300,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
