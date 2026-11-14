# Keep Retrofit data models & API interfaces
-keepclassmembers class * {
    @com.google.gson.annotations.SerializedName <fields>;
}
-keep class com.ghostchat.mobile.data.api.** { *; }

# Socket.IO Proguard rules
-keep class io.socket.** { *; }
-keep class okhttp3.** { *; }

# Keep AES engine & crypto classes from obfuscation
-keep class com.ghostchat.mobile.data.crypto.** { *; }
