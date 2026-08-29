const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const exifParser = require('exif-parser');
const { db, getSetting, setSetting, getUserStorageDir, getActiveStorageDir } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'temp');
const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 5 * 1024 * 1024 * 1024 } });

function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}

// -------------------------------------------------------------
// 1. GET /api/photos/timeline - Google Photos Style Timeline
// -------------------------------------------------------------
router.get('/timeline', authMiddleware, (req, res) => {
  try {
    const mediaItems = db.prepare(`
      SELECT 
        f.id, f.name, f.size_bytes, f.mime_type, f.created_at, f.is_starred,
        COALESCE(p.date_taken, f.created_at) as timeline_date,
        p.width, p.height, p.camera_make, p.camera_model
      FROM files f
      LEFT JOIN photo_metadata p ON f.id = p.file_id
      WHERE f.user_id = ? AND f.is_trashed = 0 
        AND (f.mime_type LIKE 'image/%' OR f.mime_type LIKE 'video/%')
      ORDER BY timeline_date DESC
    `).all(req.user.id);

    // Group by Date (YYYY-MM-DD)
    const grouped = {};
    for (const item of mediaItems) {
      const d = new Date(item.timeline_date);
      const dateKey = isNaN(d.getTime()) ? 'Unknown Date' : d.toISOString().split('T')[0];
      
      if (!grouped[dateKey]) {
        grouped[dateKey] = {
          date: dateKey,
          displayDate: new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(d),
          items: []
        };
      }
      grouped[dateKey].items.push(item);
    }

    res.json({
      timeline: Object.values(grouped),
      totalMedia: mediaItems.length
    });
  } catch (err) {
    console.error('Photos timeline error:', err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 2. POST /api/photos/sync - Mobile Android Auto-Backup Sync
// -------------------------------------------------------------
router.post('/sync', authMiddleware, upload.single('media'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'File media tidak ditemukan.' });
  }

  const { deviceName = 'Android Device', clientDateTaken, originalPath } = req.body;
  const userStorageDir = getUserStorageDir(req.user.id);

  try {
    // 1. Check deduplication via SHA-256 Checksum
    const checksum = await calculateChecksum(req.file.path);
    const existingFile = db.prepare('SELECT id, name FROM files WHERE user_id = ? AND checksum_sha256 = ? AND is_trashed = 0').get(req.user.id, checksum);

    if (existingFile) {
      // File already backed up! Delete temporary uploaded file and return success
      fs.unlinkSync(req.file.path);
      return res.json({
        success: true,
        isDuplicate: true,
        message: 'File sudah ada di Cloud (Deduplicated)',
        fileId: existingFile.id
      });
    }

    // 2. Create Photos/Backup Folder if not exists
    let photosFolder = db.prepare("SELECT id FROM files WHERE user_id = ? AND name = 'Mobile Backup' AND is_folder = 1 AND parent_id IS NULL").get(req.user.id);
    if (!photosFolder) {
      const folderId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      db.prepare("INSERT INTO files (id, user_id, name, is_folder, mime_type) VALUES (?, ?, 'Mobile Backup', 1, 'folder')").run(folderId, req.user.id);
      photosFolder = { id: folderId };
    }

    // 3. Move file to permanent storage
    const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const ext = path.extname(req.file.originalname) || '.jpg';
    const safeDiskName = `${fileId}${ext}`;
    const finalDiskPath = path.join(userStorageDir, safeDiskName);
    fs.renameSync(req.file.path, finalDiskPath);

    const detectedMime = mime.lookup(req.file.originalname) || req.file.mimetype || 'image/jpeg';
    const originalName = req.file.originalname || `photo_${Date.now()}${ext}`;

    db.prepare(`
      INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type, disk_path, checksum_sha256)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(fileId, req.user.id, photosFolder.id, originalName, req.file.size, detectedMime, safeDiskName, checksum);

    // 4. Extract EXIF
    let dateTaken = clientDateTaken ? new Date(clientDateTaken).toISOString() : new Date().toISOString();
    let width = null, height = null, make = null, model = null, iso = null, focalLength = null;

    try {
      if (detectedMime.startsWith('image/')) {
        const buffer = fs.readFileSync(finalDiskPath);
        const parser = exifParser.create(buffer);
        const result = parser.parse();
        if (result && result.tags) {
          const tags = result.tags;
          if (tags.DateTimeOriginal) dateTaken = new Date(tags.DateTimeOriginal * 1000).toISOString();
          width = tags.ExifImageWidth || result.imageSize?.width || null;
          height = tags.ExifImageHeight || result.imageSize?.height || null;
          make = tags.Make || null;
          model = tags.Model || null;
          iso = tags.ISO || null;
          focalLength = tags.FocalLength || null;
        }
      }
    } catch(e) {}

    db.prepare(`
      INSERT OR REPLACE INTO photo_metadata (
        file_id, date_taken, width, height, camera_make, camera_model, iso, focal_length
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, dateTaken, width, height, make, model, iso, focalLength);

    // 5. Update Sync Devices table
    const deviceId = 'dev_' + crypto.createHash('md5').update(req.user.id + deviceName).digest('hex');
    db.prepare(`
      INSERT INTO sync_devices (id, user_id, device_name, device_type, last_sync_at)
      VALUES (?, ?, ?, 'android', CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET last_sync_at = CURRENT_TIMESTAMP
    `).run(deviceId, req.user.id, deviceName);

    res.json({
      success: true,
      isDuplicate: false,
      message: 'Foto/Video berhasil di-backup ke Cloud',
      file: {
        id: fileId,
        name: originalName,
        size: req.file.size,
        dateTaken
      }
    });
  } catch (err) {
    console.error('Mobile sync error:', err);
    res.status(500).json({ error: 'Gagal auto-backup: ' + err.message });
  }
});

// -------------------------------------------------------------
// 4. POST /api/photos/import-takeout - Google Takeout ZIP Importer
// -------------------------------------------------------------
const AdmZip = require('adm-zip');

router.post('/import-takeout', authMiddleware, upload.single('zipFile'), async (req, res) => {
  const { url } = req.body;
  let zipFilePath = null;
  let isTempDownloaded = false;

  try {
    // 1. Get ZIP file from Upload or Remote URL
    if (req.file) {
      zipFilePath = req.file.path;
    } else if (url && url.trim().startsWith('http')) {
      let downloadUrl = url.trim();
      if (downloadUrl.includes('drive.google.com')) {
        const fileIdMatch = downloadUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || downloadUrl.match(/id=([a-zA-Z0-9_-]+)/);
        if (fileIdMatch && fileIdMatch[1]) {
          downloadUrl = `https://drive.usercontent.google.com/download?id=${fileIdMatch[1]}&export=download&authuser=0&confirm=t`;
        }
      }

      const tempZipName = `takeout_dl_${Date.now()}.zip`;
      zipFilePath = path.join(UPLOADS_DIR, tempZipName);
      isTempDownloaded = true;

      const response = await fetch(downloadUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });

      if (!response.ok) {
        return res.status(400).json({ error: `Gagal mengunduh ZIP Takeout dari link (HTTP ${response.status})` });
      }

      const fileStream = fs.createWriteStream(zipFilePath);
      const { Readable } = require('stream');
      const nodeStream = Readable.fromWeb(response.body);
      nodeStream.pipe(fileStream);

      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
    } else {
      return res.status(400).json({ error: 'Pilih file ZIP Google Takeout atau masukkan link URL download-nya.' });
    }

    // 2. Extract ZIP archive
    const extractDir = path.join(UPLOADS_DIR, `takeout_extract_${Date.now()}`);
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    const zip = new AdmZip(zipFilePath);
    zip.extractAllTo(extractDir, true);

    // 3. Create or Find "Google Photos Import" Folder
    let takeoutFolder = db.prepare("SELECT id FROM files WHERE user_id = ? AND name = 'Google Photos Import' AND is_folder = 1 AND parent_id IS NULL").get(req.user.id);
    if (!takeoutFolder) {
      const folderId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      db.prepare("INSERT INTO files (id, user_id, name, is_folder, mime_type) VALUES (?, ?, 'Google Photos Import', 1, 'folder')").run(folderId, req.user.id);
      takeoutFolder = { id: folderId };
    }

    const userStorageDir = getUserStorageDir(req.user.id);
    let totalPhotos = 0;
    let totalVideos = 0;
    let duplicatesSkipped = 0;

    // 4. Recursive directory walker
    function walkDir(dir) {
      let results = [];
      const list = fs.readdirSync(dir);
      list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results = results.concat(walkDir(fullPath));
        } else {
          results.push(fullPath);
        }
      });
      return results;
    }

    const allExtractedFiles = walkDir(extractDir);

    for (const filePath of allExtractedFiles) {
      const filename = path.basename(filePath);
      const ext = path.extname(filename).toLowerCase();
      const detectedMime = mime.lookup(filename) || '';

      const isImage = detectedMime.startsWith('image/') || ['.heic', '.heif', '.raw', '.dng'].includes(ext);
      const isVideo = detectedMime.startsWith('video/') || ['.mov', '.3gp', '.m4v'].includes(ext);

      if (!isImage && !isVideo) continue; // Skip non-media and json files

      // Check SHA-256 Checksum for deduplication
      const checksum = await calculateChecksum(filePath);
      const existing = db.prepare('SELECT id FROM files WHERE user_id = ? AND checksum_sha256 = ? AND is_trashed = 0').get(req.user.id, checksum);

      if (existing) {
        duplicatesSkipped++;
        continue;
      }

      // Check for Google Takeout sidecar JSON metadata (e.g. image.jpg.json or image.json)
      let dateTaken = new Date().toISOString();
      let latitude = null, longitude = null;

      const sidecar1 = filePath + '.json';
      const sidecar2 = filePath.substring(0, filePath.lastIndexOf('.')) + '.json';
      const jsonPath = fs.existsSync(sidecar1) ? sidecar1 : (fs.existsSync(sidecar2) ? sidecar2 : null);

      if (jsonPath) {
        try {
          const jsonContent = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          if (jsonContent.photoTakenTime && jsonContent.photoTakenTime.timestamp) {
            dateTaken = new Date(parseInt(jsonContent.photoTakenTime.timestamp, 10) * 1000).toISOString();
          } else if (jsonContent.creationTime && jsonContent.creationTime.timestamp) {
            dateTaken = new Date(parseInt(jsonContent.creationTime.timestamp, 10) * 1000).toISOString();
          }
          if (jsonContent.geoData) {
            latitude = jsonContent.geoData.latitude || null;
            longitude = jsonContent.geoData.longitude || null;
          }
        } catch(e) {}
      }

      // Move media to user permanent storage
      const fileId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const safeDiskName = `${fileId}${ext}`;
      const finalDiskPath = path.join(userStorageDir, safeDiskName);
      fs.copyFileSync(filePath, finalDiskPath);

      const stats = fs.statSync(finalDiskPath);

      db.prepare(`
        INSERT INTO files (id, user_id, parent_id, name, is_folder, size_bytes, mime_type, disk_path, checksum_sha256)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(fileId, req.user.id, takeoutFolder.id, filename, stats.size, detectedMime || 'application/octet-stream', safeDiskName, checksum);

      // Extract EXIF if not found in JSON
      let width = null, height = null, make = null, model = null, iso = null, focalLength = null;
      if (isImage) {
        try {
          const buffer = fs.readFileSync(finalDiskPath);
          const parser = exifParser.create(buffer);
          const result = parser.parse();
          if (result && result.tags) {
            const tags = result.tags;
            if (!jsonPath && tags.DateTimeOriginal) {
              dateTaken = new Date(tags.DateTimeOriginal * 1000).toISOString();
            }
            width = tags.ExifImageWidth || result.imageSize?.width || null;
            height = tags.ExifImageHeight || result.imageSize?.height || null;
            make = tags.Make || null;
            model = tags.Model || null;
            iso = tags.ISO || null;
            focalLength = tags.FocalLength || null;
            if (!latitude && tags.GPSLatitude) latitude = tags.GPSLatitude;
            if (!longitude && tags.GPSLongitude) longitude = tags.GPSLongitude;
          }
        } catch(e) {}
      }

      db.prepare(`
        INSERT OR REPLACE INTO photo_metadata (
          file_id, date_taken, width, height, camera_make, camera_model, iso, focal_length, latitude, longitude
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fileId, dateTaken, width, height, make, model, iso, focalLength, latitude, longitude);

      if (isImage) totalPhotos++;
      if (isVideo) totalVideos++;
    }

    // 5. Cleanup Temp extraction folder & zip
    try {
      fs.rmSync(extractDir, { recursive: true, force: true });
      if (zipFilePath && (isTempDownloaded || req.file)) {
        fs.unlinkSync(zipFilePath);
      }
    } catch(e) {}

    res.json({
      success: true,
      message: `Migrasi Google Takeout berhasil!`,
      summary: {
        totalPhotos,
        totalVideos,
        totalImported: totalPhotos + totalVideos,
        duplicatesSkipped
      }
    });
  } catch (err) {
    console.error('Takeout import error:', err);
    res.status(500).json({ error: 'Gagal memproses Google Takeout: ' + err.message });
  }
});

module.exports = router;
