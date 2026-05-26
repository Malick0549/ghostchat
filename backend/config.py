# config.py
"""
GhostChat Centralized Configuration System
Single source of truth for all application settings

DESIGN PRINCIPLES:
- All settings in one place
- Environment variable override support
- Type validation
- Default values for all settings
- Modular sections for different components
"""

import os
from dataclasses import dataclass, field
from typing import Optional, Dict, Any
from pathlib import Path


@dataclass
class AESConfig:
    """AES-256 Encryption Configuration"""
    
    # Key size in bytes (32 bytes = 256 bits)
    key_size: int = 32
    
    # Block size for AES (16 bytes = 128 bits)
    block_size: int = 16
    
    # Initialization Vector size
    iv_size: int = 16
    
    # Salt size for key derivation
    salt_size: int = 32
    
    # PBKDF2 iterations (higher = more secure but slower)
    pbkdf2_iterations: int = 100000
    
    # Padding scheme
    padding_scheme: str = "PKCS7"
    
    # Cipher mode
    cipher_mode: str = "CBC"
    
    def validate(self) -> bool:
        """Validate AES configuration values"""
        if self.key_size not in [16, 24, 32]:
            raise ValueError(f"Invalid key_size: {self.key_size}. Must be 16, 24, or 32")
        if self.block_size != 16:
            raise ValueError(f"Invalid block_size: {self.block_size}. Must be 16")
        if self.pbkdf2_iterations < 10000:
            raise ValueError(f"PBKDF2 iterations too low: {self.pbkdf2_iterations}")
        return True


@dataclass
class SessionConfig:
    """Session Key Management Configuration"""
    
    # Session duration in seconds (default: 1 hour)
    duration_seconds: int = 3600
    
    # Maximum messages per session key
    max_messages_per_key: int = 1000
    
    # Enable automatic key rotation
    auto_rotation: bool = True
    
    # Rotation threshold (percentage of max messages)
    rotation_threshold: float = 0.8
    
    # Session timeout (seconds of inactivity)
    inactivity_timeout: int = 1800  # 30 minutes
    
    def validate(self) -> bool:
        """Validate session configuration"""
        if self.duration_seconds < 60:
            raise ValueError(f"Session duration too short: {self.duration_seconds}")
        if self.max_messages_per_key < 1:
            raise ValueError(f"Invalid max_messages: {self.max_messages_per_key}")
        if not 0 < self.rotation_threshold <= 1:
            raise ValueError(f"Invalid rotation_threshold: {self.rotation_threshold}")
        return True


@dataclass
class EmojiConfig:
    """Emoji Obfuscation Configuration"""
    
    # Deterministic mode for testing
    deterministic_by_default: bool = False
    
    # Maximum emoji length before truncation in display
    max_display_length: int = 100
    
    # Character set supported (Base64)
    supported_charset: str = "base64"
    
    # Duplicate handling strategy: 'first', 'position', 'context'
    duplicate_handling: str = "position"
    
    # Enable random seed for reproducible randomness
    random_seed_enabled: bool = False
    
    def validate(self) -> bool:
        """Validate emoji configuration"""
        valid_strategies = ['first', 'position', 'context']
        if self.duplicate_handling not in valid_strategies:
            raise ValueError(f"Invalid duplicate_handling: {self.duplicate_handling}")
        return True


@dataclass
class LoggingConfig:
    """Secure Logging Configuration"""
    
    # Log directory path
    log_dir: str = "logs"
    
    # Log file name
    log_file: str = "ghostchat.log"
    
    # Maximum log file size in bytes (10 MB default)
    max_log_size_bytes: int = 10 * 1024 * 1024
    
    # Number of backup log files to keep
    backup_count: int = 5
    
    # Log level: DEBUG, INFO, WARNING, ERROR, CRITICAL
    log_level: str = "INFO"
    
    # Log format
    log_format: str = "%(asctime)s | %(levelname)-8s | %(message)s"
    
    # Date format
    date_format: str = "%Y-%m-%d %H:%M:%S"
    
    # Log to console in addition to file
    console_logging: bool = False
    
    # Mask sensitive data in logs
    mask_sensitive_data: bool = True
    
    # Sensitive patterns to mask
    sensitive_patterns: list = field(default_factory=lambda: [
        r'password=\S+',
        r'key[\s]*=[\s]*\S+',
    ])
    
    def validate(self) -> bool:
        """Validate logging configuration"""
        valid_levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']
        if self.log_level not in valid_levels:
            raise ValueError(f"Invalid log_level: {self.log_level}")
        if self.max_log_size_bytes < 1024:
            raise ValueError(f"max_log_size_bytes too small: {self.max_log_size_bytes}")
        return True


@dataclass
class AIConfig:
    """AI Features Configuration (Future Enhancement)"""
    
    # Enable AI features
    enabled: bool = False
    
    # AI model to use (future)
    model: str = "none"
    
    # Sentiment analysis enabled
    sentiment_analysis: bool = False
    
    # Anomaly detection enabled
    anomaly_detection: bool = False
    
    # Pattern analysis enabled
    pattern_analysis: bool = False
    
    # Confidence threshold for AI predictions
    confidence_threshold: float = 0.7
    
    # API endpoint for AI service (future)
    api_endpoint: Optional[str] = None
    
    # API key (will be loaded from environment)
    api_key: Optional[str] = None
    
    def validate(self) -> bool:
        """Validate AI configuration"""
        if self.enabled and self.confidence_threshold <= 0:
            raise ValueError(f"Invalid confidence_threshold: {self.confidence_threshold}")
        return True


@dataclass
class StorageConfig:
    """Message Storage Configuration"""
    
    # Storage directory for encrypted messages
    storage_dir: str = "messages"
    
    # Storage format: 'json' or 'encrypted'
    storage_format: str = "json"
    
    # Maximum messages to keep in storage
    max_messages: int = 1000
    
    # Auto-cleanup old messages
    auto_cleanup: bool = False
    
    # Cleanup age in days
    cleanup_age_days: int = 30
    
    def validate(self) -> bool:
        """Validate storage configuration"""
        valid_formats = ['json', 'encrypted']
        if self.storage_format not in valid_formats:
            raise ValueError(f"Invalid storage_format: {self.storage_format}")
        return True


@dataclass
class UIConfig:
    """User Interface Configuration"""
    
    # Menu width in characters
    menu_width: int = 60
    
    # Separator character
    separator_char: str = "─"
    
    # Enable colored output
    enable_colors: bool = True
    
    # Enable emoji display
    enable_emoji: bool = True
    
    # Max message length for input
    max_message_length: int = 10000
    
    # Input timeout in seconds (0 = no timeout)
    input_timeout: int = 0
    
    def validate(self) -> bool:
        """Validate UI configuration"""
        if self.menu_width < 20:
            raise ValueError(f"menu_width too small: {self.menu_width}")
        return True


@dataclass
class GhostChatConfig:
    """
    Master Configuration for GhostChat
    
    Combines all subsystem configurations into one.
    Supports loading from file and environment variables.
    """
    
    # Version
    version: str = "2.0.0"
    
    # Application name
    app_name: str = "GhostChat"
    
    # Subsystem configurations
    aes: AESConfig = field(default_factory=AESConfig)
    session: SessionConfig = field(default_factory=SessionConfig)
    emoji: EmojiConfig = field(default_factory=EmojiConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    ai: AIConfig = field(default_factory=AIConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    ui: UIConfig = field(default_factory=UIConfig)
    
    # Development mode (enables debug features)
    debug: bool = False
    
    # Production mode (enables security hardening)
    production: bool = True
    
    def __post_init__(self):
        """Post-initialization: create necessary directories"""
        # Create directories
        for dir_path in [self.logging.log_dir, self.storage.storage_dir]:
            Path(dir_path).mkdir(exist_ok=True)
    
    @classmethod
    def from_env(cls) -> 'GhostChatConfig':
        """
        Load configuration from environment variables.
        
        Environment variables override defaults:
        - GHOSTCHAT_DEBUG=1
        - GHOSTCHAT_PRODUCTION=0
        - GHOSTCHAT_SESSION_DURATION=7200
        - GHOSTCHAT_LOG_LEVEL=DEBUG
        - etc.
        """
        config = cls()
        
        # Override from environment
        if os.getenv('GHOSTCHAT_DEBUG') == '1':
            config.debug = True
        if os.getenv('GHOSTCHAT_PRODUCTION') == '0':
            config.production = False
        if os.getenv('GHOSTCHAT_SESSION_DURATION'):
            config.session.duration_seconds = int(os.getenv('GHOSTCHAT_SESSION_DURATION'))
        if os.getenv('GHOSTCHAT_LOG_LEVEL'):
            config.logging.log_level = os.getenv('GHOSTCHAT_LOG_LEVEL')
        if os.getenv('GHOSTCHAT_MAX_MESSAGE_LENGTH'):
            config.ui.max_message_length = int(os.getenv('GHOSTCHAT_MAX_MESSAGE_LENGTH'))
        
        return config
    
    @classmethod
    def from_file(cls, filepath: str) -> 'GhostChatConfig':
        """
        Load configuration from JSON file.
        
        Args:
            filepath: Path to JSON configuration file
        """
        import json
        config = cls()
        
        if Path(filepath).exists():
            with open(filepath, 'r') as f:
                data = json.load(f)
            
            # Apply loaded configuration
            for key, value in data.items():
                if hasattr(config, key):
                    setattr(config, key, value)
        
        return config
    
    def save_to_file(self, filepath: str):
        """
        Save current configuration to JSON file.
        
        Args:
            filepath: Path to save configuration
        """
        import json
        from dataclasses import asdict
        
        with open(filepath, 'w') as f:
            json.dump(asdict(self), f, indent=2, default=str)
    
    def validate_all(self) -> bool:
        """Validate all subsystem configurations"""
        valid = True
        valid &= self.aes.validate()
        valid &= self.session.validate()
        valid &= self.emoji.validate()
        valid &= self.logging.validate()
        valid &= self.ai.validate()
        valid &= self.storage.validate()
        valid &= self.ui.validate()
        return valid
    
    def get_security_summary(self) -> Dict[str, Any]:
        """
        Get security-relevant configuration summary.
        
        Returns:
            Dictionary with security settings
        """
        return {
            'encryption': {
                'algorithm': f"AES-{self.aes.key_size * 8}-{self.aes.cipher_mode}",
                'key_derivation': f"PBKDF2 ({self.aes.pbkdf2_iterations} iterations)",
                'padding': self.aes.padding_scheme,
            },
            'session': {
                'duration_seconds': self.session.duration_seconds,
                'auto_rotation': self.session.auto_rotation,
                'max_messages_per_key': self.session.max_messages_per_key,
            },
            'logging': {
                'enabled': True,
                'level': self.logging.log_level,
                'mask_sensitive': self.logging.mask_sensitive_data,
            },
            'production_mode': self.production,
        }


# ============================================================
# Singleton Instance
# ============================================================

# Create default configuration
_default_config = None


def get_config() -> GhostChatConfig:
    """Get the singleton configuration instance"""
    global _default_config
    if _default_config is None:
        # Try to load from file first
        config_file = Path(".ghostchat_config.json")
        if config_file.exists():
            _default_config = GhostChatConfig.from_file(config_file)
        else:
            _default_config = GhostChatConfig.from_env()
        
        # Validate configuration
        _default_config.validate_all()
    
    return _default_config


# Export a ready-to-use singleton instance for easy imports
config = get_config()


def reload_config():
    """Reload configuration from file/environment"""
    global _default_config, config
    _default_config = None
    config = get_config()
    return config


# ============================================================
# Test and Example
# ============================================================

if __name__ == "__main__":
    print("=" * 60)
    print("GHOSTCHAT CONFIGURATION SYSTEM")
    print("=" * 60)
    
    # Get configuration
    config = get_config()
    
    print("\n📋 Current Configuration:")
    print(f"  Version: {config.version}")
    print(f"  Debug Mode: {config.debug}")
    print(f"  Production Mode: {config.production}")
    
    print("\n🔒 AES Configuration:")
    print(f"  Key Size: {config.aes.key_size * 8} bits")
    print(f"  PBKDF2 Iterations: {config.aes.pbkdf2_iterations:,}")
    
    print("\n🔑 Session Configuration:")
    print(f"  Duration: {config.session.duration_seconds} seconds")
    print(f"  Auto Rotation: {config.session.auto_rotation}")
    
    print("\n📝 Logging Configuration:")
    print(f"  Log Level: {config.logging.log_level}")
    print(f"  Log Directory: {config.logging.log_dir}")
    
    print("\n🔮 AI Configuration (Future):")
    print(f"  Enabled: {config.ai.enabled}")
    
    print("\n📊 Security Summary:")
    security = config.get_security_summary()
    for category, settings in security.items():
        if isinstance(settings, dict):
            print(f"  {category}:")
            for key, value in settings.items():
                print(f"    {key}: {value}")
        else:
            print(f"  {category}: {settings}")
    
    # Save example config
    print("\n💾 Saving example configuration to example_config.json")
    config.save_to_file("example_config.json")
    print("  ✅ Saved!")
    
    print("\n" + "=" * 60)
    print("✅ CONFIGURATION SYSTEM READY")
    print("=" * 60)