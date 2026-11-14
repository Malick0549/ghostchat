package com.ghostchat.mobile.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ghostchat.mobile.data.api.SocketManager
import com.ghostchat.mobile.data.crypto.NativeCryptoEngine
import com.ghostchat.mobile.data.local.SessionManager
import com.ghostchat.mobile.data.models.ChatMessage
import com.ghostchat.mobile.ui.components.GhostMessageBubble
import com.ghostchat.mobile.ui.theme.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatDetailScreen(
    conversationId: String,
    conversationName: String,
    isGroup: Boolean,
    sessionManager: SessionManager,
    socketManager: SocketManager,
    onBackClick: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var inputText by remember { mutableStateOf("") }

    val messages = remember {
        mutableStateListOf(
            ChatMessage(
                id = "1",
                senderId = "other",
                senderName = conversationName,
                emojiContent = NativeCryptoEngine.encryptToEmoji("Welcome to GhostChat encrypted stream!", sessionManager.masterPassword ?: "default"),
                encryptedContent = NativeCryptoEngine.encrypt("Welcome to GhostChat encrypted stream!", sessionManager.masterPassword ?: "default"),
                timestamp = "12:00 PM",
                isMine = false
            )
        )
    }

    LaunchedEffect(Unit) {
        socketManager.connect(sessionManager.serverUrl, sessionManager.userId, sessionManager.authToken)
        socketManager.messageFlow.collectLatest { msg ->
            messages.add(msg)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(conversationName, color = TextPrimaryDark, fontWeight = FontWeight.Bold)
                        Text("AES-256-CBC • End-to-End Encrypted", color = CyberNeonGreen, style = MaterialTheme.typography.bodyMedium)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBackClick) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = TextPrimaryDark)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = DarkBackground)
            )
        },
        containerColor = DarkBackground
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            LazyColumn(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.Bottom
            ) {
                items(messages) { msg ->
                    GhostMessageBubble(
                        senderName = msg.senderName,
                        emojiContent = msg.emojiContent,
                        decryptedText = msg.decryptedText,
                        isMine = msg.isMine,
                        timestamp = msg.timestamp,
                        onDecryptClick = {
                            try {
                                val password = sessionManager.masterPassword ?: "default"
                                val decrypted = NativeCryptoEngine.decryptFromEmoji(msg.emojiContent, password)
                                val index = messages.indexOf(msg)
                                if (index != -1) {
                                    messages[index] = msg.copy(decryptedText = decrypted)
                                }
                            } catch (e: Exception) {
                                Toast.makeText(context, "Decryption failed: Incorrect Password", Toast.LENGTH_SHORT).show()
                            }
                        }
                    )
                }
            }

            // Composer
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(SurfaceDark)
                    .padding(12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedTextField(
                    value = inputText,
                    onValueChange = { inputText = it },
                    placeholder = { Text("Type plain text (Auto Encrypted)...", color = TextSecondaryDark) },
                    modifier = Modifier.weight(1f),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = CyberNeonBlue,
                        unfocusedBorderColor = SurfaceVariantDark,
                        focusedTextColor = TextPrimaryDark,
                        unfocusedTextColor = TextPrimaryDark,
                        focusedContainerColor = DarkBackground,
                        unfocusedContainerColor = DarkBackground
                    ),
                    shape = RoundedCornerShape(24.dp)
                )

                Spacer(modifier = Modifier.width(8.dp))

                FloatingActionButton(
                    onClick = {
                        if (inputText.isBlank()) return@FloatingActionButton
                        val textToEncrypt = inputText
                        inputText = ""
                        val password = sessionManager.masterPassword ?: "default"

                        scope.launch {
                            val emojiMsg = NativeCryptoEngine.encryptToEmoji(textToEncrypt, password)
                            val encMsg = NativeCryptoEngine.encrypt(textToEncrypt, password)

                            val newMsg = ChatMessage(
                                id = System.currentTimeMillis().toString(),
                                senderId = sessionManager.userId ?: "me",
                                senderName = sessionManager.username ?: "Me",
                                receiverId = if (!isGroup) conversationId else null,
                                groupId = if (isGroup) conversationId else null,
                                emojiContent = emojiMsg,
                                encryptedContent = encMsg,
                                timestamp = "Just now",
                                isMine = true,
                                decryptedText = textToEncrypt
                            )

                            messages.add(newMsg)
                            socketManager.sendMessage(
                                senderId = sessionManager.userId ?: "me",
                                receiverId = if (!isGroup) conversationId else null,
                                groupId = if (isGroup) conversationId else null,
                                emojiContent = emojiMsg,
                                encryptedContent = encMsg
                            )
                        }
                    },
                    containerColor = CyberNeonBlue,
                    contentColor = DarkBackground
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
                }
            }
        }
    }
}
