# run.py
import sys
import os

# Add the current directory to Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import and run the app
from backend.flask_app import app

if __name__ == '__main__':
    import gunicorn.app.wsgiapp
    gunicorn.app.wsgiapp.run()