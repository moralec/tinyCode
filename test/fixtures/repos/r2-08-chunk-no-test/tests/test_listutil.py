from listutil import flatten, unique


def test_flatten():
    assert flatten([[1], [2, 3]]) == [1, 2, 3]


def test_unique():
    assert unique([3, 1, 3, 2, 1]) == [3, 1, 2]
