import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backend.flask_app import app as application
app = application
