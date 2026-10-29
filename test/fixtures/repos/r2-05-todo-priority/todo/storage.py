import json
import os

from todo.model import Task


def load(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [Task(id=r["id"], text=r["text"], done=r.get("done", False)) for r in json.load(f)]


def save(path, tasks):
    with open(path, "w") as f:
        json.dump([{"id": t.id, "text": t.text, "done": t.done} for t in tasks], f)
