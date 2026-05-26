# Development Notes

## Recent Changes

- Restructured project to reduce file/folder count
- Consolidated tests into test_crypto.py and test_emoji.py
- Added robust error handling throughout GhostChat
- Created modular architecture documentation

## TODO

- Implement AI obfuscator with more advanced techniques
- Add GUI interface option
- Support for file encryption
- Network protocol for direct messaging
- Mobile app version

## Known Issues

- Emoji display may vary across platforms
- Large messages may be truncated in some terminals
- Windows console may not display all Unicode characters

## Testing

Run tests with:
```bash
python tests/test_crypto.py
python tests/test_emoji.py
```

## Dependencies

- cryptography: For AES encryption
- All dependencies listed in requirements.txt

## Security Notes

- Emoji layer provides NO security - only visual camouflage
- Real security comes from AES-256 encryption
- Passwords should be strong and unique
- Never share encryption keys or metadata