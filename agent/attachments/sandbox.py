"""Linux 解析隔离：Landlock 文件边界和 seccomp 禁网，所有限制由子进程继承。

内核没有 Landlock（低于 6.12，或容器策略拦了它）而本进程是 root 时退一步：
把文件复制进私有临时目录，派生子进程降为 nobody 解析，禁网规则照旧；
结果由仍是 root 的父进程拷回输出目录。容器入口已把 /data 收成只有 root 能进。
"""
import ctypes
import errno
import json
import os
import pathlib
import platform
import runpy
import shutil
import sys

script, source, output, name, packages = sys.argv[1:6]
scratch = sys.argv[6]
# 降权分支会切换工作目录，路径先变成绝对路径。
script, source, output, scratch = (str(pathlib.Path(path).resolve()) for path in (script, source, output, scratch))
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long


def checked(value, operation):
    if value < 0:
        raise RuntimeError(operation + "失败：" + os.strerror(ctypes.get_errno()))
    return value


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64), ("scoped", ctypes.c_uint64)]


class Beneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


class Filter(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint32)]


class Program(ctypes.Structure):
    _fields_ = [("length", ctypes.c_ushort), ("filter", ctypes.POINTER(Filter))]


NOBODY = 65534


def landlock_abi():
    value = libc.syscall(444, 0, 0, 1)
    return value if value >= 0 else -ctypes.get_errno()


def run_as_nobody():
    """没有 Landlock 时的退路：复制输入、降权解析、拷回结果。返回子进程退出码。"""
    private = pathlib.Path(scratch) / "nobody"
    private.mkdir(mode=0o700)
    work = private / "out"
    work.mkdir(mode=0o700)
    copy = private / ("input" + pathlib.Path(source).suffix.lower())
    shutil.copyfile(source, copy)
    for path in [scratch, private, work, copy]:
        os.chown(path, NOBODY, NOBODY)
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(NOBODY)
            os.setuid(NOBODY)
            if os.getuid() != NOBODY or os.geteuid() != NOBODY:
                raise RuntimeError("降权失败")
            os.environ["HOME"] = str(work)
            os.chdir(work)
            apply_seccomp()
            sys.argv = [script, str(copy), str(work), name]
            runpy.run_path(script, run_name="__main__")
            os._exit(0)
        except SystemExit as stop:
            os._exit(stop.code if isinstance(stop.code, int) else 1)
        except BaseException as error:
            print("文件解析失败：" + type(error).__name__ + " " + str(error)[:200], file=sys.stderr)
            os._exit(1)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    # 只拷回解析产物里的普通文件，符号链接一律不跟。
    for item in work.rglob("*"):
        if item.is_symlink() or not item.is_file():
            continue
        target = pathlib.Path(output) / item.relative_to(work)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, target, follow_symlinks=False)
    return code


def apply_seccomp():
    # 禁止网络套接字、跨进程读取、内核挂载和可绕过普通系统调用过滤的接口。
    forbidden = [42, 44, 46, 307, 101, 165, 166, 246, 250, 298, 303, 304, 310, 311, 321, 323] if machine == "x86_64" else [203, 206, 211, 269, 117, 40, 39, 104, 219, 241, 264, 265, 270, 271, 280, 282]
    forbidden += [425, 426, 427, 438]
    architecture = 0xC000003E if machine == "x86_64" else 0xC00000B7
    instructions = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, architecture), Filter(0x06, 0, 0, 0x80000000), Filter(0x20, 0, 0, 0)]
    if machine == "x86_64":
        instructions += [Filter(0x35, 0, 1, 0x40000000), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
    # 仅允许创建本地 UNIX 管道；连接仍被禁止，IP 套接字不能创建。
    socket_number = 41 if machine == "x86_64" else 198
    instructions += [Filter(0x15, 0, 4, socket_number), Filter(0x20, 0, 0, 16), Filter(0x15, 1, 0, 1), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM), Filter(0x06, 0, 0, 0x7FFF0000)]
    for number in forbidden:
        instructions += [Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x00050000 | errno.EPERM)]
    instructions.append(Filter(0x06, 0, 0, 0x7FFF0000))
    buffer = (Filter * len(instructions))(*instructions)
    program = Program(len(instructions), buffer)
    checked(libc.prctl(22, 2, ctypes.byref(program), 0, 0), "应用解析禁网规则")


try:
    machine = platform.machine()
    if machine not in ["aarch64", "x86_64"]:
        raise RuntimeError("当前处理器缺少已验证的解析隔离配置")
    checked(libc.prctl(38, 1, 0, 0, 0), "禁止权限提升")
    abi = landlock_abi()
    if abi in (-errno.ENOSYS, -errno.EPERM, -errno.EOPNOTSUPP) and os.geteuid() == 0:
        print("Landlock 不可用，改用降权隔离", file=sys.stderr)
        sys.exit(run_as_nobody())
    if abi < 0:
        raise RuntimeError("Landlock 内核探测失败：" + os.strerror(-abi))
    if abi < 6:
        raise RuntimeError("Linux 内核需要支持 Landlock ABI 6，才能隔离文档本地管道与进程信号")
    access = (1 << 13) - 1
    if abi >= 2:
        access |= 1 << 13
    if abi >= 3:
        access |= 1 << 14
    rule = Ruleset(access, 0, 3)
    ruleset_fd = checked(libc.syscall(444, ctypes.byref(rule), ctypes.sizeof(rule), 0), "创建文件隔离规则")
    try:
        readable = ["/usr", "/bin", "/lib", "/lib64", "/etc/fonts", "/etc/libreoffice", "/var/cache/fontconfig", "/var/spool/libreoffice", "/etc/ld.so.cache", "/etc/localtime", "/etc/locale.alias", "/etc/mime.types", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/dev/urandom", "/dev/random", str(pathlib.Path(script).parent)] + json.loads(packages)
        paths = {str(pathlib.Path(path).resolve()): False for path in readable if pathlib.Path(path).exists()}
        paths[str(pathlib.Path(source).resolve())] = False
        paths[str(pathlib.Path(output).resolve())] = True
        paths[str(pathlib.Path(scratch).resolve())] = True
        paths["/dev/null"] = True
        for path, writable in paths.items():
            folder = pathlib.Path(path).is_dir()
            allowed = access & ~(1 << 0) if writable and folder else ((1 << 1) | (1 << 2)) if writable else ((1 << 0) | (1 << 2) | (1 << 3)) if folder else (1 << 2)
            fd = checked(os.open(path, os.O_PATH | os.O_CLOEXEC), "打开隔离路径")
            try:
                beneath = Beneath(allowed, fd)
                checked(libc.syscall(445, ruleset_fd, 1, ctypes.byref(beneath), 0), "登记隔离路径")
            finally:
                os.close(fd)
        checked(libc.syscall(446, ruleset_fd, 0), "应用文件隔离")
    finally:
        os.close(ruleset_fd)

    apply_seccomp()
except SystemExit:
    raise
except Exception as error:
    print("文件解析隔离器启动失败：" + str(error), file=sys.stderr)
    sys.exit(78)

sys.argv = [script, source, output, name]
runpy.run_path(script, run_name="__main__")
