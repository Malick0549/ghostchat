# Architecture

## Overview

GhostChat uses a modular architecture with clean separation of concerns:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   CLI Interface │    │   GhostChat Core │    │   JSON Package  │
│                 │    │                  │    │                 │
│ • User input    │───▶│ • Orchestration  │───▶│ • Network       │
│ • Display       │    │ • Error handling │    │ • Persistence   │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
┌─────────────────┐    ┌──────────────────┐
│   AES-256       │    │   Emoji Mapper   │
│   Encryption    │    │   Obfuscation    │
│                 │    │                  │
│ • Real security │    │ • Visual only    │
│ • Confidentiality│    │ • Reversible     │
│ • Integrity      │    │ • Camouflage     │
└─────────────────┘    └──────────────────┘
```

## Components

### Core (ghostchat.py)

The `GhostChat` class orchestrates the entire pipeline:

- **send()**: plaintext → encrypt → obfuscate → emoji message
- **receive()**: emoji message → deobfuscate → decrypt → plaintext
- **Error handling**: Catches and handles all exceptions
- **Validation**: Input validation and sanitization

### Crypto Layer (crypto/)

- **AES256Engine**: Pure encryption/decryption
- **KeyManager**: Secure key derivation from passwords
- **Security**: AES-256-CBC, PBKDF2, random IV/salt

### Obfuscation Layer (obfuscation/)

- **EmojiMapper**: Base64 ↔ emoji conversion
- **AIObfuscator**: Advanced text camouflage (future)
- **Purpose**: Visual obfuscation only (no security)

### Interface Layer (interface/)

- **CLI**: Command-line user interface
- **Features**: Interactive menus, file I/O, validation

### Tests (tests/)

- **test_crypto.py**: AES engine and pipeline tests
- **test_emoji.py**: Emoji mapper tests
- **Coverage**: Security properties, edge cases, integration

## Data Flow

### Send Message

1. User inputs plaintext message
2. AES encryption: plaintext → ciphertext + IV + salt
3. Base64 encoding for transport
4. Emoji obfuscation: Base64 → emojis
5. JSON packaging with metadata
6. Output emoji message for sharing

### Receive Message

1. User provides emoji message + metadata
2. Emoji deobfuscation: emojis → Base64
3. AES decryption: ciphertext + IV → plaintext
4. Validation and error handling
5. Output decrypted message

## Security Model

- **Encryption**: AES-256 provides confidentiality
- **Key derivation**: PBKDF2 prevents brute force
- **IV randomness**: Prevents pattern attacks
- **Salt uniqueness**: Prevents rainbow table attacks
- **Integrity**: PKCS7 padding validation
- **Authentication**: Wrong password detection

## Error Handling

- **Invalid input**: Clear error messages
- **Wrong password**: Secure failure (no info leak)
- **Corrupted data**: Integrity checks
- **Empty input**: Graceful handling
- **Unicode support**: Full UTF-8 compatibility