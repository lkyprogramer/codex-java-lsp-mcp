#include <limits.h>
#include <sys/file.h>
#include <time.h>

#ifndef ILV2_NODE_BIN
#error ILV2_NODE_BIN is required
#endif
#ifndef ILV2_OWNER_GUARD
#error ILV2_OWNER_GUARD is required
#endif

static int lock_path(const char *root, char *output) {
    char canonical[PATH_MAX];
    if (root[0] != '/' || realpath(root, canonical) == NULL || strcmp(root, canonical) != 0)
        return failure("CANONICAL_CACHE_REQUIRED", errno);
    if (snprintf(output, PATH_MAX, "%s/.owner.lock", canonical) >= PATH_MAX)
        return failure("PATH_TOO_LONG", 0);
    return 0;
}

static double monotonic_seconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
    return (double)now.tv_sec + (double)now.tv_nsec / 1000000000.0;
}

/* A second open must contend; fd4 must already refer to the held OFD. Never
 * LOCK_UN: that would unlock every inherited reference, including the owner. */
static int verify_owner_lock(const char *root) {
    char filename[PATH_MAX];
    if (lock_path(root, filename) != 0) return 1;
    struct stat held, named;
    if (fstat(4, &held) != 0 || lstat(filename, &named) != 0)
        return failure("OWNER_FD_MISSING", errno);
    if (!S_ISREG(held.st_mode) || !S_ISREG(named.st_mode) || held.st_dev != named.st_dev ||
        held.st_ino != named.st_ino || held.st_uid != geteuid() || held.st_nlink != 1)
        return failure("OWNER_INODE_MISMATCH", 0);
    int probe = open(filename, O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (probe < 0) return failure("OWNER_PROBE_FAILED", errno);
    int result = flock(probe, LOCK_EX | LOCK_NB);
    int error = errno;
    close(probe);
    if (result == 0 || (error != EWOULDBLOCK && error != EAGAIN))
        return failure("OWNER_LOCK_NOT_HELD", result == 0 ? 0 : error);
    if (flock(4, LOCK_EX | LOCK_NB) != 0) return failure("OWNER_OFD_MISMATCH", errno);
    printf("{\"protocol\":\"%s\",\"kind\":\"owner-lock\",\"pid\":%d,\"pgid\":%d,\"fd\":4,\"inode\":%llu}\n",
        ILV2_NATIVE_PROTOCOL, getpid(), getpgrp(), (unsigned long long)held.st_ino);
    return 0;
}

static int launch_owner(int argc, char **argv) {
    char filename[PATH_MAX];
    if (lock_path(argv[2], filename) != 0) return 1;
    if (argv[3][0] != '/') return failure("ABSOLUTE_ENTRY_REQUIRED", 0);
    int fd = open(filename, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) return failure("OWNER_OPEN_FAILED", errno);
    struct stat held;
    if (fstat(fd, &held) != 0 || !S_ISREG(held.st_mode) || held.st_uid != geteuid() || held.st_nlink != 1) {
        close(fd); return failure("OWNER_FILE_INVALID", 0);
    }
    double started = monotonic_seconds();
    if (started < 0) { close(fd); return failure("CLOCK_FAILED", errno); }
    while (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        int error = errno;
        if (error != EWOULDBLOCK && error != EAGAIN && error != EINTR) {
            close(fd); return failure("OWNER_LOCK_FAILED", error);
        }
        double now = monotonic_seconds();
        if (now < 0 || now - started >= 5.0) {
            close(fd); return failure(now < 0 ? "CLOCK_FAILED" : "OWNER_BUSY", 0);
        }
        double remaining = 5.0 - (now - started);
        struct timespec pause = { 0, (long)((remaining < 0.1 ? remaining : 0.1) * 1000000000.0) };
        nanosleep(&pause, NULL);
    }
    if ((fd != 4 && dup2(fd, 4) < 0) || fcntl(4, F_SETFD, 0) != 0) {
        int error = errno; close(fd); return failure("OWNER_FD_FAILED", error);
    }
    if (fd != 4) close(fd);
    if (setenv("ILV2_OWNER_CACHE_ROOT", argv[2], 1) != 0) return failure("OWNER_ENV_FAILED", errno);
    const char *scrub[] = { "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_HISTORY", "NODE_V8_COVERAGE",
        "NODE_COMPILE_CACHE", "NODE_REDIRECT_WARNINGS", "NODE_TEST_CONTEXT" };
    for (size_t i = 0; i < sizeof(scrub) / sizeof(scrub[0]); i++) unsetenv(scrub[i]);
    char **args = calloc((size_t)argc + 1, sizeof(char *));
    if (args == NULL) return failure("ALLOCATION_FAILED", errno);
    args[0] = ILV2_NODE_BIN;
    args[1] = "--import";
    args[2] = ILV2_OWNER_GUARD;
    for (int i = 3; i < argc; i++) args[i] = argv[i];
    execv(ILV2_NODE_BIN, args);
    int error = errno; free(args); return failure("OWNER_EXEC_FAILED", error);
}
