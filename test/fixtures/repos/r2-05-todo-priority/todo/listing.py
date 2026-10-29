def ordered(tasks):
    return sorted(tasks, key=lambda t: t.id)


def render(tasks):
    return "\n".join("%d [%s] %s" % (t.id, "x" if t.done else " ", t.text) for t in ordered(tasks))
