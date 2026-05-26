# tests/test_crypto.py
"""
Unit tests for AES-256 encryption/decryption module.
Tests the crypto layer in isolation.

These tests verify:
1. Encryption produces different ciphertext for same message (IV randomness)
2. Decryption correctly recovers original message
3. Wrong password fails to decrypt
4. Corrupted data fails to decrypt
5. Empty string handling
6. Long message handling
7. Unicode character handling
8. Key derivation consistency
9. Salt persistence
10. Error handling for edge cases
"""

import unittest
import base64
import sys
import os

# Add parent directory to path to import modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.crypto.aes_engine import AES256Engine


class TestAESEngine(unittest.TestCase):
    """
    Test suite for AES-256 encryption engine.
    Each test method focuses on a specific security property.
    """
    
    def setUp(self):
        """
        Set up test fixtures before each test.
        This runs before every test method.
        """
        self.password = "TestPassword123!"
        self.test_messages = [
            "Hello, World!",
            "This is a secret message that needs encryption.",
            "1234567890",
            "Special chars: !@#$%^&*()",
            "A" * 1000,  # Long message
        ]
    
    def test_01_encrypt_returns_required_fields(self):
        """
        Test that encrypt() returns ciphertext, iv, and salt.
        These three components are essential for decryption.
        """
        engine = AES256Engine(self.password)
        result = engine.encrypt("Test message")
        
        # Check all required keys exist in the result dictionary
        self.assertIn('ciphertext', result)
        self.assertIn('iv', result)
        self.assertIn('salt', result)
        
        # Check values are non-empty strings
        self.assertTrue(len(result['ciphertext']) > 0)
        self.assertTrue(len(result['iv']) > 0)
        self.assertTrue(len(result['salt']) > 0)
        
        print("✓ Test 1: Encrypt returns all required fields (ciphertext, iv, salt)")
    
    def test_02_encrypt_decrypt_roundtrip(self):
        """
        Test that encryption followed by decryption returns original message.
        This is the most basic test - encryption must be reversible.
        """
        engine = AES256Engine(self.password)
        
        for original in self.test_messages:
            with self.subTest(message=original[:30]):
                # Step 1: Encrypt the message
                encrypted = engine.encrypt(original)
                
                # Step 2: Decrypt the ciphertext
                decrypted = engine.decrypt(encrypted['ciphertext'], encrypted['iv'])
                
                # Step 3: Verify they match
                self.assertEqual(original, decrypted)
        
        print("✓ Test 2: All messages successfully encrypted and decrypted")
    
    def test_03_same_message_different_ciphertext(self):
        """
        Test that same message produces different ciphertext each time.
        This verifies that the Initialization Vector (IV) is random.
        If two encryptions of the same message produce the same ciphertext,
        it would be a serious security vulnerability.
        """
        engine = AES256Engine(self.password)
        message = "Same message every time"
        
        # Encrypt same message twice
        result1 = engine.encrypt(message)
        result2 = engine.encrypt(message)
        
        # Ciphertexts should be different due to random IV
        self.assertNotEqual(result1['ciphertext'], result2['ciphertext'])
        
        # But both should decrypt to the same message
        decrypted1 = engine.decrypt(result1['ciphertext'], result1['iv'])
        decrypted2 = engine.decrypt(result2['ciphertext'], result2['iv'])
        
        self.assertEqual(decrypted1, message)
        self.assertEqual(decrypted2, message)
        
        print("✓ Test 3: Same message produces different ciphertext (IV randomness working)")
    
    def test_04_wrong_password_fails(self):
        """
        Test that wrong password cannot decrypt.
        This is a critical security property - only the correct password
        should be able to decrypt the message.
        """
        correct_engine = AES256Engine("correct_password")
        wrong_engine = AES256Engine("wrong_password")
        
        original = "Secret message"
        encrypted = correct_engine.encrypt(original)
        
        # Use same salt for wrong engine to isolate password difference
        wrong_engine.salt = correct_engine.salt
        wrong_engine.key = wrong_engine._derive_key()
        
        # Decryption should fail with ValueError
        with self.assertRaises(ValueError):
            wrong_engine.decrypt(encrypted['ciphertext'], encrypted['iv'])
        
        print("✓ Test 4: Wrong password correctly rejected (security property verified)")
    
    def test_05_corrupted_ciphertext_fails(self):
        """
        Test that corrupted ciphertext raises error.
        This ensures data integrity - if the ciphertext is modified,
        decryption should detect it and fail.
        """
        engine = AES256Engine(self.password)
        original = "Important message"
        
        encrypted = engine.encrypt(original)
        
        # Corrupt the ciphertext by changing one character
        corrupted = encrypted['ciphertext'][:-1] + 'X'
        
        # Decryption should detect the corruption
        with self.assertRaises(ValueError):
            engine.decrypt(corrupted, encrypted['iv'])
        
        print("✓ Test 5: Corrupted ciphertext correctly rejected (integrity check)")
    
    def test_06_empty_string(self):
        """
        Test encryption and decryption of empty string.
        Edge case - empty messages should be handled gracefully.
        """
        engine = AES256Engine(self.password)
        original = ""
        
        encrypted = engine.encrypt(original)
        decrypted = engine.decrypt(encrypted['ciphertext'], encrypted['iv'])
        
        self.assertEqual(original, decrypted)
        
        print("✓ Test 6: Empty string handled correctly")
    
    def test_07_unicode_characters(self):
        """
        Test encryption of Unicode/emoji characters.
        The system should support all Unicode characters, not just ASCII.
        """
        engine = AES256Engine(self.password)
        test_strings = [
            "Hello 🌍 World!",
            "Привет мир",  # Russian
            "こんにちは世界",  # Japanese
            "[GHOST]🎃💀[ALIEN]🤖",  # Emojis
        ]
        
        for original in test_strings:
            with self.subTest(message=original):
                encrypted = engine.encrypt(original)
                decrypted = engine.decrypt(encrypted['ciphertext'], encrypted['iv'])
                self.assertEqual(original, decrypted)
        
        print("✓ Test 7: Unicode characters (including emojis) handled correctly")
    
    def test_08_salt_persistence(self):
        """
        Test that using same salt allows decryption across instances.
        This verifies that the salt can be stored and reused.
        """
        engine1 = AES256Engine(self.password)
        original = "Cross-instance test"
        
        encrypted = engine1.encrypt(original)
        
        # Create new engine with same salt
        salt_bytes = base64.b64decode(encrypted['salt'])
        engine2 = AES256Engine(self.password, salt=salt_bytes)
        
        # Should decrypt successfully
        decrypted = engine2.decrypt(encrypted['ciphertext'], encrypted['iv'])
        
        self.assertEqual(original, decrypted)
        
        print("✓ Test 8: Salt persistence works across instances")
    
    def test_09_key_derivation_consistency(self):
        """
        Test that same password + same salt produces same key.
        Key derivation must be deterministic for decryption to work.
        """
        import os
        salt = os.urandom(32)
        
        engine1 = AES256Engine(self.password, salt=salt)
        engine2 = AES256Engine(self.password, salt=salt)
        
        self.assertEqual(engine1.key, engine2.key)
        
        print("✓ Test 9: Key derivation is deterministic with same salt")
    
    def test_10_no_password_error(self):
        """
        Test that empty password raises error.
        Security requirement - password cannot be empty.
        """
        with self.assertRaises(ValueError):
            AES256Engine("")
        
        print("✓ Test 10: Empty password correctly rejected")
    
    def test_11_long_message_performance(self):
        """
        Test handling of very long messages.
        Verifies the system can handle large data without breaking.
        """
        engine = AES256Engine(self.password)
        long_message = "X" * 10000  # 10,000 character message
        
        encrypted = engine.encrypt(long_message)
        decrypted = engine.decrypt(encrypted['ciphertext'], encrypted['iv'])
        
        self.assertEqual(long_message, decrypted)
        
        print("✓ Test 11: Long message (10,000 chars) handled correctly")
    
    def test_12_key_derivation_iterations(self):
        """
        Test that PBKDF2 iterations are set correctly.
        Verifies security parameter configuration.
        """
        engine = AES256Engine(self.password)
        info = engine.get_key_info()
        
        self.assertEqual(info['pbkdf2_iterations'], 100000)
        self.assertEqual(info['key_size_bits'], 256)
        self.assertEqual(info['algorithm'], 'AES-256-CBC')
        
        print("✓ Test 12: Security parameters correctly configured (PBKDF2: 100k iterations)")


def run_tests():
    """Run all AES engine tests and print summary"""
    print("\n" + "=" * 60)
    print("TESTING AES-256 ENCRYPTION ENGINE")
    print("=" * 60)
    print("\nThese tests verify the security properties of AES-256:")
    print("  • Confidentiality (encryption/decryption)")
    print("  • IV randomness (different ciphertexts)")
    print("  • Key derivation (PBKDF2)")
    print("  • Authentication (wrong password rejection)")
    print("  • Integrity (corruption detection)")
    print()
    
    # Create test suite
    suite = unittest.TestLoader().loadTestsFromTestCase(TestAESEngine)
    
    # Run tests with verbosity
    runner = unittest.TextTestRunner(verbosity=0)
    result = runner.run(suite)
    
    print("\n" + "=" * 60)
    if result.wasSuccessful():
        print(f"ALL {result.testsRun} AES TESTS PASSED!")
        print("   Security properties verified successfully.")
    else:
        print(f"{len(result.failures)} AES TESTS FAILED")
        for failure in result.failures:
            print(f"   - {failure[0]._testMethodName}")
    print("=" * 60)
    
    return result.wasSuccessful()


if __name__ == "__main__":
    run_tests()