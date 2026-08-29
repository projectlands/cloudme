package com.cloudme.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;

public class AutoBackupWorker extends Worker {
    private static final String CHANNEL_ID = "cloudme_backup_channel";
    private static final int NOTIF_ID = 2001;

    public AutoBackupWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences prefs = context.getSharedPreferences("cloudme_backup_prefs", Context.MODE_PRIVATE);
        boolean enabled = prefs.getBoolean("backup_enabled", false);
        if (!enabled) {
            return Result.success();
        }

        String serverUrl = prefs.getString("server_url", "");
        String token = prefs.getString("auth_token", "");
        if (serverUrl.isEmpty() || token.isEmpty()) {
            return Result.success();
        }

        Set<String> uploadedSet = new HashSet<>(prefs.getStringSet("uploaded_ids", new HashSet<String>()));
        NotificationManager notifManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel(notifManager);

        NotificationCompat.Builder notifBuilder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("CloudMe Auto-Backup")
                .setContentText("Memeriksa foto baru di galeri...")
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true);

        try {
            notifManager.notify(NOTIF_ID, notifBuilder.build());
        } catch (Exception ignored) {}

        ContentResolver resolver = context.getContentResolver();
        Uri[] uris = new Uri[]{
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        };

        String[] projection = new String[]{
                MediaStore.MediaColumns._ID,
                MediaStore.MediaColumns.DISPLAY_NAME,
                MediaStore.MediaColumns.MIME_TYPE,
                MediaStore.MediaColumns.SIZE
        };

        int uploadCount = 0;
        for (Uri mediaUri : uris) {
            try (Cursor cursor = resolver.query(
                    mediaUri,
                    projection,
                    null,
                    null,
                    MediaStore.MediaColumns.DATE_ADDED + " DESC LIMIT 50"
            )) {
                if (cursor != null) {
                    int idCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID);
                    int nameCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME);
                    int mimeCol = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.MIME_TYPE);

                    while (cursor.moveToNext()) {
                        String id = cursor.getString(idCol);
                        String name = cursor.getString(nameCol);
                        String mime = cursor.getString(mimeCol);

                        if (uploadedSet.contains(id)) {
                            continue;
                        }

                        Uri fileUri = Uri.withAppendedPath(mediaUri, id);
                        boolean success = uploadMedia(context, fileUri, name, mime, serverUrl, token);
                        if (success) {
                            uploadedSet.add(id);
                            uploadCount++;
                            try {
                                notifBuilder.setContentText("Menyinkronkan foto (" + uploadCount + " berhasil)...");
                                notifManager.notify(NOTIF_ID, notifBuilder.build());
                            } catch (Exception ignored) {}
                        }
                    }
                }
            } catch (Exception ignored) {}
        }

        prefs.edit()
                .putStringSet("uploaded_ids", uploadedSet)
                .putLong("last_backup_timestamp", System.currentTimeMillis())
                .putInt("total_uploaded_count", uploadedSet.size())
                .apply();

        try {
            if (uploadCount > 0) {
                NotificationCompat.Builder doneNotif = new NotificationCompat.Builder(context, CHANNEL_ID)
                        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
                        .setContentTitle("CloudMe Auto-Backup")
                        .setContentText("Berhasil mencadangkan " + uploadCount + " foto/video baru!")
                        .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                        .setAutoCancel(true);
                notifManager.notify(NOTIF_ID, doneNotif.build());
            } else {
                notifManager.cancel(NOTIF_ID);
            }
        } catch (Exception ignored) {}

        return Result.success();
    }

    private boolean uploadMedia(Context context, Uri uri, String name, String mime, String serverUrl, String token) {
        String boundary = "----CloudMeBoundary" + System.currentTimeMillis();
        String lineEnd = "\r\n";
        String twoHyphens = "--";

        try {
            String targetUrl = serverUrl.replaceAll("/+$", "") + "/api/files/upload";
            URL url = new URL(targetUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setDoInput(true);
            conn.setDoOutput(true);
            conn.setUseCaches(false);
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Connection", "Keep-Alive");
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(60000);

            try (DataOutputStream dos = new DataOutputStream(conn.getOutputStream());
                 InputStream is = context.getContentResolver().openInputStream(uri)) {

                if (is == null) return false;

                // Multipart: files
                dos.writeBytes(twoHyphens + boundary + lineEnd);
                dos.writeBytes("Content-Disposition: form-data; name=\"files\"; filename=\"" + (name != null ? name : "photo.jpg") + "\"" + lineEnd);
                dos.writeBytes("Content-Type: " + (mime != null ? mime : "image/jpeg") + lineEnd);
                dos.writeBytes(lineEnd);

                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = is.read(buffer)) != -1) {
                    dos.write(buffer, 0, bytesRead);
                }
                dos.writeBytes(lineEnd);
                dos.writeBytes(twoHyphens + boundary + twoHyphens + lineEnd);
                dos.flush();
            }

            int responseCode = conn.getResponseCode();
            return responseCode == 200 || responseCode == 201;
        } catch (Exception e) {
            return false;
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
