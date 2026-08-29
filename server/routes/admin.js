const express = require('express');
const router = express.Router();
const os = require('os');
const { db, getSetting, setSetting } = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);
router.use(adminOnly);

// 1. GET /api/admin/stats - Server & Storage Overview
router.get('/stats', (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalFiles = db.prepare('SELECT COUNT(*) as count FROM files WHERE is_folder = 0 AND is_trashed = 0').get().count;
    const totalStorageUsed = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM files WHERE is_trashed = 0').get().total;
    const totalPhotos = db.prepare("SELECT COUNT(*) as count FROM files WHERE is_trashed = 0 AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')").get().count;

    const fs = require('fs');
    const path = require('path');
    const storageRoot = getSetting('storage_root') || path.join(__dirname, '..', '..', 'data', 'storage');
    let diskInfo = {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedPercent: 0
    };

    try {
      if (fs.statfsSync) {
        const diskStat = fs.statfsSync(storageRoot);
        const totalDiskBytes = Number(diskStat.bsize) * Number(diskStat.blocks);
        const freeDiskBytes = Number(diskStat.bsize) * Number(diskStat.bfree);
        const usedDiskBytes = totalDiskBytes - freeDiskBytes;
        diskInfo = {
          totalBytes: totalDiskBytes,
          freeBytes: freeDiskBytes,
          usedBytes: usedDiskBytes,
          usedPercent: Math.round((usedDiskBytes / totalDiskBytes) * 100)
        };
      }
    } catch(e) {}

    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      freeMemBytes: os.freemem(),
      totalMemBytes: os.totalmem(),
      uptimeSeconds: os.uptime(),
      nodeVersion: process.version,
      disk: diskInfo
    };

    res.json({
      stats: {
        totalUsers,
        totalFiles,
        totalStorageUsed,
        totalPhotos
      },
      system: systemInfo,
      settings: {
        appName: getSetting('app_name') || 'CloudMe',
        storageRoot: getSetting('storage_root'),
        defaultQuotaBytes: parseInt(getSetting('default_quota_bytes') || '53687091200', 10),
        allowRegistration: getSetting('allow_registration') !== 'false'
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/admin/users - List all users & their usage
router.get('/users', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT 
        u.id, u.username, u.email, u.role, u.storage_quota_bytes, u.created_at,
        COALESCE(SUM(CASE WHEN f.is_trashed = 0 THEN f.size_bytes ELSE 0 END), 0) as used_bytes,
        COUNT(CASE WHEN f.is_folder = 0 AND f.is_trashed = 0 THEN 1 END) as file_count
      FROM users u
      LEFT JOIN files f ON u.id = f.user_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `).all();

    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2.1 POST /api/admin/users - Create new user
router.post('/users', (req, res) => {
  const { username, email, password, role = 'user', quotaGB = 50 } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, dan password wajib diisi.' });
  }

  const cleanUsername = username.trim();
  const cleanEmail = email.trim();
  const cleanRole = role === 'admin' ? 'admin' : 'user';
  const parsedQuota = parseInt(quotaGB, 10);
  if (isNaN(parsedQuota) || parsedQuota <= 0) {
    return res.status(400).json({ error: 'Kapasitas kuota (GB) harus berupa angka positif.' });
  }

  if (cleanUsername.length < 3) {
    return res.status(400).json({ error: 'Username minimal 3 karakter.' });
  }

  if (password.length < 4) {
    return res.status(400).json({ error: 'Password minimal 4 karakter.' });
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(cleanUsername, cleanEmail);
    if (existing) {
      return res.status(400).json({ error: 'Username atau Email sudah terdaftar.' });
    }

    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');
    const { getUserStorageDir } = require('../db');

    const userId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const passwordHash = bcrypt.hashSync(password, 10);
    const apiKey = 'cme_' + crypto.randomBytes(24).toString('hex');
    const quotaBytes = parsedQuota * 1024 * 1024 * 1024;

    db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, storage_quota_bytes, api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, cleanUsername, cleanEmail, passwordHash, cleanRole, quotaBytes, apiKey);

    // Initialize physical storage folder for the user
    getUserStorageDir(userId);

    res.json({
      success: true,
      message: `Pengguna '${cleanUsername}' berhasil ditambahkan.`,
      user: {
        id: userId,
        username: cleanUsername,
        email: cleanEmail,
        role: cleanRole,
        storage_quota_bytes: quotaBytes
      }
    });
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Gagal membuat pengguna: ' + err.message });
  }
});

// 2.2 PUT /api/admin/users/:id - Update user details
router.put('/users/:id', (req, res) => {
  const { username, email, password, role, quotaGB } = req.body;
  const userId = req.params.id;

  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    }

    const cleanUsername = username ? username.trim() : user.username;
    const cleanEmail = email ? email.trim() : user.email;
    const cleanRole = role ? (role === 'admin' ? 'admin' : 'user') : user.role;

    if (cleanUsername.length < 3) {
      return res.status(400).json({ error: 'Username minimal 3 karakter.' });
    }

    // Check uniqueness
    const duplicate = db.prepare('SELECT id FROM users WHERE (username = ? OR email = ?) AND id != ?').get(cleanUsername, cleanEmail, userId);
    if (duplicate) {
      return res.status(400).json({ error: 'Username atau Email sudah digunakan oleh pengguna lain.' });
    }

    // Prevent demoting the only admin
    if (user.role === 'admin' && cleanRole !== 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = "admin"').get().count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Tidak dapat mengubah role administrator terakhir sistem.' });
      }
    }

    let quotaBytes = user.storage_quota_bytes;
    if (quotaGB !== undefined && !isNaN(parseInt(quotaGB, 10))) {
      quotaBytes = parseInt(quotaGB, 10) * 1024 * 1024 * 1024;
    }

    if (password && password.trim() !== '') {
      if (password.trim().length < 4) {
        return res.status(400).json({ error: 'Password baru minimal 4 karakter.' });
      }
      const bcrypt = require('bcryptjs');
      const passwordHash = bcrypt.hashSync(password.trim(), 10);
      db.prepare(`
        UPDATE users 
        SET username = ?, email = ?, password_hash = ?, role = ?, storage_quota_bytes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cleanUsername, cleanEmail, passwordHash, cleanRole, quotaBytes, userId);
    } else {
      db.prepare(`
        UPDATE users 
        SET username = ?, email = ?, role = ?, storage_quota_bytes = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(cleanUsername, cleanEmail, cleanRole, quotaBytes, userId);
    }

    res.json({
      success: true,
      message: `Data pengguna '${cleanUsername}' berhasil diperbarui.`
    });
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Gagal memperbarui pengguna: ' + err.message });
  }
});

// 2.3 DELETE /api/admin/users/:id - Delete user & storage
router.delete('/users/:id', (req, res) => {
  const userId = req.params.id;

  try {
    if (req.user && req.user.id === userId) {
      return res.status(400).json({ error: 'Anda tidak dapat menghapus akun Anda sendiri yang sedang aktif digunakan.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ error: 'Pengguna tidak ditemukan.' });
    }

    if (user.role === 'admin') {
      const adminCount = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = "admin"').get().count;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Tidak dapat menghapus administrator terakhir sistem.' });
      }
    }

    // Delete user from DB (foreign keys cascade will remove files, shares, sync_devices, photo_metadata)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);

    // Delete physical user storage directory
    const fs = require('fs');
    const path = require('path');
    const { getActiveStorageDir } = require('../db');
    const storageDir = getActiveStorageDir();

    const possibleDirs = [
      path.join(storageDir, `user_${userId}`),
      path.join(storageDir, userId)
    ];

    for (const dir of possibleDirs) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
          console.error(`Error deleting user storage directory ${dir}:`, e.message);
        }
      }
    }

    res.json({
      success: true,
      message: `Pengguna '${user.username}' beserta seluruh data berkasnya berhasil dihapus.`
    });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ error: 'Gagal menghapus pengguna: ' + err.message });
  }
});

// 3. PUT /api/admin/users/:id/quota - Update User Quota
router.put('/users/:id/quota', (req, res) => {
  const { quotaGB } = req.body;
  if (!quotaGB || isNaN(quotaGB)) {
    return res.status(400).json({ error: 'Kapasitas kuota (GB) tidak valid.' });
  }

  try {
    const quotaBytes = parseInt(quotaGB, 10) * 1024 * 1024 * 1024;
    db.prepare('UPDATE users SET storage_quota_bytes = ? WHERE id = ?').run(quotaBytes, req.params.id);
    res.json({ success: true, message: 'Kuota pengguna berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT /api/admin/settings - Update global settings
router.put('/settings', (req, res) => {
  const { appName, allowRegistration, defaultQuotaGB } = req.body;
  try {
    if (appName) setSetting('app_name', appName.trim());
    if (allowRegistration !== undefined) setSetting('allow_registration', allowRegistration ? 'true' : 'false');
    if (defaultQuotaGB) {
      const quotaBytes = parseInt(defaultQuotaGB, 10) * 1024 * 1024 * 1024;
      setSetting('default_quota_bytes', quotaBytes.toString());
    }
    res.json({ success: true, message: 'Pengaturan sistem berhasil disimpan.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. GET /api/admin/drives - Get all detected physical disk drives on host machine
router.get('/drives', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const { getActiveStorageDir } = require('../db');

  const currentStorageDir = getActiveStorageDir();
  const drives = [];

  try {
    if (process.platform === 'win32') {
      const output = execSync('powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Free, Used | ConvertTo-Json"', { encoding: 'utf-8' });
      const parsed = JSON.parse(output);
      const list = Array.isArray(parsed) ? parsed : [parsed];

      for (const d of list) {
        if (!d.Root) continue;
        const rootPath = d.Root.endsWith('\\') ? d.Root : d.Root + '\\';
        const free = Number(d.Free) || 0;
        const used = Number(d.Used) || 0;
        const total = free + used;
        drives.push({
          name: `Drive ${d.Name}:`,
          letter: d.Name,
          root: rootPath,
          freeBytes: free,
          usedBytes: used,
          totalBytes: total,
          usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
          isActive: currentStorageDir.toLowerCase().startsWith(rootPath.toLowerCase())
        });
      }
    } else {
      // Linux / Unix statfs
      const stat = fs.statfsSync('/');
      const total = Number(stat.bsize) * Number(stat.blocks);
      const free = Number(stat.bsize) * Number(stat.bfree);
      const used = total - free;
      drives.push({
        name: 'Root Partition (/)',
        letter: '/',
        root: '/',
        freeBytes: free,
        usedBytes: used,
        totalBytes: total,
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        isActive: true
      });
    }
  } catch (e) {
    console.error('Error fetching drives:', e.message);
  }

  res.json({
    currentStorageDir,
    drives
  });
});

// 6. POST /api/admin/storage-path - Change the active storage directory / HDD Drive
router.post('/storage-path', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const { newPath, migrateExisting = false } = req.body;
  const { getActiveStorageDir, setSetting } = require('../db');

  if (!newPath || typeof newPath !== 'string' || newPath.trim() === '') {
    return res.status(400).json({ error: 'Lokasi path penyimpanan tidak boleh kosong.' });
  }

  const targetPath = path.resolve(newPath.trim());
  const oldStorageDir = getActiveStorageDir();

  try {
    // 1. Ensure target directory exists & writable
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    // Test write permission
    const testFile = path.join(targetPath, `.cloudme_write_test_${Date.now()}`);
    fs.writeFileSync(testFile, 'OK');
    fs.unlinkSync(testFile);

    // 2. Optionally migrate existing user folders
    let migratedCount = 0;
    if (migrateExisting && fs.existsSync(oldStorageDir) && oldStorageDir !== targetPath) {
      const items = fs.readdirSync(oldStorageDir);
      for (const item of items) {
        if (item.startsWith('user_')) {
          const oldUserDir = path.join(oldStorageDir, item);
          const newUserDir = path.join(targetPath, item);
          if (!fs.existsSync(newUserDir)) {
            fs.cpSync(oldUserDir, newUserDir, { recursive: true });
            migratedCount++;
          }
        }
      }
    }

    // 3. Save new storage path to settings
    setSetting('storage_path', targetPath);

    res.json({
      success: true,
      message: `Lokasi penyimpanan berhasil dialihkan ke: ${targetPath}${migratedCount > 0 ? ` (${migratedCount} folder pengguna berhasil dimigrasi)` : ''}`,
      activeStorageDir: targetPath
    });
  } catch (err) {
    console.error('Storage path change error:', err);
    res.status(500).json({ error: `Gagal mengalihkan penyimpanan ke '${targetPath}': ${err.message}` });
  }
});

module.exports = router;
