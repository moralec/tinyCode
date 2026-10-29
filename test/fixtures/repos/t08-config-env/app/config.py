import json
import os

DEFAULTS = {"host": "203.0.113.1", "port": 8000, "debug": False, "timeout": 2.5}


def load_config(path=None):
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        with open(path) as f:
            cfg.update(json.load(f))
    return cfg
