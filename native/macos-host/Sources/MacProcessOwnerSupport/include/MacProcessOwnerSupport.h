#ifndef LNWJUD_MAC_PROCESS_OWNER_H
#define LNWJUD_MAC_PROCESS_OWNER_H
#include <stdint.h>
#include <sys/types.h>

typedef struct {
    uint64_t sequence;
    int sequenced;
    int kind;
    int32_t pid;
    uint32_t pid_version;
    int32_t child_pid;
    uint32_t child_version;
    uint32_t effective_uid;
    int32_t exit_status;
} LnwjudProcessEvent;

typedef int (*LnwjudProcessEventHandler)(void *, const LnwjudProcessEvent *);
int lnwjud_owner_monitor_start(void *context, LnwjudProcessEventHandler handler);
int lnwjud_owner_disable_core_dumps(void);
int lnwjud_owner_probe(void);
int lnwjud_owner_listen(const char *path);
int lnwjud_owner_accept(int listener, uint32_t *uid, uint32_t *gid, const char *requirement);
int lnwjud_owner_lock(const char *path);
int lnwjud_owner_boot_id(char *buffer, size_t capacity);
int32_t lnwjud_owner_spawn_stopped(const char *executable, char *const arguments[], char *const environment[],
    const char *cwd, uint32_t uid, uint32_t gid, int output, int error, uint32_t *pid_version);
int lnwjud_owner_resume_child(int32_t pid);
int lnwjud_owner_abort_stopped_child(int32_t pid);
int lnwjud_owner_reap_child(int32_t pid);
int lnwjud_owner_terminate(int32_t pid, uint32_t pid_version);
#endif
