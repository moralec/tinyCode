import json
from exporter import cli, formats, settings


def test_json_round_trip(tmp_path):
    records = [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]
    src = tmp_path / "in.json"
    src.write_text(json.dumps(records))
    dst = tmp_path / "out.json"
    assert cli.main(["--format", "json", str(src), str(dst)]) == 0
    assert json.loads(dst.read_text()) == records


def test_text_output(tmp_path):
    src = tmp_path / "in.json"
    src.write_text(json.dumps([{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]))
    dst = tmp_path / "out.txt"
    assert cli.main(["--format", "text", str(src), str(dst)]) == 0
    assert dst.read_text().splitlines() == ["a=1 b=x", "a=2 b=y"]


def test_registered():
    assert {"json", "text"} <= set(formats.names())
    assert settings.EXTENSIONS["json"] == ".json" and settings.EXTENSIONS["text"] == ".txt"


def test_list(capsys):
    assert cli.main(["--list-formats"]) == 0
    out = capsys.readouterr().out
    assert "json(.json)" in out and "text(.txt)" in out
