package com.ghostchat.mobile.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SessionManager(context: Context) {

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = try {
        EncryptedSharedPreferences.create(
            context,
            "ghostchat_secure_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        context.getSharedPreferences("ghostchat_fallback_prefs", Context.MODE_PRIVATE)
    }

    companion object {
        const val DEFAULT_SERVER_URL = "https://ghostchat-t0cp.onrender.com"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_USERNAME = "username"
        private const val KEY_MASTER_PASSWORD = "master_password"
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL) ?: DEFAULT_SERVER_URL
        set(value) {
            val formatted = if (value.endsWith("/")) value.dropLast(1) else value
            prefs.edit().putString(KEY_SERVER_URL, formatted).apply()
        }

    var authToken: String?
        get() = prefs.getString(KEY_AUTH_TOKEN, null)
        set(value) = prefs.edit().putString(KEY_AUTH_TOKEN, value).apply()

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(value) = prefs.edit().putString(KEY_USER_ID, value).apply()

    var username: String?
        get() = prefs.getString(KEY_USERNAME, null)
        set(value) = prefs.edit().putString(KEY_USERNAME, value).apply()

    var masterPassword: String?
        get() = prefs.getString(KEY_MASTER_PASSWORD, null)
        set(value) = prefs.edit().putString(KEY_MASTER_PASSWORD, value).apply()

    fun isLoggedIn(): Boolean {
        return !authToken.isNullOrEmpty() && !userId.isNullOrEmpty()
    }

    fun clearSession() {
        prefs.edit().clear().apply()
    }
}
