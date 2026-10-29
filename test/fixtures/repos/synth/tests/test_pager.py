from pager import paginate


def test_first():
    assert paginate([1, 2, 3], 1, 2) == [1, 2]
