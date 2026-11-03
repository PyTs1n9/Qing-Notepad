; Qing Notepad — per-user .md "Open with" registration.
;
; Deliberately NOT `bundle.fileAssociations`: Tauri's NSIS macro writes
; `Software\Classes\.md` (the default handler) unconditionally, so installing
; would take Markdown away from Typora / VS Code / Obsidian. This hook writes
; only a ProgID and an `OpenWithProgids` value, which is what puts the app in
; the "打开方式" submenu while leaving the user's default program alone.
;
; Idempotence, which is the answer to "do I have to uninstall before every
; reinstall?":
;   * every value is addressed by a fixed key + value name, so a second run
;     overwrites in place instead of appending;
;   * `OpenWithProgids` is keyed by the ProgID, not a list, so duplicates are
;     structurally impossible;
;   * the command line is rebuilt from `$INSTDIR` on every install, so a new
;     install directory repairs the path automatically.
; Uninstalling removes exactly these keys; no other application's entry is
; touched. SHCTX is HKCU because this bundle installs with installMode
; "currentUser".

; ASCII only: NSIS reads a `.nsh` without a BOM in the system ANSI code page, so
; a UTF-8 Chinese description would be garbled on a non-Chinese build machine.
; The app name in the "打开方式" list comes from the exe's FileDescription.
!define QING_MD_PROGID "QingNotepad.Markdown"
!define QING_MD_DESC "Markdown Document"

!macro QING_MD_ADD_EXT EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${QING_MD_PROGID}" ""
!macroend

!macro QING_MD_REMOVE_EXT EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${QING_MD_PROGID}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\${QING_MD_PROGID}" "" "${QING_MD_DESC}"
  WriteRegStr SHCTX "Software\Classes\${QING_MD_PROGID}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\${QING_MD_PROGID}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  !insertmacro QING_MD_ADD_EXT "md"
  !insertmacro QING_MD_ADD_EXT "markdown"

  ; The Applications key is what makes the exe appear in the "Open with"
  ; dialog (and in Settings → Default apps) before the ProgID was ever used.
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""

  ; Explorer caches association menus; without this the new entry can take a
  ; restart (or a sign-out) to show up.
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro QING_MD_REMOVE_EXT "md"
  !insertmacro QING_MD_REMOVE_EXT "markdown"
  DeleteRegKey SHCTX "Software\Classes\${QING_MD_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  !insertmacro UPDATEFILEASSOC
!macroend
