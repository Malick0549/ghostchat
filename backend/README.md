# GhostChat

Secure messaging system with AES-256 encryption and emoji obfuscation.

## Features

- **Military-grade encryption**: AES-256-CBC with PBKDF2 key derivation
- **Visual camouflage**: Emoji-based obfuscation for social media
- **Modular architecture**: Clean separation of crypto and obfuscation layers
- **Cross-platform**: Works on Windows, macOS, and Linux

## Installation

```bash
pip install -r requirements.txt
```

## Usage

### Command Line Interface

```bash
# Interactive mode
python interface/cli.py

# Send a message
python interface/cli.py --send

# Receive a message
python interface/cli.py --receive

# Run demo
python interface/cli.py --demo
```

### Python API

```python
from ghostchat import GhostChat

# Create instance
gc = GhostChat("your_password")

# Send message
result = gc.send("Secret message")
print(result['emoji_message'])

# Receive message
decrypted = gc.receive(result['emoji_message'], result['metadata'])
print(decrypted)
```

## Architecture

- `crypto/`: AES-256 encryption engine
- `obfuscation/`: Emoji mapping for visual camouflage
- `interface/`: CLI for user interaction
- `tests/`: Unit tests for all components

## Security

- AES-256 encryption with random IV
- PBKDF2 key derivation (100,000 iterations)
- No backdoors or weak algorithms
- Emoji layer provides NO security (visual only)