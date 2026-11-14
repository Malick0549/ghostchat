package com.ghostchat.mobile.data.api

import android.util.Log
import com.ghostchat.mobile.data.models.ChatMessage
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.json.JSONObject
import java.net.URI

class SocketManager {

    private var socket: Socket? = null
    private val TAG = "SocketManager"

    private val _messageFlow = MutableSharedFlow<ChatMessage>(extraBufferCapacity = 64)
    val messageFlow: SharedFlow<ChatMessage> = _messageFlow

    private val _connectionStatus = MutableSharedFlow<Boolean>(extraBufferCapacity = 16)
    val connectionStatus: SharedFlow<Boolean> = _connectionStatus

    fun connect(serverUrl: String, userId: String?, token: String?) {
        try {
            if (socket != null && socket!!.connected()) return

            val options = IO.Options().apply {
                forceNew = true
                reconnection = true
                if (!userId.isNullOrEmpty()) {
                    extraHeaders = mapOf("X-User-ID" to listOf(userId))
                }
            }

            val uri = URI.create(serverUrl)
            socket = IO.socket(uri, options)

            socket?.on(Socket.EVENT_CONNECT) {
                Log.d(TAG, "Socket Connected to $serverUrl")
                _connectionStatus.tryEmit(true)
                if (!token.isNullOrEmpty() || !userId.isNullOrEmpty()) {
                    val authObj = JSONObject().apply {
                        put("token", token ?: "")
                        put("user_id", userId ?: "")
                    }
                    socket?.emit("authenticate", authObj)
                }
            }

            socket?.on(Socket.EVENT_DISCONNECT) {
                Log.d(TAG, "Socket Disconnected")
                _connectionStatus.tryEmit(false)
            }

            socket?.on("receive_message") { args ->
                if (args.isNotEmpty() && args[0] is JSONObject) {
                    val json = args[0] as JSONObject
                    val msg = ChatMessage(
                        id = json.optString("id", System.currentTimeMillis().toString()),
                        senderId = json.optString("sender_id", ""),
                        senderName = json.optString("sender_name", "Unknown"),
                        receiverId = json.optString("receiver_id", null),
                        groupId = json.optString("group_id", null),
                        encryptedContent = json.optString("encrypted_content", ""),
                        emojiContent = json.optString("emoji_content", ""),
                        timestamp = json.optString("timestamp", "Just now"),
                        isMine = json.optString("sender_id") == userId
                    )
                    _messageFlow.tryEmit(msg)
                }
            }

            socket?.connect()
        } catch (e: Exception) {
            Log.e(TAG, "Socket connection error", e)
        }
    }

    fun sendMessage(
        senderId: String,
        receiverId: String?,
        groupId: String?,
        emojiContent: String,
        encryptedContent: String
    ) {
        if (socket?.connected() == true) {
            val data = JSONObject().apply {
                put("sender_id", senderId)
                put("receiver_id", receiverId)
                put("group_id", groupId)
                put("chat_type", if (groupId != null) "group" else "private")
                put("emoji_content", emojiContent)
                put("encrypted_content", encryptedContent)
                put("message_type", "text")
            }
            socket?.emit("send_message", data)
        }
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
    }
}
