// TODO: Handle longer audio responses without cutting off the response

import WebSocket from "ws";
import fs from "fs";
import { exec, spawn } from "child_process";
import { Buffer } from "buffer";
import dotenv from "dotenv";
import { PassThrough } from "stream";
import path from "path";

const audioDir = "./saved_audio";
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir);
}

dotenv.config();

const url =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17";

let ws = null;
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
let isPlaying = false;
let audioBuffer = [];
let isProcessingAudio = false;

// Initialize WebSocket connection
ws = new WebSocket(url, {
  headers: {
    Authorization: "Bearer " + process.env.OPENAI_API_KEY,
    "OpenAI-Beta": "realtime=v1"
  }
});

// Set up WebSocket event handlers
ws.on("open", async function open() {
  console.log("Connected to OpenAI Realtime API");
  startRecording(ws);
});

ws.on("message", handleEvent);
ws.on("error", function error(err) {
  console.error("WebSocket error:", err);
  cleanup(false); // Don't exit process, just clean up resources
});

ws.on("close", function close() {
  console.log("WebSocket connection closed");
  cleanup(false); // Don't exit process, just clean up resources
});

function cleanup(exitAfter = true) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;

  console.log("\nCleaning up...");

  // Stop recording
  if (recordingProcess) {
    recordingProcess.kill("SIGTERM");
    recordingProcess = null;
    isRecording = false;
  }

  // Stop playback
  endAudioPlayback();

  // Clear any pending audio
  responseChunks = [];
  audioBuffer = [];
  isProcessingAudio = false;
  isPlaying = false;
  totalAudioLength = 0;
  playbackStartTime = 0;

  // Close WebSocket connection
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "session.end" }));
        setTimeout(() => {
          ws.close();
          ws = null;
          if (exitAfter) {
            process.exit(0);
          }
        }, 500);
      } else {
        ws = null;
        if (exitAfter) {
          process.exit(0);
        }
      }
    } catch (e) {
      console.error("Error during cleanup:", e);
      ws = null;
      if (exitAfter) {
        process.exit(1);
      }
    }
  } else if (exitAfter) {
    process.exit(0);
  }

  cleanupInProgress = false;
}

process.on("SIGINT", function () {
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
  console.log("Starting recording...");
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

  isRecording = true;

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

async function playAudioChunk(base64Audio) {
  try {
    // Stop recording before playing audio
    if (recordingProcess) {
      recordingProcess.kill("SIGTERM");
      recordingProcess = null;
      isRecording = false;
    }

    const audioData = Buffer.from(base64Audio, "base64");
    totalAudioLength += audioData.length;
    audioBuffer.push(audioData);

    // If we're already processing audio, just add to buffer
    if (isProcessingAudio) {
      return;
    }

    isProcessingAudio = true;

    // Initialize stream and playback process if not already running
    if (!audioStream || !playbackProcess) {
      audioStream = new PassThrough();
      playbackStartTime = Date.now();
      isPlaying = true;

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
        "0.5",
        "0.5",
        "gain",
        "-n",
        "silence",
        "1",
        "0.1",
        "1%",
        "delay",
        "0.5"
      ]);

      // Handle errors on the audio stream
      audioStream.on("error", (error) => {
        if (error.code !== "EPIPE") {
          console.error("Audio stream error:", error);
        }
        cleanupAudio();
      });

      // Handle errors on the playback process stdin
      playbackProcess.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          console.error("Playback stdin error:", error);
        }
        cleanupAudio();
      });

      // Pipe audio stream to sox
      audioStream.pipe(playbackProcess.stdin);

      // Handle playback process events
      playbackProcess.on("error", (error) => {
        console.error("Playback error:", error);
        cleanupAudio();
      });

      // Wait for the stream to be ready before writing data
      playbackProcess.stdin.on("drain", () => {
        if (audioStream && !audioStream.destroyed) {
          audioStream.resume();
        }
      });

      playbackProcess.on("close", (code) => {
        console.log(`Playback process closed with code ${code}`);
        cleanupAudio();
      });
    }

    // Process all buffered chunks
    while (audioBuffer.length > 0) {
      const chunk = audioBuffer.shift();
      if (
        audioStream &&
        !audioStream.destroyed &&
        playbackProcess &&
        !playbackProcess.killed
      ) {
        try {
          const canWrite = audioStream.write(chunk);
          if (!canWrite) {
            audioStream.pause();
            // Put the chunk back in the buffer if we couldn't write it
            audioBuffer.unshift(chunk);
            break;
          }
        } catch (error) {
          if (error.code !== "EPIPE") {
            console.error("Error writing to audio stream:", error);
          }
          cleanupAudio();
          break;
        }
      } else {
        break;
      }
    }

    isProcessingAudio = false;
  } catch (error) {
    console.error("Error playing audio chunk:", error);
    cleanupAudio();
    isProcessingAudio = false;
  }
}

function cleanupAudio() {
  if (audioStream) {
    try {
      if (!audioStream.destroyed) {
        audioStream.end();
      }
      audioStream = null;
    } catch (error) {
      if (error.code !== "EPIPE") {
        console.error("Error cleaning up audio stream:", error);
      }
      audioStream = null;
    }
  }

  if (playbackProcess) {
    try {
      if (!playbackProcess.killed) {
        playbackProcess.kill();
      }
      playbackProcess = null;
    } catch (error) {
      console.error("Error cleaning up playback process:", error);
      playbackProcess = null;
    }
  }

  totalAudioLength = 0;
  playbackStartTime = 0;
  isPlaying = false;
  audioBuffer = [];
  isProcessingAudio = false;
}

function endAudioPlayback() {
  return new Promise((resolve) => {
    if (!audioStream && !playbackProcess) {
      resolve();
      return;
    }

    if (playbackProcess) {
      // Wait for the playback process to finish naturally
      playbackProcess.once("close", () => {
        cleanupAudio();
        resolve();
      });

      // End the process input
      if (audioStream && !audioStream.destroyed) {
        try {
          audioStream.end(() => {
            if (playbackProcess && !playbackProcess.killed) {
              playbackProcess.stdin.end();
            }
          });
        } catch (error) {
          if (error.code !== "EPIPE") {
            console.error("Error ending audio stream:", error);
          }
          cleanupAudio();
          resolve();
        }
      } else {
        cleanupAudio();
        resolve();
      }
    } else {
      resolve();
    }
  });
}

function handleEvent(message) {
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

    console.log("\nStarting recording...");
    startRecording(ws);
  } else if (serverEvent.type === "response.audio.delta") {
    console.log("Received audio chunk:", serverEvent.delta.length, "bytes");

    // Stop recording on first audio chunk to prevent feedback
    if (recordingProcess && responseChunks.length === 0) {
      console.log("Stopping recording...");
      recordingProcess.kill("SIGTERM");
      recordingProcess = null;
      isRecording = false;
    }

    responseChunks.push(serverEvent.delta);
    playAudioChunk(serverEvent.delta);
  } else if (serverEvent.type === "response.content_part.done") {
    console.log("Response:", serverEvent.part.transcript);

    // Wait a bit to ensure all chunks are played
    setTimeout(async () => {
      await endAudioPlayback();
      console.log("Playback finished!");
      startRecording(ws);
    }, 1000);
  }
}

// Add SIGTERM handler
process.on("SIGTERM", () => {
  console.log("Received SIGTERM - Cleaning up...");
  cleanup(true);
});
