"""Win32 helpers for unattended CS2 recording.

Spike conclusion (HLAE FAQ + mirv_streams docs):
- Minimizing or SW_HIDE often yields black / corrupted MIRV screen capture.
- Unfocused-but-visible works when engine_no_focus_sleep is 0 (set in sequences).
- So unattended mode sinks the window (HWND_BOTTOM, no activate) and keeps it on-screen.
True headless / no-cs2.exe recording is out of scope for this HLAE pipeline.
"""

from __future__ import annotations

import ctypes
import sys
import time
from ctypes import wintypes

from reel_core.util.log import info, warn

HWND_BOTTOM = 1
SWP_NOSIZE = 0x0001
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
GW_OWNER = 4
SPI_GETWORKAREA = 0x0030


class RECT(ctypes.Structure):
    _fields_ = (
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    )


def _user32():
    if sys.platform != "win32":
        return None
    return ctypes.windll.user32


def find_main_window(pid: int, timeout_seconds: float = 45.0) -> int | None:
    """Return the first visible top-level HWND owned by *pid*, or None."""
    user32 = _user32()
    if user32 is None:
        return None

    deadline = time.monotonic() + timeout_seconds
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum(hwnd: int, _lparam: int) -> bool:
        process_id = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        if process_id.value != pid:
            return True
        if user32.GetWindow(hwnd, GW_OWNER):
            return True
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        found.append(int(hwnd))
        return False

    while time.monotonic() < deadline:
        found.clear()
        user32.EnumWindows(_enum, 0)
        if found:
            return found[0]
        time.sleep(0.4)
    return None


def sink_window(hwnd: int) -> bool:
    """Keep the window visible but behind others, without activating it."""
    user32 = _user32()
    if user32 is None:
        return False

    work = RECT()
    if not user32.SystemParametersInfoW(SPI_GETWORKAREA, 0, ctypes.byref(work), 0):
        work.left, work.top, work.right, work.bottom = 0, 0, 1920, 1080

    rect = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return False

    width = max(1, rect.right - rect.left)
    height = max(1, rect.bottom - rect.top)
    # Park fully inside the work area (bottom-right), still entirely visible for MIRV.
    x = max(work.left, work.right - width)
    y = max(work.top, work.bottom - height)

    return bool(
        user32.SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            x,
            y,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    )


def prepare_unattended_game_window(pid: int, timeout_seconds: float = 45.0) -> bool:
    """Find CS2's main window and sink it for background recording."""
    if sys.platform != "win32":
        warn("Unattended window prep is Windows-only; leaving the game as HLAE launched it")
        return False

    hwnd = find_main_window(pid, timeout_seconds=timeout_seconds)
    if hwnd is None:
        warn("Could not find the CS2 window to sink — leave it visible (do not minimize)")
        return False

    if sink_window(hwnd):
        info("CS2 window sunk to background (kept visible — do not minimize during record)")
        return True

    warn("Failed to reposition the CS2 window — keep it visible and unobstructed")
    return False
