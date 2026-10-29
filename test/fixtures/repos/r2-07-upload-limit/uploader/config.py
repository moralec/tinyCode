import configparser
import os

DEFAULT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "app.ini")


def load(path=None):
    cp = configparser.ConfigParser()
    cp.read(path or DEFAULT_PATH)
    return cp
