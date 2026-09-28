import pytest
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_plugins_status_endpoint():
    res = client.get("/workstream/plugins/status")
    assert res.status_code == 200
    data = res.json()
    assert "ide" in data
    assert "terminal" in data
    assert "browser" in data
    assert "available_targets" in data["ide"]
    assert "path" in data["browser"]

def test_install_and_uninstall_ide():
    # Install
    res_inst = client.post("/workstream/plugins/install-ide")
    assert res_inst.status_code == 200
    assert res_inst.json()["success"] is True

    # Check status
    res_stat = client.get("/workstream/plugins/status")
    assert res_stat.json()["ide"]["installed"] is True

    # Uninstall
    res_un = client.post("/workstream/plugins/uninstall-ide")
    assert res_un.status_code == 200
    assert res_un.json()["success"] is True

def test_install_and_uninstall_terminal():
    # Install
    res_inst = client.post("/workstream/plugins/install-terminal")
    assert res_inst.status_code == 200
    assert res_inst.json()["success"] is True

    # Check status
    res_stat = client.get("/workstream/plugins/status")
    assert res_stat.json()["terminal"]["installed"] is True

    # Uninstall
    res_un = client.post("/workstream/plugins/uninstall-terminal")
    assert res_un.status_code == 200
    assert res_un.json()["success"] is True

def test_open_browser_folder():
    res = client.post("/workstream/plugins/open-browser-folder")
    assert res.status_code == 200
    assert res.json()["success"] is True
    assert "path" in res.json()
