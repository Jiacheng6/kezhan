; Updates may preserve links which still point to a moved installation.
; Start the freshly installed executable directly, and repair existing links.
!macro customInstall
  StrCpy $launchLink "$appExe"
  ; Only remove the retired launcher after the renamed executable exists.
  ${if} $INSTDIR != ""
  ${andIf} ${FileExists} "$INSTDIR\课栈.exe"
    Delete "$INSTDIR\学习通助手.exe"
    Delete "$INSTDIR\课泊.exe"
  ${endif}
  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endif}
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endif}
  ClearErrors
!macroend
