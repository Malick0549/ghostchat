import os
import sys
import unittest

# Ensure the workspace root is on the import path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.ghostchat import GhostChat


class TestGhostChatSessionKeys(unittest.TestCase):
    """Test GhostChat session key recovery across separate instances."""

    def test_cross_instance_session_recovery(self):
        sender = GhostChat("SamePassword")
        receiver = GhostChat("SamePassword")

        result = sender.send("Secret message", deterministic=True)

        self.assertIn('salt', result['metadata'])
        self.assertIn('key_id', result['metadata'])

        decrypted = receiver.receive(result['emoji_message'], result['metadata'])
        self.assertEqual("Secret message", decrypted)

    def test_send_package_cross_instance(self):
        sender = GhostChat("SamePassword")
        receiver = GhostChat("SamePassword")

        package = sender.send_package("Another message")
        decrypted = receiver.receive_package(package)

        self.assertEqual("Another message", decrypted)


if __name__ == '__main__':
    unittest.main()
