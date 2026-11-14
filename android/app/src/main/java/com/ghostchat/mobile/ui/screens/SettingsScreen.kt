package com.ghostchat.mobile.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.ghostchat.mobile.data.local.SessionManager
import com.ghostchat.mobile.ui.components.GhostButton
import com.ghostchat.mobile.ui.components.GhostTextField
import com.ghostchat.mobile.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    sessionManager: SessionManager,
    onBackClick: () -> Unit,
    onLogoutClick: () -> Unit
) {
    val context = LocalContext.current
    var serverUrl by remember { mutableStateOf(sessionManager.serverUrl) }
    var masterPassword by remember { mutableStateOf(sessionManager.masterPassword ?: "") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Security Settings", color = TextPrimaryDark, fontWeight = FontWeight.Bold) },
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
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Card(
                colors = CardDefaults.cardColors(containerColor = SurfaceDark),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Dns, contentDescription = null, tint = CyberNeonBlue)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Server Endpoint", fontWeight = FontWeight.Bold, color = TextPrimaryDark)
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    GhostTextField(
                        value = serverUrl,
                        onValueChange = { serverUrl = it },
                        label = "GhostChat Server Base URL"
                    )
                }
            }

            Card(
                colors = CardDefaults.cardColors(containerColor = SurfaceDark),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Lock, contentDescription = null, tint = CyberNeonGreen)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Master Encryption Key", fontWeight = FontWeight.Bold, color = TextPrimaryDark)
                    }
                    Spacer(modifier = Modifier.height(8.dp))
                    GhostTextField(
                        value = masterPassword,
                        onValueChange = { masterPassword = it },
                        label = "Local Encryption Password",
                        isPassword = true
                    )
                }
            }

            GhostButton(
                text = "SAVE SETTINGS",
                onClick = {
                    sessionManager.serverUrl = serverUrl
                    sessionManager.masterPassword = masterPassword
                    Toast.makeText(context, "Settings saved!", Toast.LENGTH_SHORT).show()
                }
            )

            Spacer(modifier = Modifier.height(24.dp))

            Button(
                onClick = {
                    sessionManager.clearSession()
                    onLogoutClick()
                },
                colors = ButtonDefaults.buttonColors(containerColor = ErrorRed),
                modifier = Modifier.fillMaxWidth().height(50.dp),
                shape = RoundedCornerShape(12.dp)
            ) {
                Icon(Icons.Default.Logout, contentDescription = null)
                Spacer(modifier = Modifier.width(8.dp))
                Text("LOGOUT SESSION", fontWeight = FontWeight.Bold)
            }
        }
    }
}
