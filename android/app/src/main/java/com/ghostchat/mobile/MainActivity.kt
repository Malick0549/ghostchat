package com.ghostchat.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.ghostchat.mobile.data.api.SocketManager
import com.ghostchat.mobile.data.local.SessionManager
import com.ghostchat.mobile.ui.navigation.GhostChatNavGraph
import com.ghostchat.mobile.ui.theme.GhostChatTheme

class MainActivity : ComponentActivity() {

    private lateinit var sessionManager: SessionManager
    private val socketManager = SocketManager()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate()
        enableEdgeToEdge()

        sessionManager = SessionManager(applicationContext)

        setContent {
            GhostChatTheme {
                GhostChatNavGraph(
                    sessionManager = sessionManager,
                    socketManager = socketManager
                )
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        socketManager.disconnect()
    }
}
