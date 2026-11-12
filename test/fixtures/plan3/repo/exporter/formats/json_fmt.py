import json


def write_json(records, fh):
    json.dump(records, fh, indent=1)
