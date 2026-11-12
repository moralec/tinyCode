import argparse
import json
import sys

from exporter import formats, settings


def main(argv=None):
    ap = argparse.ArgumentParser(prog="exporter")
    ap.add_argument("--format", default=settings.DEFAULT_FORMAT, choices=formats.names())
    ap.add_argument("--list-formats", action="store_true")
    ap.add_argument("src", nargs="?")
    ap.add_argument("dst", nargs="?")
    a = ap.parse_args(argv)
    if a.list_formats:
        print(" ".join("%s(%s)" % (n, settings.EXTENSIONS[n]) for n in formats.names()))
        return 0
    with open(a.src) as f:
        records = json.load(f)
    with open(a.dst, "w", newline="") as fh:
        formats.get(a.format)(records, fh)
    return 0


if __name__ == "__main__":
    sys.exit(main())
