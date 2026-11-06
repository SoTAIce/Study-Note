' study-notes  capture assistant launcher  (bin\CaptureAssistant.vbs)
'
' WHAT THIS IS
'   Starts the resident PowerShell capture helper (bin\capture.ps1) with no console
'   window and returns immediately. The helper itself builds the WPF popup once at
'   startup, hides it, then waits for the global hotkey (default Ctrl+Alt+Space).
'   Pressing the hotkey only shows the already-warmed window, so there is no browser
'   start-up and no page load - that is the whole point of this launcher.
'
' USAGE
'   Double-click once per login (optionally put a shortcut to this file into
'   shell:startup). Press Ctrl+Alt+Space anywhere to capture an idea, Ctrl+Enter to
'   send it to the inbox, Esc to discard.
'
' ENCODING NOTE - IMPORTANT
'   Keep this file pure 7-bit ASCII and save it as UTF-8 *without* BOM.
'   Windows Script Host (wscript/cscript) does not accept a UTF-8 BOM: the three BOM
'   bytes end up in front of the first statement and VBScript fails with
'   "Invalid character". Non-ASCII text in .vbs files is not portable either, so all
'   messages here are ASCII on purpose. Chinese UI text lives in capture.ps1, which is
'   UTF-8 with BOM (PowerShell 7 + PowerShell 5.1 both read that correctly).
Option Explicit

Dim shell, fso, here, helperPath, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
helperPath = here & "\capture.ps1"

If Not fso.FileExists(helperPath) Then
    MsgBox "capture.ps1 not found next to this launcher:" & vbCrLf & helperPath, 16, "study-notes capture"
    WScript.Quit 1
End If

command = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & helperPath & """"

' 0 = hidden window, False = do not wait for the helper to exit
shell.Run command, 0, False
