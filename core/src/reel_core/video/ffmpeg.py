from pathlib import Path

import subprocess


class FfmpegError(RuntimeError):
    pass


def run_ffmpeg(ffmpeg_exe: Path, args: list[str]) -> None:
    cmd = [str(ffmpeg_exe), "-hide_banner", "-loglevel", "error", *args]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        tail = (result.stderr or "").strip().splitlines()[-10:]
        raise FfmpegError(
            "ffmpeg failed (exit {}):\n  {}\ncommand: {}".format(
                result.returncode, "\n  ".join(tail), subprocess.list2cmdline(cmd)
            )
        )
