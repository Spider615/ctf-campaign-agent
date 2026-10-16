"""使用隔离外监听器验证真实内核边界，不接触业务数据。"""
import json
import pathlib
import site
import socket
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix="ctf-isolation-") as directory:
    root = pathlib.Path(directory)
    code = root / "code"; code.mkdir()
    output = root / "output"; output.mkdir()
    scratch = root / "scratch"; scratch.mkdir()
    secret = root / "private-canary"; secret.write_text("synthetic-private-value")
    address = "\0ctf-isolation-" + root.name
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); listener.bind(address); listener.settimeout(0.2)
    source = root / "input"; source.write_text(json.dumps(dict(secret=str(secret), address=address)))
    script = code / "probe.py"
    script.write_text('''import json, pathlib, socket, subprocess, sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text()); blocked=[]
def attempt(name, work):
    try: work()
    except (PermissionError, OSError): blocked.append(name)
attempt("private_read", lambda: pathlib.Path(data["secret"]).read_text())
attempt("outside_write", lambda: pathlib.Path(data["secret"]+"-write").write_text("forbidden"))
attempt("ip_socket", lambda: socket.socket(socket.AF_INET, socket.SOCK_STREAM))
sock=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM)
attempt("unix_sendto", lambda: sock.sendto(b"isolated-probe",data["address"]))
attempt("unix_sendmsg", lambda: sock.sendmsg([b"isolated-probe"],[],0,data["address"]))
child=subprocess.run(["/bin/cat",data["secret"]],capture_output=True)
if child.returncode and b"synthetic-private-value" not in child.stdout: blocked.append("child_read")
pathlib.Path(sys.argv[2],"probe.json").write_text(json.dumps(blocked))
print(json.dumps(blocked))
''')
    completed = subprocess.run([sys.executable, sys.argv[1], str(script), str(source), str(output), "合成检查", json.dumps(site.getsitepackages()), str(scratch)], capture_output=True, text=True, timeout=10)
    if completed.returncode:
        raise RuntimeError(completed.stderr)
    blocked = json.loads(completed.stdout)
    expected = ["private_read", "outside_write", "ip_socket", "unix_sendto", "unix_sendmsg", "child_read"]
    assert sorted(blocked) == sorted(expected), "隔离缺少阻断：" + str(set(expected) - set(blocked))
    try:
        listener.recv(100)
        raise AssertionError("隔离外监听器收到了受限进程数据")
    except socket.timeout:
        pass
    listener.close()
    assert (output / "probe.json").is_file()
    print("私有文件、越界写入、IP、外部 UNIX 出站及子进程继承检查通过")
