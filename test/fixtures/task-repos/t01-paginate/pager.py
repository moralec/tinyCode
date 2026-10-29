def paginate(items, page, size):
    """Return page `page` (1-based) of `items`, `size` items per page."""
    start = page * size
    return items[start:start + size]


def page_count(items, size):
    return (len(items) + size - 1) // size
