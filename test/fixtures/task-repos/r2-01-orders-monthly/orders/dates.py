from datetime import date


def parse_day(text):
    """'2026-01-05' -> date(2026, 1, 5)"""
    y, m, dd = (int(x) for x in text.split("-"))
    return date(y, m, dd)


def month_key(day):
    """The bucket an order falls in for monthly reports, e.g. '2026-01'."""
    return day.strftime("%Y-%d")


def quarter(day):
    return (day.month - 1) // 3 + 1
