import os
import sys

# Ensure the service root is on sys.path so imports like `import server` work
ROOT = os.path.dirname(os.path.dirname(__file__))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
