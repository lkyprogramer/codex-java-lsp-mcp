#include <CoreServices/CoreServices.h>
#include <IOKit/IOMessage.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <dispatch/dispatch.h>
#include <inttypes.h>
#include <signal.h>

/* All protocol output and sequence mutation occur on this serial queue.
 * FlushSync runs on the stdin/control thread, never on the callback queue:
 * the SDK contract requires callbacks to finish before FlushSync returns.
 * System power notifications are delivered on the same queue, so a resume
 * takes its place in the one sequence (contract §2.4: the raw signal is native). */
typedef struct {
    FSEventStreamRef stream;
    dispatch_queue_t queue;
    char epoch[33];
    uint64_t seq;
    io_connect_t power;
    IONotificationPortRef power_port;
    io_object_t power_notifier;
} WatchState;

static void watch_prefix(WatchState *state, const char *kind) {
    printf("{\"protocol\":\"%s\",\"epoch\":\"%s\",\"seq\":\"%" PRIu64 "\",\"kind\":\"%s\"",
        ILV2_NATIVE_PROTOCOL, state->epoch, ++state->seq, kind);
}
static void watch_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; p++) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 32) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
static void watch_callback(ConstFSEventStreamRef stream, void *context, size_t count,
    void *paths, const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
    (void)stream;
    WatchState *state = context;
    char **names = paths;
    for (size_t i = 0; i < count; i++) {
        watch_prefix(state, "event");
        printf(",\"eventId\":\"%" PRIu64 "\",\"flags\":%" PRIu32 ",\"path\":", ids[i], flags[i]);
        watch_string(names[i]);
        puts("}");
    }
    fflush(stdout);
}
static void watch_resume(WatchState *state, const char *source) {
    watch_prefix(state, "resume");
    printf(",\"source\":\"%s\"}\n", source);
    fflush(stdout);
}
/* A system power client must answer every sleep query, or sleep is held for 30 s. */
static void power_callback(void *context, io_service_t service, natural_t type, void *argument) {
    (void)service;
    WatchState *state = context;
    if (type == kIOMessageCanSystemSleep || type == kIOMessageSystemWillSleep) IOAllowPowerChange(state->power, (long)argument);
    else if (type == kIOMessageSystemHasPoweredOn) watch_resume(state, "system-has-powered-on");
}
static int watch_fsevents(const char *cache_root, const char *root) {
    native_startup_error = true;
    const char *binding = getenv("ILV2_OWNER_CACHE_ROOT");
    if (binding == NULL || strcmp(binding, cache_root) != 0) return failure("OWNER_BINDING_REQUIRED", 0);
    if (validate_owner_lock(cache_root, false) != 0) return 1;
    char canonical[PATH_MAX];
    struct stat info;
    if (root[0] != '/' || realpath(root, canonical) == NULL || strcmp(root, canonical) != 0 ||
        stat(root, &info) != 0 || !S_ISDIR(info.st_mode)) return failure("INVALID_ROOT", errno);
    WatchState state = {0};
    unsigned char random[16]; arc4random_buf(random, sizeof(random));
    for (size_t i = 0; i < sizeof(random); i++) snprintf(state.epoch + i * 2, 3, "%02x", random[i]);
    state.queue = dispatch_queue_create("ilv2.fsevents.protocol", DISPATCH_QUEUE_SERIAL);
    CFStringRef directory = CFStringCreateWithCString(NULL, root, kCFStringEncodingUTF8);
    if (directory == NULL) { dispatch_release(state.queue); return failure("INVALID_ROOT_ENCODING", 0); }
    CFArrayRef roots = CFArrayCreate(NULL, (const void **)&directory, 1, &kCFTypeArrayCallBacks);
    FSEventStreamContext context = {0, &state, NULL, NULL, NULL};
    state.stream = FSEventStreamCreate(NULL, watch_callback, &context, roots,
        kFSEventStreamEventIdSinceNow, 0.05,
        kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer);
    CFRelease(roots); CFRelease(directory);
    if (state.stream == NULL) { dispatch_release(state.queue); return failure("STREAM_CREATE_FAILED", 0); }
    FSEventStreamSetDispatchQueue(state.stream, state.queue);
    state.power = IORegisterForSystemPower(&state, &state.power_port, power_callback, &state.power_notifier);
    if (state.power == MACH_PORT_NULL) {
        FSEventStreamInvalidate(state.stream); FSEventStreamRelease(state.stream); dispatch_release(state.queue);
        return failure("POWER_REGISTER_FAILED", 0);
    }
    /* Test hook only (never set by the service): SIGUSR1 replays the resume path on the protocol queue,
     * so an external fault harness can wake a helper without sleeping the host. */
    const char *hooks = getenv("ILV2_NATIVE_TEST_HOOKS");
    bool test_hooks = hooks != NULL && strcmp(hooks, "1") == 0;
    dispatch_source_t test_resume = NULL;
    if (test_hooks) {
        signal(SIGUSR1, SIG_IGN);
        test_resume = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, SIGUSR1, 0, state.queue);
        WatchState *target = &state;
        dispatch_source_set_event_handler(test_resume, ^{ watch_resume(target, "test-hook"); });
    }
    __block bool started = false;
    WatchState *shared = &state;
    dispatch_sync(state.queue, ^{
        started = FSEventStreamStart(shared->stream);
        if (started) {
            watch_prefix(shared, "ready");
            struct stat held; fstat(4, &held);
            printf(",\"pid\":%d,\"pgid\":%d,\"fd\":4,\"inode\":\"%llu\",\"volumeIdentity\":\"%llu\",\"power\":\"registered\",\"testHooks\":%s}\n",
                getpid(), getpgrp(), (unsigned long long)held.st_ino, (unsigned long long)info.st_dev, test_hooks ? "true" : "false");
            fflush(stdout);
        }
    });
    int status = 0;
    if (!started) {
        FSEventStreamInvalidate(state.stream); FSEventStreamRelease(state.stream);
        /* Never activated: a suspended source must be resumed (after cancel) before its release. */
        if (test_resume != NULL) { dispatch_source_cancel(test_resume); dispatch_resume(test_resume); dispatch_release(test_resume); }
        IODeregisterForSystemPower(&state.power_notifier); IOServiceClose(state.power); IONotificationPortDestroy(state.power_port);
        dispatch_release(state.queue);
        return failure("STREAM_START_FAILED", 0);
    }
    else {
        native_startup_error = false;
        /* Delivered only after ready: a wake before it is covered by the new epoch's startup hash. */
        IONotificationPortSetDispatchQueue(state.power_port, state.queue);
        if (test_resume != NULL) dispatch_resume(test_resume);
        /* A bounded token protocol: never allocate an unbounded stdin line. */
        char command[96];
        while (fgets(command, sizeof(command), stdin) != NULL) {
            size_t length = strlen(command);
            if (length == 0 || command[length - 1] != '\n') { status = 1; break; }
            command[length - 1] = '\0';
            if (strcmp(command, "stop") == 0) break;
            if (strncmp(command, "fence ", 6) != 0 || length < 8) { status = 1; break; }
            const char *token = command + 6;
            bool valid = true;
            for (const char *p = token; *p; p++) if (*p < '0' || *p > '9') valid = false;
            if (!valid || strlen(token) > 20) { status = 1; break; }
            FSEventStreamFlushSync(state.stream);
            dispatch_sync(state.queue, ^{
                watch_prefix(shared, "fence"); printf(",\"requestId\":\"%s\"}\n", token); fflush(stdout);
            });
        }
        if (ferror(stdin)) status = 1;
        FSEventStreamStop(state.stream);
    }
    FSEventStreamInvalidate(state.stream);
    /* After this no power callback can be queued; the dispatch_sync below drains any already queued. */
    IODeregisterForSystemPower(&state.power_notifier);
    IOServiceClose(state.power);
    if (test_resume != NULL) { dispatch_source_cancel(test_resume); dispatch_release(test_resume); }
    dispatch_sync(state.queue, ^{
        watch_prefix(shared, status ? "error" : "stopped");
        if (status) printf(",\"code\":\"CONTROL_PROTOCOL_ERROR\"");
        puts("}"); fflush(stdout);
    });
    FSEventStreamRelease(state.stream); IONotificationPortDestroy(state.power_port); dispatch_release(state.queue);
    return status;
}
