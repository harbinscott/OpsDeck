#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <syslog.h>
#include <unistd.h>

static int read_full(int fd, void *buffer, size_t length) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count == 0) return -1;
    if (count < 0) { if (errno == EINTR) continue; return -1; }
    cursor += count;
    length -= (size_t)count;
  }
  return 0;
}

static void run_action(const char *action) {
  if (strcmp(action, "refresh-repositories") == 0) {
    execl("/usr/bin/apt-get", "apt-get", "-o", "DPkg::Lock::Timeout=60", "update", (char *)NULL);
  } else if (strcmp(action, "install-updates") == 0) {
    setenv("DEBIAN_FRONTEND", "noninteractive", 1);
    execl("/usr/bin/apt-get", "apt-get", "-o", "DPkg::Lock::Timeout=60", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "-y", "upgrade", (char *)NULL);
  } else if (strcmp(action, "reboot") == 0) {
    execl("/usr/bin/systemctl", "systemctl", "reboot", (char *)NULL);
  } else if (strcmp(action, "poweroff") == 0) {
    execl("/usr/bin/systemctl", "systemctl", "poweroff", (char *)NULL);
  }
  _exit(127);
}

int main(void) {
  openlog("opsdeck-control", LOG_PID, LOG_AUTHPRIV);
  uint32_t encoded_length = 0;
  if (read_full(STDIN_FILENO, &encoded_length, sizeof(encoded_length)) != 0) return 3;
  uint32_t length = ntohl(encoded_length);
  if (length == 0 || length > 64) return 3;
  char action[65] = {0};
  if (read_full(STDIN_FILENO, action, length) != 0) return 3;
  if (strcmp(action, "refresh-repositories") != 0 && strcmp(action, "install-updates") != 0 &&
      strcmp(action, "reboot") != 0 && strcmp(action, "poweroff") != 0) return 3;

  syslog(LOG_NOTICE, "starting privileged action %s", action);
  pid_t child = fork();
  if (child < 0) return 3;
  if (child == 0) {
    if (dup2(STDERR_FILENO, STDOUT_FILENO) < 0) _exit(126);
    close(STDIN_FILENO);
    run_action(action);
  }

  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) { status = -1; break; }
  }
  unsigned char result = (status >= 0 && WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : 1;
  (void)write(STDOUT_FILENO, &result, 1);
  if (result == 0) syslog(LOG_NOTICE, "privileged action %s completed", action);
  else syslog(LOG_ERR, "privileged action %s failed", action);
  closelog();
  return 0;
}
