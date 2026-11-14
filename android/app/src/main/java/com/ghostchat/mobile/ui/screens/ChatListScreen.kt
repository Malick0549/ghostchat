package com.ghostchat.mobile.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ghostchat.mobile.data.local.SessionManager
import com.ghostchat.mobile.ui.components.EncryptionBadge
import com.ghostchat.mobile.ui.theme.*

data class ConversationItem(
    val id: String,
    val name: String,
    val isGroup: Boolean = false,
    val lastEmojiMsg: String,
    val timestamp: String,
    val isOnline: Boolean = false
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatListScreen(
    sessionManager: SessionManager,
    onConversationClick: (String, String, Boolean) -> Unit,
    onNavigateToSettings: () -> Unit
) {
    val sampleConversations = remember {
        listOf(
            ConversationItem("1", "Global Cyber Group", isGroup = true, lastEmojiMsg = "🔒 😎🐶🚀🔥", timestamp = "12:45 PM", isOnline = true),
            ConversationItem("2", "Alice (Security Lead)", isGroup = false, lastEmojiMsg = "🔑 😃🐻🍇", timestamp = "11:30 AM", isOnline = true),
            ConversationItem("3", "Bob (Cryptographer)", isGroup = false, lastEmojiMsg = "🛡️ 😉🐱⚡", timestamp = "Yesterday", isOnline = false)
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Lock, contentDescription = null, tint = CyberNeonBlue)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("GhostChat", color = TextPrimaryDark, fontWeight = FontWeight.Bold)
                        Spacer(modifier = Modifier.width(8.dp))
                        EncryptionBadge()
                    }
                },
                actions = {
                    IconButton(onClick = onNavigateToSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings", tint = TextPrimaryDark)
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
                .padding(horizontal = 16.dp)
        ) {
            Text(
                text = "Logged in as: ${sessionManager.username ?: "User"}",
                style = MaterialTheme.typography.bodyMedium,
                color = TextSecondaryDark,
                modifier = Modifier.padding(vertical = 8.dp)
            )

            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(sampleConversations) { conv ->
                    ConversationCard(
                        item = conv,
                        onClick = { onConversationClick(conv.id, conv.name, conv.isGroup) }
                    )
                }
            }
        }
    }
}

@Composable
fun ConversationCard(
    item: ConversationItem,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(SurfaceDark)
            .border(1.dp, SurfaceVariantDark, RoundedCornerShape(16.dp))
            .clickable { onClick() }
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(contentAlignment = Alignment.BottomEnd) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(if (item.isGroup) CyberAccentPurple.copy(alpha = 0.2f) else CyberNeonBlue.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = if (item.isGroup) Icons.Default.Group else Icons.Default.Person,
                    contentDescription = null,
                    tint = if (item.isGroup) CyberAccentPurple else CyberNeonBlue
                )
            }
            if (item.isOnline) {
                Box(
                    modifier = Modifier
                        .size(12.dp)
                        .clip(CircleShape)
                        .background(CyberNeonGreen)
                        .border(2.dp, DarkBackground, CircleShape)
                )
            }
        }

        Spacer(modifier = Modifier.width(14.dp))

        Column(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = item.name,
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    color = TextPrimaryDark
                )
                Text(
                    text = item.timestamp,
                    fontSize = 12.sp,
                    color = TextSecondaryDark
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = item.lastEmojiMsg,
                fontSize = 14.sp,
                color = TextSecondaryDark,
                maxLines = 1
            )
        }
    }
}
