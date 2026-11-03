# Nebflix

A private video library that runs on your computer. The catalogue and episode stills are stored in the `library` folder. Folder imports use videos in their existing locations; individual file uploads are copied into `library/videos`.

## Start Nebflix

1. Install Node.js 18 or newer if you do not already have it.
2. Open Command Prompt in this project folder.
3. Run `node server.js`.
4. Open [http://localhost:4173](http://localhost:4173).

Keep the Command Prompt window open while using Nebflix. Press Ctrl+C there to stop it. The window logs library API calls and episode playback requests as they happen.

You can also double-click `Launch Nebflix.cmd` on your Desktop. It starts the server, opens the browser when the server is ready, and keeps the log window open.

## Add videos

- Select **Add a series** or the **+** button, then browse to a folder or paste its path. Each imported folder appears as one clickable show or movie card, with its episodes inside. Nebflix references folder videos in place, so they are not duplicated. Keep the source folder where it is so the videos remain available.
- Or choose **Upload episodes** and select video files. Give them a series name so they appear together; uploaded files are copied into `library/videos`.

Nebflix creates episode stills in `library/stills` when the browser can decode the video format. Browsers do not support every video and audio format; MP4/H.264 is widely supported for playback and stills. MKV files can be imported, though playback depends on the browser and installed codecs.

Playback position and the last episode are saved in this browser and in `library/library.json`.

The `library` folder contains your catalogue, stills, and uploaded video copies. Keep it if you want to preserve those items, or back it up separately. The app does not send video files to a server; it only listens on your computer at localhost.