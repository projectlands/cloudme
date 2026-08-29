package com.cloudme.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "AutoBackup",
    permissions = {
        @Permission(
            alias = "media",
            strings = {
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO
            }
        ),
        @Permission(
            alias = "storage",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE
            }
        ),
        @Permission(
            alias = "notifications",
            strings = {
                Manifest.permission.POST_NOTIFICATIONS
            }
        )
    }
)
public class AutoBackupPlugin extends Plugin {
    private static final String WORK_NAME = "CloudMeAutoBackupWork";
    private static AutoBackupPlugin instance;
    private static volatile boolean isCancelRequested = false;

    @Override
    public void load() {
        instance = this;
    }

    public static boolean isCancelRequested() {
        return isCancelRequested;
    }

    public static void emitSyncProgress(int current, int total, String status) {
        if (instance != null) {
            JSObject data = new JSObject();
            data.put("current", current);
            data.put("total", total);
            data.put("status", status);
            instance.notifyListeners("syncProgress", data);
        }
    }

    @PluginMethod
    public void checkPermissions(PluginCall call) {
        boolean granted = isMediaPermissionGranted();
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (isMediaPermissionGranted()) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAliases(new String[]{"media", "notifications"}, call, "mediaPermissionsCallback");
        } else {
            requestPermissionForAlias("storage", call, "mediaPermissionsCallback");
        }
    }

    @PermissionCallback
    private void mediaPermissionsCallback(PluginCall call) {
        boolean granted = isMediaPermissionGranted();
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    private boolean isMediaPermissionGranted() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return getPermissionState("media") == PermissionState.GRANTED;
        } else {
            return getPermissionState("storage") == PermissionState.GRANTED;
        }
    }

    @PluginMethod
    public void enableAutoBackup(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String token = call.getString("token", "");
        int intervalMinutes = call.getInt("intervalMinutes", 15);

        if (serverUrl.isEmpty() || token.isEmpty()) {
            call.reject("Server URL dan Token wajib diisi.");
            return;
        }

        isCancelRequested = false;
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences("cloudme_backup_prefs", Context.MODE_PRIVATE);
        prefs.edit()
                .putBoolean("backup_enabled", true)
                .putString("server_url", serverUrl)
                .putString("auth_token", token)
                .putInt("interval_minutes", intervalMinutes)
                .apply();

        // Schedule periodic background work
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

        PeriodicWorkRequest workRequest = new PeriodicWorkRequest.Builder(
                AutoBackupWorker.class,
                Math.max(intervalMinutes, 15),
                TimeUnit.MINUTES
        )
                .setConstraints(constraints)
                .build();

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                workRequest
        );

        // Also trigger an immediate sync
        OneTimeWorkRequest immediate = new OneTimeWorkRequest.Builder(AutoBackupWorker.class)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueue(immediate);

        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", "Auto-backup berhasil diaktifkan.");
        call.resolve(ret);
    }

    @PluginMethod
    public void disableAutoBackup(PluginCall call) {
        isCancelRequested = true;
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences("cloudme_backup_prefs", Context.MODE_PRIVATE);
        prefs.edit().putBoolean("backup_enabled", false).apply();

        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);

        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", "Auto-backup dinonaktifkan.");
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelSync(PluginCall call) {
        isCancelRequested = true;
        Context context = getContext();
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        emitSyncProgress(0, 0, "Sinkronisasi dibatalkan oleh pengguna.");

        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", "Sinkronisasi dihentikan.");
        call.resolve(ret);
    }

    @PluginMethod
    public void syncNow(PluginCall call) {
        isCancelRequested = false;
        Context context = getContext();
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

        OneTimeWorkRequest immediate = new OneTimeWorkRequest.Builder(AutoBackupWorker.class)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueue(immediate);

        JSObject ret = new JSObject();
        ret.put("success", true);
        ret.put("message", "Sinkronisasi sedang berjalan di latar belakang.");
        call.resolve(ret);
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        Context context = getContext();
        SharedPreferences prefs = context.getSharedPreferences("cloudme_backup_prefs", Context.MODE_PRIVATE);

        boolean enabled = prefs.getBoolean("backup_enabled", false);
        long lastBackup = prefs.getLong("last_backup_timestamp", 0);
        int totalUploaded = prefs.getInt("total_uploaded_count", 0);

        JSObject ret = new JSObject();
        ret.put("isEnabled", enabled);
        ret.put("lastBackupTimestamp", lastBackup);
        ret.put("totalUploaded", totalUploaded);
        ret.put("hasPermission", isMediaPermissionGranted());
        ret.put("isCancelled", isCancelRequested);
        call.resolve(ret);
    }
}
