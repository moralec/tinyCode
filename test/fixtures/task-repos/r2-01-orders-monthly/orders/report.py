from orders.aggregate import by_month, by_quarter


def _total(rows):
    return round(sum(r["amount"] for r in rows), 2)


def monthly_totals(orders):
    """[(month, total)] in date order."""
    return [(k, _total(v)) for k, v in by_month(orders).items()]


def quarterly_totals(orders):
    return [(k, _total(v)) for k, v in by_quarter(orders).items()]
