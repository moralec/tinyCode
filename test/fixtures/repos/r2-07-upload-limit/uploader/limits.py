from uploader import config

MB = 1024 * 1024


def max_upload_bytes(path=None):
    return int(config.load(path).getfloat("limits", "max_upload_mb") * MB)


def accept(size_bytes, path=None):
    return size_bytes <= max_upload_bytes(path)
