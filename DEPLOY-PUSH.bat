@echo off
setlocal
cd /d "%~dp0"

echo.
echo ============================================
echo   GPN Push - deploy
echo ============================================
echo.

where firebase >nul 2>&1
if errorlevel 1 (
  echo ERROR: firebase not found.
  pause
  exit /b 1
)

echo [1] If deploy ever says App Engine required, open this link once:
echo     https://console.cloud.google.com/appengine?project=geelong-premium-network-f54a5
echo     Click Create Application - choose any region - then run this script again.
echo.

echo [2] Setting cleanup policy...
call firebase functions:artifacts:setpolicy --days 1 --force

echo.
echo [3] Deploying team chat push (onNoticeCreated only)...
echo     Job push functions stay on existing v1 deploy - full deploy fails on Gen1-^>Gen2 upgrade.
echo.
call firebase deploy --only functions:onNoticeCreated --non-interactive > deploy-log.txt 2>&1
type deploy-log.txt
echo.

findstr /C:"Deploy complete" deploy-log.txt >nul
if errorlevel 1 (
  echo ============================================
  echo   DEPLOY FAILED - see lines above
  echo   Full log: deploy-log.txt
  echo ============================================
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   SUCCESS - Functions deployed!
echo ============================================
echo.
echo Next: upload these to GitHub (see UPLOAD-THESE-FILES.txt):
echo   icons/icon-192.png, icon-512.png, apple-touch-icon.png
echo   sw.js, manifest.json, index.html
echo.
pause
