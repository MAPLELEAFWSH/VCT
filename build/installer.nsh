; ============================================================
; 元素手帐 · 安装器自定义页：安装时自己决定要不要建快捷方式
; ------------------------------------------------------------
; 背景：electron-builder 的"辅助安装"（oneClick: false）只有
;   「安装模式 → 安装位置 → 安装进度 → 完成」四页，
;   **没有快捷方式的勾选项**（见 app-builder-lib/templates/nsis/assistedInstaller.nsh），
;   而 installSection.nsh 会无条件插入 addStartMenuLink / addDesktopLink，
;   于是桌面图标是硬塞的、用户没法选。
; 做法（用的是 electron-builder 官方的两个宏钩子）：
;   1) customPageAfterChangeDir —— 在「安装位置」之后插一页两个勾选框；
;   2) customInstall —— 它被插在 addStartMenuLink / addDesktopLink **之后**
;      （installSection.nsh:68 → 81），所以在这一步把用户没勾的那个删掉即可。
; 覆盖安装（更新）时也会显示这一页 —— 这是 Windows 安装器的常规做法
; （"选择附加任务"那一页每次都出现）。语义上也自洽：
;   · 勾着（默认）→ 什么都不删，要不要建由 electron-builder 自己的
;     keepShortcuts 逻辑决定（用户上次手动删掉图标的话不会被重新塞回来）；
;   · 没勾 → 用户明确说不要，那就把它删掉，哪怕这次是更新。
; 两个状态变量预先设成 "keep" 兜底：万一这一页被跳过（Abort / 静默安装），
; customInstall 里两个分支都不成立，绝不会误删。
; ============================================================
; ★ 必须自己 include MUI2：electron-builder 把这个自定义 include 放在生成脚本的
;   **最前面**，而模板里的 MUI2 引用在后面 —— 不自己引一次的话，
;   Function 里的 !insertmacro MUI_HEADER_TEXT 会在定义时就展开失败：
;   "!insertmacro: macro named MUI_HEADER_TEXT not found!"。
;   MUI2.nsh 自带重复包含保护，后面模板再引一次是无害的空操作。
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

; 两个勾选框的变量只在页面函数里用，而那两个函数只在安装器那一趟编译，
; 所以跟着一起进 !ifndef —— 否则卸载器那一趟会报
; "warning 6001: Variable ... not referenced or never set, wasting memory!"，
; 而 makensis 带 -WX（警告当错误）。
; 两个状态变量则两趟都会用到（preInit 里要赋初值 / customInstall 里要读），
; 所以声明在条件之外。
!ifndef BUILD_UNINSTALLER
  Var MjDesktopBox
  Var MjStartMenuBox
!endif
Var MjDesktopState
Var MjStartMenuState

!macro preInit
  StrCpy $MjDesktopState "keep"
  StrCpy $MjStartMenuState "keep"
!macroend

!macro customPageAfterChangeDir
  ; 这行 !echo 是给构建日志留的面包屑：只有这个宏真的被模板展开时才会打印，
  ; 用来确认"快捷方式选择页确实插进去了"（宏名写错 / 位置不对时会静默失效）。
  !echo "[elemental-journal] customPageAfterChangeDir hook active: shortcut options page inserted"
  Page custom mjShortcutPageCreate mjShortcutPageLeave
!macroend

; ★ 两个页面函数必须只在**安装器**那一趟编译：
;   electron-builder 会先用同一份脚本编译一遍卸载器（-DBUILD_UNINSTALLER），
;   而 assistedInstaller.nsh 里插入自定义页的那段本身就在 !ifndef BUILD_UNINSTALLER 里，
;   于是卸载器那一趟这两个函数没人引用 → warning 6010（install function not referenced）
;   → 又因为 makensis 带 -WX（把警告当错误）→ 整个打包失败。
;   实测报错原文：
;     warning 6010: install function "mjShortcutPageCreate" not referenced - zeroing code out
;     Error: warning treated as error
!ifndef BUILD_UNINSTALLER

Function mjShortcutPageCreate
  !insertmacro MUI_HEADER_TEXT "快捷方式" "选择安装完成后在哪里放一个入口，之后也可以随时手动创建。"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 0 100% 12u "在桌面创建快捷方式"
  Pop $MjDesktopBox
  ${NSD_SetState} $MjDesktopBox ${BST_CHECKED}
  ${NSD_CreateCheckbox} 0 20u 100% 12u "在开始菜单创建快捷方式"
  Pop $MjStartMenuBox
  ${NSD_SetState} $MjStartMenuBox ${BST_CHECKED}
  nsDialogs::Show
FunctionEnd

Function mjShortcutPageLeave
  ; 用 "keep" / "drop" 两个明确的字符串，而不是 0/1：
  ; 覆盖安装时这一页被跳过，两个变量是空的，空值不等于 "drop"，
  ; 所以不会误删用户上次装出来的快捷方式。
  ${NSD_GetState} $MjDesktopBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MjDesktopState "keep"
  ${Else}
    StrCpy $MjDesktopState "drop"
  ${EndIf}
  ${NSD_GetState} $MjStartMenuBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $MjStartMenuState "keep"
  ${Else}
    StrCpy $MjStartMenuState "drop"
  ${EndIf}
FunctionEnd

!endif

!macro customInstall
  ${If} $MjDesktopState == "drop"
    Delete "$newDesktopLink"
  ${EndIf}
  ${If} $MjStartMenuState == "drop"
    Delete "$newStartMenuLink"
    ; 没有开始菜单入口时，「安装完成后运行」要指回 exe 本身 ——
    ; 否则完成页那个勾会去启动一个刚被删掉的 .lnk。
    ; 模板自己在 addStartMenuLink 之后也做了同样的兜底（installSection.nsh:70）。
    StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${EndIf}
!macroend
