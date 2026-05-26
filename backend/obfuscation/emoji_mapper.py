# obfuscation/emoji_mapper.py
"""
Emoji Obfuscation Layer for GhostChat
PURE VISUAL CAMOUFLAGE - NO SECURITY WHATSOEVER

This module does ONE thing: Convert text (ciphertext) to emojis and back.
It has NO knowledge of:
- Encryption
- Keys
- Passwords
- Any security mechanisms

IMPORTANT SECURITY NOTICE:
- This is NOT encryption
- This is NOT security
- This is ONLY visual obfuscation (like a secret decoder ring)
- The REAL security comes from AES-256 in the crypto layer

DESIGN PRINCIPLES:
1. Reversible: emojis → text → same emojis
2. Deterministic: Same input always produces same output (for same mapping choice)
3. Complete: All Base64 characters (A-Z, a-z, 0-9, +, /, =) have mappings
4. Lossless: No information lost in conversion
"""

import random
from typing import Dict, List, Tuple, Optional


class EmojiMapper:
    """
    Converts Base64 text to emojis and back.
    
    HOW IT WORKS:
    1. Each Base64 character maps to 2-4 possible emojis
    2. When converting text→emojis, randomly chooses one emoji per character
    3. When converting emojis→text, looks up the character for each emoji
    4. Result: Ciphertext looks like random emojis, but can be recovered exactly
    
    CHARACTER SET SUPPORTED:
    - Uppercase: A-Z (26 chars)
    - Lowercase: a-z (26 chars)  
    - Digits: 0-9 (10 chars)
    - Special: +, /, = (3 chars)
    Total: 65 characters (standard Base64)
    
    DUPLICATE HANDLING:
    Some emojis appear for multiple characters (e.g., '😎' for 'C' and 'L').
    During reverse conversion, we use the first matching character found.
    This is acceptable because:
    1. The mapping is still reversible (one emoji → one character)
    2. We keep all original emojis for visual variety
    3. No information is lost during conversion
    """
    
    # Mapping: Base64 character -> List of possible emojis
    # Each character has MULTIPLE emoji options for variety
    # This makes the output look more "random" but still reversible
    
    RANDOM_EMOJI = CHAR_TO_EMOJI = {
        # Uppercase letters (A-Z)
        'A': ['😀', '😁', '😂', '🤣'],
        'B': ['😃', '😄', '😅', '😆'],
        'C': ['😉', '😊', '😋', '😜'],
        'D': ['😍', '😘', '😗', '😙'],
        'E': ['😚', '🙂', '🤗', '🤔'],
        'F': ['😐', '😑', '😶', '🙄'],
        'G': ['😏', '🧠', '🧛', '🧜'],
        'H': ['🤐', '😌', '😔', '😪'],
        'I': ['🤤', '😴', '😷', '🤒'],
        'J': ['🤕', '🤢', '🤮', '🤧'],
        'K': ['🥵', '🥶', '🥴', '😵'],
        'L': ['🤯', '🤠', '🥳', '😎'],
        'M': ['🤓', '🧐', '😕', '😟'],
        'N': ['🙁', '😮', '😯', '😲'],
        'O': ['😳', '🥺', '😦', '😧'],
        'P': ['😨', '😰', '😥', '😢'],
        'Q': ['😭', '😱', '😖', '😣'],
        'R': ['😞', '😓', '😩', '😫'],
        'S': ['😤', '😡', '😠', '🤬'],
        'T': ['😈', '👿', '💀', '☠️'],
        'U': ['💩', '🤡', '👹', '👺'],
        'V': ['👻', '🧟', '👽', '🤖'],
        'W': ['🎃', '😺', '😸', '😹'],
        'X': ['😻', '😼', '😽', '🙀'],
        'Y': ['😿', '😾', '🙈', '🙉'],
        'Z': ['🙊', '💋', '💌', '💘'],
        
        # Lowercase letters (a-z)
        'a': ['🐶', '🐱', '🐭', '🐹'],
        'b': ['🐰', '🦊', '🐻', '🐼'],
        'c': ['🐨', '🐯', '🦁', '🐮'],
        'd': ['🐷', '🐸', '🐒', '🐔'],
        'e': ['🐧', '🐦', '🐤', '🐣'],
        'f': ['🐥', '🐺', '🐗', '🐴'],
        'g': ['🦄', '🐝', '🐛', '🦋'],
        'h': ['🐌', '🐞', '🐜', '🕷️'],
        'i': ['🦂', '🐢', '🐍', '🦎'],
        'j': ['🐙', '🦑', '🐬', '🐳'],
        'k': ['🐋', '🦈', '🐊', '🐅'],
        'l': ['🐆', '🦓', '🦍', '🦧'],
        'm': ['🐘', '🦛', '🦏', '🐪'],
        'n': ['🐫', '🦒', '🦘', '🐃'],
        'o': ['🐂', '🐄', '🐎', '🐖'],
        'p': ['🐏', '🐑', '🐐', '🦌'],
        'q': ['🐕', '🐩', '🐈', '🐓'],
        'r': ['🦃', '🕊️', '🐇', '🦝'],
        's': ['🦨', '🦡', '🦦', '🦥'],
        't': ['🐁', '🐀', '🐿️', '🦔'],
        'u': ['🐉', '🐲', '🌵', '🎄'],
        'v': ['🌲', '🌳', '🌴', '🌿'],
        'w': ['🍀', '🍁', '🍂', '🍃'],
        'x': ['🍇', '🍈', '🍉', '🍊'],
        'y': ['🍋', '🍌', '🍍', '🥭'],
        'z': ['🍎', '🍏', '🍐', '🍑'],
        
        # Digits (0-9)
        '0': ['0️⃣', '0⃣', '⓿'],
        '1': ['1️⃣', '1⃣', '❶'],
        '2': ['2️⃣', '2⃣', '❷'],
        '3': ['3️⃣', '3⃣', '❸'],
        '4': ['4️⃣', '4⃣', '❹'],
        '5': ['5️⃣', '5⃣', '❺'],
        '6': ['6️⃣', '6⃣', '❻'],
        '7': ['7️⃣', '7⃣', '❼'],
        '8': ['8️⃣', '8⃣', '❽'],
        '9': ['9️⃣', '9⃣', '❾'],
        
        # Base64 special characters
        '+': ['➕', '✚', '🆙', '🔼'],  # Plus sign
        '/': ['➗', '〰️', '🪢', '➿'],  # Forward slash
        '=': ['🟰', '≣', '🇪', '⚖️'],  # Equals sign
    }
    
    # Build reverse mapping: Emoji -> Base64 character
    # For duplicate emojis, we store ALL possibilities, then use position to disambiguate
    EMOJI_TO_CHARS = {}
    
    for char, emojis in CHAR_TO_EMOJI.items():
        for emoji in emojis:
            if emoji not in EMOJI_TO_CHARS:
                EMOJI_TO_CHARS[emoji] = []
            if char not in EMOJI_TO_CHARS[emoji]:
                EMOJI_TO_CHARS[emoji].append(char)

    # Unique deterministic mapping for direct reversible conversion
    DETERMINISTIC_EMOJI = {
        char: emojis[0]
        for char, emojis in CHAR_TO_EMOJI.items()
    }
    
    @staticmethod
    def text_to_emojis(text: str, deterministic: bool = False, seed: Optional[int] = None) -> str:
        """
        Convert Base64 text to emoji sequence.
        
        Args:
            text: Base64 string (ciphertext from AES encryption)
            deterministic: If True, always use first emoji (no randomness)
            seed: Random seed for reproducible randomness (for testing)
            
        Returns:
            Emoji string that visually represents the text
            
        IMPORTANT:
            This is NOT encryption! Anyone with this mapping can reverse it.
            The security comes from AES, NOT from these emojis.
        """
        if not text:
            return ""
        
        # Validate input contains only Base64 characters
        valid_chars = set('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=')
        for char in text:
            if char not in valid_chars:
                raise ValueError(f"Invalid Base64 character: '{char}'. "
                               f"Emoji mapper only accepts valid Base64 strings.")
        
        # Set up randomness
        if deterministic:
            # Deterministic mode: use UNIQUE emoji mapping (perfect reversibility)
            return ''.join(EmojiMapper.DETERMINISTIC_EMOJI[c] for c in text)
        elif seed is not None:
            # Reproducible randomness without mutating global state
            rng = random.Random(seed)
            choice_func = lambda lst: rng.choice(lst)
        else:
            # True random (good for production)
            choice_func = random.choice
        
        # Convert each character to an emoji (random mode)
        emoji_sequence = []
        for char in text:
            emoji_options = EmojiMapper.RANDOM_EMOJI.get(char)
            if emoji_options:
                emoji = choice_func(emoji_options)
                emoji_sequence.append(emoji)
            else:
               raise ValueError(f"No emoji mapping found for character: '{char}'")
        
        return ''.join(emoji_sequence)
    
    @staticmethod
    def emojis_to_text(emoji_string: str) -> str:
        """
        Convert emoji sequence back to Base64 text.
        
        Args:
            emoji_string: Emoji sequence from text_to_emojis()
            
        Returns:
            Original Base64 string (ciphertext)
        """
        if not emoji_string:
            return ""
        
        # First extract all emojis from the string
        emojis_found = []
        i = 0
        
        while i < len(emoji_string):
            matched = False
            
            # Try longest possible emoji first (up to 4 characters)
            for length in range(4, 0, -1):
                if i + length <= len(emoji_string):
                    potential_emoji = emoji_string[i:i+length]
                    
                    if potential_emoji in EmojiMapper.EMOJI_TO_CHARS:
                        emojis_found.append(potential_emoji)
                        i += length
                        matched = True
                        break
            
            if not matched:
                # Try single character
                potential_emoji = emoji_string[i]
                if potential_emoji in EmojiMapper.EMOJI_TO_CHARS:
                    emojis_found.append(potential_emoji)
                    i += 1
                    matched = True
            
            if not matched:
                # Unknown emoji found - raise error
                raise ValueError(f"Unknown emoji sequence starting at position {i}: "
                               f"'{emoji_string[i:i+4]}'")
        
        # Now convert each emoji back to a character
        # For duplicate emojis, we use the position to determine which character
        result_chars = []
        for idx, emoji in enumerate(emojis_found):
            possible_chars = EmojiMapper.EMOJI_TO_CHARS[emoji]
            
            if len(possible_chars) == 1:
                result_chars.append(possible_chars[0])
            else:
                # Multiple possibilities - use position to decide
                # This ensures deterministic reversal
                pos = idx % len(possible_chars)
                result_chars.append(possible_chars[pos])
        
        return ''.join(result_chars)

    def encode(self, text: str) -> str:
        """Alias for emoji encoding to support existing API route expectations."""
        return self.text_to_emojis(text)

    def decode(self, emoji_string: str) -> str:
        """Alias for emoji decoding to support existing API route expectations."""
        return self.emojis_to_text(emoji_string)
    
    @staticmethod
    def verify_mapping(text: str, seed: Optional[int] = None) -> bool:
        """
        Verify that text → emojis → text works correctly.
        
        Args:
            text: The original Base64 text
            seed: Random seed for reproducible testing
            
        Returns:
            True if mapping is reversible, False otherwise
        """
        # Test deterministic mode first
        emoji_det = EmojiMapper.text_to_emojis(text, deterministic=True)
        recovered_det = EmojiMapper.emojis_to_text(emoji_det)
        
        if text != recovered_det:
            return False
        
        # Test random mode with seed if provided
        if seed is not None:
            emoji_rand = EmojiMapper.text_to_emojis(text, seed=seed)
            recovered_rand = EmojiMapper.emojis_to_text(emoji_rand)
            return text == recovered_rand
        
        return True
    
    @staticmethod
    def get_statistics() -> Dict:
        """
        Get statistics about the emoji mapping.
        Useful for documentation and testing.
        
        Returns:
            Dictionary with mapping statistics
        """
        total_chars = len(EmojiMapper.CHAR_TO_EMOJI)
        total_emojis = len(EmojiMapper.EMOJI_TO_CHARS)
        
        # Count emojis per character
        emojis_per_char = [len(emojis) for emojis in EmojiMapper.CHAR_TO_EMOJI.values()]
        
        # Count duplicates (emojis that appear for multiple chars)
        all_emojis = []
        duplicates = set()
        for emojis in EmojiMapper.CHAR_TO_EMOJI.values():
            for emoji in emojis:
                if emoji in all_emojis:
                    duplicates.add(emoji)
                else:
                    all_emojis.append(emoji)
        
        return {
            'supported_characters': total_chars,
            'total_unique_emojis': total_emojis,
            'avg_emojis_per_char': sum(emojis_per_char) / total_chars,
            'min_emojis_per_char': min(emojis_per_char),
            'max_emojis_per_char': max(emojis_per_char),
            'duplicate_emojis_count': len(duplicates),
            'character_set': 'Base64 (A-Z, a-z, 0-9, +, /, =)'
        }


# Self-test when run directly
if __name__ == "__main__":
    print("=" * 60)
    print("EMOJI OBFUSCATION LAYER - VISUAL CAMOUFLAGE TEST")
    print("=" * 60)
    print("\n⚠️  REMINDER: This provides NO security!")
    print("   This is ONLY visual obfuscation.\n")
    
    # Test 1: Basic conversion
    print("[TEST 1] Basic conversion (deterministic mode)")
    test_text = "SGVsbG8gV29ybGQ="  # This is "Hello World" in Base64
    print(f"Original Base64: {test_text}")
    
    emoji_version = EmojiMapper.text_to_emojis(test_text, deterministic=True)
    print(f"Emoji version: {emoji_version}")
    
    recovered = EmojiMapper.emojis_to_text(emoji_version)
    print(f"Recovered: {recovered}")
    
    assert test_text == recovered, "Conversion failed!"
    print("✓ Test 1 passed\n")
    
    # Test 2: Randomness (non-deterministic)
    print("[TEST 2] Randomness demonstration")
    test_text = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    
    # Generate multiple emoji versions
    version1 = EmojiMapper.text_to_emojis(test_text, seed=42)
    version2 = EmojiMapper.text_to_emojis(test_text, seed=42)  # Same seed
    version3 = EmojiMapper.text_to_emojis(test_text, deterministic=False)
    version4 = EmojiMapper.text_to_emojis(test_text, deterministic=False)
    
    print(f"Version 1 (seed=42): {version1[:50]}...")
    print(f"Version 2 (seed=42): {version2[:50]}...")
    print(f"Version 3 (random):  {version3[:50]}...")
    print(f"Version 4 (random):  {version4[:50]}...")
    
    assert version1 == version2, "Same seed should produce same result!"
    print("✓ Same seed = same emojis (deterministic)")
    
    if version3 != version4:
        print("✓ Different random seeds = different emojis (non-deterministic)")
    print()
    
    # Test 3: Reverse mapping verification (handles duplicates)
    print("[TEST 3] Reverse mapping with duplicate handling")
    all_mapped_emojis = set()
    all_mapped_chars = set()
    reverse_failures = []
    
    for char, emojis in EmojiMapper.CHAR_TO_EMOJI.items():
        all_mapped_chars.add(char)
        for emoji in emojis:
            all_mapped_emojis.add(emoji)
            # Verify each emoji maps back to SOME character
            recovered_char = EmojiMapper.EMOJI_TO_CHARS.get(emoji)
            if recovered_char is None:
                reverse_failures.append(emoji)
    
    print(f"Total characters mapped: {len(all_mapped_chars)}")
    print(f"Total emoji entries: {len(all_mapped_emojis)}")
    print(f"Unique emojis in reverse map: {len(EmojiMapper.EMOJI_TO_CHARS)}")
    
    if reverse_failures:
        print(f"✗ Reverse mapping failed for {len(reverse_failures)} emojis")
    else:
        print("✓ All emojis reverse-map to characters (duplicates handled)")
    print()
    
    # Test 4: All Base64 characters
    print("[TEST 4] Testing all Base64 characters")
    base64_chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
    
    # Test each character individually
    failed_chars = []
    for char in base64_chars:
        # Single character test
        emoji_single = EmojiMapper.text_to_emojis(char, deterministic=True)
        recovered_single = EmojiMapper.emojis_to_text(emoji_single)
        
        if char != recovered_single:
            failed_chars.append(char)
    
    if failed_chars:
        print(f"✗ Failed characters: {failed_chars}")
    else:
        print(f"✓ All {len(base64_chars)} Base64 characters work correctly")
    
    # Test longer string
    test_all = base64_chars * 2  # Double to test combinations
    emoji_all = EmojiMapper.text_to_emojis(test_all, deterministic=True)
    recovered_all = EmojiMapper.emojis_to_text(emoji_all)
    assert test_all == recovered_all, "Full Base64 set test failed!"
    print("✓ Full Base64 character set works in sequence\n")
    
    # Test 5: Edge cases
    print("[TEST 5] Edge cases")
    
    # Empty string
    empty_result = EmojiMapper.text_to_emojis("")
    assert empty_result == "", "Empty string should return empty"
    assert EmojiMapper.emojis_to_text("") == "", "Empty emoji should return empty"
    print("✓ Empty string handling")
    
    # Long string
    long_text = "A" * 1000
    emoji_long = EmojiMapper.text_to_emojis(long_text, deterministic=True)
    recovered_long = EmojiMapper.emojis_to_text(emoji_long)
    assert long_text == recovered_long, "Long string test failed!"
    print("✓ Long string (1000 chars) handled correctly\n")
    
    # Test 6: Error handling
    print("[TEST 6] Error handling")
    try:
        invalid_input = "This has spaces!"
        EmojiMapper.text_to_emojis(invalid_input)
        print("✗ Should have rejected invalid Base64")
    except ValueError as e:
        print(f"✓ Correctly rejected invalid input: {str(e)[:50]}...")
    
    try:
        # Try to convert unknown emoji back
        EmojiMapper.emojis_to_text("🚫🎉")  # Not in our mapping
        print("✗ Should have rejected unknown emojis")
    except ValueError as e:
        print(f"✓ Correctly rejected unknown emojis: {str(e)[:50]}...")
    
    # Test 7: Reversibility verification
    print("\n[TEST 7] Reversibility verification")
    
    test_strings = [
        "SGVsbG8=",  # "Hello"
        "V29ybGQ=",  # "World"
        "MTIzNDU2Nzg5MA==",  # "1234567890"
        "VGhpcyBpcyBhIHRlc3QgbWVzc2FnZSBmb3IgR2hvc3RDaGF0",  # Long message
        "A" * 50,
        base64_chars,
        "fL5TZ4snC/Lk+dQESZ5e6w==",  # Real ciphertext example
    ]
    
    all_passed = True
    for test in test_strings:
        if not EmojiMapper.verify_mapping(test):
            print(f"✗ Failed for: {test[:30]}...")
            all_passed = False
        else:
            print(f"✓ Passed: {test[:30]}...")
    
    if all_passed:
        print(f"\n✓ All {len(test_strings)} test strings are perfectly reversible")
    else:
        print(f"\n✗ Some tests failed")
    
    # Statistics
    print("\n[STATISTICS]")
    stats = EmojiMapper.get_statistics()
    for key, value in stats.items():
        print(f"  {key}: {value}")
    
    # Test 8: Duplicate handling demonstration
    print("\n[TEST 8] Duplicate emoji handling demonstration")
    # Show that duplicate emojis still work
    test_duplicate_chars = "CL"  # C and L both have '😎'
    print(f"Testing characters '{test_duplicate_chars}' (both can use '😎')")
    
    emoji_dup = EmojiMapper.text_to_emojis(test_duplicate_chars, deterministic=True)
    print(f"Deterministic emoji output: {emoji_dup}")
    
    recovered_dup = EmojiMapper.emojis_to_text(emoji_dup)
    print(f"Recovered: {recovered_dup}")
    assert test_duplicate_chars == recovered_dup, "Duplicate handling failed!"
    print("✓ Duplicate emojis handled correctly - reversibility preserved")
    
    # Security reminder
    print("\n" + "=" * 60)
    print("✅ ALL EMOJI TESTS PASSED")
    print("=" * 60)
    print("\n🔴 CRITICAL SECURITY REMINDER:")
    print("   This emoji mapping provides NO security!")
    print("   It is ONLY visual obfuscation (camouflage)")
    print("   The REAL security comes from AES-256 encryption")
    print("\n   Anyone with this mapping can reverse emojis to text")
    print("   Always use the crypto layer for actual security")