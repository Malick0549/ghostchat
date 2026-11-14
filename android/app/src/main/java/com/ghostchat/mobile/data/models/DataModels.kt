package com.ghostchat.mobile.data.models

import com.google.gson.annotations.SerializedName

data class User(
    @SerializedName("id") val id: String,
    @SerializedName("username") val username: String,
    @SerializedName("email") val email: String? = null,
    @SerializedName("is_online") val isOnline: Boolean = false,
    @SerializedName("last_seen") val lastSeen: String? = null
)

data class AuthResponse(
    @SerializedName("status") val status: String? = null,
    @SerializedName("success") val success: Boolean? = false,
    @SerializedName("message") val message: String? = null,
    @SerializedName("token") val token: String? = null,
    @SerializedName("user_id") val userId: String? = null,
    @SerializedName("user") val user: User? = null
)

data class LoginRequest(
    @SerializedName("username") val username: String,
    @SerializedName("password") val password: String
)

data class RegisterRequest(
    @SerializedName("username") val username: String,
    @SerializedName("email") val email: String,
    @SerializedName("password") val password: String
)

data class EncryptApiRequest(
    @SerializedName("message") val message: String,
    @SerializedName("password") val password: String,
    @SerializedName("use_decoys") val useDecoys: Boolean = false
)

data class EncryptApiResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("emoji_message") val emojiMessage: String? = null,
    @SerializedName("error") val error: String? = null
)

data class DecryptApiRequest(
    @SerializedName("emoji_message") val emojiMessage: String,
    @SerializedName("password") val password: String
)

data class DecryptApiResponse(
    @SerializedName("success") val success: Boolean,
    @SerializedName("decrypted_message") val decryptedMessage: String? = null,
    @SerializedName("error") val error: String? = null
)

data class ChatMessage(
    val id: String,
    val senderId: String,
    val senderName: String,
    val receiverId: String? = null,
    val groupId: String? = null,
    val encryptedContent: String,
    val emojiContent: String,
    val timestamp: String,
    val isMine: Boolean = false,
    var decryptedText: String? = null
)

data class GroupChatModel(
    val id: String,
    val name: String,
    val description: String? = null,
    val memberCount: Int = 0
)
