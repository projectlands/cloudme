package com.cloudme.app;

import android.content.Context;
import android.content.SharedPreferences;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "AutoBackup")
public class AutoBackupPlugin extends Plugin {
    private static final String WORK_NAME = "CloudMeAutoBackupWork";

    @PluginMethod
    public void enableAutoBackup(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String token = call.getString("token", "");
        int intervalMinutes = call.getInt("intervalMinutes", 15);

        if (serverUrl.isEmpty() || token.isEmpty()) {
            call.reject("Server URL dan Token wajib diisi.");
            return;
        }

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
    public void syncNow(PluginCall call) {
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
        call.resolve(ret);
    }
}
