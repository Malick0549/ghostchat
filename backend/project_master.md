# GhostChat - Master Project Documentation

## PROJECT NAME
GhostChat

## PROJECT TYPE
Final Year Cybersecurity Project

## CORE IDEA
GhostChat is a secure messaging system that:
1. Encrypts messages using AES-256 encryption
2. Converts encrypted ciphertext into emoji-based obfuscation
3. Allows users to securely send disguised messages across social media platforms
4. Reverses the process for authorized receivers

---

# IMPORTANT SECURITY DESIGN

## REAL SECURITY LAYER
AES-256 Encryption

## CAMOUFLAGE LAYER
Emoji Obfuscation

IMPORTANT:
Emoji conversion is NOT encryption.
Encryption ALWAYS happens BEFORE emoji obfuscation.

Correct Workflow:
Plaintext → AES Encryption → Emoji Obfuscation

NOT:
Plaintext → Emoji Replacement

---

# CURRENT PROJECT STRUCTURE

GhostChat/
│
├── main.py
├── ghostchat.py
│
├── crypto/
│   └── aes_engine.py
│
├── obfuscation/
│   └── emoji_mapper.py
│
└── tests/

---

# CURRENT STATUS

## COMPLETED
- Project structure initialized
- AES module created
- Emoji mapper created

## CURRENT TASK
Integrate full encryption → emoji → decryption pipeline

---

# NEXT DEVELOPMENT PHASES

1. Pipeline Integration
2. Error Handling
3. CLI Interface
4. AI Obfuscation
5. Flask/Flutter Interface
6. Authentication
7. Testing
8. Documentation

---

# IMPORTANT DESIGN PRINCIPLES

- Modular architecture
- Security-first design
- Encryption separate from obfuscation
- Reversible emoji mapping
- Clean testing workflow

---

# FUTURE FEATURES

- AI-generated camouflage sentences
- Biometrics
- Self-destruct messages
- Screenshot protection
- Social media integration

---

# TECHNOLOGY STACK

- Python
- PyCryptodome
- Flask (future)
- Flutter (possible future)
- AES-256
- Emoji Mapping