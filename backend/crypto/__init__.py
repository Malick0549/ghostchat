"""
GhostChat :: backend/crypto/__init__.py
Marks crypto/ as an explicit Python package.

(Previously missing — Python 3's implicit namespace packages often paper
over this, but relying on that is fragile across different import
mechanisms/build tools. Explicit is safer, especially in a fresh
container build where the exact working directory and PYTHONPATH may
differ from local dev.)
"""