@echo off
set "EXT_DIR=%~dp0"
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --load-extension="%EXT_DIR%" https://www.facebook.com/marketplace/inbox/
