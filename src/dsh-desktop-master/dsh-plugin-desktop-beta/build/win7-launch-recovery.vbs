' Launch DSH Desktop with the recovery retry, without showing a console window.
'
' The desktop shortcut used to point straight at the .cmd retry wrapper, which made Windows open a
' console window for the whole session. WScript.Shell.Run's second argument is the window state:
' 0 hides the started process entirely, so the wrapper still runs but nothing is displayed.

Option Explicit
Dim shell, fso, here, target, attempts, attempt, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
target = here & "\DSH Desktop Beta.exe"

If Not fso.FileExists(target) Then
  ' Fall back to a search, in case the layout changes.
  Dim folder, file
  For Each file In fso.GetFolder(here).Files
    If LCase(Left(file.Name, 11)) = "dsh desktop" And LCase(Right(file.Name, 4)) = ".exe" Then
      target = file.Path
      Exit For
    End If
  Next
End If

attempts = 3
If Not IsEmpty(WScript.Arguments) Then
  If WScript.Arguments.Count > 0 Then
    If IsNumeric(WScript.Arguments(0)) Then attempts = CInt(WScript.Arguments(0))
  End If
End If

' Exit codes the retry wrapper treated as transient: the Electron main process aborted before it
' could report anything of its own.
Dim transient
transient = Array(-2147483645, -1073741819, -1073740791, -1073740940)

For attempt = 1 To attempts
  ' 0 = hidden window, False = do not wait for the process to exit before continuing.
  code = shell.Run(Chr(34) & target & Chr(34), 0, True)
  If code = 0 Then Exit For
  Dim matched, flag
  matched = False
  For Each flag In transient
    If code = flag Then matched = True
  Next
  If Not matched Then Exit For
  WScript.Sleep 1500
Next
