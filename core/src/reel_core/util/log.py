"""Rich console helpers."""

from rich.console import Console

console = Console(stderr=True)


def info(message: str) -> None:
    console.print(message)


def warn(message: str) -> None:
    console.print(f"[yellow]Warning:[/yellow] {message}")
