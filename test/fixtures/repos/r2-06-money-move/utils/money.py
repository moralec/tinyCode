def parse_money(text):
    """'12.50' or '€12.50' -> 1250 (cents)"""
    text = text.strip().lstrip("€$")
    whole, _, frac = text.partition(".")
    return int(whole) * 100 + int((frac + "00")[:2])


def fmt_money(cents, symbol="€"):
    return "%s%d.%02d" % (symbol, cents // 100, cents % 100)
