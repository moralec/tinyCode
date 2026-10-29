from pager import paginate, page_count


def test_first_page():
    assert paginate(list(range(10)), 1, 3) == [0, 1, 2]


def test_last_partial_page():
    assert paginate(list(range(10)), 4, 3) == [9]


def test_past_end():
    assert paginate(list(range(10)), 5, 3) == []


def test_count():
    assert page_count(list(range(10)), 3) == 4
