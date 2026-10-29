from orders.report import monthly_totals, quarterly_totals

ORDERS = [{"day": "2026-01-05", "amount": 10.0}, {"day": "2026-01-20", "amount": 5.5},
          {"day": "2026-02-05", "amount": 1.0}, {"day": "2026-04-01", "amount": 2.0}]


def test_monthly():
    assert monthly_totals(ORDERS) == [("2026-01", 15.5), ("2026-02", 1.0), ("2026-04", 2.0)]


def test_quarterly():
    assert quarterly_totals(ORDERS) == [("2026-Q1", 16.5), ("2026-Q2", 2.0)]
