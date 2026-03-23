import asyncio
from typing import Dict

class TerminalStreamer:
    """Manages active terminal output streams for different threads."""
    def __init__(self):
        # thread_id -> queue of SSE payload strings
        self.queues: Dict[str, asyncio.Queue] = {}

    def get_queue(self, thread_id: str) -> asyncio.Queue:
        if thread_id not in self.queues:
            self.queues[thread_id] = asyncio.Queue()
        return self.queues[thread_id]

    async def put_chunk(self, thread_id: str, data: str):
        """Put a chunk of terminal output into the thread's queue."""
        q = self.get_queue(thread_id)
        await q.put(data)

    def cleanup(self, thread_id: str):
        if thread_id in self.queues:
            self.queues.pop(thread_id, None)

# Global singleton
streamer = TerminalStreamer()
