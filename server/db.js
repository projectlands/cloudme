const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'cloudme.db');
const db = new Database(DB_PATH);

// Enable WAL mode & performance PRAGMAs for fast concurrent reads & writes
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('cache_size = -64000'); // 64MB cache

// Initialize Database Schema
function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', -- 'admin' or 'user'
      storage_quota_bytes INTEGER NOT NULL DEFAULT 53687091200, -- 50 GB default
      api_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      parent_id TEXT, -- NULL for root directory
      name TEXT NOT NULL,
      is_folder INTEGER NOT NULL DEFAULT 0, -- 1 for folder, 0 for file
      size_bytes INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT,
      disk_path TEXT, -- relative path inside user storage
      checksum_sha256 TEXT,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_trashed INTEGER NOT NULL DEFAULT 0,
      trashed_at DATETIME,
      color_tag TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS photo_metadata (
      file_id TEXT PRIMARY KEY,
      date_taken DATETIME,
      width INTEGER,
      height INTEGER,
      camera_make TEXT,
      camera_model TEXT,
      iso INTEGER,
      focal_length REAL,
      latitude REAL,
      longitude REAL,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      allow_download INTEGER NOT NULL DEFAULT 1,
      expires_at DATETIME,
      views_count INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sync_devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      device_type TEXT NOT NULL DEFAULT 'android', -- 'android', 'ios', 'desktop'
      last_sync_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS share_items (
      share_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      PRIMARY KEY (share_id, file_id),
      FOREIGN KEY (share_id) REFERENCES shares(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
    );

    -- Create indexes for super-fast lookups
    CREATE INDEX IF NOT EXISTS idx_files_user_parent ON files(user_id, parent_id, is_trashed);
    CREATE INDEX IF NOT EXISTS idx_files_user_starred ON files(user_id, is_starred, is_trashed);
    CREATE INDEX IF NOT EXISTS idx_files_user_trashed ON files(user_id, is_trashed);
    CREATE INDEX IF NOT EXISTS idx_files_checksum ON files(checksum_sha256);
    CREATE INDEX IF NOT EXISTS idx_photo_date ON photo_metadata(date_taken);
  `);
}

initSchema();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function getActiveStorageDir() {
  const customPath = getSetting('storage_path');
  if (customPath && customPath.trim() !== '') {
    return path.resolve(customPath.trim());
  }
  return process.env.STORAGE_PATH ? path.resolve(process.env.STORAGE_PATH) : path.join(__dirname, '..', 'storage');
}

function getUserStorageDir(userId) {
  const baseDir = getActiveStorageDir();
  const dir = path.join(baseDir, `user_${userId}`);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getActiveStorageDir,
  getUserStorageDir
};
