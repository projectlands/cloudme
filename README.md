# ☁️ CloudMe - Personal Cloud Storage & Photos Auto-Backup

**CloudMe** adalah aplikasi Web Cloud Storage mandiri (*self-hosted*) yang ringan, cepat, modern, dan dirancang khusus agar dapat berjalan di **Windows & Linux** tanpa installer `.exe` desktop yang rumit, serta mendukung **Auto-Backup Foto & Video dari HP Android** layaknya Google Photos.

---

## ✨ Fitur Unggulan

### 1. 📂 Google Drive-Style File Management
* **Grid & List View:** Tampilan kartu thumbnail dan tabel detail berkas.
* **Operasi Lengkap:** Buat Folder, Ganti Nama (*Rename*), Pindahkan (*Move*), Beri Bintang (*Starred*), dan Sampah (*Trash/Restore*).
* **Chunked & Resumable Upload:** Unggah file besar berukuran GB tanpa takut gagal saat koneksi terputus.
* **Bulk Actions:** Pilih banyak berkas dan unduh langsung dalam format `.zip` secara *streaming*.
* **In-Browser File Preview:** Pemutar Video HTML5 (*seekable*), Pemutar Musik, Viewer Foto, Pembaca Dokumen PDF, dan Teks.
* **Sharing Link & QR Code:** Bagikan tautan publik dengan proteksi password, batas waktu (*expiration*), dan QR Code yang bisa di-scan langsung lewat kamera HP.

### 2. 📸 Google Photos-Style Timeline & Auto-Backup
* **Photos Timeline View:** Galeri visual foto dan video yang otomatis dikelompokkan berdasarkan **Hari, Bulan, dan Tahun**.
* **Ekstraksi Data EXIF:** Membaca otomatis tanggal asli pengambilan foto, resolusi, dan model kamera.
* **Deduplikasi Cerdas (SHA-256):** Foto/video yang sama tidak akan diunggah ulang dua kali, menghemat ruang penyimpanan dan kuota.

### 3. 📱 Integrasi Mobile Android (Auto-Backup Background)
* **WebDAV Support (`/webdav`):** Terhubung langsung ke aplikasi sinkronisasi background Android seperti **FolderSync** atau **AutoSync**.
* **PWA (Progressive Web App):** Dapat di-*install* langsung dari browser Chrome di Android, muncul di layar utama layaknya aplikasi asli.

### 4. ⚡ Ringan & Cepat (High Performance)
* **SQLite dengan Mode WAL (Write-Ahead Logging):** Super cepat, *zero-configuration*, dan tidak membebani RAM (hanya ~25–45 MB RAM).
* **Cross-Platform:** Berjalan di Windows, Linux (Ubuntu, Debian, dsb.), dan Docker.

---

## 🚀 Cara Menjalankan Aplikasi

### Opsi 1: Menggunakan Node.js (Windows & Linux)

1. Pastikan **Node.js (versi 18+)** sudah terpasang.
2. Jalankan perintah instalasi dan start:
   ```bash
   # Install dependensi
   npm install

   # Jalankan server
   npm start
   ```
   * *Di Windows:* Kamu juga bisa cukup klik ganda file `run.bat`.
   * *Di Linux:* Cukup jalankan `./run.sh`.

3. Buka browser di alamat:
   ```
   http://localhost:8080
   ```

---

### Opsi 2: Menggunakan Docker / Docker Compose

Cukup jalankan:
```bash
docker compose up -d
```
Aplikasi akan langsung berjalan di port `8080` dan data tersimpan aman di folder `./data`.

---

## 🛠️ Panduan Instalasi Pertama Kali (Web Setup Wizard)

Saat pertama kali membuka `http://localhost:8080`, kamu akan disambut oleh **Web Setup Wizard**:
1. Masukkan **Username & Email Administrator**.
2. Buat **Password Admin**.
3. Tentukan **Folder Penyimpanan** (Default: `./data/storage`).
4. Tentukan **Kapasitas Kuota Default** (Default: 50 GB).
5. Klik **"Selesaikan Instalasi & Masuk"**.

---

## 📲 Panduan Auto-Backup Foto Android (FolderSync)

1. Unduh aplikasi **FolderSync** (Gratis) dari Google Play Store di HP Android.
2. Buka FolderSync $\rightarrow$ Masuk ke menu **Accounts** $\rightarrow$ Tambah Akun **WebDAV**:
   * **Server URL:** `http://[IP-KOMPUTER-ANDA]:8080/webdav` *(Contoh: `http://192.168.1.10:8080/webdav`)*
   * **Username:** Username CloudMe Anda
   * **Password:** Password CloudMe Anda
3. Buat **Sync Filter / Folderpair**:
   * **Akun:** WebDAV CloudMe
   * **Folder HP:** `DCIM/Camera` atau `Pictures`
   * **Tipe Sinkronisasi:** *To remote account (Upload)*
   * **Jadwal:** Pilih *Saat terhubung ke Wi-Fi* dan *Saat HP sedang di-cas (Charging)*.
4. Selesai! Semua foto yang kamu ambil di HP akan otomatis masuk ke CloudMe dan muncul di menu **"Foto & Video"** sesuai tanggalnya.
