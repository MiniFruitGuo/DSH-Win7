; DSH Desktop NSIS customizations.
;
; Two host checks run before anything is written to disk, both from customInit (the one hook
; electron-builder's template definitely expands — customInstall is not inserted):
;
;   1. The product is x64-only by construction: the bundled Node runtime is compiled for x64, and
;      sharp, koffi, sherpa-onnx and ripgrep ship x64 prebuilds alone. On 32-bit Windows the
;      installer would otherwise succeed and leave a shortcut whose target the loader terminates
;      immediately ("processes appear, then vanish"), which reads as a broken application rather
;      than an unsupported system. The check reads the environment rather than x64.nsh, because
;      .onInit runs before electron-builder sets up its arch variables; a 32-bit installer on
;      64-bit Windows reports AMD64 through PROCESSOR_ARCHITEW6432.
;
;   2. A bare Windows 7 SP1 image cannot fetch the prerequisite updates offline, and one of the
;      components the shell needs is no longer served by Microsoft at all, so the installer carries
;      every update that can still be obtained. They are never installed silently — each needs
;      elevation and a restart — so the installer names the missing ones and points at the folder
;      that holds them.

; Count one missing update into $R6 and append its name to $R7.
;
; The component-store scan is inlined into each expansion rather than living in a shared Function:
; a Function referenced only from a macro body trips NSIS warning 6010 ("not referenced"), and
; electron-builder compiles the installer with warnings treated as errors. The labels carry the KB
; number so that four expansions of this macro stay distinct.
!macro DSH_KB_PROBE kb
  StrCpy $R8 "Package_for_${kb}~"
  StrCpy $R9 0
  StrCpy $R2 0
  dsh_kb_enum_${kb}:
    EnumRegKey $R3 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\Packages" $R2
    StrCmp $R3 "" dsh_kb_done_${kb}
    StrLen $R4 $R8
    StrCpy $R5 $R3 $R4
    StrCmp $R5 $R8 dsh_kb_hit_${kb}
    IntOp $R2 $R2 + 1
    Goto dsh_kb_enum_${kb}
  dsh_kb_hit_${kb}:
    StrCpy $R9 1
  dsh_kb_done_${kb}:
  ${if} $R9 == 0
    IntOp $R6 $R6 + 1
    StrCpy $R7 "$R7$\r$\n  - ${kb}"
  ${endif}
!macroend

!macro customInit
  ; --- 32-bit host -----------------------------------------------------------
  ReadEnvStr $R0 "PROCESSOR_ARCHITEW6432"
  StrCmp $R0 "AMD64" dsh_arch_supported
  StrCmp $R0 "IA64" dsh_arch_supported
  ReadEnvStr $R0 "PROCESSOR_ARCHITECTURE"
  StrCmp $R0 "AMD64" dsh_arch_supported
  StrCmp $R0 "IA64" dsh_arch_supported
  MessageBox MB_OK|MB_ICONSTOP "DSH Desktop requires 64-bit Windows.$\r$\n$\r$\nThis system is 32-bit: the bundled runtime (Node, sharp, koffi, sherpa-onnx, ripgrep) ships x64 binaries only, so the application could not start after installing.$\r$\n$\r$\nInstall it on 64-bit Windows 7 SP1 (x64)."
  Abort

  dsh_arch_supported:
  ; --- Windows 7 prerequisite updates ---------------------------------------
  ; Only Windows 7 needs these; Windows 8 and later ship the same components.
  ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentVersion"
  StrCmp $R0 "6.1" dsh_kb_check
  Goto dsh_kb_skip

  dsh_kb_check:
    StrCpy $R6 0
    StrCpy $R7 ""
    !insertmacro DSH_KB_PROBE "KB2999226"
    !insertmacro DSH_KB_PROBE "KB4019990"
    !insertmacro DSH_KB_PROBE "KB4490628"
    !insertmacro DSH_KB_PROBE "KB4474419"
    ${if} $R6 > 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$R6 Windows 7 update(s) are missing on this system:$R7$\r$\n$\r$\nThey ship with this installation, under$\r$\n  <install folder>\resources\win7-prerequisites$\r$\n$\r$\nInstall them after setup (each needs administrator rights), then restart before starting DSH Desktop.$\r$\n$\r$\nA machine that has never installed Windows updates may also need the Windows 7 SP1 rollup (KB3125574), which ships separately."
    ${endif}

  dsh_kb_skip:
!macroend

; Point the desktop shortcut at the recovery launcher instead of the executable.
;
; On Windows 7 the shell can abort natively while starting — V8's emulated virtual address subspace
; raises 0x80000003, which Windows reports as exit code -2147483645 — with no window and no message,
; so a shortcut aimed at the executable looks like it does nothing. The launcher retries a bounded
; number of times, which turns a dead shortcut into a slower start.
;
; The launcher is a .vbs, not the .cmd it wraps: shortcutting the .cmd left a black console window
; open for the whole session. WScript.Shell.Run with window state 0 starts the wrapper hidden, so the
; retry behaviour is kept and nothing is displayed. This runs after the builder's own shortcut
; creation, so the name it replaces is the one the installer just wrote.
!macro customInstall
  IfFileExists "$INSTDIR\DSH Desktop (recovery start).vbs" 0 dsh_recovery_shortcut_skipped
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\DSH Desktop (recovery start).vbs" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
  dsh_recovery_shortcut_skipped:
!macroend

; Check the exact app process before launching the quit handoff. This preserves
; the #469 fix: unrelated helpers under $INSTDIR must never block an upgrade.
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 != 0
    Goto dsh_installer_app_stopped
  ${endIf}

  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 dsh_installer_scoped_fallback
    ; Newer versions receive this through Electron's single-instance channel.
    ; 2.0.2 ignores it, so the scoped builder fallback remains necessary for
    ; the first upgrade to a version that supports orderly shutdown.
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --dsh-installer-quit'
    StrCpy $R1 0

  dsh_installer_wait_for_exit:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      Goto dsh_installer_app_stopped
    ${endIf}
    IntOp $R1 $R1 + 1
    ; Slow disks, antivirus hooks, and a large physical runtime can keep the
    ; process alive after Cordis disposal begins. Give the orderly handoff a
    ; full 30 seconds before escalating to the scoped forced-close path.
    ${if} $R1 < 60
      Sleep 500
      Goto dsh_installer_wait_for_exit
    ${endIf}

  dsh_installer_scoped_fallback:
    ; The patched builder macros match DSH Desktop Beta.exe, not every executable
    ; below $INSTDIR. They handle pre-handoff releases and stubborn processes.
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK dsh_installer_stop_app
    Quit

  dsh_installer_stop_app:
    DetailPrint "$(appClosing)"
    ; KILL_PROCESS's tasklist fallback excludes $pid. The installer never has
    ; the application executable name, so zero is a safe sentinel here.
    StrCpy $pid 0
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 0
    Sleep 500
    StrCpy $R1 0

  dsh_installer_wait_for_fallback:
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 != 0
      Goto dsh_installer_app_stopped
    ${endIf}
    IntOp $R1 $R1 + 1
    ${if} $R1 > 1
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY dsh_installer_wait_for_fallback
      Quit
    ${endIf}
    Sleep 1000
    !insertmacro KILL_PROCESS "${APP_EXECUTABLE_FILENAME}" 1
    Sleep 500
    Goto dsh_installer_wait_for_fallback

  dsh_installer_app_stopped:
!macroend
