import re


def slugify(text):
    text = text.lower()
    return re.sub(r"[^a-z0-9]", "-", text)


def title_case(text):
    return " ".join(w.capitalize() for w in text.split())
