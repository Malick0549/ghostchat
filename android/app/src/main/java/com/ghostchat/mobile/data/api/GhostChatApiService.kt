package com.ghostchat.mobile.data.api

import com.ghostchat.mobile.data.models.AuthResponse
import com.ghostchat.mobile.data.models.DecryptApiRequest
import com.ghostchat.mobile.data.models.DecryptApiResponse
import com.ghostchat.mobile.data.models.EncryptApiRequest
import com.ghostchat.mobile.data.models.EncryptApiResponse
import com.ghostchat.mobile.data.models.LoginRequest
import com.ghostchat.mobile.data.models.RegisterRequest
import com.ghostchat.mobile.data.models.User
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import java.util.concurrent.TimeUnit

interface GhostChatApiService {

    @POST("api/login")
    suspend fun login(@Body request: LoginRequest): Response<AuthResponse>

    @POST("api/register")
    suspend fun register(@Body request: RegisterRequest): Response<AuthResponse>

    @POST("api/encrypt")
    suspend fun encryptMessage(@Body request: EncryptApiRequest): Response<EncryptApiResponse>

    @POST("api/decrypt")
    suspend fun decryptMessage(@Body request: DecryptApiRequest): Response<DecryptApiResponse>

    @GET("api/users")
    suspend fun getUsers(): Response<List<User>>

    companion object {
        fun create(baseUrl: String): GhostChatApiService {
            val formattedUrl = if (baseUrl.endsWith("/")) baseUrl else "$baseUrl/"

            val loggingInterceptor = HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BODY
            }

            val okHttpClient = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .addInterceptor(loggingInterceptor)
                .build()

            return Retrofit.Builder()
                .baseUrl(formattedUrl)
                .client(okHttpClient)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
                .create(GhostChatApiService::class.java)
        }
    }
}
