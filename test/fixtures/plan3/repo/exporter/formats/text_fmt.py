def write_text(records, fh):
    for r in records:
        fh.write(" ".join("%s=%s" % (k, v) for k, v in r.items()) + "\n")
