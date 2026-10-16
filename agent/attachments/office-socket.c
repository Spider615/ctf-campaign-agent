/* LibreOffice 的固定 /tmp 探测忽略 Landlock；让它使用本任务的 OSL_SOCKET_PATH。
 * 只改变可写性探测结果，实际读写和连接仍受内核隔离规则限制。 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>

int access(const char *path, int mode) {
    static int (*original)(const char *, int);
    if (!original) original = dlsym(RTLD_NEXT, "access");
    if ((mode & W_OK) && (!strcmp(path, "/tmp") || !strcmp(path, "/var/tmp"))) {
        errno = EACCES;
        return -1;
    }
    if (!original) { errno = EACCES; return -1; }
    return original(path, mode);
}
