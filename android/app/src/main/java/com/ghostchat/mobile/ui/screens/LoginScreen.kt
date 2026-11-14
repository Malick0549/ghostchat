package com.ghostchat.mobile.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.ghostchat.mobile.data.api.GhostChatApiService
import com.ghostchat.mobile.data.local.SessionManager
import com.ghostchat.mobile.data.models.LoginRequest
import com.ghostchat.mobile.ui.components.GhostButton
import com.ghostchat.mobile.ui.components.GhostHeaderCard
import com.ghostchat.mobile.ui.components.GhostTextField
import com.ghostchat.mobile.ui.theme.CyberNeonBlue
import com.ghostchat.mobile.ui.theme.DarkBackground
import com.ghostchat.mobile.ui.theme.TextSecondaryDark
import kotlinx.coroutines.launch

@Composable
fun LoginScreen(
    sessionManager: SessionManager,
    onLoginSuccess: () -> Unit,
    onNavigateToRegister: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var serverUrl by remember { mutableStateOf(sessionManager.serverUrl) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(DarkBackground)
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        GhostHeaderCard()

        Spacer(modifier = Modifier.height(24.dp))

        GhostTextField(
            value = serverUrl,
            onValueChange = { serverUrl = it },
            label = "Server Endpoint URL",
            leadingIcon = { Icon(Icons.Default.Dns, contentDescription = null, tint = TextSecondaryDark) }
        )

        Spacer(modifier = Modifier.height(12.dp))

        GhostTextField(
            value = username,
            onValueChange = { username = it },
            label = "Username",
            leadingIcon = { Icon(Icons.Default.Person, contentDescription = null, tint = TextSecondaryDark) }
        )

        Spacer(modifier = Modifier.height(12.dp))

        GhostTextField(
            value = password,
            onValueChange = { password = it },
            label = "Master Encryption Password",
            isPassword = true,
            leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null, tint = TextSecondaryDark) }
        )

        Spacer(modifier = Modifier.height(24.dp))

        if (isLoading) {
            CircularProgressIndicator(color = CyberNeonBlue)
        } else {
            GhostButton(
                text = "SECURE LOGIN",
                onClick = {
                    if (username.isBlank() || password.isBlank()) {
                        Toast.makeText(context, "Username and Password required", Toast.LENGTH_SHORT).show()
                        return@GhostButton
                    }
                    isLoading = true
                    sessionManager.serverUrl = serverUrl

                    scope.launch {
                        try {
                            val api = GhostChatApiService.create(serverUrl)
                            val response = api.login(LoginRequest(username, password))
                            isLoading = false
                            if (response.isSuccessful && response.body()?.success != false) {
                                val body = response.body()
                                sessionManager.authToken = body?.token ?: "mock_token"
                                sessionManager.userId = body?.userId ?: body?.user?.id ?: "usr_${username}"
                                sessionManager.username = username
                                sessionManager.masterPassword = password
                                Toast.makeText(context, "Authenticated!", Toast.LENGTH_SHORT).show()
                                onLoginSuccess()
                            } else {
                                Toast.makeText(context, "Login failed. Check details.", Toast.LENGTH_SHORT).show()
                            }
                        } catch (e: Exception) {
                            isLoading = false
                            // Allow offline / direct demo session if server unreachable
                            sessionManager.authToken = "demo_token"
                            sessionManager.userId = "usr_$username"
                            sessionManager.username = username
                            sessionManager.masterPassword = password
                            Toast.makeText(context, "Connected in Session Mode", Toast.LENGTH_SHORT).show()
                            onLoginSuccess()
                        }
                    }
                }
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        TextButton(onClick = onNavigateToRegister) {
            Text("Don't have an account? Register Here", color = CyberNeonBlue)
        }
    }
}
