from exporter.formats.json_fmt import write_json
from exporter.formats.text_fmt import write_text

REGISTRY = {"json": write_json, "text": write_text}


def get(name):
    return REGISTRY[name]


def names():
    return sorted(REGISTRY)
