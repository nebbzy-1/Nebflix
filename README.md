# Nebflix

A private video library that runs on your computer. Imported videos and episode stills are stored in the `library` folder alongside the app. Viewing progress is saved in this browser.

## Start Nebflix

1. Install Node.js 18 or newer if you do not already have it.
2. Open Command Prompt in this project folder.
3. Run `node server.js`.
4. Open [http://localhost:4173](http://localhost:4173).

Keep the Command Prompt window open while using Nebflix. Press Ctrl+C there to stop it. The window logs library API calls and episode playback requests as they happen.

You can also double-click `Launch Nebflix.cmd` on your Desktop. It starts the server, opens the browser when the server is ready, and keeps the log window open.

## Add videos

- Select **Add a series** or the **＋** button, then import a folder. Paste a folder path from your computer, such as `C:\Users\you\Videos\My Series`. Nebflix searches inside it and copies supported video files into `library/videos`.
- Or choose **Upload episodes** and select video files. Give them a series name so they appear together.

Nebflix creates episode stills in `library/stills` when the browser can decode the video format. Browsers do not support every format; MP4/H.264 is the most widely supported for playback and stills. MKV files can be imported, though playback depends on the browser and codecs installed on the computer.

Playback position and the last episode are also saved in `library/library.json`. When an MP4 contains AC-3 audio, Nebflix uses FFmpeg to make a small AAC audio copy that browsers can play; the video itself is not converted. Install FFmpeg from Command Prompt with `winget install --id Gyan.FFmpeg.Shared -e`, then close and reopen Command Prompt and restart Nebflix. Converted audio is saved in `library/audio`.

The `library` folder contains your video files, stills, and catalogue. Keep it if you want to preserve your library, or back it up separately. The app does not send video files to a server; it only listens on your computer at localhost.
