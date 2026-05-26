# ai/__init__.py
"""
AI Obfuscation Layer for GhostChat

This module provides deniable camouflage for encrypted messages.
It is NOT a security layer - it only hides the fact that
encrypted communication is occurring.

The REAL security remains AES-256 encryption.
"""

from ai.camouflage_generator import CamouflageLayer, AICamouflage, CasualCamouflage, WeatherCamouflage