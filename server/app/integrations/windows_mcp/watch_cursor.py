from uiautomation import Control
import threading
import time

class WatchCursor:
    def __init__(self):
        self._stop_event = threading.Event()
        self._thread = None

    def start(self):
        # Only start if needed and avoid idle loop overhead
        pass

    def stop(self):
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)

