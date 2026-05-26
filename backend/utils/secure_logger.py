# utils/secure_logger.py
"""
Secure Logging for GhostChat
Audit trail for security events without exposing sensitive data

SECURITY PRINCIPLES:
- Never log plaintext messages
- Never log passwords or keys
- Log event types, timestamps, and metadata only
- Rotate logs to prevent disk filling
- Separate log levels for different event types
"""

import logging
import logging.handlers
import os
from datetime import datetime
from pathlib import Path
from typing import Optional
# At the top of utils/secure_logger.py
from config import get_config

config = get_config()

class SecureLogger:
    # Use config values
    LOG_DIR = config.logging.log_dir
    LOG_FILE = config.logging.log_file
    MAX_LOG_SIZE = config.logging.max_log_size_bytes
    BACKUP_COUNT = config.logging.backup_count


    """
    Secure audit logger for GhostChat.
    
    Logs security events without exposing sensitive information:
    - Encryption events (timestamp, message length, success/failure)
    - Decryption events (timestamp, success/failure, reason)
    - Authentication events (timestamp, success/failure, reason)
    - Error events (type, context, but no sensitive data)
    """
    
    # Log file configuration
    LOG_DIR = "logs"
    LOG_FILE = "ghostchat.log"
    MAX_LOG_SIZE = 10 * 1024 * 1024  # 10 MB
    BACKUP_COUNT = 5
    
    # Event types for consistent logging
    class EventType:
        ENCRYPTION = "ENCRYPTION"
        DECRYPTION = "DECRYPTION"
        AUTHENTICATION = "AUTHENTICATION"
        KEY_ROTATION = "KEY_ROTATION"
        EMOJI_ERROR = "EMOJI_ERROR"
        SYSTEM = "SYSTEM"
        SECURITY = "SECURITY"
    
    # Severity levels
    class Severity:
        INFO = "INFO"
        WARNING = "WARNING"
        ERROR = "ERROR"
        CRITICAL = "CRITICAL"
    
    _instance = None
    
    def __new__(cls):
        """Singleton pattern to ensure single logger instance"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._setup_logger()
        return cls._instance
    
    def _setup_logger(self):
        """Setup the secure logger with rotation"""
        # Create logs directory if it doesn't exist
        log_path = Path(self.LOG_DIR)
        log_path.mkdir(exist_ok=True)
        
        # Create logger
        self.logger = logging.getLogger("GhostChatSecure")
        self.logger.setLevel(logging.INFO)
        
        # Prevent duplicate handlers
        if self.logger.handlers:
            return
        
        # File handler with rotation
        file_handler = logging.handlers.RotatingFileHandler(
            filename=log_path / self.LOG_FILE,
            maxBytes=self.MAX_LOG_SIZE,
            backupCount=self.BACKUP_COUNT,
            encoding='utf-8'
        )
        
        # Console handler for critical events (optional)
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.WARNING)
        
        # Formatter - includes timestamp and event type
        formatter = logging.Formatter(
            '%(asctime)s | %(levelname)-8s | %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        
        file_handler.setFormatter(formatter)
        console_handler.setFormatter(formatter)
        
        self.logger.addHandler(file_handler)
        self.logger.addHandler(console_handler)
    
    def _format_message(self, event_type: str, severity: str, details: str, user_id: Optional[str] = None) -> str:
        """Format log message consistently"""
        parts = [f"[{event_type}]", f"[{severity}]", details]
        if user_id:
            parts.insert(1, f"[USER:{user_id[:8]}]")
        return " ".join(parts)
    
    def log_encryption(self, message_length: int, success: bool, error: str = None, user_id: str = None):
        """
        Log an encryption event.
        
        Args:
            message_length: Length of plaintext (not the content)
            success: Whether encryption succeeded
            error: Error message if failed
            user_id: Optional user identifier
        """
        if success:
            details = f"Encrypted message of length {message_length}"
            severity = self.Severity.INFO
        else:
            details = f"Encryption failed: {error}"
            severity = self.Severity.ERROR
        
        self.logger.info(self._format_message(
            self.EventType.ENCRYPTION, severity, details, user_id
        ))
    
    def log_decryption(self, success: bool, error: str = None, user_id: str = None):
        """
        Log a decryption event.
        
        Args:
            success: Whether decryption succeeded
            error: Error message if failed
            user_id: Optional user identifier
        """
        if success:
            details = "Decryption successful"
            severity = self.Severity.INFO
        else:
            details = f"Decryption failed: {error}"
            severity = self.Severity.WARNING
        
        self.logger.info(self._format_message(
            self.EventType.DECRYPTION, severity, details, user_id
        ))
    
    def log_authentication(self, success: bool, reason: str = None, user_id: str = None):
        """
        Log an authentication event.
        
        Args:
            success: Whether authentication succeeded
            reason: Reason for failure (never includes password)
            user_id: Optional user identifier
        """
        if success:
            details = "Authentication successful"
            severity = self.Severity.INFO
        else:
            details = f"Authentication failed: {reason if reason else 'Invalid credentials'}"
            severity = self.Severity.WARNING
        
        self.logger.info(self._format_message(
            self.EventType.AUTHENTICATION, severity, details, user_id
        ))
    
    def log_key_rotation(self, old_key_id: str, new_key_id: str, success: bool, error: str = None):
        """
        Log a session key rotation event.
        
        Args:
            old_key_id: Previous key identifier (truncated)
            new_key_id: New key identifier (truncated)
            success: Whether rotation succeeded
            error: Error message if failed
        """
        if success:
            details = f"Key rotated: {old_key_id[:8]}... → {new_key_id[:8]}..."
            severity = self.Severity.INFO
        else:
            details = f"Key rotation failed: {error}"
            severity = self.Severity.ERROR
        
        self.logger.info(self._format_message(
            self.EventType.KEY_ROTATION, severity, details
        ))
    
    def log_emoji_error(self, error_type: str, position: int = None, user_id: str = None):
        """
        Log an emoji decoding error.
        
        Args:
            error_type: Type of error (invalid_emoji, invalid_input, etc.)
            position: Position where error occurred (if applicable)
            user_id: Optional user identifier
        """
        details = f"Emoji error: {error_type}"
        if position is not None:
            details += f" at position {position}"
        
        self.logger.warning(self._format_message(
            self.EventType.EMOJI_ERROR, self.Severity.WARNING, details, user_id
        ))
    
    def log_security_event(self, event: str, severity: str = Severity.WARNING, details: str = None):
        """
        Log a general security event.
        
        Args:
            event: Type of security event
            severity: Severity level
            details: Additional details (no sensitive data)
        """
        self.logger.log(
            logging.WARNING if severity == self.Severity.WARNING else logging.ERROR,
            self._format_message(self.EventType.SECURITY, severity, f"{event}: {details}" if details else event)
        )
    
    def log_system_event(self, event: str, severity: str = Severity.INFO, details: str = None):
        """
        Log a system event (startup, shutdown, configuration).
        
        Args:
            event: Type of system event
            severity: Severity level
            details: Additional details
        """
        self.logger.info(self._format_message(
            self.EventType.SYSTEM, severity, f"{event}: {details}" if details else event
        ))
    
    def get_log_file_path(self) -> Path:
        """Get the path to the log file"""
        return Path(self.LOG_DIR) / self.LOG_FILE
    
    def get_log_stats(self) -> dict:
        """
        Get statistics about the log file.
        
        Returns:
            Dictionary with log file statistics
        """
        log_path = self.get_log_file_path()
        
        if not log_path.exists():
            return {'exists': False, 'size_bytes': 0, 'lines': 0}
        
        with open(log_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        return {
            'exists': True,
            'size_bytes': log_path.stat().st_size,
            'lines': len(lines),
            'path': str(log_path)
        }
    
    def clear_logs(self):
        """Clear all log files (for testing/debugging only)"""
        log_path = Path(self.LOG_DIR)
        for log_file in log_path.glob("*.log*"):
            log_file.unlink()
        self.log_system_event("Logs cleared", self.Severity.WARNING)


# Singleton instance for easy import
secure_logger = SecureLogger()


def log_encryption(message_length: int, success: bool, error: str = None, user_id: str = None):
    """Convenience function for logging encryption events"""
    secure_logger.log_encryption(message_length, success, error, user_id)


def log_decryption(success: bool, error: str = None, user_id: str = None):
    """Convenience function for logging decryption events"""
    secure_logger.log_decryption(success, error, user_id)


def log_authentication(success: bool, reason: str = None, user_id: str = None):
    """Convenience function for logging authentication events"""
    secure_logger.log_authentication(success, reason, user_id)


def log_emoji_error(error_type: str, position: int = None, user_id: str = None):
    """Convenience function for logging emoji errors"""
    secure_logger.log_emoji_error(error_type, position, user_id)


# Test the logger
if __name__ == "__main__":
    print("Testing Secure Logger...")
    
    # Test various log events
    secure_logger.log_system_event("GhostChat started", secure_logger.Severity.INFO)
    secure_logger.log_authentication(True, user_id="test_user_123")
    secure_logger.log_encryption(42, True, user_id="test_user_123")
    secure_logger.log_decryption(True, user_id="test_user_123")
    secure_logger.log_emoji_error("invalid_emoji", position=15)
    secure_logger.log_authentication(False, reason="Invalid password", user_id="unknown")
    secure_logger.log_key_rotation("key_old_12345", "key_new_67890", True)
    
    print(f"Log file created at: {secure_logger.get_log_file_path()}")
    print("Log entries written. Check logs/ghostchat.log")
    
    stats = secure_logger.get_log_stats()
    print(f"Log stats: {stats}")