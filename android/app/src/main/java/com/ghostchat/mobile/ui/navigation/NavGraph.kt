package com.ghostchat.mobile.ui.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.ghostchat.mobile.data.api.SocketManager
import com.ghostchat.mobile.data.local.SessionManager
import com.ghostchat.mobile.ui.screens.*

sealed class Screen(val route: String) {
    object Login : Screen("login")
    object Register : Screen("register")
    object ChatList : Screen("chat_list")
    object ChatDetail : Screen("chat_detail/{id}/{name}/{isGroup}") {
        fun createRoute(id: String, name: String, isGroup: Boolean) = "chat_detail/$id/$name/$isGroup"
    }
    object Settings : Screen("settings")
}

@Composable
fun GhostChatNavGraph(
    sessionManager: SessionManager,
    socketManager: SocketManager
) {
    val navController = rememberNavController()
    val startDestination = remember {
        if (sessionManager.isLoggedIn()) Screen.ChatList.route else Screen.Login.route
    }

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Screen.Login.route) {
            LoginScreen(
                sessionManager = sessionManager,
                onLoginSuccess = {
                    navController.navigate(Screen.ChatList.route) {
                        popUpTo(Screen.Login.route) { inclusive = true }
                    }
                },
                onNavigateToRegister = {
                    navController.navigate(Screen.Register.route)
                }
            )
        }

        composable(Screen.Register.route) {
            RegisterScreen(
                sessionManager = sessionManager,
                onRegisterSuccess = {
                    navController.navigate(Screen.Login.route) {
                        popUpTo(Screen.Register.route) { inclusive = true }
                    }
                },
                onNavigateToLogin = {
                    navController.navigate(Screen.Login.route) {
                        popUpTo(Screen.Register.route) { inclusive = true }
                    }
                }
            )
        }

        composable(Screen.ChatList.route) {
            ChatListScreen(
                sessionManager = sessionManager,
                onConversationClick = { id, name, isGroup ->
                    navController.navigate(Screen.ChatDetail.createRoute(id, name, isGroup))
                },
                onNavigateToSettings = {
                    navController.navigate(Screen.Settings.route)
                }
            )
        }

        composable(
            route = Screen.ChatDetail.route,
            arguments = listOf(
                navArgument("id") { type = NavType.StringType },
                navArgument("name") { type = NavType.StringType },
                navArgument("isGroup") { type = NavType.BoolType }
            )
        ) { backStackEntry ->
            val id = backStackEntry.arguments?.getString("id") ?: "1"
            val name = backStackEntry.arguments?.getString("name") ?: "Chat"
            val isGroup = backStackEntry.arguments?.getBoolean("isGroup") ?: false

            ChatDetailScreen(
                conversationId = id,
                conversationName = name,
                isGroup = isGroup,
                sessionManager = sessionManager,
                socketManager = socketManager,
                onBackClick = { navController.popBackStack() }
            )
        }

        composable(Screen.Settings.route) {
            SettingsScreen(
                sessionManager = sessionManager,
                onBackClick = { navController.popBackStack() },
                onLogoutClick = {
                    socketManager.disconnect()
                    navController.navigate(Screen.Login.route) {
                        popUpTo(0) { inclusive = true }
                    }
                }
            )
        }
    }
}
