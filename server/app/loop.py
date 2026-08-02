"""
Custom event loop factory for uvicorn on Windows.

uvicorn's default loop factory (asyncio_loop_factory) returns SelectorEventLoop
when use_subprocess=True (i.e., --reload or --workers > 1). SelectorEventLoop
does NOT support subprocess creation on Windows, which causes NotImplementedError
when Playwright/Camoufox tries to spawn the Firefox process.

This module provides a factory that always returns ProactorEventLoop on Windows,
regardless of the use_subprocess flag.

Usage:
    poetry run uvicorn main:app --reload --loop app.loop:proactor_loop_factory
    # or set in uvicorn.run(): loop="app.loop:proactor_loop_factory"
"""
import asyncio
import sys


def proactor_loop_factory() -> asyncio.AbstractEventLoop:
    """Always return ProactorEventLoop on Windows for subprocess support."""
    if sys.platform == "win32":
        return asyncio.ProactorEventLoop()
    return asyncio.SelectorEventLoop()
