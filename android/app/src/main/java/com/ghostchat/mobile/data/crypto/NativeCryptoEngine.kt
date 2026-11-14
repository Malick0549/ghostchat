package com.ghostchat.mobile.data.crypto

import android.util.Base64
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

object NativeCryptoEngine {

    private const val KEY_SIZE = 32           // 256 bits
    private const val BLOCK_SIZE = 16         // 128 bits
    private const val SALT_SIZE = 32          // 256 bits
    private const val PBKDF2_ITERATIONS = 100000

    fun deriveKey(password: String, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(password.toCharArray(), salt, PBKDF2_ITERATIONS, KEY_SIZE * 8)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        return factory.generateSecret(spec).encoded
    }

    fun encrypt(plaintext: String, password: String): String {
        val random = SecureRandom()
        val salt = ByteArray(SALT_SIZE)
        random.nextBytes(salt)

        val iv = ByteArray(BLOCK_SIZE)
        random.nextBytes(iv)

        val keyBytes = deriveKey(password, salt)
        val secretKey = SecretKeySpec(keyBytes, "AES")
        val ivSpec = IvParameterSpec(iv)

        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey, ivSpec)

        val ciphertextBytes = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        // Format: Salt (32) + IV (16) + Ciphertext
        val combined = ByteArray(salt.size + iv.size + ciphertextBytes.size)
        System.arraycopy(salt, 0, combined, 0, salt.size)
        System.arraycopy(iv, 0, combined, salt.size, iv.size)
        System.arraycopy(ciphertextBytes, 0, combined, salt.size + iv.size, ciphertextBytes.size)

        return Base64.encodeToString(combined, Base64.NO_WRAP)
    }

    fun decrypt(base64Combined: String, password: String): String {
        val combined = Base64.decode(base64Combined, Base64.NO_WRAP)
        if (combined.size < SALT_SIZE + BLOCK_SIZE) {
            throw IllegalArgumentException("Invalid encrypted payload length")
        }

        val salt = ByteArray(SALT_SIZE)
        System.arraycopy(combined, 0, salt, 0, SALT_SIZE)

        val iv = ByteArray(BLOCK_SIZE)
        System.arraycopy(combined, SALT_SIZE, iv, 0, BLOCK_SIZE)

        val ciphertextSize = combined.size - SALT_SIZE - BLOCK_SIZE
        val ciphertextBytes = ByteArray(ciphertextSize)
        System.arraycopy(combined, SALT_SIZE + BLOCK_SIZE, ciphertextBytes, 0, ciphertextSize)

        val keyBytes = deriveKey(password, salt)
        val secretKey = SecretKeySpec(keyBytes, "AES")
        val ivSpec = IvParameterSpec(iv)

        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey, ivSpec)

        val decryptedBytes = cipher.doFinal(ciphertextBytes)
        return String(decryptedBytes, Charsets.UTF_8)
    }

    /**
     * Complete GhostChat encryption pipeline:
     * Plaintext -> AES-256 -> Base64 -> Emoji Obfuscation
     */
    fun encryptToEmoji(plaintext: String, password: String): String {
        val b64Ciphertext = encrypt(plaintext, password)
        return EmojiMapper.textToEmojis(b64Ciphertext)
    }

    /**
     * Complete GhostChat decryption pipeline:
     * Emoji Obfuscation -> Base64 -> AES-256 Decryption -> Plaintext
     */
    fun decryptFromEmoji(emojiText: String, password: String): String {
        val b64Ciphertext = EmojiMapper.emojisToText(emojiText)
        return decrypt(b64Ciphertext, password)
    }
}
