package com.ghostchat.mobile.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Shield
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.ghostchat.mobile.ui.theme.*

@Composable
fun GhostHeaderCard(
    title: String = "GHOSTCHAT",
    subtitle: String = "AES-256-GCM Encrypted & Emoji Camouflaged"
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Icon(
                imageVector = Icons.Default.Shield,
                contentDescription = null,
                tint = CyberNeonBlue,
                modifier = Modifier.size(32.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = title,
                style = MaterialTheme.typography.headlineLarge,
                color = CyberNeonBlue
            )
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = subtitle,
            style = MaterialTheme.typography.bodyMedium,
            color = TextSecondaryDark
        )
    }
}

@Composable
fun GhostTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    isPassword: Boolean = false,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    leadingIcon: @Composable (() -> Unit)? = null
) {
    var passwordVisible by remember { mutableStateOf(false) }

    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label, color = TextSecondaryDark) },
        modifier = modifier.fillMaxWidth(),
        leadingIcon = leadingIcon,
        trailingIcon = if (isPassword) {
            {
                IconButton(onClick = { passwordVisible = !passwordVisible }) {
                    Icon(
                        imageVector = if (passwordVisible) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                        contentDescription = "Toggle Password",
                        tint = TextSecondaryDark
                    )
                }
            }
        } else null,
        visualTransformation = if (isPassword && !passwordVisible) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = keyboardOptions,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = CyberNeonBlue,
            unfocusedBorderColor = SurfaceVariantDark,
            focusedTextColor = TextPrimaryDark,
            unfocusedTextColor = TextPrimaryDark,
            focusedContainerColor = SurfaceDark,
            unfocusedContainerColor = SurfaceDark
        ),
        shape = RoundedCornerShape(12.dp)
    )
}

@Composable
fun GhostButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    containerColor: Color = CyberNeonBlue
) {
    Button(
        onClick = onClick,
        modifier = modifier
            .fillMaxWidth()
            .height(52.dp),
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(
            containerColor = containerColor,
            contentColor = DarkBackground,
            disabledContainerColor = SurfaceVariantDark
        ),
        shape = RoundedCornerShape(12.dp)
    ) {
        Text(
            text = text,
            fontWeight = FontWeight.Bold,
            fontSize = 16.sp,
            fontFamily = FontFamily.Monospace
        )
    }
}

@Composable
fun EncryptionBadge(
    isEncrypted: Boolean = true
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(if (isEncrypted) CyberNeonGreen.copy(alpha = 0.15f) else ErrorRed.copy(alpha = 0.15f))
            .border(1.dp, if (isEncrypted) CyberNeonGreen else ErrorRed, RoundedCornerShape(16.dp))
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = Icons.Default.Lock,
            contentDescription = null,
            tint = if (isEncrypted) CyberNeonGreen else ErrorRed,
            modifier = Modifier.size(14.dp)
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text(
            text = if (isEncrypted) "AES-256 SECURE" else "PLAIN TEXT",
            color = if (isEncrypted) CyberNeonGreen else ErrorRed,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace
        )
    }
}

@Composable
fun GhostMessageBubble(
    senderName: String,
    emojiContent: String,
    decryptedText: String?,
    isMine: Boolean,
    timestamp: String,
    onDecryptClick: () -> Unit
) {
    var showDecrypted by remember { mutableStateOf(!decryptedText.isNullOrEmpty()) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalAlignment = if (isMine) Alignment.End else Alignment.Start
    ) {
        if (!isMine) {
            Text(
                text = senderName,
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(start = 4.dp, bottom = 2.dp)
            )
        }

        Box(
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(
                    RoundedCornerShape(
                        topStart = 16.dp,
                        topEnd = 16.dp,
                        bottomStart = if (isMine) 16.dp else 4.dp,
                        bottomEnd = if (isMine) 4.dp else 16.dp
                    )
                )
                .background(if (isMine) SurfaceVariantDark else SurfaceDark)
                .border(
                    1.dp,
                    if (isMine) CyberNeonBlue.copy(alpha = 0.4f) else CyberAccentPurple.copy(alpha = 0.4f),
                    RoundedCornerShape(16.dp)
                )
                .clickable {
                    showDecrypted = !showDecrypted
                    if (showDecrypted && decryptedText.isNullOrEmpty()) {
                        onDecryptClick()
                    }
                }
                .padding(12.dp)
        ) {
            Column {
                if (showDecrypted && !decryptedText.isNullOrEmpty()) {
                    Text(
                        text = decryptedText,
                        style = MaterialTheme.typography.bodyLarge,
                        color = TextPrimaryDark
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "🔒 Decrypted from: $emojiContent",
                        style = MaterialTheme.typography.bodyMedium,
                        color = CyberNeonGreen,
                        fontSize = 11.sp
                    )
                } else {
                    Text(
                        text = emojiContent,
                        fontSize = 20.sp,
                        color = TextPrimaryDark
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Tap to decrypt",
                        style = MaterialTheme.typography.bodyMedium,
                        color = CyberNeonBlue,
                        fontSize = 11.sp
                    )
                }
            }
        }
        Text(
            text = timestamp,
            style = MaterialTheme.typography.bodyMedium,
            fontSize = 10.sp,
            color = TextSecondaryDark,
            modifier = Modifier.padding(top = 2.dp, start = 4.dp, end = 4.dp)
        )
    }
}
