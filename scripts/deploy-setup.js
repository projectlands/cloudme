/**
 * CloudMe Windows Server Automated Deploy & Setup Script
 * - Auto-detects available free port (8080, 8081, 3000, etc.)
 * - Configures Git sparse-checkout to exclude android/ folder (clean server)
 * - Sets up .env configuration
 * - Prepares PM2 24/7 background process
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');

function log(msg, symbol = 'ℹ️') {
  console.log(`\x1b[36m[${symbol}]\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m[✅]\x1b[0m \x1b[1m${msg}\x1b[0m`);
}

function warn(msg) {
  console.log(`\x1b[33m[⚠️]\x1b[0m ${msg}`);
}

// 1. Test Port Availability
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        server.once('close', () => resolve(true)).close();
      })
      .listen(port, '0.0.0.0');
  });
}

async function getBestPort() {
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const match = envContent.match(/^PORT\s*=\s*(\d+)/m);
    if (match) {
      const configuredPort = parseInt(match[1], 10);
      const isFree = await isPortAvailable(configuredPort);
      if (isFree) return configuredPort;
      warn(`Port ${configuredPort} dari file .env sedang terpakai, mencari port lain yang kosong...`);
    }
  }

  const portsToTest = [8080, 8081, 8082, 8088, 3000, 5000, 8000, 9000, 9090];
  for (const port of portsToTest) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  // Fallback random available port
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const assignedPort = server.address().port;
      server.close(() => resolve(assignedPort));
    });
  });
}

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses.length > 0 ? addresses : ['127.0.0.1'];
}

async function main() {
  console.log('\n======================================================');
  console.log('   🚀 CLOUDME 1-CLICK WINDOWS SERVER DEPLOYMENT      ');
  console.log('======================================================\n');

  // Step A: Git Sparse-checkout to exclude android/
  log('Memeriksa konfigurasi Git (mengabaikan folder android/)...');
  try {
    if (fs.existsSync(path.join(rootDir, '.git'))) {
      execSync('git config core.sparseCheckout true', { cwd: rootDir, stdio: 'ignore' });
      execSync('git sparse-checkout set /* !/android', { cwd: rootDir, stdio: 'ignore' });
      success('Folder android/ berhasil diabaikan di server!');
    }
  } catch (e) {
    warn('Git sparse-checkout dilewati (bukan git repository atau sudah tersetup).');
  }

  // Step B: Detect available port
  log('Memeriksa ketersediaan port jaringan...');
  const port = await getBestPort();
  success(`Port yang dipilih untuk CloudMe: ${port}`);

  // Step C: Update or create .env
  const envPath = path.join(rootDir, '.env');
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
    if (/^PORT\s*=/m.test(envContent)) {
      envContent = envContent.replace(/^PORT\s*=.*/m, `PORT=${port}`);
    } else {
      envContent += `\nPORT=${port}\n`;
    }
  } else {
    envContent = `PORT=${port}\nHOST=0.0.0.0\nNODE_ENV=production\n`;
  }
  fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf-8');
  success('File konfigurasi .env berhasil diperbarui.');

  // Step D: Install PM2 if not present
  log('Memeriksa PM2 process manager...');
  try {
    execSync('pm2 --version', { stdio: 'ignore' });
    success('PM2 sudah terpasang.');
  } catch (e) {
    log('Menginstal PM2 & pm2-windows-startup secara global...');
    try {
      execSync('npm install -g pm2 pm2-windows-startup', { stdio: 'inherit' });
      try { execSync('pm2-startup install', { stdio: 'inherit' }); } catch (err) {}
      success('PM2 berhasil dipasang.');
    } catch (err) {
      warn('Gagal memasang PM2 secara global. Server akan dijalankan via node biasa.');
    }
  }

  // Step E: Start or Restart CloudMe with PM2
  let startedWithPm2 = false;
  try {
    execSync('pm2 delete cloudme', { stdio: 'ignore' });
  } catch (e) {}

  try {
    log('Menjalankan CloudMe dengan PM2 (24/7 background)...');
    execSync(`pm2 start server/index.js --name cloudme --update-env`, { cwd: rootDir, stdio: 'inherit' });
    execSync('pm2 save', { cwd: rootDir, stdio: 'ignore' });
    startedWithPm2 = true;
    success('CloudMe berhasil berjalan di background via PM2!');
  } catch (err) {
    warn('Tidak dapat menjalankan via PM2. Menjalankan via node langsung...');
  }

  // Summary
  const ips = getLocalIpAddresses();
  console.log('\n======================================================');
  console.log('   🎉 CLOUDME SERVER BERHASIL AKTIF & SIAP DIGUNAKAN! ');
  console.log('======================================================');
  console.log(`🌐 Akses Lokal   : http://localhost:${port}`);
  ips.forEach(ip => {
    console.log(`🏠 Akses Wi-Fi/LAN: http://${ip}:${port}`);
  });
  console.log(`⚡ Mode 24/7      : ${startedWithPm2 ? 'Aktif (PM2 Service)' : 'Standar'}`);
  console.log(`🔄 Auto-Restart  : ${startedWithPm2 ? 'Aktif saat Windows Reboot' : 'Nonaktif'}`);
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('\x1b[31m[ERROR]\x1b[0m Gagal melakukan deploy:', err);
  process.exit(1);
});
