from dataclasses import dataclass


@dataclass
class Task:
    id: int
    text: str
    done: bool = False
