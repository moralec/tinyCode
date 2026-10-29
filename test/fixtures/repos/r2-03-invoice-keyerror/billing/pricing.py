RATES = {"standard": 0.20, "reduced": 0.05, "zero": 0.0}


def breakdown(lines, rate="standard"):
    """lines: [(unit_price, qty)] -> {'net', 'tax', 'gross'} rounded to cents."""
    net = round(sum(p * q for p, q in lines), 2)
    taxes = round(net * RATES[rate], 2)
    return {"net": net, "taxes": taxes, "gross": round(net + taxes, 2)}
