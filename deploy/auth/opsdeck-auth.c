#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <grp.h>
#include <security/pam_appl.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <syslog.h>
#include <unistd.h>

enum result_code { RESULT_OK = 0, RESULT_AUTH_FAILED = 1, RESULT_FORBIDDEN = 2, RESULT_ERROR = 3 };

struct conversation_data {
  const char *username;
  const char *password;
};

static int read_full(int fd, void *buffer, size_t length) {
  unsigned char *cursor = buffer;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count == 0) return -1;
    if (count < 0) { if (errno == EINTR) continue; return -1; }
    cursor += count; length -= (size_t)count;
  }
  return 0;
}

static int pam_conversation(int count, const struct pam_message **messages, struct pam_response **responses, void *data) {
  if (count <= 0 || count > PAM_MAX_NUM_MSG) return PAM_CONV_ERR;
  struct conversation_data *credentials = data;
  struct pam_response *result = calloc((size_t)count, sizeof(*result));
  if (!result) return PAM_BUF_ERR;
  for (int index = 0; index < count; index++) {
    if (messages[index]->msg_style == PAM_PROMPT_ECHO_OFF) {
      result[index].resp = strdup(credentials->password);
      if (!result[index].resp) goto failure;
    } else if (messages[index]->msg_style == PAM_PROMPT_ECHO_ON) {
      result[index].resp = strdup(credentials->username);
      if (!result[index].resp) goto failure;
    } else if (messages[index]->msg_style != PAM_ERROR_MSG && messages[index]->msg_style != PAM_TEXT_INFO) {
      goto failure;
    }
  }
  *responses = result;
  return PAM_SUCCESS;
failure:
  for (int index = 0; index < count; index++) free(result[index].resp);
  free(result);
  return PAM_CONV_ERR;
}

static int username_valid(const char *username) {
  size_t length = strlen(username);
  if (length == 0 || length > 64) return 0;
  for (size_t index = 0; index < length; index++) {
    char c = username[index];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.')) return 0;
  }
  return 1;
}

static int user_in_allowed_group(const char *username) {
  if (strcmp(username, "root") == 0) return 1;
  struct passwd password_record, *password_result = NULL;
  char password_buffer[16384];
  if (getpwnam_r(username, &password_record, password_buffer, sizeof(password_buffer), &password_result) != 0 || !password_result) return 0;
  int group_count = 0;
  (void)getgrouplist(username, password_record.pw_gid, NULL, &group_count);
  if (group_count <= 0 || group_count > 1024) return 0;
  gid_t *groups = calloc((size_t)group_count, sizeof(*groups));
  if (!groups) return 0;
  if (getgrouplist(username, password_record.pw_gid, groups, &group_count) < 0) { free(groups); return 0; }
  const char *configured = getenv("OPSDECK_ADMIN_GROUPS");
  char *allowed = strdup(configured && *configured ? configured : "sudo,admin,wheel");
  if (!allowed) { free(groups); return 0; }
  int permitted = 0;
  for (char *save = NULL, *name = strtok_r(allowed, ",", &save); name && !permitted; name = strtok_r(NULL, ",", &save)) {
    struct group *group = getgrnam(name);
    if (!group) continue;
    for (int index = 0; index < group_count; index++) if (groups[index] == group->gr_gid) { permitted = 1; break; }
  }
  free(allowed); free(groups);
  return permitted;
}

int main(void) {
  openlog("opsdeck-auth", LOG_PID, LOG_AUTHPRIV);
  uint32_t header[2];
  if (read_full(STDIN_FILENO, header, sizeof(header)) != 0) return RESULT_ERROR;
  uint32_t username_length = ntohl(header[0]), password_length = ntohl(header[1]);
  if (username_length == 0 || username_length > 64 || password_length == 0 || password_length > PAM_MAX_RESP_SIZE) return RESULT_ERROR;
  char username[65] = {0};
  char *password = calloc((size_t)password_length + 1, 1);
  if (!password) return RESULT_ERROR;
  if (read_full(STDIN_FILENO, username, username_length) != 0 || read_full(STDIN_FILENO, password, password_length) != 0 || !username_valid(username)) {
    explicit_bzero(password, (size_t)password_length); free(password); return RESULT_ERROR;
  }
  struct conversation_data data = { .username = username, .password = password };
  struct pam_conv conversation = { .conv = pam_conversation, .appdata_ptr = &data };
  pam_handle_t *handle = NULL;
  int pam_status = pam_start("opsdeck", username, &conversation, &handle);
  if (pam_status == PAM_SUCCESS) pam_status = pam_authenticate(handle, PAM_SILENT);
  if (pam_status == PAM_SUCCESS) pam_status = pam_acct_mgmt(handle, PAM_SILENT);
  int result = RESULT_AUTH_FAILED;
  if (pam_status == PAM_SUCCESS) result = user_in_allowed_group(username) ? RESULT_OK : RESULT_FORBIDDEN;
  if (handle) pam_end(handle, pam_status);
  explicit_bzero(password, (size_t)password_length); free(password);
  unsigned char response = (unsigned char)result;
  (void)write(STDOUT_FILENO, &response, 1);
  if (result == RESULT_OK) syslog(LOG_NOTICE, "administrative authentication succeeded for user %s", username);
  else if (result == RESULT_FORBIDDEN) syslog(LOG_WARNING, "authenticated user %s is not in an allowed administrative group", username);
  else syslog(LOG_WARNING, "administrative authentication failed for user %s", username);
  closelog();
  return 0;
}
