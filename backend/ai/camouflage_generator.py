# ai/camouflage_generator.py
"""
AI Camouflage Layer for GhostChat
PURE VISUAL CAMOUFLAGE - NOT SECURITY

This module generates innocent-looking sentences to hide the fact
that encrypted communication is occurring.

IMPORTANT:
- AI is NOT used for encryption
- AES-256 remains the REAL security layer
- This only provides deniable plausibility
- The camouflage is separate from the encrypted message

HOW IT WORKS:
1. Encrypted message (already secured by AES-256)
2. Wrapped in innocent-looking AI-generated text
3. Observer sees harmless conversation
4. Receiver extracts and decrypts the real message

SECURITY NOTE:
- This provides NO cryptographic security
- This is ONLY social camouflage/deniability
- The real security is still AES-256
"""

import random
from typing import List, Dict, Tuple, Optional


class CamouflageGenerator:
    """
    Generates innocent-looking text to hide encrypted messages.
    
    The encrypted message is embedded within or appended to
    innocent-looking sentences. This provides deniability.
    """
    
    # ============================================================
    # Innocent conversation starters
    # ============================================================
    
    GREETINGS = [
        "Hey, how's your day going?",
        "Just checking in!",
        "Hope you're doing well.",
        "Quick update:",
        "By the way,",
        "Thought you should know:",
        "FYI:",
        "Just a heads up:",
        "Random thought:",
        "Not important but:",
    ]
    
    WEATHER_TOPICS = [
        "The weather is nice today.",
        "Looks like rain later.",
        "It's getting cold outside.",
        "Beautiful sunset this evening.",
        "Can't believe how hot it is.",
        "The morning fog was thick.",
        "Perfect weather for a walk.",
    ]
    
    DAILY_LIFE = [
        "Just had lunch.",
        "Been busy with work.",
        "Finally finished that task.",
        "Need coffee right now.",
        "Looking forward to the weekend.",
        "Can't focus today.",
        "Too many meetings.",
    ]
    
    FOOD_PHRASES = [
        "Had a great breakfast.",
        "I'm craving pizza.",
        "This coffee is amazing.",
        "What's for dinner?",
        "Made some pasta today.",
        "The food here is great.",
    ]
    
    CASUAL_PHRASES = [
        "Nothing much here.",
        "Just another day.",
        "Same old, same old.",
        "Taking it easy.",
        "Keeping busy.",
        "All good here.",
        "Everything is fine.",
    ]
    
    PLACEHOLDERS = [
        "As they say,",
        "You know how it is,",
        "Anyway,",
        "Moving on,",
        "That reminds me,",
        "Speaking of which,",
        "Come to think of it,",
    ]
    
    EMOJI_CLUELESS = [
        "😊",
        "👍",
        "🙂",
        "😅",
        "🤷",
        "😎",
        "👌",
    ]
    
    # ============================================================
    # Innocent message templates
    # ============================================================
    
    TEMPLATES = [
        "{greeting} {casual} By the way, {message}",
        "{greeting} {weather} {message}",
        "{placeholder} {daily} {message}",
        "{food} {casual} {message}",
        "{greeting} {message} Anyway, {daily}",
        "{placeholder} {weather} {message}",
        "{casual} {message} Just saying.",
        "{greeting} {message} Hope that makes sense.",
        "{daily} {message} Talk to you later.",
        "{weather} {message} Just thought I'd share.",
    ]

    HIDDEN_START = "\u2063"
    HIDDEN_END = "\u2064"
    
    @classmethod
    def generate_camouflage(cls, encrypted_msg: str, style: str = "casual") -> str:
        """
        Wrap an encrypted message in innocent-looking camouflage text.
        
        Args:
            encrypted_msg: The encrypted message (Base64 or emojis)
            style: Style of camouflage ('casual', 'weather', 'daily', 'mixed')
            
        Returns:
            Innocent-looking text containing the hidden message
        """
        if not encrypted_msg:
            return ""
        
        # Select components based on style
        if style == "weather":
            templates = [cls.TEMPLATES[1], cls.TEMPLATES[6]]
            components = {
                'greeting': random.choice(cls.GREETINGS),
                'weather': random.choice(cls.WEATHER_TOPICS),
                'casual': random.choice(cls.CASUAL_PHRASES),
                'daily': random.choice(cls.DAILY_LIFE),
                'food': random.choice(cls.FOOD_PHRASES),
                'placeholder': random.choice(cls.PLACEHOLDERS),
            }
        elif style == "daily":
            templates = [cls.TEMPLATES[2], cls.TEMPLATES[4], cls.TEMPLATES[8]]
            components = {
                'greeting': random.choice(cls.GREETINGS),
                'weather': random.choice(cls.WEATHER_TOPICS),
                'casual': random.choice(cls.CASUAL_PHRASES),
                'daily': random.choice(cls.DAILY_LIFE),
                'food': random.choice(cls.FOOD_PHRASES),
                'placeholder': random.choice(cls.PLACEHOLDERS),
            }
        else:  # casual or mixed
            templates = cls.TEMPLATES
            components = {
                'greeting': random.choice(cls.GREETINGS),
                'weather': random.choice(cls.WEATHER_TOPICS),
                'casual': random.choice(cls.CASUAL_PHRASES),
                'daily': random.choice(cls.DAILY_LIFE),
                'food': random.choice(cls.FOOD_PHRASES),
                'placeholder': random.choice(cls.PLACEHOLDERS),
            }
        
        # Choose a random template
        template = random.choice(templates)
        
        # Embed the hidden payload using invisible markers so output stays innocent-looking.
        hidden_payload = f"{cls.HIDDEN_START}{encrypted_msg}{cls.HIDDEN_END}"
        result = template.format(message=hidden_payload, **components)
        
        # Add random emoji sometimes
        if random.random() < 0.3:
            result += " " + random.choice(cls.EMOJI_CLUELESS)
        
        return result
    
    @classmethod
    def extract_message(cls, camouflaged_text: str) -> str:
        """
        Extract the hidden message from camouflaged text.
        
        Note: This is simple stub extraction. In practice, the
        receiver would know where the message is embedded.
        
        Args:
            camouflaged_text: Text containing hidden message
            
        Returns:
            Extracted message (original encrypted content)
        """
        # This is a simplified extractor.
        # In a real implementation, the sender and receiver would
        # have a pre-agreed method (e.g., message after a marker).
        
        # For now, we assume the encrypted message is the last
        # part after the last space or punctuation.
        
        # Simple heuristic: look for Base64 pattern or emoji pattern
        import re
        
        # Try to extract the payload from invisible hidden markers first.
        marker_pattern = re.escape(cls.HIDDEN_START) + r'(.+?)' + re.escape(cls.HIDDEN_END)
        marker_match = re.search(marker_pattern, camouflaged_text)
        if marker_match:
            return marker_match.group(1)

        # Try to find Base64 pattern (A-Za-z0-9+/=)
        base64_pattern = r'[A-Za-z0-9+/=]{20,}'
        match = re.search(base64_pattern, camouflaged_text)
        if match:
            return match.group(0)
        
        # Try to find emoji sequence (for emoji obfuscation)
        emoji_pattern = (
            r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF'
            r'\U0001F900-\U0001F9FF\U0001FA70-\U0001FAFF\u2600-\u26FF\u2700-\u27BF\uFE0F\u20E3]'
            r'{5,}'
        )
        match = re.search(emoji_pattern, camouflaged_text)
        if match:
            return match.group(0)
        
        # Fallback: return last word/sentence
        words = camouflaged_text.split()
        # Assume last word/sentence is the message
        last_part = words[-1] if words else camouflaged_text
        return last_part

    def generate(self, encrypted_msg: str, style: str = "casual") -> str:
        """Alias for API compatibility with existing route expectations."""
        return self.generate_camouflage(encrypted_msg, style)

    def extract(self, camouflaged_text: str) -> str:
        """Alias for API compatibility with existing route expectations."""
        return self.extract_message(camouflaged_text)


class CasualCamouflage:
    """
    Simple casual conversation camouflage.
    Generates text that looks like normal chat.
    """
    
    # Innocent chat phrases
    OPENERS = [
        "Hey", "Hi", "Hello", "Sup", "Yo", "Hey there",
        "What's up", "How's it going", "Just saying",
    ]
    
    FILLERS = [
        "I was thinking", "just wanted to say", "random thought",
        "by the way", "quick note", "just so you know",
        "for what it's worth", "not sure if you care but",
    ]
    
    CLOSERS = [
        "just saying", "thought you should know", "that's all",
        "anyway", "just fyi", "just a heads up",
    ]
    
    @classmethod
    def wrap(cls, message: str) -> str:
        """Wrap a message in casual conversation"""
        if not message:
            return ""
        
        opener = random.choice(cls.OPENERS)
        filler = random.choice(cls.FILLERS)
        closer = random.choice(cls.CLOSERS) if random.random() < 0.5 else ""
        
        result = f"{opener}, {filler}: {message}"
        if closer:
            result += f" {closer}"
        
        return result
    
    @classmethod
    def unwrap(cls, text: str) -> str:
        """Extract the original message"""
        # Remove common prefixes and suffixes
        for prefix in cls.OPENERS:
            if text.startswith(prefix + ","):
                text = text[len(prefix) + 1:]
                break
        
        for suffix in cls.CLOSERS:
            if text.endswith(suffix):
                text = text[:-len(suffix)]
                break
        
        # Find the message after colon
        if ":" in text:
            parts = text.split(":", 1)
            if len(parts) > 1:
                text = parts[1].strip()
        
        return text.strip()


class WeatherCamouflage:
    """
    Weather-themed camouflage.
    Messages hidden in weather-related chat.
    """
    
    PHRASES = [
        "The weather is nice today.",
        "Looks like it might rain.",
        "It's getting colder.",
        "Beautiful sunset.",
        "Cloudy with a chance of",
        "Temperatures are dropping.",
        "Checking the forecast:",
    ]
    
    @classmethod
    def wrap(cls, message: str) -> str:
        """Wrap message in weather chat"""
        phrase = random.choice(cls.PHRASES)
        return f"{phrase} {message}"
    
    @classmethod
    def unwrap(cls, text: str) -> str:
        """Extract message from weather chat"""
        for phrase in cls.PHRASES:
            if text.startswith(phrase):
                return text[len(phrase):].strip()
        return text


# ============================================================
# AI Style Generator (Simulated AI)
# ============================================================

class AICamouflage:
    """
    Simulated AI-powered camouflage generation.
    
    In a real implementation, this would call an actual AI API
    (like OpenAI, Hugging Face, or local LLM) to generate
    contextually appropriate camouflage.
    
    For demo purposes, we use templates that mimic AI output.
    """
    
    # Context-specific templates
    CONTEXT_TEMPLATES = {
        "work": [
            "Just finished {task}. Anyway, {message}",
            "Meeting at {time}. By the way, {message}",
            "The report is ready. {message}",
        ],
        "social": [
            "How's everything? {message}",
            "Long time no see! {message}",
            "Thinking of you. {message}",
        ],
        "neutral": [
            "Not much new here. {message}",
            "Everything's fine. {message}",
            "Just another day. {message}",
        ],
    }
    
    TASKS = [
        "that email", "the presentation", "the coding", "my coffee",
        "cleaning up", "organizing", "that report", "my work"
    ]
    
    TIMES = [
        "9 AM", "noon", "3 PM", "5 PM", "later", "tomorrow"
    ]
    
    @classmethod
    def generate(cls, message: str, context: str = "neutral") -> str:
        """
        Generate AI-style camouflage text.
        
        Args:
            message: The message to hide
            context: 'work', 'social', or 'neutral'
            
        Returns:
            Camouflaged text
        """
        if context not in cls.CONTEXT_TEMPLATES:
            context = "neutral"
        
        template = random.choice(cls.CONTEXT_TEMPLATES[context])
        
        # Fill template
        result = template.format(
            message=message,
            task=random.choice(cls.TASKS),
            time=random.choice(cls.TIMES)
        )
        
        return result
    
    @classmethod
    def extract(cls, text: str) -> str:
        """Extract message from AI-style text"""
        # Look for message after the last sentence or colon
        if ":" in text:
            return text.split(":", 1)[1].strip()
        
        # Simple extraction - return the last part
        parts = text.split(". ")
        if len(parts) > 1:
            return parts[-1].strip()
        
        return text.strip()

    @classmethod
    def wrap(cls, message: str) -> str:
        """Alias for generate() to match camouflage interface."""
        return cls.generate(message)

    @classmethod
    def unwrap(cls, text: str) -> str:
        """Alias for extract() to match camouflage interface."""
        return cls.extract(text)


# ============================================================
# Main Interface
# ============================================================

class CamouflageLayer:
    """
    Main interface for AI camouflage.
    
    This is the entry point for using camouflage features.
    It selects the appropriate camouflage strategy.
    """
    
    STRATEGIES = {
        "casual": CasualCamouflage,
        "weather": WeatherCamouflage,
        "ai": AICamouflage,
        "mixed": None,  # Will use CamouflageGenerator
    }
    
    @classmethod
    def hide(cls, encrypted_message: str, strategy: str = "mixed") -> str:
        """
        Hide an encrypted message in innocent-looking text.
        
        Args:
            encrypted_message: The encrypted message (Base64 or emojis)
            strategy: 'casual', 'weather', 'ai', or 'mixed'
            
        Returns:
            Camouflaged text ready for sending
        """
        if not encrypted_message:
            return ""
        
        if strategy == "mixed":
            return CamouflageGenerator.generate_camouflage(encrypted_message)
        elif strategy in cls.STRATEGIES and cls.STRATEGIES[strategy]:
            return cls.STRATEGIES[strategy].wrap(encrypted_message)
        else:
            return encrypted_message
    
    @classmethod
    def reveal(cls, camouflaged_text: str, strategy: str = "mixed") -> str:
        """
        Extract the hidden message from camouflaged text.
        
        Args:
            camouflaged_text: Text containing hidden message
            strategy: The strategy used to hide the message
            
        Returns:
            The extracted encrypted message
        """
        if not camouflaged_text:
            return ""
        
        if strategy == "mixed":
            return CamouflageGenerator.extract_message(camouflaged_text)
        elif strategy in cls.STRATEGIES and cls.STRATEGIES[strategy]:
            return cls.STRATEGIES[strategy].unwrap(camouflaged_text)
        else:
            return camouflaged_text


# ============================================================
# Demo and Test
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("AI CAMOUFLAGE LAYER - DEMO")
    print("=" * 60)
    print("\n⚠️  IMPORTANT: This is ONLY visual camouflage!")
    print("   The REAL security comes from AES-256 encryption.\n")
    
    # Example encrypted message (simulated)
    encrypted = "8fj3k2l9s8df7q2w3e4r5t6y7u8i9o0p"
    
    print("Original encrypted message:")
    print(f"  {encrypted}\n")
    
    print("=" * 50)
    print("CAMOUFLAGE EXAMPLES")
    print("=" * 50)
    
    # Test each strategy
    strategies = ["casual", "weather", "ai", "mixed"]
    
    for strategy in strategies:
        print(f"\n[{strategy.upper()} STRATEGY]")
        
        # Hide the message
        camouflaged = CamouflageLayer.hide(encrypted, strategy=strategy)
        print(f"  Sent: {camouflaged[:80]}...")
        
        # Reveal the message
        revealed = CamouflageLayer.reveal(camouflaged, strategy=strategy)
        print(f"  Extracted: {revealed}")
        
        # Verify
        if revealed == encrypted:
            print("  ✓ Successfully extracted!")
    
    print("\n" + "=" * 60)
    print("✅ DEMO COMPLETE")
    print("=" * 60)
    print("\n🔴 REMINDER: This provides NO cryptographic security!")
    print("   It ONLY provides deniability and visual camouflage.")
    print("   The REAL security is still AES-256 encryption.")