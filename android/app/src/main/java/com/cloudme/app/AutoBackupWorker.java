package com.cloudme.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class AutoBackupWorker extends Worker {
    private static final String TAG = "CloudMeAutoBackup";
    private static final String CHANNEL_ID = "cloudme_backup_channel";
    private static final int NOTIF_ID = 2001;

    public static class MediaItem {
        public String id;
        public Uri uri;
        public String name;
        public String mime;
        public long size;
        public String albumName;

        public MediaItem(String id, Uri uri, String name, String mime, long size, String albumName) {
            this.id = id;
            this.uri = uri;
            this.name = name;
            this.mime = mime;
            this.size = size;
            this.albumName = (albumName != null && !albumName.trim().isEmpty()) ? albumName.trim() : "Galeri";
        }

        public String getUniqueKey() {
            return (name != null ? name : "") + "_" + size;
        }
    }

    public AutoBackupWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences("cloudme_backup_prefs", Context.MODE_PRIVATE);
        boolean enabled = prefs.getBoolean("backup_enabled", false);
        if (!enabled || AutoBackupPlugin.isCancelRequested()) {
            Log.d(TAG, "AutoBackup is disabled or cancelled.");
            return Result.success();
        }

        String serverUrl = prefs.getString("server_url", "");
        String token = prefs.getString("auth_token", "");
        if (serverUrl.isEmpty() || token.isEmpty()) {
            Log.e(TAG, "Server URL or token missing.");
            return Result.success();
        }

        Set<String> uploadedSet = new HashSet<>(prefs.getStringSet("uploaded_ids", new HashSet<String>()));
        NotificationManager notifManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel(notifManager);

        // PendingIntent so tapping notification opens MainActivity
        Intent launchIntent = new Intent(context, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        NotificationCompat.Builder notifBuilder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("CloudMe Auto-Backup")
                .setContentText("Memeriksa foto & video baru di galeri...")
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true);

        try {
            notifManager.notify(NOTIF_ID, notifBuilder.build());
        } catch (Exception ignored) {}

        ContentResolver resolver = context.getContentResolver();
        List<MediaItem> pendingItems = new ArrayList<>();

        queryMedia(resolver, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, uploadedSet, pendingItems);
        queryMedia(resolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, uploadedSet, pendingItems);

        int totalFound = pendingItems.size();
        Log.d(TAG, "Found " + totalFound + " new media items to backup.");
        AutoBackupPlugin.emitSyncProgress(0, totalFound, totalFound > 0 ? "Ditemukan " + totalFound + " media baru..." : "Semua galeri sudah tercadangkan.");

        String deviceName = Build.MANUFACTURER != null ? Build.MANUFACTURER : "Android";
        String model = Build.MODEL != null ? Build.MODEL : "Device";
        if (model.toLowerCase().startsWith(deviceName.toLowerCase())) {
            deviceName = model;
        } else {
            deviceName = deviceName + " " + model;
        }
        deviceName = "Backup - " + deviceName.trim();

        int uploadCount = 0;
        for (MediaItem item : pendingItems) {
            // Check for user cancellation before each upload
            if (isStopped() || AutoBackupPlugin.isCancelRequested() || !prefs.getBoolean("backup_enabled", true)) {
                Log.d(TAG, "AutoBackup cancelled by user.");
                AutoBackupPlugin.emitSyncProgress(uploadCount, totalFound, "Sinkronisasi dihentikan.");
                notifManager.cancel(NOTIF_ID);
                return Result.success();
            }

            String folderPath = deviceName + "/" + item.albumName;
            boolean success = uploadMedia(context, item.uri, item.name, item.mime, folderPath, serverUrl, token);
            if (success) {
                // Immediately save unique key to prevent re-upload even if stopped later
                uploadedSet.add(item.getUniqueKey());
                uploadedSet.add(item.id);
                uploadCount++;

                prefs.edit()
                        .putStringSet("uploaded_ids", uploadedSet)
                        .putLong("last_backup_timestamp", System.currentTimeMillis())
                        .putInt("total_uploaded_count", uploadedSet.size())
                        .apply();

                AutoBackupPlugin.emitSyncProgress(uploadCount, totalFound, "Menyinkronkan foto (" + uploadCount + "/" + totalFound + ")");
                try {
                    notifBuilder.setContentText("Menyinkronkan foto (" + uploadCount + "/" + totalFound + ")...");
                    notifManager.notify(NOTIF_ID, notifBuilder.build());
                } catch (Exception ignored) {}
            }
        }

        AutoBackupPlugin.emitSyncProgress(uploadCount, totalFound, uploadCount > 0 ? "Selesai! " + uploadCount + " foto baru berhasil dicadangkan." : "Galeri sudah mutakhir.");

        try {
            if (uploadCount > 0) {
                NotificationCompat.Builder doneNotif = new NotificationCompat.Builder(context, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                        .setContentTitle("CloudMe Auto-Backup")
                        .setContentText("Berhasil mencadangkan " + uploadCount + " foto/video baru!")
                        .setContentIntent(pendingIntent)
                        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                        .setAutoCancel(true);
                notifManager.notify(NOTIF_ID, doneNotif.build());
            } else {
                notifManager.cancel(NOTIF_ID);
            }
        } catch (Exception ignored) {}

        return Result.success();
    }

    private void queryMedia(ContentResolver resolver, Uri mediaUri, Set<String> uploadedSet, List<MediaItem> list) {
        String[] projection = new String[]{
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_ADDED,
                "bucket_display_name"
        };

        String sortOrder = MediaStore.MediaColumns.DATE_ADDED + " DESC";
        try (Cursor cursor = resolver.query(mediaUri, projection, null, null, sortOrder)) {
            if (cursor != null) {
                int idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                int nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
                int mimeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE);
                int sizeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE);
                int bucketCol = cursor.getColumnIndex("bucket_display_name");

                while (cursor.moveToNext() && list.size() < 100) {
                    long id = cursor.getLong(idCol);
                    String idStr = String.valueOf(id);
                    String name = cursor.getString(nameCol);
                    String mime = cursor.getString(mimeCol);
                    long size = cursor.getLong(sizeCol);

                    String albumName = "Galeri";
                    if (bucketCol != -1) {
                        try {
                            String b = cursor.getString(bucketCol);
                            if (b != null && !b.trim().isEmpty()) {
                                albumName = b.trim();
                            }
                        } catch (Exception ignored) {}
                    }

                    String uniqueKey = (name != null ? name : "") + "_" + size;
                    if (uploadedSet.contains(uniqueKey) || uploadedSet.contains(idStr)) {
                        continue;
                    }

                    Uri contentUri = ContentUris.withAppendedId(mediaUri, id);
                    list.add(new MediaItem(idStr, contentUri, name, mime, size, albumName));
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error querying " + mediaUri + ": " + e.getMessage());
        }
    }

    private boolean uploadMedia(Context context, Uri uri, String name, String mime, String folderPath, String serverUrl, String token) {
        String boundary = "----CloudMeBoundary" + System.currentTimeMillis();
        String lineEnd = "\r\n";
        String twoHyphens = "--";

        HttpURLConnection conn = null;
        try {
            String targetUrl = serverUrl.replaceAll("/+$", "") + "/api/files/upload";
            URL url = new URL(targetUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setDoInput(true);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Connection", "Keep-Alive");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(120000);

            try (DataOutputStream dos = new DataOutputStream(conn.getOutputStream());
                 InputStream is = context.getContentResolver().openInputStream(uri)) {

                if (is == null) {
                    Log.e(TAG, "Cannot open InputStream for URI: " + uri);
                    return false;
                }

                String filename = (name != null && !name.isEmpty()) ? name : "photo_" + System.currentTimeMillis() + ".jpg";
                String contentType = (mime != null && !mime.isEmpty()) ? mime : "image/jpeg";

                // Add folderPath field for automatic device & album categorization
                if (folderPath != null && !folderPath.isEmpty()) {
                    dos.writeBytes(twoHyphens + boundary + lineEnd);
                    dos.writeBytes("Content-Disposition: form-data; name=\"folderPath\"" + lineEnd + lineEnd);
                    dos.write(folderPath.getBytes("UTF-8"));
                    dos.writeBytes(lineEnd);
                }

                dos.writeBytes(twoHyphens + boundary + lineEnd);
                dos.writeBytes("Content-Disposition: form-data; name=\"files\"; filename=\"" + filename + "\"" + lineEnd);
                dos.writeBytes("Content-Type: " + contentType + lineEnd);
                dos.writeBytes(lineEnd);

                byte[] buffer = new byte[16384];
                int bytesRead;
                while ((bytesRead = is.read(buffer)) != -1) {
                    dos.write(buffer, 0, bytesRead);
                }
                dos.writeBytes(lineEnd);
                dos.writeBytes(twoHyphens + boundary + twoHyphens + lineEnd);
                dos.flush();
            }

            int responseCode = conn.getResponseCode();
            Log.d(TAG, "Upload response: " + responseCode + " for " + name + " into " + folderPath);
            return responseCode == 200 || responseCode == 201;
        } catch (Exception e) {
            Log.e(TAG, "Upload error for " + name + ": " + e.getMessage(), e);
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void createNotificationChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "CloudMe Auto-Backup",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Notifikasi sinkronisasi otomatis foto & video galeri");
            manager.createNotificationChannel(channel);
        }
    }
}
