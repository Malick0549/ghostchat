# utils/log_viewer.py
"""
Log Viewer Utility for GhostChat
View and analyze security logs
"""

import json
from pathlib import Path
from datetime import datetime
from typing import List, Dict


class LogViewer:
    """Utility to view and analyze GhostChat security logs"""
    
    def __init__(self, log_path: str = "logs/ghostchat.log"):
        self.log_path = Path(log_path)
    
    def read_logs(self, lines: int = None) -> List[str]:
        """Read log entries"""
        if not self.log_path.exists():
            return []
        
        with open(self.log_path, 'r', encoding='utf-8') as f:
            if lines:
                return f.readlines()[-lines:]
            return f.readlines()
    
    def filter_by_event(self, event_type: str) -> List[str]:
        """Filter logs by event type"""
        logs = self.read_logs()
        return [log for log in logs if f"[{event_type}]" in log]
    
    def get_statistics(self) -> Dict:
        """Get log statistics"""
        logs = self.read_logs()
        
        event_counts = {}
        for log in logs:
            # Extract event type
            if "[ENCRYPTION]" in log:
                event_counts['encryption'] = event_counts.get('encryption', 0) + 1
            elif "[DECRYPTION]" in log:
                event_counts['decryption'] = event_counts.get('decryption', 0) + 1
            elif "[AUTHENTICATION]" in log:
                event_counts['authentication'] = event_counts.get('authentication', 0) + 1
            elif "[KEY_ROTATION]" in log:
                event_counts['key_rotation'] = event_counts.get('key_rotation', 0) + 1
            elif "[EMOJI_ERROR]" in log:
                event_counts['emoji_error'] = event_counts.get('emoji_error', 0) + 1
        
        # Count success/failure for authentication
        auth_success = sum(1 for log in logs if "[AUTHENTICATION]" in log and "successful" in log)
        auth_failure = sum(1 for log in logs if "[AUTHENTICATION]" in log and "failed" in log)
        
        return {
            'total_events': len(logs),
            'event_counts': event_counts,
            'authentication_success_rate': f"{auth_success}/{auth_success + auth_failure}",
            'log_file_size': self.log_path.stat().st_size if self.log_path.exists() else 0
        }


if __name__ == "__main__":
    viewer = LogViewer()
    print("=== GhostChat Log Statistics ===")
    print(json.dumps(viewer.get_statistics(), indent=2))