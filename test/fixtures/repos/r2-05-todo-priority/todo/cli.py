import argparse

from todo import listing, storage
from todo.model import Task


def main(argv, path="todo.json"):
    ap = argparse.ArgumentParser(prog="todo")
    sub = ap.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add")
    add.add_argument("text")
    sub.add_parser("list")
    a = ap.parse_args(argv)
    tasks = storage.load(path)
    if a.cmd == "add":
        tasks.append(Task(id=max([t.id for t in tasks] or [0]) + 1, text=a.text))
        storage.save(path, tasks)
        return ""
    return listing.render(tasks)
