from collections import OrderedDict

from orders.dates import month_key, parse_day, quarter


def group_by(orders, keyfn):
    out = OrderedDict()
    for o in sorted(orders, key=lambda o: o["day"]):
        out.setdefault(keyfn(parse_day(o["day"])), []).append(o)
    return out


def by_month(orders):
    return group_by(orders, month_key)


def by_quarter(orders):
    return group_by(orders, lambda d: "%d-Q%d" % (d.year, quarter(d)))
