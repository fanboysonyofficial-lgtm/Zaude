# Zaude

A video editor for building clips with AI tools. Cut and edit on a timeline, use trackpad gestures to change clip length, and generate clips from a text prompt through Mannimmate.

## Install

Zaude is a private repository, so the installers use the GitHub CLI (`gh`) with your account.

### One-time setup

1. Install the GitHub CLI.
   - Windows (PowerShell): `winget install --id GitHub.cli`
   - Linux: see https://cli.github.com, or install `gh` from your package manager.
2. Log in once: `gh auth login`. Choose GitHub.com, HTTPS, and log in with your browser.

### Windows

Paste this into PowerShell (one line):

```powershell
New-Item -ItemType Directory -Force "$HOME\Zaude" | Out-Null; gh release download --repo fanboysonyofficial-lgtm/Zaude --pattern "*windows-x64.exe" --dir "$HOME\Zaude" --clobber; Start-Process (Get-ChildItem "$HOME\Zaude\*.exe" | Select-Object -First 1).FullName
```

It downloads the program to `%USERPROFILE%\Zaude` and starts it. Next time, double-click the `.exe` in that folder. Windows may warn that the app is not signed. Click **More info**, then **Run anyway**.

### Linux

Paste this into a terminal (one line):

```bash
mkdir -p ~/Applications && gh release download --repo fanboysonyofficial-lgtm/Zaude --pattern "*linux-x86_64.AppImage" --dir ~/Applications --clobber && chmod +x ~/Applications/Zaude-*-linux-x86_64.AppImage && ~/Applications/Zaude-*-linux-x86_64.AppImage &
```

Next time, run `~/Applications/Zaude-*-linux-x86_64.AppImage` or double-click it in your file manager. If it mentions FUSE, install `libfuse2` (`sudo apt install libfuse2` on Ubuntu and Debian).

> The one-line installers need a published release. If there is no release yet, build it yourself (below).

## Build from source

You need Node.js 22 or newer.

```bash
git clone https://github.com/fanboysonyofficial-lgtm/Zaude.git
cd Zaude
npm install
npm run dist
```

The installers appear in `dist/`:
- Windows: `Zaude-<version>-windows-x64.exe`
- Linux: `Zaude-<version>-linux-x86_64.AppImage`

Run the app without building: `npm run desktop`.
Run the editor in a browser (no AI or remote features): `npm start`, then open http://localhost:8080.

## Text to video

The **Text to video** button sends a prompt to the Mannimmate command-line tool, which renders the clip on the GPU machine. You need:
- Mannimmate installed in the folder set in the dialog (default `~/Documents/MeineProgramme/mannimmate`).
- Python on your PATH (`python3` on Linux, `python` on Windows).
- The ComfyUI connection to the GPU machine running.

Finished clips are saved to `~/Videos/Zaude` and play in the program monitor.

## Remote machines

**Remote machines** adds an ssh machine (such as a GPU PC). Zaude checks its hardware and whether ComfyUI is installed, then saves the report. **Reconfigure** runs the check again. Password logins are not supported. Use keys or `~/.ssh/config`.

## Tests

```bash
npm test
```

## More

See [INSTALL.md](INSTALL.md) for the installer details.
