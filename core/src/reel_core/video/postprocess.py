from pathlib import Path

from reel_core.recording.recorder import SequenceOutput
from reel_core.video.ffmpeg import run_ffmpeg


def process_clip(ffmpeg_exe: Path, output: SequenceOutput, clips_dir: Path, dest_name: str | None = None) -> Path:
    clips_dir.mkdir(parents=True, exist_ok=True)
    clip_path = clips_dir / (dest_name or f"{output.sequence.filename or f'clip_{output.sequence.number:02d}.mp4'}")

    map_args = ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "192k"]
    trailing_args: list[str] = []
    if output.audio_path is not None:
        audio_args = ["-i", str(output.audio_path)]
    else:
        audio_args = ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]
        trailing_args = ["-shortest"]

    run_ffmpeg(
        ffmpeg_exe,
        [
            "-y",
            "-i",
            str(output.video_path),
            *audio_args,
            *map_args,
            "-c:v",
            "copy",
            *trailing_args,
            str(clip_path),
        ],
    )
    return clip_path
