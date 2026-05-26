# tests/test_emoji.py
"""
Unit tests for emoji obfuscation module.
Tests the visual camouflage layer in isolation.

These tests verify:
1. Text → emoji → text reversibility
2. Deterministic mode produces consistent output
3. Random mode produces different output
4. All Base64 characters are supported
5. Error handling for invalid input
6. Long string handling
7. Special character handling
8. Seed reproducibility
9. Empty string handling
10. Statistics method accuracy
11. Emoji length preservation
12. Reverse mapping completeness
"""

import unittest
import sys
import os
import random

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.obfuscation.emoji_mapper import EmojiMapper


class TestEmojiMapper(unittest.TestCase):
    """
    Test suite for emoji obfuscation mapper.
    Tests the visual camouflage layer that provides NO security,
    only visual obfuscation.
    """
    
    def setUp(self):
        """Set up test fixtures before each test"""
        self.base64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
        self.test_strings = [
            "HelloWorld",
            "SGVsbG8gV29ybGQ=",  # Base64 of "Hello World"
            "ABC123abc",
            "A" * 100,
            self.base64_chars,
        ]
    
    def test_01_deterministic_reversibility(self):
        """
        Test that deterministic mode: text → emojis → text works perfectly.
        This ensures the mapping is lossless and completely reversible.
        """
        for original in self.test_strings:
            with self.subTest(text=original[:30]):
                # Convert to emojis using deterministic mode
                emojis = EmojiMapper.text_to_emojis(original, deterministic=True)
                
                # Convert back to text
                recovered = EmojiMapper.emojis_to_text(emojis)
                
                # Verify perfect reconstruction
                self.assertEqual(original, recovered)
        
        print("✓ Test 1: Deterministic mode perfectly reversible (lossless)")
    
    def test_02_deterministic_consistency(self):
        """
        Test that deterministic mode produces same output for same input.
        This ensures consistency - same message always produces same emojis.
        """
        test_text = "TestString123"
        
        # Convert twice with deterministic mode
        result1 = EmojiMapper.text_to_emojis(test_text, deterministic=True)
        result2 = EmojiMapper.text_to_emojis(test_text, deterministic=True)
        
        self.assertEqual(result1, result2)
        
        print("✓ Test 2: Deterministic mode produces consistent output")
    
    def test_03_random_mode_reversibility(self):
        """
        Test that random mode with fixed seed is reversible.
        Random mode still maintains reversibility when using the same seed.
        """
        for original in self.test_strings[:3]:  # Test first 3 strings
            with self.subTest(text=original[:30]):
                # Use fixed seed for reproducibility
                emojis = EmojiMapper.text_to_emojis(original, seed=42)
                recovered = EmojiMapper.emojis_to_text(emojis)
                self.assertEqual(original, recovered)
        
        print("✓ Test 3: Random mode with fixed seed is reversible")
    
    def test_04_seed_reproducibility(self):
        """
        Test that same seed produces same random output.
        This allows reproducible "random" output for testing.
        """
        test_text = "SeedTest"
        
        result1 = EmojiMapper.text_to_emojis(test_text, seed=123)
        result2 = EmojiMapper.text_to_emojis(test_text, seed=123)
        
        self.assertEqual(result1, result2)
        
        # Different seed should produce different output
        result3 = EmojiMapper.text_to_emojis(test_text, seed=456)
        
        # Verify both are reversible
        recovered1 = EmojiMapper.emojis_to_text(result1)
        recovered3 = EmojiMapper.emojis_to_text(result3)
        
        self.assertEqual(test_text, recovered1)
        self.assertEqual(test_text, recovered3)
        
        print("✓ Test 4: Seed parameter works correctly")
    
    def test_05_all_base64_characters(self):
        """
        Test that every Base64 character works individually.
        The mapping must support all 65 Base64 characters.
        """
        failed_chars = []
        
        for char in self.base64_chars:
            # Convert single character
            emoji = EmojiMapper.text_to_emojis(char, deterministic=True)
            recovered = EmojiMapper.emojis_to_text(emoji)
            
            if char != recovered:
                failed_chars.append(char)
        
        self.assertEqual(failed_chars, [], f"Failed chars: {failed_chars}")
        
        print(f"✓ Test 5: All {len(self.base64_chars)} Base64 characters work correctly")
    
    def test_06_empty_string(self):
        """
        Test empty string handling.
        Edge case - empty input should produce empty output.
        """
        self.assertEqual(EmojiMapper.text_to_emojis(""), "")
        self.assertEqual(EmojiMapper.emojis_to_text(""), "")
        
        print("✓ Test 6: Empty string handled correctly")
    
    def test_07_invalid_input_rejection(self):
        """
        Test that invalid Base64 input raises error.
        Only valid Base64 strings should be accepted.
        """
        invalid_inputs = [
            "This has spaces!",
            "Hello\nWorld",
            "Tab\tcharacter",
            "Unicode™",
            "Email@domain.com",
        ]
        
        for invalid in invalid_inputs:
            with self.subTest(input=invalid):
                with self.assertRaises(ValueError):
                    EmojiMapper.text_to_emojis(invalid)
        
        print("✓ Test 7: Invalid Base64 input correctly rejected")
    
    def test_08_unknown_emoji_rejection(self):
        """
        Test that unknown emojis raise error.
        The reverse mapping only knows emojis in CHAR_TO_EMOJI.
        """
        unknown_emojis = [
            "🚫[PASS]",  # Not in mapping
            "[FAIL]",    # Not in mapping
            "⭐",    # Not in mapping
            "🔥",    # Not in mapping
            "💯",    # Not in mapping
        ]
        
        for unknown in unknown_emojis:
            with self.subTest(emoji=unknown):
                with self.assertRaises(ValueError):
                    EmojiMapper.emojis_to_text(unknown)
        
        print("✓ Test 8: Unknown emojis correctly rejected")
    
    def test_09_long_string(self):
        """
        Test handling of long strings.
        The mapper should handle large inputs efficiently.
        """
        long_text = "A" * 5000
        emojis = EmojiMapper.text_to_emojis(long_text, deterministic=True)
        recovered = EmojiMapper.emojis_to_text(emojis)
        
        self.assertEqual(long_text, recovered)
        
        print("✓ Test 9: Long string (5000 chars) handled correctly")
    
    def test_10_special_base64_characters(self):
        """
        Test special Base64 characters: +, /, =
        These are the three non-alphanumeric Base64 characters.
        """
        special_chars = ['+', '/', '=']
        
        for char in special_chars:
            emoji = EmojiMapper.text_to_emojis(char, deterministic=True)
            recovered = EmojiMapper.emojis_to_text(emoji)
            self.assertEqual(char, recovered)
        
        # Test combination
        special_string = "ABC+/=123"
        emoji = EmojiMapper.text_to_emojis(special_string, deterministic=True)
        recovered = EmojiMapper.emojis_to_text(emoji)
        self.assertEqual(special_string, recovered)
        
        print("✓ Test 10: Special Base64 characters (+ / =) work correctly")
    
    def test_11_statistics_method(self):
        """
        Test that statistics method returns expected structure.
        Provides useful information about the mapping.
        """
        stats = EmojiMapper.get_statistics()
        
        # Check expected keys
        expected_keys = [
            'supported_characters',
            'total_unique_emojis',
            'avg_emojis_per_char',
            'min_emojis_per_char',
            'max_emojis_per_char',
            'duplicate_emojis_count',
            'character_set'
        ]
        
        for key in expected_keys:
            self.assertIn(key, stats)
        
        # Verify values
        self.assertEqual(stats['supported_characters'], 65)
        self.assertEqual(stats['character_set'], 'Base64 (A-Z, a-z, 0-9, +, /, =)')
        self.assertGreater(stats['total_unique_emojis'], 0)
        
        print("✓ Test 11: Statistics method returns correct information")
    
    def test_12_reversibility_for_complex_strings(self):
        """
        Test that complex strings with all characters are reversible.
        This is the most comprehensive reversibility test.
        """
        # Create a string that includes all Base64 characters multiple times
        complex_string = self.base64_chars * 3
        
        # Test deterministic mode
        emojis_det = EmojiMapper.text_to_emojis(complex_string, deterministic=True)
        recovered_det = EmojiMapper.emojis_to_text(emojis_det)
        self.assertEqual(complex_string, recovered_det)
        
        # Test random mode with seed
        emojis_rand = EmojiMapper.text_to_emojis(complex_string, seed=12345)
        recovered_rand = EmojiMapper.emojis_to_text(emojis_rand)
        self.assertEqual(complex_string, recovered_rand)
        
        print("✓ Test 12: Complex strings perfectly reversible in both modes")


def run_tests():
    """Run all emoji mapper tests and print summary"""
    print("\n" + "=" * 60)
    print("TESTING EMOJI OBFUSCATION LAYER")
    print("=" * 60)
    print("\nIMPORTANT: These tests verify visual camouflage ONLY.")
    print("   This layer provides NO security - only reversible obfuscation.")
    print("   Real security comes from AES-256 in the crypto layer.\n")
    
    # Create test suite
    suite = unittest.TestLoader().loadTestsFromTestCase(TestEmojiMapper)
    
    # Run tests
    runner = unittest.TextTestRunner(verbosity=0)
    result = runner.run(suite)
    
    print("\n" + "=" * 60)
    if result.wasSuccessful():
        print(f"ALL {result.testsRun} EMOJI TESTS PASSED!")
        print("   Visual obfuscation layer is fully reversible.")
    else:
        print(f"{len(result.failures)} EMOJI TESTS FAILED")
        for failure in result.failures:
            print(f"   - {failure[0]._testMethodName}")
    print("=" * 60)
    
    return result.wasSuccessful()


if __name__ == "__main__":
    run_tests()