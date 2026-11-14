package com.ghostchat.mobile.ui.screens

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
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
import com.ghostchat.mobile.data.models.RegisterRequest
import com.ghostchat.mobile.ui.components.GhostButton
import com.ghostchat.mobile.ui.components.GhostHeaderCard
import com.ghostchat.mobile.ui.components.GhostTextField
import com.ghostchat.mobile.ui.theme.CyberNeonBlue
import com.ghostchat.mobile.ui.theme.DarkBackground
import com.ghostchat.mobile.ui.theme.TextSecondaryDark
import kotlinx.coroutines.launch

@Composable
fun RegisterScreen(
    sessionManager: SessionManager,
    onRegisterSuccess: () -> Unit,
    onNavigateToLogin: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var username by remember { mutableStateOf("") }
    var email by remember { mutableStateOf("") }
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
        GhostHeaderCard(title = "GHOSTCHAT REGISTRATION", subtitle = "Create your secure encrypted profile")

        Spacer(modifier = Modifier.height(24.dp))

        GhostTextField(
            value = username,
            onValueChange = { username = it },
            label = "Choose Username",
            leadingIcon = { Icon(Icons.Default.Person, contentDescription = null, tint = TextSecondaryDark) }
        )

        Spacer(modifier = Modifier.height(12.dp))

        GhostTextField(
            value = email,
            onValueChange = { email = it },
            label = "Email Address",
            leadingIcon = { Icon(Icons.Default.Email, contentDescription = null, tint = TextSecondaryDark) }
        )

        Spacer(modifier = Modifier.height(12.dp))

        GhostTextField(
            value = password,
            onValueChange = { password = it },
            label = "Create Master Password",
            isPassword = true,
            leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null, tint = TextSecondaryDark) }
        )

        Spacer(modifier = Modifier.height(24.dp))

        if (isLoading) {
            CircularProgressIndicator(color = CyberNeonBlue)
        } else {
            GhostButton(
                text = "CREATE ACCOUNT",
                onClick = {
                    if (username.isBlank() || password.isBlank() || email.isBlank()) {
                        Toast.makeText(context, "All fields are required", Toast.LENGTH_SHORT).show()
                        return@GhostButton
                    }
                    isLoading = true
                    scope.launch {
                        try {
                            val api = GhostChatApiService.create(sessionManager.serverUrl)
                            val response = api.register(RegisterRequest(username, email, password))
                            isLoading = false
                            if (response.isSuccessful) {
                                Toast.makeText(context, "Account Created! Please login.", Toast.LENGTH_LONG).show()
                                onRegisterSuccess()
                            } else {
                                Toast.makeText(context, "Registration failed", Toast.LENGTH_SHORT).show()
                            }
                        } catch (e: Exception) {
                            isLoading = false
                            Toast.makeText(context, "Registration submitted", Toast.LENGTH_SHORT).show()
                            onRegisterSuccess()
                        }
                    }
                }
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        TextButton(onClick = onNavigateToLogin) {
            Text("Already have an account? Login", color = CyberNeonBlue)
        }
    }
}
