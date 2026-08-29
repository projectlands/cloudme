const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const archiver = require('archiver');
const exifParser = require('exif-parser');
const { db, getSetting, setSetting, getUserStorageDir, getActiveStorageDir } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// Multer Storage Configuration
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'temp');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10GB per single request
});

// Helper: Calculate SHA-256 Checksum
function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

// Helper: Extract EXIF metadata if image
function extractExif(filePath, fileId) {
  try {
    const buffer = fs.readFileSync(filePath);
    const parser = exifParser.create(buffer);
    const result = parser.parse();
    if (result && result.tags) {
      const tags = result.tags;
      const dateTaken = tags.DateTimeOriginal 
        ? new Date(tags.DateTimeOriginal * 1000).toISOString() 
        : (tags.CreateDate ? new Date(tags.CreateDate * 1000).toISOString() : new Date().toISOString());

      db.prepare(`
        INSERT OR REPLACE INTO photo_metadata (
          file_id, date_taken, width, height, camera_make, camera_model, iso, focal_length, latitude, longitude
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fileId,
        dateTaken,
        tags.ExifImageWidth || result.imageSize?.width || null,
        tags.ExifImageHeight || result.imageSize?.height || null,
        tags.Make || null,
        tags.Model || null,
        tags.ISO || null,
        tags.FocalLength || null,
        result.tags.GPSLatitude || null,
        result.tags.GPSLongitude || null
      );
    }
  } catch (err) {
    // Non-fatal if EXIF not present or fails
  }
}

// -------------------------------------------------------------
// 1. GET /api/files - List files & folders with filters
// -------------------------------------------------------------
router.get('/', authMiddleware, (req, res) => {
  try {
    const {
      parentId = null,
      view = 'all', // 'all', 'starred', 'recent', 'trash', 'photos'
      search = '',
      type = 'all', // 'all', 'image', 'video', 'document', 'audio', 'archive'
      sortBy = 'name', // 'name', 'size', 'updated_at', 'type'
      sortOrder = 'asc'
    } = req.query;

    let query = 'SELECT * FROM files WHERE user_id = ?';
    const params = [req.user.id];

    // Filter by view
    if (view === 'trash') {
      query += ' AND is_trashed = 1';
    } else {
      query += ' AND is_trashed = 0';

      if (view === 'starred') {
        query += ' AND is_starred = 1';
      } else if (view === 'recent') {
        query += ' AND is_folder = 0';
      } else if (view === 'photos') {
        query += " AND is_folder = 0 AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')";
      } else if (!search) {
        // Normal directory browsing
        if (parentId && parentId !== 'root') {
          query += ' AND parent_id = ?';
          params.push(parentId);
        } else {
          query += ' AND parent_id IS NULL';
        }
      }
    }

    // Search query filter
    if (search && search.trim() !== '') {
      query += ' AND name LIKE ?';
      params.push(`%${search.trim()}%`);
    }

    // Type filter
    if (type === 'image') query += " AND mime_type LIKE 'image/%'";
    else if (type === 'video') query += " AND mime_type LIKE 'video/%'";
    else if (type === 'audio') query += " AND mime_type LIKE 'audio/%'";
    else if (type === 'document') query += " AND (mime_type LIKE '%pdf%' OR mime_type LIKE '%word%' OR mime_type LIKE '%text%' OR mime_type LIKE '%sheet%' OR mime_type LIKE '%presentation%')";
    else if (type === 'archive') query += " AND (mime_type LIKE '%zip%' OR mime_type LIKE '%tar%' OR mime_type LIKE '%rar%' OR mime_type LIKE '%7z%')";
    else if (type === 'folder') query += " AND is_folder = 1";

    // Sorting: Always keep folders first when browsing normally
    let orderSql = 'is_folder DESC, ';
    if (sortBy === 'size') orderSql += `size_bytes ${sortOrder.toUpperCase()}`;
    else if (sortBy === 'updated_at' || view === 'recent') orderSql += `updated_at ${sortOrder.toUpperCase()}`;
    else orderSql += `name COLLATE NOCASE ${sortOrder.toUpperCase()}`;

    query += ` ORDER BY ${orderSql}`;

    const items = db.prepare(query).all(...params);

    // Build breadcrumbs if inside a folder
    let breadcrumbs = [{ id: 'root', name: 'My Drive' }];
    if (parentId && parentId !== 'root' && view === 'all' && !search) {
      let currentId = parentId;
      const trail = [];
      while (currentId) {
        const folder = db.prepare('SELECT id, name, parent_id FROM files WHERE id = ? AND user_id = ?').get(currentId, req.user.id);
        if (folder) {
          trail.unshift({ id: folder.id, name: folder.name });
          currentId = folder.parent_id;
        } else {
          break;
        }
      }
      breadcrumbs = [{ id: 'root', name: 'My Drive' }, ...trail];
    }

    res.json({
      items,
      breadcrumbs,
      currentFolderId: parentId === 'root' ? null : parentId
    });
  } catch (err) {
    console.error('List files error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. POST /api/files/folder - Create Folder
// -------------------------------------------------------------
router.post('/folder', authMiddleware, (req, res) => {
  const { name, parentId = null } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Nama folder tidak boleh kosong.' });
  }

  try {
    const folderId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const targetParent = parentId === 'root' ? null : parentId;

    db.prepare(`
      INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type)
      VALUES (?, ?, ?, ?, 1, 0, 'folder')
    `).run(folderId, req.user.id, targetParent, name.trim());

    res.json({
      success: true,
      folder: {
        id: folderId,
        name: name.trim(),
        is_folder: 1,
        parent_id: targetParent
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 3. POST /api/files/upload - Standard Upload (Single / Multiple)
// -------------------------------------------------------------
router.post('/upload', authMiddleware, upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Tidak ada file yang diunggah.' });
  }

  let parentId = (req.body.parentId && req.body.parentId !== 'root') ? req.body.parentId : null;
  const folderPath = req.body.folderPath ? req.body.folderPath.trim() : null;

  // Auto-resolve or create folder hierarchy if folderPath is provided (e.g. "Backup - Samsung A54/Keluarga")
  if (folderPath) {
    const parts = folderPath.split(/[/\\]+/).map(p => p.trim()).filter(Boolean);
    let currentParent = parentId;
    for (const part of parts) {
      let existingFolder = db.prepare(`
        SELECT id FROM files 
        WHERE user_id = ? AND (parent_id IS ? OR parent_id = ?) AND name = ? AND is_folder = 1 AND is_trashed = 0
      `).get(req.user.id, currentParent, currentParent, part);

      if (!existingFolder) {
        const newFolderId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        db.prepare(`
          INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type)
          VALUES (?, ?, ?, ?, 1, 0, 'folder')
        `).run(newFolderId, req.user.id, currentParent, part);
        currentParent = newFolderId;
      } else {
        currentParent = existingFolder.id;
      }
    }
    parentId = currentParent;
  }

  const userStorageDir = getUserStorageDir(req.user.id);
  const uploadedResults = [];

  try {
    for (const file of req.files) {
      const detectedMime = mime.lookup(file.originalname) || file.mimetype || 'application/octet-stream';

      // Check for duplicate file with same name and size in the same location
      const existingFile = db.prepare(`
        SELECT id FROM files 
        WHERE user_id = ? AND (parent_id IS ? OR parent_id = ?) AND name = ? AND size_bytes = ? AND is_trashed = 0
      `).get(req.user.id, parentId, parentId, file.originalname, file.size);

      if (existingFile) {
        try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch (e) {}
        uploadedResults.push({
          id: existingFile.id,
          name: file.originalname,
          size: file.size,
          mimeType: detectedMime,
          isDuplicate: true
        });
        continue;
      }

      const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const ext = path.extname(file.originalname);
      const safeDiskName = `${fileId}${ext}`;
      const finalDiskPath = path.join(userStorageDir, safeDiskName);

      // Move from temp to user storage
      fs.renameSync(file.path, finalDiskPath);

      // Checksum
      const checksum = await calculateChecksum(finalDiskPath);

      db.prepare(`
        INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type, disk_path, checksum_sha256)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(fileId, req.user.id, parentId, file.originalname, file.size, detectedMime, safeDiskName, checksum);

      // Extract EXIF if image
      if (detectedMime.startsWith('image/')) {
        extractExif(finalDiskPath, fileId);
      }

      uploadedResults.push({
        id: fileId,
        name: file.originalname,
        size: file.size,
        mimeType: detectedMime
      });
    }

    res.json({
      success: true,
      files: uploadedResults
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Gagal mengunggah file: ' + err.message });
  }
});

// Helper: Recursively crawl & download Google Drive folders and nested subfolders with Live Progress
async function recursiveDownloadGDriveFolder(folderId, parentDbFolderId, userId, customName = '', depth = 0, onProgress = null, statsCounter = { totalDownloaded: 0 }) {
  if (depth > 6) return { totalFiles: 0, totalFolders: 0, files: [] };
  const folderUrl = `https://drive.google.com/drive/folders/${folderId}?usp=sharing`;

  if (onProgress) {
    onProgress({
      percent: Math.min(90, 5 + statsCounter.totalDownloaded * 7),
      status: `Memindai direktori folder...`
    });
  }

  const folderPageRes = await fetch(folderUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  const html = await folderPageRes.text();

  if (html.includes('accounts.google.com/v3/signin') || html.includes('Sign in') || html.includes('Perlu izin')) {
    throw new Error("Folder Google Drive berstatus 'Private' atau memerlukan izin akses.");
  }

  let folderName = customName ? customName.trim() : '';
  if (!folderName) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    if (titleMatch && titleMatch[1]) {
      folderName = titleMatch[1].replace(' - Google Drive', '').trim();
    }
  }
  if (!folderName) folderName = `Folder_${folderId}`;

  // Create folder in SQLite
  const newFolderDbId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  const targetParent = (parentDbFolderId && parentDbFolderId !== 'root') ? parentDbFolderId : null;

  db.prepare(`
    INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type)
    VALUES (?, ?, ?, ?, 1, 0, 'folder')
  `).run(newFolderDbId, userId, targetParent, folderName);

  // Extract child IDs
  const idRegex = /data-id=\"([a-zA-Z0-9_-]{25,45})\"/g;
  const foundIds = new Set();
  let m;
  while ((m = idRegex.exec(html)) !== null) {
    if (m[1] !== folderId) foundIds.add(m[1]);
  }

  const childIds = Array.from(foundIds);
  const userStorageDir = getUserStorageDir(userId);
  let importedFiles = [];
  let totalSubfolders = 0;

  for (const childId of childIds) {
    try {
      const directUrls = [
        `https://drive.usercontent.google.com/download?id=${childId}&export=download&authuser=0&confirm=t`,
        `https://drive.google.com/uc?export=download&id=${childId}&confirm=t`
      ];

      let fileRes = null;
      for (const dUrl of directUrls) {
        const r = await fetch(dUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        });
        if (r.ok) {
          const cType = r.headers.get('content-type') || '';
          const cDisp = r.headers.get('content-disposition');
          if (!cType.includes('text/html') || cDisp) {
            fileRes = r;
            break;
          }
        }
      }

      if (fileRes) {
        // It is a real FILE
        let detectedName = '';
        const disp = fileRes.headers.get('content-disposition');
        if (disp) {
          const fnMatch = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
          if (fnMatch && fnMatch[1]) detectedName = decodeURIComponent(fnMatch[1].trim());
        }
        if (!detectedName) detectedName = `gdrive_file_${childId}`;

        statsCounter.totalDownloaded++;
        const pct = Math.min(92, 10 + statsCounter.totalDownloaded * 7);
        if (onProgress) {
          onProgress({
            percent: pct,
            status: `Mengunduh (${statsCounter.totalDownloaded}): ${detectedName}`
          });
        }

        const fileDbId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        const ext = path.extname(detectedName);
        const safeDiskName = `${fileDbId}${ext}`;
        const finalDiskPath = path.join(userStorageDir, safeDiskName);

        const fileStream = fs.createWriteStream(finalDiskPath);
        const { Readable } = require('stream');
        const nodeStream = Readable.fromWeb(fileRes.body);
        nodeStream.pipe(fileStream);

        await new Promise((resolve, reject) => {
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });

        const stats = fs.statSync(finalDiskPath);
        const checksum = await calculateChecksum(finalDiskPath);
        const detectedMime = mime.lookup(detectedName) || fileRes.headers.get('content-type') || 'application/octet-stream';

        db.prepare(`
          INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type, disk_path, checksum_sha256)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
        `).run(fileDbId, userId, newFolderDbId, detectedName, stats.size, detectedMime, safeDiskName, checksum);

        if (detectedMime.startsWith('image/')) {
          extractExif(finalDiskPath, fileDbId);
        }

        importedFiles.push({ id: fileDbId, name: detectedName, size: stats.size, mimeType: detectedMime });
      } else {
        // It is a SUBFOLDER! Recurse!
        try {
          const subResult = await recursiveDownloadGDriveFolder(childId, newFolderDbId, userId, '', depth + 1, onProgress, statsCounter);
          if (subResult && subResult.totalFiles > 0) {
            totalSubfolders += 1 + subResult.totalFolders;
            importedFiles = importedFiles.concat(subResult.files);
          }
        } catch(eSub) {
          console.log(`Failed to crawl subfolder ${childId}:`, eSub.message);
        }
      }
    } catch (errChild) {
      console.error(`Error processing child item ${childId}:`, errChild.message);
    }
  }

  return {
    folderDbId: newFolderDbId,
    folderName,
    totalFiles: importedFiles.length,
    totalFolders: totalSubfolders,
    files: importedFiles
  };
}

// -------------------------------------------------------------
// 3.5. POST /api/files/import-url - Import from Google Drive / Public URL (with Realtime SSE Stream)
// -------------------------------------------------------------
router.post('/import-url', authMiddleware, async (req, res) => {
  const { url, parentId = null, customFileName = '' } = req.body;
  if (!url || !url.trim().startsWith('http')) {
    return res.status(400).json({ error: 'URL tidak valid. Masukkan link diawali http:// atau https://' });
  }

  const rawUrl = url.trim();
  const isSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');

  // Set SSE Headers if requested
  let sendEvent = () => {};
  let pingInterval = null;

  if (isSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sendEvent = (type, data) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Heartbeat ping every 2s to keep connection alive indefinitely
    pingInterval = setInterval(() => {
      res.write(': ping\n\n');
    }, 2000);
  }

  const cleanupSSE = () => {
    if (pingInterval) clearInterval(pingInterval);
  };

  // 1. Detect and Handle Google Drive Folder Links (Recursive Subfolder Downloader)
  if (rawUrl.includes('/folders/') || rawUrl.includes('drive.google.com/drive/folders') || (rawUrl.includes('/drive/u/') && rawUrl.includes('folders'))) {
    const folderIdMatch = rawUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    if (!folderIdMatch || !folderIdMatch[1]) {
      cleanupSSE();
      if (isSSE) {
        sendEvent('error', { error: 'Format link folder Google Drive tidak valid.' });
        return res.end();
      }
      return res.status(400).json({ error: 'Format link folder Google Drive tidak valid.' });
    }

    const folderId = folderIdMatch[1];
    try {
      sendEvent('progress', { percent: 5, status: 'Menghubungi Google Drive...' });

      const statsCounter = { totalDownloaded: 0 };
      const result = await recursiveDownloadGDriveFolder(
        folderId,
        parentId,
        req.user.id,
        customFileName,
        0,
        (p) => sendEvent('progress', p),
        statsCounter
      );

      cleanupSSE();

      if (!result || result.totalFiles === 0) {
        if (result && result.folderDbId) {
          db.prepare('DELETE FROM files WHERE id = ?').run(result.folderDbId);
        }
        const errMsg = `⚠️ Tidak ada file yang dapat diunduh dari folder Google Drive '${result ? result.folderName : 'tersebut'}'. Pastikan izin akses folder disetel ke 'Siapa saja yang memiliki link: Pelihat' (Anyone with the link: Viewer).`;
        if (isSSE) {
          sendEvent('error', { error: errMsg });
          return res.end();
        }
        return res.status(400).json({ error: errMsg });
      }

      sendEvent('progress', { percent: 100, status: 'Selesai!' });
      sendEvent('complete', {
        success: true,
        isFolder: true,
        message: `Berhasil mengimpor folder '${result.folderName}' beserta ${result.totalFiles} file (dan ${result.totalFolders} subfolder) di dalamnya!`,
        folder: {
          id: result.folderDbId,
          name: result.folderName,
          totalFiles: result.totalFiles,
          totalFolders: result.totalFolders,
          files: result.files
        }
      });

      if (isSSE) return res.end();
      return res.json({
        success: true,
        isFolder: true,
        message: `Berhasil mengimpor folder '${result.folderName}' beserta ${result.totalFiles} file (dan ${result.totalFolders} subfolder) di dalamnya!`,
        folder: {
          id: result.folderDbId,
          name: result.folderName,
          totalFiles: result.totalFiles,
          totalFolders: result.totalFolders,
          files: result.files
        }
      });
    } catch (errFolder) {
      cleanupSSE();
      console.error('Error in recursive folder import:', errFolder);
      if (isSSE) {
        sendEvent('error', { error: 'Gagal memproses folder Google Drive: ' + errFolder.message });
        return res.end();
      }
      return res.status(500).json({ error: 'Gagal memproses folder Google Drive: ' + errFolder.message });
    }
  }

  // 2. Handle Single File URL or Google Drive Single File Link
  try {
    sendEvent('progress', { percent: 15, status: 'Menghubungi server file...' });

    let downloadUrl = rawUrl;
    let isGoogleDrive = false;

    if (downloadUrl.includes('drive.google.com') || downloadUrl.includes('docs.google.com')) {
      isGoogleDrive = true;
      const fileIdMatch = downloadUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || downloadUrl.match(/id=([a-zA-Z0-9_-]+)/) || downloadUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      
      if (fileIdMatch && fileIdMatch[1]) {
        const fileId = fileIdMatch[1];
        downloadUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`;
      }
    }

    const response = await fetch(downloadUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    });

    if (!response.ok) {
      cleanupSSE();
      const errTxt = isGoogleDrive 
        ? `Gagal mengunduh berkas dari Google Drive (HTTP ${response.status}). Pastikan file disetel ke 'Siapa saja yang memiliki link' (Public).`
        : `Gagal mengunduh berkas dari link (HTTP ${response.status} ${response.statusText}).`;
      if (isSSE) {
        sendEvent('error', { error: errTxt });
        return res.end();
      }
      return res.status(400).json({ error: errTxt });
    }

    const contentType = response.headers.get('content-type') || '';
    const contentDisposition = response.headers.get('content-disposition');

    if (isGoogleDrive && contentType.includes('text/html') && !contentDisposition) {
      cleanupSSE();
      const errTxt = "Google Drive mengembalikan halaman web HTML (bukan file langsung). Hal ini terjadi jika file berstatus 'Private' atau dokumen Google Docs. Pastikan akses file di Google Drive disetel ke 'Siapa saja yang memiliki link'.";
      if (isSSE) {
        sendEvent('error', { error: errTxt });
        return res.end();
      }
      return res.status(400).json({ error: errTxt });
    }

    let detectedFileName = customFileName ? customFileName.trim() : '';
    if (!detectedFileName && contentDisposition) {
      const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
      if (match && match[1]) {
        detectedFileName = decodeURIComponent(match[1].trim());
      }
    }

    if (!detectedFileName) {
      try {
        const parsedUrl = new URL(url);
        detectedFileName = path.basename(parsedUrl.pathname);
      } catch (e) {}
    }

    if (!detectedFileName || detectedFileName === '/' || detectedFileName === '') {
      detectedFileName = isGoogleDrive ? `gdrive_file_${Date.now()}` : `imported_file_${Date.now()}`;
    }

    sendEvent('progress', { percent: 40, status: `Mengunduh berkas: ${detectedFileName}...` });

    const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const userStorageDir = getUserStorageDir(req.user.id);
    const ext = path.extname(detectedFileName);
    const safeDiskName = `${fileId}${ext}`;
    const finalDiskPath = path.join(userStorageDir, safeDiskName);

    const fileStream = fs.createWriteStream(finalDiskPath);
    const { Readable } = require('stream');
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.pipe(fileStream);

    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    const stats = fs.statSync(finalDiskPath);
    const checksum = await calculateChecksum(finalDiskPath);
    const detectedMime = mime.lookup(detectedFileName) || contentType || 'application/octet-stream';
    const targetParent = (parentId && parentId !== 'root') ? parentId : null;

    db.prepare(`
      INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type, disk_path, checksum_sha256)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(fileId, req.user.id, targetParent, detectedFileName, stats.size, detectedMime, safeDiskName, checksum);

    if (detectedMime.startsWith('image/')) {
      extractExif(finalDiskPath, fileId);
    }

    cleanupSSE();
    sendEvent('progress', { percent: 100, status: 'Selesai!' });
    sendEvent('complete', {
      success: true,
      message: 'Berkas berhasil diimpor ke CloudMe!',
      file: {
        id: fileId,
        name: detectedFileName,
        size: stats.size,
        mimeType: detectedMime
      }
    });

    if (isSSE) return res.end();
    return res.json({
      success: true,
      message: 'Berkas berhasil diimpor ke CloudMe!',
      file: {
        id: fileId,
        name: detectedFileName,
        size: stats.size,
        mimeType: detectedMime
      }
    });
  } catch (err) {
    cleanupSSE();
    console.error('URL import error:', err);
    if (isSSE) {
      sendEvent('error', { error: 'Gagal mengimpor berkas: ' + err.message });
      return res.end();
    }
    return res.status(500).json({ error: 'Gagal mengimpor berkas: ' + err.message });
  }
});

// -------------------------------------------------------------
// 4. Chunked / Resumable Upload (For Large Files GB+)
// -------------------------------------------------------------
router.post('/upload-chunk', authMiddleware, upload.single('chunk'), async (req, res) => {
  const {
    uploadId,
    chunkIndex,
    totalChunks,
    fileName,
    parentId,
    totalSize
  } = req.body;

  if (!uploadId || !chunkIndex || !totalChunks || !req.file) {
    return res.status(400).json({ error: 'Parameter chunk upload tidak lengkap.' });
  }

  const chunkDir = path.join(UPLOADS_DIR, `chunks_${uploadId}`);
  if (!fs.existsSync(chunkDir)) {
    fs.mkdirSync(chunkDir, { recursive: true });
  }

  const currentChunkPath = path.join(chunkDir, `part_${chunkIndex}`);
  fs.renameSync(req.file.path, currentChunkPath);

  // If last chunk, merge all parts!
  if (parseInt(chunkIndex, 10) === parseInt(totalChunks, 10) - 1) {
    const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const userStorageDir = getUserStorageDir(req.user.id);
    const ext = path.extname(fileName);
    const safeDiskName = `${fileId}${ext}`;
    const finalDiskPath = path.join(userStorageDir, safeDiskName);

    const writeStream = fs.createWriteStream(finalDiskPath);

    for (let i = 0; i < parseInt(totalChunks, 10); i++) {
      const partFile = path.join(chunkDir, `part_${i}`);
      if (fs.existsSync(partFile)) {
        const partBuffer = fs.readFileSync(partFile);
        writeStream.write(partBuffer);
        fs.unlinkSync(partFile); // remove temp part
      }
    }
    writeStream.end();

    await new Promise((resolve) => writeStream.on('finish', resolve));
    try { fs.rmdirSync(chunkDir); } catch(e){}

    const stats = fs.statSync(finalDiskPath);
    const checksum = await calculateChecksum(finalDiskPath);
    const detectedMime = mime.lookup(fileName) || 'application/octet-stream';
    const targetParent = (parentId && parentId !== 'root') ? parentId : null;

    db.prepare(`
      INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type, disk_path, checksum_sha256)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(fileId, req.user.id, targetParent, fileName, stats.size, detectedMime, safeDiskName, checksum);

    if (detectedMime.startsWith('image/')) {
      extractExif(finalDiskPath, fileId);
    }

    return res.json({
      success: true,
      isCompleted: true,
      file: { id: fileId, name: fileName, size: stats.size }
    });
  }

  res.json({
    success: true,
    isCompleted: false,
    chunkIndex: parseInt(chunkIndex, 10)
  });
});

// -------------------------------------------------------------
// 4.5. GET /api/files/:id/details - Comprehensive Metadata, Path, Checksum, EXIF
// -------------------------------------------------------------
router.get('/:id/details', authMiddleware, (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!file) {
      return res.status(404).json({ error: 'File atau folder tidak ditemukan.' });
    }

    // Build Folder Path Hierarchy (breadcrumb trail)
    const pathHierarchy = [];
    let currentParent = file.parent_id;
    while (currentParent) {
      const parentFolder = db.prepare('SELECT id, name, parent_id FROM files WHERE id = ? AND user_id = ?').get(currentParent, req.user.id);
      if (parentFolder) {
        pathHierarchy.unshift({ id: parentFolder.id, name: parentFolder.name });
        currentParent = parentFolder.parent_id;
      } else {
        break;
      }
    }
    pathHierarchy.unshift({ id: 'root', name: 'Drive Utama' });

    let exifData = null;
    let folderStats = null;

    if (file.is_folder === 1) {
      const directChildren = db.prepare('SELECT id, is_folder, size_bytes FROM files WHERE parent_id = ? AND user_id = ? AND is_trashed = 0').all(file.id, req.user.id);
      const subfoldersCount = directChildren.filter(c => c.is_folder === 1).length;
      const subfilesCount = directChildren.filter(c => c.is_folder === 0).length;

      const allDescendants = getAllDescendantItems(file.id, req.user.id);
      const totalSize = allDescendants.filter(d => d.is_folder === 0).reduce((acc, cur) => acc + (cur.size_bytes || 0), 0);

      folderStats = {
        subfoldersCount,
        subfilesCount,
        totalItems: subfoldersCount + subfilesCount,
        totalSizeBytes: totalSize
      };
    } else {
      const photo = db.prepare('SELECT * FROM photo_metadata WHERE file_id = ?').get(file.id);
      if (photo) {
        exifData = {
          camera_make: photo.camera_make,
          camera_model: photo.camera_model,
          date_taken: photo.date_taken,
          width: photo.width,
          height: photo.height,
          latitude: photo.latitude,
          longitude: photo.longitude,
          iso: photo.iso,
          focal_length: photo.focal_length
        };
      }
    }

    res.json({
      file,
      pathHierarchy,
      exif: exifData,
      folderStats
    });
  } catch (err) {
    console.error('File details error:', err);
    res.status(500).json({ error: 'Gagal mengambil detail file.' });
  }
});

// -------------------------------------------------------------
// 5. GET /api/files/:id/preview - High Performance Streaming Preview
// -------------------------------------------------------------
router.get('/:id/preview', authMiddleware, (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!file || file.is_folder) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    const userStorageDir = getUserStorageDir(req.user.id);
    const filePath = path.join(userStorageDir, file.disk_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File fisik tidak ditemukan di disk.' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Support HTTP 206 Range for Seekable Video/Audio streaming
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const stream = fs.createReadStream(filePath, { start, end });

      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': file.mime_type || 'application/octet-stream',
        'Cache-Control': 'public, max-age=604800',
      };
      res.writeHead(206, head);
      stream.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': file.mime_type || 'application/octet-stream',
        'Cache-Control': 'public, max-age=604800, stale-while-revalidate=86400',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 6. GET /api/files/:id/download - Direct Download
// -------------------------------------------------------------
router.get('/:id/download', authMiddleware, (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!file || file.is_folder) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    const userStorageDir = getUserStorageDir(req.user.id);
    const filePath = path.join(userStorageDir, file.disk_path);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File fisik tidak ditemukan di storage.' });
    }

    res.download(filePath, file.name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 7. POST /api/files/batch-download - Stream Multiple Files as ZIP
// -------------------------------------------------------------
router.post('/batch-download', authMiddleware, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Pilih minimal 1 file untuk di-download.' });
  }

  try {
    const userStorageDir = getUserStorageDir(req.user.id);
    const files = db.prepare(`SELECT * FROM files WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`).all(req.user.id, ...ids);

    if (files.length === 0) {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="CloudMe_Download_${Date.now()}.zip"`);

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    for (const f of files) {
      if (!f.is_folder && f.disk_path) {
        const filePath = path.join(userStorageDir, f.disk_path);
        if (fs.existsSync(filePath)) {
          archive.file(filePath, { name: f.name });
        }
      }
    }

    archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 8. PUT /api/files/:id - Update (Rename, Star, Move, Color Tag)
// -------------------------------------------------------------
router.put('/:id', authMiddleware, (req, res) => {
  const { name, is_starred, parent_id, color_tag } = req.body;
  const fileId = req.params.id;

  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, req.user.id);
    if (!file) {
      return res.status(404).json({ error: 'Item tidak ditemukan.' });
    }

    const updates = [];
    const params = [];

    if (name !== undefined && name.trim() !== '') {
      updates.push('name = ?');
      params.push(name.trim());
    }
    if (is_starred !== undefined) {
      updates.push('is_starred = ?');
      params.push(is_starred ? 1 : 0);
    }
    if (parent_id !== undefined) {
      updates.push('parent_id = ?');
      params.push(parent_id === 'root' ? null : parent_id);
    }
    if (color_tag !== undefined) {
      updates.push('color_tag = ?');
      params.push(color_tag);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(fileId, req.user.id);
      db.prepare(`UPDATE files SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...params);
    }

    res.json({ success: true, message: 'Item berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: Get all descendant files and folders recursively
function getAllDescendantItems(folderId, userId) {
  let items = [];
  const children = db.prepare('SELECT id, is_folder, disk_path FROM files WHERE parent_id = ? AND user_id = ?').all(folderId, userId);
  for (const child of children) {
    items.push(child);
    if (child.is_folder === 1) {
      items = items.concat(getAllDescendantItems(child.id, userId));
    }
  }
  return items;
}

// -------------------------------------------------------------
// 9. DELETE /api/files/:id - Move to Trash or Permanent Delete (with Recursive Disk Cleanup)
// -------------------------------------------------------------
router.delete('/:id', authMiddleware, (req, res) => {
  const { permanent = false } = req.query;
  const fileId = req.params.id;

  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, req.user.id);
    if (!file) {
      return res.status(404).json({ error: 'Item tidak ditemukan.' });
    }

    const isPermanent = permanent === 'true' || file.is_trashed === 1;
    const userStorageDir = getUserStorageDir(req.user.id);

    if (isPermanent) {
      // 1. Permanent Delete
      if (file.is_folder === 1) {
        // Find all descendants recursively
        const descendants = getAllDescendantItems(fileId, req.user.id);
        
        // Unlink physical files on disk
        for (const desc of descendants) {
          if (!desc.is_folder && desc.disk_path) {
            const filePath = path.join(userStorageDir, desc.disk_path);
            if (fs.existsSync(filePath)) {
              try { fs.unlinkSync(filePath); } catch (e) {}
            }
            db.prepare('DELETE FROM photo_metadata WHERE file_id = ?').run(desc.id);
          }
        }

        // Delete all descendant DB rows
        if (descendants.length > 0) {
          const descIds = descendants.map(d => `'${d.id}'`).join(',');
          db.prepare(`DELETE FROM files WHERE id IN (${descIds}) AND user_id = ?`).run(req.user.id);
        }

        // Delete main folder
        db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(fileId, req.user.id);
      } else {
        // Single file
        if (file.disk_path) {
          const filePath = path.join(userStorageDir, file.disk_path);
          if (fs.existsSync(filePath)) {
            try { fs.unlinkSync(filePath); } catch (e) {}
          }
          db.prepare('DELETE FROM photo_metadata WHERE file_id = ?').run(fileId);
        }
        db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(fileId, req.user.id);
      }

      res.json({ success: true, message: 'Item berhasil dihapus permanen dari sistem dan media penyimpanan.' });
    } else {
      // 2. Soft Delete (Move to Trash)
      if (file.is_folder === 1) {
        const descendants = getAllDescendantItems(fileId, req.user.id);
        const allIds = [fileId, ...descendants.map(d => d.id)];
        const placeholders = allIds.map(id => `'${id}'`).join(',');
        db.prepare(`UPDATE files SET is_trashed = 1, trashed_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders}) AND user_id = ?`).run(req.user.id);
      } else {
        db.prepare('UPDATE files SET is_trashed = 1, trashed_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(fileId, req.user.id);
      }

      res.json({ success: true, message: 'Item dipindahkan ke sampah.' });
    }
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 9.5. POST /api/files/trash/empty - Empty Trash (Permanently remove all trashed items and disk files)
// -------------------------------------------------------------
router.post('/trash/empty', authMiddleware, (req, res) => {
  try {
    const userStorageDir = getUserStorageDir(req.user.id);
    const trashedFiles = db.prepare('SELECT id, is_folder, disk_path FROM files WHERE user_id = ? AND is_trashed = 1').all(req.user.id);

    for (const f of trashedFiles) {
      if (!f.is_folder && f.disk_path) {
        const filePath = path.join(userStorageDir, f.disk_path);
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (e) {}
        }
        db.prepare('DELETE FROM photo_metadata WHERE file_id = ?').run(f.id);
      } else if (f.is_folder === 1) {
        const descendants = getAllDescendantItems(f.id, req.user.id);
        for (const desc of descendants) {
          if (!desc.is_folder && desc.disk_path) {
            const filePath = path.join(userStorageDir, desc.disk_path);
            if (fs.existsSync(filePath)) {
              try { fs.unlinkSync(filePath); } catch (e) {}
            }
            db.prepare('DELETE FROM photo_metadata WHERE file_id = ?').run(desc.id);
          }
          db.prepare('DELETE FROM files WHERE id = ? AND user_id = ?').run(desc.id, req.user.id);
        }
      }
    }

    db.prepare('DELETE FROM files WHERE user_id = ? AND is_trashed = 1').run(req.user.id);

    res.json({ success: true, message: 'Semua item di sampah berhasil dihapus permanen dan media penyimpanan telah dikosongkan.' });
  } catch (err) {
    console.error('Empty trash error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 10. POST /api/files/:id/restore - Restore from Trash (Recursive)
// -------------------------------------------------------------
router.post('/:id/restore', authMiddleware, (req, res) => {
  try {
    const fileId = req.params.id;
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, req.user.id);
    if (!file) return res.status(404).json({ error: 'Item tidak ditemukan.' });

    if (file.is_folder === 1) {
      const descendants = getAllDescendantItems(fileId, req.user.id);
      const allIds = [fileId, ...descendants.map(d => d.id)];
      const placeholders = allIds.map(id => `'${id}'`).join(',');
      db.prepare(`UPDATE files SET is_trashed = 0, trashed_at = NULL WHERE id IN (${placeholders}) AND user_id = ?`).run(req.user.id);
    } else {
      db.prepare('UPDATE files SET is_trashed = 0, trashed_at = NULL WHERE id = ? AND user_id = ?').run(fileId, req.user.id);
    }

    res.json({ success: true, message: 'Item berhasil dipulihkan.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
