import WebSocket from "ws";
import fs from "fs";
import decodeAudio from "audio-decode";
import { exec, spawn } from "child_process";
import { Buffer } from "buffer";
import dotenv from "dotenv";
import { PassThrough } from "stream";

dotenv.config();

const url =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";
const ws = new WebSocket(url, {
  headers: {
    Authorization: "Bearer " + process.env.OPENAI_API_KEY,
    "OpenAI-Beta": "realtime=v1"
  }
});

let responseChunks = [];
let sessionId = null;
let isRecording = false;
let recordingProcess = null;
let playbackProcess = null;
let audioStream = null;
let cleanupInProgress = false;
let playbackPromise = Promise.resolve();
let totalAudioLength = 0;
let playbackStartTime = 0;

function cleanup(exitAfter = true) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;

  console.log("\nCleaning up...");

  // Stop recording
  if (recordingProcess) {
    recordingProcess.kill("SIGTERM");
    recordingProcess = null;
  }

  // Stop playback
  endAudioPlayback();

  // Clear any pending audio
  responseChunks = [];

  // Send session end message
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: "session.end" }));

      // Wait briefly for the message to be sent
      setTimeout(() => {
        ws.close();
        if (exitAfter) {
          process.exit(0);
        }
      }, 500);
    } catch (e) {
      console.error("Error during cleanup:", e);
      if (exitAfter) {
        process.exit(1);
      }
    }
  } else if (exitAfter) {
    process.exit(0);
  }
}

process.on("SIGINT", function () {
  console.log("\nReceived SIGINT signal");
  cleanup(true);
});

function createWavHeader(dataLength) {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);

  view.setUint8(0, "R".charCodeAt(0));
  view.setUint8(1, "I".charCodeAt(0));
  view.setUint8(2, "F".charCodeAt(0));
  view.setUint8(3, "F".charCodeAt(0));
  view.setUint32(4, 36 + dataLength, true);
  view.setUint8(8, "W".charCodeAt(0));
  view.setUint8(9, "A".charCodeAt(0));
  view.setUint8(10, "V".charCodeAt(0));
  view.setUint8(11, "E".charCodeAt(0));
  view.setUint8(12, "f".charCodeAt(0));
  view.setUint8(13, "m".charCodeAt(0));
  view.setUint8(14, "t".charCodeAt(0));
  view.setUint8(15, " ".charCodeAt(0));
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 24000 * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint8(36, "d".charCodeAt(0));
  view.setUint8(37, "a".charCodeAt(0));
  view.setUint8(38, "t".charCodeAt(0));
  view.setUint8(39, "a".charCodeAt(0));

  view.setUint32(40, dataLength, true);

  return Buffer.from(buffer);
}

function saveAndPlayAudio(base64Audio) {
  try {
    console.log("\n=== Processing Server Response ===");
    const audioData = Buffer.from(base64Audio, "base64");
    console.log("Raw audio data length:", audioData.length, "bytes");

    if (audioData.length === 0) {
      console.error("Error: Received empty audio data");
      return;
    }

    const header = createWavHeader(audioData.length);
    const wavFile = Buffer.concat([header, audioData]);

    const audioDir = "./saved_audio";
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputFile = `${audioDir}/response_${timestamp}.wav`;
    fs.writeFileSync(outputFile, wavFile);
    console.log(`Saved response to ${outputFile}`);

    console.log("Playing response...");
    exec(
      `sox "${outputFile}" -t alsa plughw:3,0 rate 24000 norm -3 vol 8`,
      (error, stdout, stderr) => {
        if (error) {
          console.error("Error playing response:", error);
        }
        console.log("\nStarting next recording...");
        startRecording(ws);
      }
    );
  } catch (error) {
    console.error("Error processing response:", error);
  }
}

function startRecording(ws) {
  if (isRecording) {
    console.log(
      "Already recording - waiting for current recording to finish..."
    );
    return;
  }

  // Ensure clean state
  isRecording = false;
  if (recordingProcess) {
    try {
      recordingProcess.kill("SIGTERM");
      recordingProcess = null;
    } catch (e) {
      console.log("Note: Could not kill previous recording process");
    }
  }

  // Clear any existing audio chunks
  responseChunks = [];

  // Wait a moment before starting new recording
  setTimeout(() => {
    isRecording = true;
    console.log("\n=== Starting New Recording Session ===");
    console.log("Initializing audio capture...");
    console.log(
      "Start speaking - VAD will automatically detect voice activity"
    );

    const audioDir = "./saved_audio";
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir);
    }

    const tempFile = `${audioDir}/temp_recording.wav`;

    // Record audio continuously to a WAV file
    recordingProcess = spawn("rec", [
      "-t",
      "alsa",
      "default", // Use default input device
      "-t",
      "wav", // Output format
      tempFile, // Output file
      "rate",
      "24k", // Sample rate
      "channels",
      "1", // Mono
      "trim",
      "0",
      "2", // Record in 2-second chunks
      ":" // Loop recording
    ]);

    let lastSize = 44; // Start after WAV header
    const CHUNK_SIZE = 48000; // 2 seconds of audio at 24kHz

    // Check for new data every 100ms
    const checkInterval = setInterval(() => {
      try {
        if (!fs.existsSync(tempFile)) return;

        const stats = fs.statSync(tempFile);
        if (stats.size > lastSize) {
          const fd = fs.openSync(tempFile, "r");
          const buffer = Buffer.alloc(stats.size - lastSize);

          fs.readSync(fd, buffer, 0, stats.size - lastSize, lastSize);
          fs.closeSync(fd);

          // Send the new data
          ws.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: buffer.toString("base64")
            })
          );

          lastSize = stats.size;
        }
      } catch (error) {
        if (!error.message.includes("ENOENT")) {
          console.error("Error reading audio data:", error);
        }
      }
    }, 100);

    recordingProcess.stderr.on("data", (data) => {
      const info = data.toString().toLowerCase();
      if (info.includes("error") || info.includes("warning")) {
        console.log("Recording debug:", info);
      } else {
        console.log("Audio info:", info);
      }
    });

    recordingProcess.on("error", (error) => {
      console.error("Recording process error:", error);
      clearInterval(checkInterval);
      isRecording = false;
      recordingProcess = null;
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {}
    });

    recordingProcess.on("close", () => {
      console.log("Recording stopped");
      clearInterval(checkInterval);
      isRecording = false;
      recordingProcess = null;
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {}
    });
  }, 1000);
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

function base64EncodeAudio(float32Array) {
  const arrayBuffer = floatTo16BitPCM(float32Array);
  let binary = "";
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

function playAudioChunk(base64Audio) {
  try {
    // Stop recording before playing audio
    if (recordingProcess) {
      console.log("Pausing recording for playback...");
      recordingProcess.kill("SIGTERM");
      recordingProcess = null;
      isRecording = false;
    }

    const audioData = Buffer.from(base64Audio, "base64");
    totalAudioLength += audioData.length;

    // Initialize stream and playback process if not already running
    if (!audioStream || !playbackProcess) {
      audioStream = new PassThrough();
      playbackStartTime = Date.now();

      // Create WAV header for the stream
      const header = createWavHeader(1000000); // Use a large enough size
      audioStream.write(header);

      // Start sox process for streaming playback
      playbackProcess = spawn("sox", [
        "-t",
        "wav",
        "-", // Read from stdin
        "-t",
        "alsa",
        "plughw:3,0", // Output device
        "rate",
        "24k",
        "norm",
        "-3",
        "vol",
        "5",
        "pad",
        "0.2", // Add padding at start
        "0.5", // Add padding at end
        "gain",
        "-n", // Normalize audio
        "dither", // Add dither for smoother playback
        "-s" // Show progress
      ]);

      // Pipe audio stream to sox
      audioStream.pipe(playbackProcess.stdin);

      // Handle playback process events
      playbackProcess.on("error", (error) => {
        console.error("Playback error:", error);
      });

      playbackProcess.stderr.on("data", (data) => {
        const info = data.toString();
        if (!info.includes("PROGRESS")) {
          console.log("Playback info:", info);
        }
      });

      playbackProcess.stdout.on("data", (data) => {
        console.log("Playback progress:", data.toString());
      });

      playbackProcess.on("close", (code) => {
        console.log(`Playback process closed with code ${code}`);
        audioStream = null;
        playbackProcess = null;
      });
    }

    // Write chunk to the stream
    audioStream.write(audioData);
  } catch (error) {
    console.error("Error playing audio chunk:", error);
  }
}

function endAudioPlayback() {
  return new Promise((resolve) => {
    if (!audioStream && !playbackProcess) {
      resolve();
      return;
    }

    console.log("Waiting for playback to complete...");

    // End the audio stream first
    if (audioStream) {
      audioStream.end();
    }

    if (playbackProcess) {
      // Wait for the playback process to finish naturally
      playbackProcess.once("close", () => {
        console.log("Playback process finished naturally");
        audioStream = null;
        playbackProcess = null;
        totalAudioLength = 0;
        playbackStartTime = 0;

        // Add a longer delay after playback finishes
        setTimeout(resolve, 1000);
      });

      // End the process input
      playbackProcess.stdin.end();
    } else {
      resolve();
    }
  });
}

ws.on("open", async function open() {
  console.log("Connected to server.");
  console.log("Waiting for session to be created...");
});

ws.on("message", async function handleEvent(message) {
  const serverEvent = JSON.parse(message.toString());

  if (serverEvent.type === "session.created") {
    sessionId = serverEvent.session;
    console.log("Session created:", sessionId);

    // Configure session with semantic VAD
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a helpful AI assistant. Please provide clear and concise responses.",
          input_audio_format: "pcm16",
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: true
          }
        }
      })
    );

    console.log("\nStarting first recording...");
    startRecording(ws);
  } else if (serverEvent.type === "response.audio.delta") {
    console.log("Received audio chunk:", serverEvent.delta.length, "bytes");
    responseChunks.push(serverEvent.delta);
    await playAudioChunk(serverEvent.delta);
  } else if (serverEvent.type === "response.content_part.done") {
    console.log("\n=== Response Audio Ready ===");
    console.log("Transcript:", serverEvent.part.transcript);

    // Wait longer for any remaining audio chunks to be processed
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Ensure playback completes
    console.log("Finishing playback...");
    await endAudioPlayback();
    console.log("Playback finished completely");

    // Add extra buffer time after playback
    await new Promise((resolve) => setTimeout(resolve, 500));

    responseChunks = [];

    // Add a longer delay before starting next recording
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log("\nStarting next recording...");
    startRecording(ws);
  } else if (serverEvent.type === "response.end") {
    console.log("Full response completed");
  }
});

ws.on("error", function error(err) {
  console.error("WebSocket error:", err);
  cleanup(true);
});

ws.on("close", function close() {
  console.log("WebSocket connection closed");
  cleanup(true);
});
