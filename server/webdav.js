const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, getSetting } = require('./db');

function getUserStorageDir(userId) {
  const root = getSetting('storage_root') || path.join(__dirname, '..', 'data', 'storage');
  const userDir = path.join(root, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

// Lightweight WebDAV Request Handler for Android FolderSync / AutoSync
function handleWebDAV(req, res) {
  // Parse Basic Auth header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CloudMe WebDAV"');
    return res.status(401).send('WebDAV Authentication Required');
  }

  const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf8').split(':');
  const username = credentials[0];
  const password = credentials[1];

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="CloudMe WebDAV"');
    return res.status(401).send('Invalid Credentials');
  }

  const userStorageDir = getUserStorageDir(user.id);
  const method = req.method.toUpperCase();

  // Strip prefix /webdav
  let reqPath = decodeURIComponent(req.path.replace(/^\/webdav/, '')) || '/';
  reqPath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, ''); // prevent path traversal
  const targetDiskPath = path.join(userStorageDir, reqPath);

  // 1. OPTIONS Method
  if (method === 'OPTIONS') {
    res.setHeader('DAV', '1, 2');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE');
    return res.status(200).send();
  }

  // 2. PROPFIND Method (Directory listing)
  if (method === 'PROPFIND') {
    if (!fs.existsSync(targetDiskPath)) {
      return res.status(404).send('Not Found');
    }

    const stat = fs.statSync(targetDiskPath);
    let xml = `<?xml version="1.0" encoding="utf-8" ?>\n<D:multistatus xmlns:D="DAV:">\n`;

    function addResponse(filePath, isDir) {
      const relPath = '/webdav' + path.relative(userStorageDir, filePath).replace(/\\/g, '/');
      const itemStat = fs.statSync(filePath);
      xml += `  <D:response>\n`;
      xml += `    <D:href>${encodeURI(relPath || '/webdav/')}</D:href>\n`;
      xml += `    <D:propstat>\n`;
      xml += `      <D:prop>\n`;
      xml += `        <D:displayname>${path.basename(filePath) || 'root'}</D:displayname>\n`;
      xml += `        <D:getlastmodified>${itemStat.mtime.toUTCString()}</D:getlastmodified>\n`;
      if (isDir) {
        xml += `        <D:resourcetype><D:collection/></D:resourcetype>\n`;
      } else {
        xml += `        <D:resourcetype/>\n`;
        xml += `        <D:getcontentlength>${itemStat.size}</D:getcontentlength>\n`;
      }
      xml += `      </D:prop>\n`;
      xml += `      <D:status>HTTP/1.1 200 OK</D:status>\n`;
      xml += `    </D:propstat>\n`;
      xml += `  </D:response>\n`;
    }

    addResponse(targetDiskPath, stat.isDirectory());

    const depth = req.headers.depth || '1';
    if (stat.isDirectory() && depth !== '0') {
      const children = fs.readdirSync(targetDiskPath);
      for (const child of children) {
        const childPath = path.join(targetDiskPath, child);
        if (fs.existsSync(childPath)) {
          const childStat = fs.statSync(childPath);
          addResponse(childPath, childStat.isDirectory());
        }
      }
    }

    xml += `</D:multistatus>`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(207).send(xml);
  }

  // 3. GET / HEAD Method
  if (method === 'GET' || method === 'HEAD') {
    if (!fs.existsSync(targetDiskPath)) return res.status(404).send('Not Found');
    const stat = fs.statSync(targetDiskPath);
    if (stat.isDirectory()) return res.status(403).send('Cannot GET a directory');
    return res.sendFile(targetDiskPath);
  }

  // 4. PUT Method (Upload file via WebDAV from Android)
  if (method === 'PUT') {
    const parentDir = path.dirname(targetDiskPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    const writeStream = fs.createWriteStream(targetDiskPath);
    req.pipe(writeStream);
    writeStream.on('finish', () => {
      // Sync with DB
      const filename = path.basename(targetDiskPath);
      const stat = fs.statSync(targetDiskPath);
      const fileId = require('crypto').randomBytes(16).toString('hex');
      const mime = require('mime-types');
      const mimeType = mime.lookup(filename) || 'application/octet-stream';
      const relDiskPath = path.relative(userStorageDir, targetDiskPath).replace(/\\/g, '/');

      try {
        const existing = db.prepare('SELECT id FROM files WHERE user_id = ? AND disk_path = ?').get(user.id, relDiskPath);
        if (existing) {
          db.prepare('UPDATE files SET size_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stat.size, existing.id);
        } else {
          db.prepare(`
            INSERT INTO files (id, user_id, name, is_folder, size_bytes, mime_type, disk_path)
            VALUES (?, ?, ?, 0, ?, ?, ?)
          `).run(fileId, user.id, filename, stat.size, mimeType, relDiskPath);

          // If image, extract EXIF date and camera metadata for Google Photos Timeline
          if (mimeType.startsWith('image/')) {
            try {
              const exifParser = require('exif-parser');
              const buffer = fs.readFileSync(targetDiskPath);
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
            } catch (exifErr) {}
          }
        }
      } catch (e) {
        console.error('WebDAV DB sync error:', e);
      }
      res.status(201).send();
    });
    writeStream.on('error', (err) => res.status(500).send(err.message));
    return;
  }

  // 5. MKCOL (Create Folder)
  if (method === 'MKCOL') {
    if (fs.existsSync(targetDiskPath)) return res.status(405).send('Already Exists');
    fs.mkdirSync(targetDiskPath, { recursive: true });
    return res.status(201).send();
  }

  // 6. DELETE
  if (method === 'DELETE') {
    if (!fs.existsSync(targetDiskPath)) return res.status(404).send('Not Found');
    if (fs.statSync(targetDiskPath).isDirectory()) {
      fs.rmdirSync(targetDiskPath, { recursive: true });
    } else {
      fs.unlinkSync(targetDiskPath);
    }
    return res.status(204).send();
  }

  res.status(501).send('Method Not Implemented');
}

module.exports = { handleWebDAV };
