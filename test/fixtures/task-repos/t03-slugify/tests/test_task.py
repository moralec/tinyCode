from textutil import slugify, title_case


def test_basic():
    assert slugify("  Hello,  World! ") == "hello-world"


def test_repeated():
    assert slugify("a--b") == "a-b"


def test_digits():
    assert slugify("Version 2.0 Release") == "version-2-0-release"


def test_title():
    assert title_case("hello world") == "Hello World"
