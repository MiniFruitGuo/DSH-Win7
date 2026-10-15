/*
 * Launcher that lets the Desktop plugin-uninstall path reach pnpm on Windows.
 *
 * `dsh-subprocess-local` spawns argv[0] directly (no shell). On Windows a batch
 * file is not an executable image, so the generated `pnpm.cmd` shim cannot be
 * spawned:
 *
 *   spawn('pnpm')      -> ENOENT
 *   spawn('pnpm.cmd')  -> EINVAL
 *
 * This launcher is a real PE image that runs the sibling `pnpm.cmd` through
 * `cmd.exe`, which keeps the single source of truth for the runtime environment
 * (PATH, NODE, npm_config_target) in the batch shim.
 *
 * `cmd.exe` is executed by its absolute path and the batch file is passed with
 * `/?` immediately before it. The `/?` prefix is what makes cmd resolve the
 * file argument instead of searching `PATH`, and the absolute image path keeps
 * the interpreter from finding this launcher again under the name `pnpm` - the
 * loop a plain `_spawnv(_P_WAIT, "pnpm.cmd", argv)` produces.
 *
 * Arguments are forwarded verbatim from the original command line, so callers
 * that pass spaces, quotes or metacharacters get them unchanged.
 */
#include <stdio.h>
#include <wchar.h>
#include <windows.h>

#define MAX_PATH_BUFFER 4096

static void fail(const char* message) {
  fputs("dsh-pnpm-launcher: ", stderr);
  fputs(message, stderr);
  fputs("\n", stderr);
}

int main(void) {
  wchar_t executable[MAX_PATH_BUFFER];
  const DWORD length = GetModuleFileNameW(NULL, executable, MAX_PATH_BUFFER);
  if (length == 0 || length >= MAX_PATH_BUFFER) {
    fail("cannot resolve this launcher's path");
    return 127;
  }

  wchar_t* separator = NULL;
  for (wchar_t* cursor = executable; *cursor != L'\0'; ++cursor) {
    if (*cursor == L'\\' || *cursor == L'/') separator = cursor;
  }
  if (separator == NULL) {
    fail("launcher directory is unknown");
    return 127;
  }
  *(separator + 1) = L'\0';

  wchar_t script[MAX_PATH_BUFFER];
  if (swprintf(script, MAX_PATH_BUFFER, L"%spnpm.cmd", executable) < 0) {
    fail("launcher path does not fit a command line");
    return 127;
  }
  if (GetFileAttributesW(script) == INVALID_FILE_ATTRIBUTES) {
    fail("the sibling pnpm.cmd is missing");
    return 127;
  }

  wchar_t commandInterpreter[MAX_PATH_BUFFER];
  const UINT interpreterLength = GetSystemDirectoryW(commandInterpreter, MAX_PATH_BUFFER);
  if (interpreterLength == 0 || interpreterLength >= MAX_PATH_BUFFER - 16) {
    fail("cannot resolve the system directory");
    return 127;
  }
  wcscat(commandInterpreter, L"\\cmd.exe");

  /* Skip argv[0] of this process and forward the remaining command line. */
  const wchar_t* commandLine = GetCommandLineW();
  const wchar_t* arguments = commandLine;
  if (*arguments == L'"') {
    ++arguments;
    while (*arguments != L'\0' && *arguments != L'"') ++arguments;
    if (*arguments == L'"') ++arguments;
  } else {
    while (*arguments != L'\0' && *arguments != L' ' && *arguments != L'\t') ++arguments;
  }
  while (*arguments == L' ' || *arguments == L'\t') ++arguments;

  const size_t capacity = wcslen(commandInterpreter) + wcslen(script) + wcslen(arguments) + 32;
  wchar_t* childCommandLine = HeapAlloc(GetProcessHeap(), 0, capacity * sizeof(wchar_t));
  if (childCommandLine == NULL) {
    fail("cannot allocate the child command line");
    return 127;
  }
  if (_snwprintf_s(childCommandLine, capacity, _TRUNCATE, L"\"%s\" /d /s /c \"\"%s\" %s\"",
    commandInterpreter, script, arguments) < 0) {
    fail("child command line does not fit its buffer");
    HeapFree(GetProcessHeap(), 0, childCommandLine);
    return 127;
  }

  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  ZeroMemory(&startup, sizeof(startup));
  startup.cb = sizeof(startup);
  ZeroMemory(&child, sizeof(child));

  if (!CreateProcessW(commandInterpreter, childCommandLine, NULL, NULL, TRUE, 0, NULL, NULL,
    &startup, &child)) {
    fail("cannot start cmd.exe");
    HeapFree(GetProcessHeap(), 0, childCommandLine);
    return 127;
  }

  WaitForSingleObject(child.hProcess, INFINITE);
  DWORD exitCode = 127;
  GetExitCodeProcess(child.hProcess, &exitCode);
  CloseHandle(child.hThread);
  CloseHandle(child.hProcess);
  HeapFree(GetProcessHeap(), 0, childCommandLine);
  return (int)exitCode;
}
