#include "MacProcessOwnerSupport.h"
#include <EndpointSecurity/EndpointSecurity.h>
#include <Security/Security.h>
#include <dlfcn.h>
#include <pthread.h>
#include <bsm/libbsm.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <mach/mach.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static es_client_t *owner_client;

// Some macOS SDK images expose the EndpointSecurity headers without a linkable
// framework stub. Resolve the client API at runtime so the package always
// links, and refuse to start the daemon when the framework is unavailable.
typedef es_new_client_result_t (^LnwjudEsHandler)(es_client_t *, const es_message_t *);
typedef es_new_client_result_t (*LnwjudEsNewClient)(es_client_t **, LnwjudEsHandler);
typedef es_return_t (*LnwjudEsRespondAuth)(es_client_t *, const es_message_t *, es_auth_result_t, bool);
typedef es_return_t (*LnwjudEsSubscribe)(es_client_t *, const es_event_type_t *, uint32_t);
typedef es_return_t (*LnwjudEsUnmuteAllPaths)(es_client_t *);
typedef es_clear_cache_result_t (*LnwjudEsClearCache)(es_client_t *);
typedef void (*LnwjudEsDeleteClient)(es_client_t *);

static pthread_once_t owner_es_once = PTHREAD_ONCE_INIT;
static void *owner_es_library;
static LnwjudEsNewClient owner_es_new_client;
static LnwjudEsRespondAuth owner_es_respond_auth;
static LnwjudEsSubscribe owner_es_subscribe;
static LnwjudEsUnmuteAllPaths owner_es_unmute_all_paths;
static LnwjudEsClearCache owner_es_clear_cache;
static LnwjudEsDeleteClient owner_es_delete_client;

static void owner_es_load(void) {
    void *library = dlopen("/System/Library/Frameworks/EndpointSecurity.framework/EndpointSecurity", RTLD_NOW | RTLD_LOCAL);
    if (library == NULL) return;
    LnwjudEsNewClient created = (LnwjudEsNewClient)dlsym(library, "es_new_client");
    LnwjudEsRespondAuth respond = (LnwjudEsRespondAuth)dlsym(library, "es_respond_auth_result");
    LnwjudEsSubscribe subscribe = (LnwjudEsSubscribe)dlsym(library, "es_subscribe");
    LnwjudEsUnmuteAllPaths unmute = (LnwjudEsUnmuteAllPaths)dlsym(library, "es_unmute_all_paths");
    LnwjudEsClearCache clear = (LnwjudEsClearCache)dlsym(library, "es_clear_cache");
    LnwjudEsDeleteClient delete_client = (LnwjudEsDeleteClient)dlsym(library, "es_delete_client");
    if (created == NULL || respond == NULL || subscribe == NULL || unmute == NULL || clear == NULL || delete_client == NULL) {
        dlclose(library); return;
    }
    owner_es_new_client = created; owner_es_respond_auth = respond; owner_es_subscribe = subscribe;
    owner_es_unmute_all_paths = unmute; owner_es_clear_cache = clear; owner_es_delete_client = delete_client;
    owner_es_library = library;
}

static int owner_es_ready(void) {
    pthread_once(&owner_es_once, owner_es_load);
    return owner_es_library != NULL;
}

int lnwjud_owner_disable_core_dumps(void) {
    struct rlimit limit = {0, 0};
    return setrlimit(RLIMIT_CORE, &limit);
}

int lnwjud_owner_monitor_start(void *context, LnwjudProcessEventHandler handler) {
    if (geteuid() != 0 || owner_client != NULL || !owner_es_ready()) return -1;
    es_new_client_result_t created = owner_es_new_client(&owner_client, ^(es_client_t *client, const es_message_t *message) {
        LnwjudProcessEvent event = {0};
        event.sequenced = message->version >= 4;
        if (event.sequenced) event.sequence = message->global_seq_num;
        event.pid = audit_token_to_pid(message->process->audit_token);
        event.pid_version = audit_token_to_pidversion(message->process->audit_token);
        event.effective_uid = audit_token_to_euid(message->process->audit_token);
        switch (message->event_type) {
            case ES_EVENT_TYPE_NOTIFY_FORK:
                event.kind = 1;
                event.child_pid = audit_token_to_pid(message->event.fork.child->audit_token);
                event.child_version = audit_token_to_pidversion(message->event.fork.child->audit_token);
                break;
            case ES_EVENT_TYPE_NOTIFY_EXIT:
                event.kind = 2;
                event.exit_status = WIFEXITED(message->event.exit.stat) ? WEXITSTATUS(message->event.exit.stat)
                    : WIFSIGNALED(message->event.exit.stat) ? 128 + WTERMSIG(message->event.exit.stat) : -1;
                break;
            case ES_EVENT_TYPE_AUTH_EXEC:
                event.kind = 3;
                event.child_pid = audit_token_to_pid(message->event.exec.target->audit_token);
                event.child_version = audit_token_to_pidversion(message->event.exec.target->audit_token);
                event.effective_uid = audit_token_to_euid(message->event.exec.target->audit_token);
                if ((message->event.exec.target->executable->stat.st_mode & (S_ISUID | S_ISGID)) != 0)
                    event.effective_uid = UINT32_MAX;
                break;
            default: return;
        }
        int allowed = handler(context, &event);
        if (message->action_type == ES_ACTION_TYPE_AUTH)
            owner_es_respond_auth(client, message, allowed ? ES_AUTH_RESULT_ALLOW : ES_AUTH_RESULT_DENY, false);
    });
    if (created != ES_NEW_CLIENT_RESULT_SUCCESS) { owner_client = NULL; return (int)created + 100; }
    es_event_type_t events[] = { ES_EVENT_TYPE_NOTIFY_FORK, ES_EVENT_TYPE_NOTIFY_EXIT, ES_EVENT_TYPE_AUTH_EXEC };
    if (owner_es_unmute_all_paths(owner_client) != ES_RETURN_SUCCESS || owner_es_clear_cache(owner_client) != ES_CLEAR_CACHE_RESULT_SUCCESS
        || owner_es_subscribe(owner_client, events, sizeof(events) / sizeof(events[0])) != ES_RETURN_SUCCESS) {
        owner_es_delete_client(owner_client); owner_client = NULL; return -2;
    }
    return 0;
}

int lnwjud_owner_probe(void) {
    pid_t pid = fork();
    if (pid == 0) _exit(0);
    if (pid < 0) return -1;
    int status;
    while (waitpid(pid, &status, 0) < 0) { if (errno != EINTR) return -1; }
    return 0;
}

int lnwjud_owner_lock(const char *path) {
    int fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    struct stat state;
    if (fd < 0) return -1;
    if (fstat(fd, &state) != 0 || !S_ISREG(state.st_mode) || state.st_uid != 0 || state.st_nlink != 1
        || (state.st_mode & 0077) != 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) { close(fd); return -1; }
    return fd;
}

int lnwjud_owner_listen(const char *path) {
    if (strlen(path) >= sizeof(((struct sockaddr_un *)0)->sun_path)) return -1;
    struct stat previous;
    if (lstat(path, &previous) == 0) {
        if (!S_ISSOCK(previous.st_mode) || previous.st_uid != 0 || unlink(path) != 0) return -1;
    } else if (errno != ENOENT) return -1;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    struct sockaddr_un address = {0};
    address.sun_family = AF_UNIX;
    strlcpy(address.sun_path, path, sizeof(address.sun_path));
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || chmod(path, 0666) != 0 || listen(fd, 16) != 0) {
        close(fd); return -1;
    }
    return fd;
}

static int allowed_host_arguments(pid_t pid) {
    int query[] = { CTL_KERN, KERN_PROCARGS2, pid };
    const size_t maximum = 1024 * 1024;
    size_t capacity = maximum;
    char *arguments = calloc(1, maximum);
    if (!arguments) return 0;
    int allowed = 0;
    if (sysctl(query, 3, arguments, &capacity, NULL, 0) != 0 || capacity <= sizeof(int) || capacity > maximum) goto done;
    int count;
    memcpy(&count, arguments, sizeof(count));
    if (count < 1 || count > 1024) goto done;
    char *cursor = arguments + sizeof(int), *end = arguments + capacity;
    size_t length = strnlen(cursor, (size_t)(end - cursor));
    if (cursor + length >= end) goto done;
    cursor += length;
    while (cursor < end && *cursor == 0) cursor++;
    for (int index = 0; index < count; index++) {
        if (cursor >= end) goto done;
        length = strnlen(cursor, (size_t)(end - cursor));
        if (cursor + length >= end) goto done;
        if (index > 0 && (strcmp(cursor, "-e") == 0 || strcmp(cursor, "-r") == 0 || strcmp(cursor, "-p") == 0
            || strncmp(cursor, "--eval", 6) == 0 || strncmp(cursor, "--require", 9) == 0
            || strncmp(cursor, "--import", 8) == 0 || strncmp(cursor, "--loader", 8) == 0
            || strncmp(cursor, "--experimental-loader", 21) == 0 || strncmp(cursor, "--inspect", 9) == 0
            || strncmp(cursor, "--remote-debugging", 18) == 0 || strncmp(cursor, "--app", 5) == 0
            || strncmp(cursor, "--load-extension", 16) == 0 || strncmp(cursor, "--print", 7) == 0
            || (cursor[0] != '-' && (strstr(cursor, ".js") || strstr(cursor, ".mjs") || strstr(cursor, ".cjs"))))) goto done;
        cursor += length + 1;
    }
    while (cursor < end && *cursor != 0) {
        length = strnlen(cursor, (size_t)(end - cursor));
        if (cursor + length >= end) goto done;
        if (strncmp(cursor, "NODE_OPTIONS=", 13) == 0 || strncmp(cursor, "NODE_PATH=", 10) == 0
            || strncmp(cursor, "DYLD_", 5) == 0
            || (strncmp(cursor, "ELECTRON_RUN_AS_NODE=", 21) == 0 && cursor[21] != 0 && strcmp(cursor + 21, "0") != 0)) goto done;
        cursor += length + 1;
    }
    allowed = 1;
done:
    memset(arguments, 0, maximum);
    free(arguments);
    return allowed;
}

static int hardened_host_image(SecStaticCodeRef image) {
    CFDictionaryRef information = NULL;
    if (SecCodeCopySigningInformation(image, kSecCSSigningInformation, &information) != errSecSuccess || !information) return 0;
    CFTypeRef flags = CFDictionaryGetValue(information, kSecCodeInfoFlags);
    int64_t bits = 0;
    int allowed = flags && CFGetTypeID(flags) == CFNumberGetTypeID()
        && CFNumberGetValue((CFNumberRef)flags, kCFNumberSInt64Type, &bits) && (bits & kSecCodeSignatureRuntime) != 0;
    CFTypeRef raw = CFDictionaryGetValue(information, kSecCodeInfoEntitlements);
    CFTypeRef entitlements = CFDictionaryGetValue(information, kSecCodeInfoEntitlementsDict);
    if ((raw && !entitlements) || (entitlements && CFGetTypeID(entitlements) != CFDictionaryGetTypeID())) allowed = 0;
    if (allowed && entitlements) {
        CFStringRef forbidden[] = { CFSTR("com.apple.security.get-task-allow"),
            CFSTR("com.apple.security.cs.disable-library-validation"), CFSTR("com.apple.security.cs.allow-dyld-environment-variables"),
            CFSTR("com.apple.security.cs.disable-executable-page-protection") };
        for (size_t index = 0; index < sizeof(forbidden) / sizeof(forbidden[0]); index++) {
            CFTypeRef value = CFDictionaryGetValue((CFDictionaryRef)entitlements, forbidden[index]);
            if (value && (CFGetTypeID(value) != CFBooleanGetTypeID() || CFBooleanGetValue((CFBooleanRef)value))) allowed = 0;
        }
    }
    CFRelease(information);
    return allowed;
}

static int authenticated_host(int fd, const char *requirement_text) {
    audit_token_t token;
    socklen_t size = sizeof(token);
    if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size) != 0 || size != sizeof(token)) return 0;
    CFDataRef audit = CFDataCreate(kCFAllocatorDefault, (const UInt8 *)&token, sizeof(token));
    const void *keys[] = { kSecGuestAttributeAudit }, *values[] = { audit };
    CFDictionaryRef attributes = audit ? CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    CFStringRef text = CFStringCreateWithCString(kCFAllocatorDefault, requirement_text, kCFStringEncodingUTF8);
    SecRequirementRef requirement = NULL;
    SecCodeRef code = NULL;
    SecStaticCodeRef image = NULL;
    int allowed = 0;
    if (audit && attributes && text
        && SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) == errSecSuccess
        && SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) == errSecSuccess
        && SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) == errSecSuccess
        && SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &image) == errSecSuccess
        && SecStaticCodeCheckValidity(image, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode,
            requirement) == errSecSuccess
        && hardened_host_image(image)
        && allowed_host_arguments(audit_token_to_pid(token))) allowed = 1;
    if (image) CFRelease(image);
    if (code) CFRelease(code);
    if (requirement) CFRelease(requirement);
    if (text) CFRelease(text);
    if (attributes) CFRelease(attributes);
    if (audit) CFRelease(audit);
    return allowed;
}

int lnwjud_owner_accept(int listener, uint32_t *uid, uint32_t *gid, const char *requirement) {
    int fd = accept(listener, NULL, NULL);
    if (fd < 0) return -1;
    uid_t caller; gid_t group;
    struct timeval timeout = {5, 0};
    int no_sigpipe = 1;
    if (getpeereid(fd, &caller, &group) != 0 || !authenticated_host(fd, requirement)
        || setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) != 0
        || setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) != 0
        || setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe)) != 0) { close(fd); return -1; }
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    *uid = caller; *gid = group;
    return fd;
}

int lnwjud_owner_boot_id(char *buffer, size_t capacity) {
    size_t count = capacity;
    if (sysctlbyname("kern.bootsessionuuid", buffer, &count, NULL, 0) != 0 || count < 2 || count > capacity) return -1;
    buffer[capacity - 1] = 0;
    return 0;
}

int32_t lnwjud_owner_spawn_stopped(const char *executable, char *const arguments[], char *const environment[],
    const char *cwd, uint32_t uid, uint32_t gid, int output, int error, uint32_t *pid_version) {
    int maximum_fd = getdtablesize();
    int identity_pipe[2];
    if (pipe(identity_pipe) != 0) return -1;
    fcntl(identity_pipe[0], F_SETFD, FD_CLOEXEC);
    fcntl(identity_pipe[1], F_SETFD, FD_CLOEXEC);
    pid_t pid = fork();
    if (pid != 0) {
        close(identity_pipe[1]);
        if (pid < 0) { close(identity_pipe[0]); return -1; }
        uint32_t version = 0;
        ssize_t count;
        do { count = read(identity_pipe[0], &version, sizeof(version)); } while (count < 0 && errno == EINTR);
        close(identity_pipe[0]);
        if (count != sizeof(version) || version == 0) { lnwjud_owner_abort_stopped_child(pid); return -1; }
        int status;
        while (waitpid(pid, &status, WUNTRACED) < 0) { if (errno != EINTR) return -1; }
        *pid_version = version;
        return WIFSTOPPED(status) ? pid : -1;
    }
    close(identity_pipe[0]);
    audit_token_t token;
    mach_msg_type_number_t token_count = TASK_AUDIT_TOKEN_COUNT;
    if (task_info(mach_task_self(), TASK_AUDIT_TOKEN, (task_info_t)&token, &token_count) != KERN_SUCCESS) _exit(126);
    uint32_t version = audit_token_to_pidversion(token);
    if (write(identity_pipe[1], &version, sizeof(version)) != sizeof(version)) _exit(126);
    close(identity_pipe[1]);
    // setuid changes real/effective/saved IDs and marks P_SUGID. XNU denies
    // unprivileged task ports/ptrace until exec replaces this inherited image.
    if (raise(SIGSTOP) != 0 || setgroups(0, NULL) != 0 || setgid(gid) != 0 || setuid(uid) != 0
        || getuid() != uid || geteuid() != uid || getgid() != gid || getegid() != gid || chdir(cwd) != 0) _exit(126);
    int input = open("/dev/null", O_RDONLY);
    if (input < 0 || dup2(input, STDIN_FILENO) < 0 || dup2(output, STDOUT_FILENO) < 0 || dup2(error, STDERR_FILENO) < 0) _exit(126);
    for (int fd = 3; fd < maximum_fd; fd++) close(fd);
    execve(executable, arguments, environment);
    _exit(127);
}

int lnwjud_owner_resume_child(int32_t pid) { return kill(pid, SIGCONT); }

int lnwjud_owner_abort_stopped_child(int32_t pid) {
    if (kill(pid, SIGKILL) != 0 && errno != ESRCH) return -1;
    int status;
    pid_t result;
    do { result = waitpid(pid, &status, 0); } while (result < 0 && errno == EINTR);
    return result == pid ? 0 : -1;
}

int lnwjud_owner_reap_child(int32_t pid) {
    int status;
    pid_t reaped = waitpid(pid, &status, WNOHANG);
    return reaped == pid || (reaped < 0 && errno == ECHILD) ? 1 : 0;
}

int lnwjud_owner_terminate(int32_t pid, uint32_t pid_version) {
    mach_port_t task = MACH_PORT_NULL;
    if (task_for_pid(mach_task_self(), pid, &task) != KERN_SUCCESS) return -1;
    audit_token_t token;
    mach_msg_type_number_t count = TASK_AUDIT_TOKEN_COUNT;
    kern_return_t result = task_info(task, TASK_AUDIT_TOKEN, (task_info_t)&token, &count);
    if (result == KERN_SUCCESS && count == TASK_AUDIT_TOKEN_COUNT
        && audit_token_to_pid(token) == pid && audit_token_to_pidversion(token) == pid_version)
        result = task_terminate(task);
    else result = KERN_INVALID_ARGUMENT;
    mach_port_deallocate(mach_task_self(), task);
    return result == KERN_SUCCESS ? 0 : -1;
}
