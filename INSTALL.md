# Install Zaude

Zaude is in a private repository, so the one-line installers use the GitHub CLI.

## One-time setup

1. Install the GitHub CLI.
   - Windows (PowerShell): `winget install --id GitHub.cli`
   - Linux: follow https://cli.github.com (or your package manager's `gh` package)
2. Log in once: `gh auth login` (choose GitHub.com, HTTPS, and log in with your browser).

## Windows

Paste this into PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\Zaude" | Out-Null; gh release download --repo fanboysonyofficial-lgtm/Zaude --pattern "*windows-x64.exe" --dir "$HOME\Zaude" --clobber; Start-Process (Get-ChildItem "$HOME\Zaude\*.exe" | Select-Object -First 1).FullName
```

It downloads `Zaude-<version>-windows-x64.exe` to `%USERPROFILE%\Zaude` and starts it. Next time, double-click that file. Windows may show a "Windows protected your PC" warning because the app is not code-signed. Click **More info**, then **Run anyway**.

## Linux

Paste this into a terminal:

```bash
mkdir -p ~/Applications && gh release download --repo fanboysonyofficial-lgtm/Zaude --pattern "*linux-x86_64.AppImage" --dir ~/Applications --clobber && chmod +x ~/Applications/Zaude-*-linux-x86_64.AppImage && ~/Applications/Zaude-*-linux-x86_64.AppImage &
```

It downloads the AppImage to `~/Applications` and starts it. Next time, run `~/Applications/Zaude-*-linux-x86_64.AppImage` or double-click it in your file manager.

If the AppImage does not start and mentions FUSE, install it with `sudo apt install libfuse2` (Ubuntu and Debian) and try again.

## Updating

Run the same command again. It downloads the newest release and replaces the old file.
