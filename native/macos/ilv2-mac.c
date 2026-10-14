#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef ILV2_NATIVE_PROTOCOL
#error ILV2_NATIVE_PROTOCOL is required
#endif
#if defined(__arm64__)
#define ARCH "arm64"
#elif defined(__x86_64__)
#define ARCH "x64"
#else
#error Unsupported architecture
#endif

static int failure(const char *code, int error) {
    printf("{\"protocol\":\"%s\",\"kind\":\"error\",\"code\":\"%s\",\"errno\":%d}\n", ILV2_NATIVE_PROTOCOL, code, error);
    return 1;
}

static int capability(const char *directory) {
    struct statfs volume;
    if (statfs(directory, &volume) != 0) return failure("STATFS_FAILED", errno);
    bool apfs = strcmp(volume.f_fstypename, "apfs") == 0;
    printf("{\"protocol\":\"%s\",\"kind\":\"capability\",\"arch\":\"%s\",\"apfs\":%s,\"clonefile\":true}\n", ILV2_NATIVE_PROTOCOL, ARCH, apfs ? "true" : "false");
    return 0;
}

static int clone_database(const char *source, const char *target) {
    if (source[0] != '/' || target[0] != '/') return failure("ABSOLUTE_PATH_REQUIRED", 0);
    char *parent = strdup(target);
    if (parent == NULL) return failure("ALLOCATION_FAILED", errno);
    char *separator = strrchr(parent, '/');
    char *leaf = separator + 1;
    if (*leaf == '\0' || strcmp(leaf, ".") == 0 || strcmp(leaf, "..") == 0) { free(parent); return failure("INVALID_TARGET", 0); }
    *separator = '\0';
    int source_fd = open(source, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (source_fd < 0) { int error = errno; free(parent); return failure("OPEN_FAILED", error); }
    int parent_fd = open(*parent ? parent : "/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    int error = errno;
    if (parent_fd < 0) {
        close(source_fd);
        free(parent);
        return failure("OPEN_FAILED", error);
    }
    struct stat source_stat, parent_stat;
    struct statfs source_volume, target_volume;
    const char *code = NULL;
    if (fstat(source_fd, &source_stat) != 0 || fstat(parent_fd, &parent_stat) != 0 ||
        fstatfs(source_fd, &source_volume) != 0 || fstatfs(parent_fd, &target_volume) != 0) { code = "STAT_FAILED"; error = errno; }
    else if (!S_ISREG(source_stat.st_mode)) { code = "SOURCE_NOT_REGULAR"; error = 0; }
    else if (source_stat.st_dev != parent_stat.st_dev) { code = "CROSS_VOLUME"; error = EXDEV; }
    else if (strcmp(source_volume.f_fstypename, "apfs") != 0 || strcmp(target_volume.f_fstypename, "apfs") != 0) { code = "APFS_REQUIRED"; error = 0; }
    else if (fclonefileat(source_fd, parent_fd, leaf, CLONE_NOFOLLOW | CLONE_NOOWNERCOPY) != 0) { code = "CLONE_FAILED"; error = errno; }
    close(source_fd);
    close(parent_fd);
    free(parent);
    if (code != NULL) return failure(code, error);
    printf("{\"protocol\":\"%s\",\"kind\":\"cloned\"}\n", ILV2_NATIVE_PROTOCOL);
    return 0;
}

#include "owner-lock.h"

int main(int argc, char **argv) {
    if (argc == 3 && strcmp(argv[1], "capability") == 0) return capability(argv[2]);
    if (argc == 4 && strcmp(argv[1], "clone") == 0) return clone_database(argv[2], argv[3]);
    if (argc >= 4 && strcmp(argv[1], "owner") == 0) return launch_owner(argc, argv);
    if (argc == 3 && strcmp(argv[1], "verify-owner-lock") == 0) return verify_owner_lock(argv[2]);
    return failure("INVALID_ARGUMENTS", 0);
}
