import WebSocket from "ws";
import fs from "fs";
import { exec, spawn } from "child_process";
import { Buffer } from "buffer";
import dotenv from "dotenv";
import { PassThrough } from "stream";
import path from "path";

const audioDirectory = "./audio";
const tempAudioDirectory = audioDirectory + "/temp";

if (!fs.existsSync(audioDirectory)) {
  fs.mkdirSync(audioDirectory);
}

if (!fs.existsSync(tempAudioDirectory)) {
  fs.mkdirSync(tempAudioDirectory);
}

dotenv.config();

const OPENAI_REALTIME_SOCKET_SERVER =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const HARDWARE_SOCKET_SERVER = "ws://localhost:8765";

let ws = null;
let handsetWs = null;
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
let isResponseComplete = false;
let lastChunkTime = 0;
let chunkTimeout = 500;
let handsetState = "down";

function playWelcomeAudio() {
  return new Promise((resolve, reject) => {
    console.log("Waiting to play welcome audio...");
    // Add  delay before playing
    setTimeout(() => {
      console.log("Playing welcome audio...");
      const welcomeProcess = spawn("sox", [
        audioDirectory + "/alloy-welcome.wav",
        "-t",
        "alsa",
        "plughw:3,0",
        "rate",
        "24k",
        "norm",
        "-3",
        "vol",
        "5"
      ]);

      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "playing_welcome_message"
          })
        );
      }

      welcomeProcess.on("error", (error) => {
        console.error("Error playing welcome audio:", error);
        resolve(); // Resolve anyway to continue with normal flow
      });

      welcomeProcess.on("close", (code) => {
        console.log("Welcome audio finished with code:", code);
        resolve();
      });
    }, 1000);
  });
}

function initHandsetWebSocket() {
  handsetWs = new WebSocket(HARDWARE_SOCKET_SERVER);

  handsetWs.on("open", function open() {
    console.log("Connected to handset state WebSocket");
  });

  handsetWs.on("message", function message(data) {
    try {
      const event = JSON.parse(data.toString());
      console.log("Received handset event:", event);
      if (event.event === "handset_state") {
        handsetState = event.state;
        if (event.state === "up") {
          console.log("Playing welcome audio");
          playWelcomeAudio();
          console.log("Initializing OpenAI connection");
          initOpenAIWebSocket();
        } else if (event.state === "down") {
          console.log("Handset state is down - stopping current session");

          // Immediately try to kill any recording processes
          exec("pkill -9 rec", () => {
            console.log("Killed any existing rec processes");
          });

          // Stop recording
          stopRecording();

          // Wait for recording to stop before proceeding with cleanup
          const ensureRecordingStopped = async () => {
            // Try to stop recording again if needed
            if (isRecording || recordingProcess) {
              stopRecording();
              await new Promise((resolve) => setTimeout(resolve, 500));
              return ensureRecordingStopped();
            }

            // Once recording is confirmed stopped, clean up audio and session
            await endAudioPlayback();
            cleanup(false);
            ws = null;
            console.log("Ready for next handset up state");
          };

          ensureRecordingStopped().catch((error) => {
            console.error("Error during recording cleanup:", error);
            // Force cleanup as last resort
            cleanup(false);
            ws = null;
          });
        }
      }
    } catch (error) {
      console.error("Error parsing handset state message:", error);
    }
  });

  handsetWs.on("error", function error(err) {
    console.error("Handset WebSocket error:", err);
    // Try to reconnect after a delay
    setTimeout(initHandsetWebSocket, 5000);
  });

  handsetWs.on("close", function close() {
    console.log("Handset WebSocket connection closed");
    // Try to reconnect after a delay
    setTimeout(initHandsetWebSocket, 5000);
  });
}

function initOpenAIWebSocket() {
  if (ws) {
    console.log("OpenAI WebSocket already connected");
    return;
  }

  // Emit connecting event
  if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
    handsetWs.send(
      JSON.stringify({
        event: "open_ai_realtime_client_message",
        message: "openai_connecting"
      })
    );
  }

  ws = new WebSocket(OPENAI_REALTIME_SOCKET_SERVER, {
    headers: {
      Authorization: "Bearer " + process.env.OPENAI_API_KEY,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  ws.on("open", async function open() {
    console.log("Connected to OpenAI Realtime API");
    // Emit connected event
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "openai_connected"
        })
      );
    }
  });

  ws.on("message", handleEvent);
  ws.on("error", function error(err) {
    console.error("WebSocket error:", err);
    // Emit error event
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "openai_error",
          error: err.message || "Unknown error"
        })
      );
    }
    cleanup(false); // Don't exit process, just clean up resources
  });

  ws.on("close", function close() {
    console.log("WebSocket connection closed");
    // Emit disconnected event
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "openai_disconnected"
        })
      );
    }
    cleanup(false); // Don't exit process, just clean up resources
  });
}

function stopRecording() {
  if (recordingProcess) {
    console.log("Stopping recording process...");
    try {
      // Try to kill the process with increasing force
      const killProcess = () => {
        try {
          if (!recordingProcess || recordingProcess.killed) return;

          // Try SIGTERM first
          recordingProcess.kill("SIGTERM");

          setTimeout(() => {
            if (!recordingProcess || recordingProcess.killed) return;

            // If still running, try SIGKILL
            recordingProcess.kill("SIGKILL");

            setTimeout(() => {
              if (!recordingProcess || recordingProcess.killed) return;

              // If somehow still running, use pkill as last resort
              exec("pkill -9 rec", () => {
                recordingProcess = null;
                console.log("Used pkill to stop recording process");
              });
            }, 100);
          }, 100);
        } catch (error) {
          console.error("Error during process kill:", error);
          recordingProcess = null;
        }
      };

      killProcess();
    } catch (error) {
      console.error("Error stopping recording process:", error);
      recordingProcess = null;
    }
  }

  isRecording = false;

  // Emit recording state event
  if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
    handsetWs.send(
      JSON.stringify({
        event: "recording_state",
        state: "stopped"
      })
    );
  }

  // Clean up any temp files that might be left
  try {
    const tempFile = `${tempAudioDirectory}/recording.wav`;
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
      console.log("Cleaned up temporary recording file");
    }
  } catch (error) {
    console.error("Error cleaning up temp recording file:", error);
  }
}

function cleanup(exitAfter = true) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;

  console.log("\nCleaning up...");

  // Stop recording with the new function
  stopRecording();

  // Stop playback
  endAudioPlayback();

  // Clear any pending audio
  responseChunks = [];
  audioBuffer = [];
  isProcessingAudio = false;
  isPlaying = false;
  totalAudioLength = 0;
  playbackStartTime = 0;

  // Close OpenAI WebSocket connection
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "session.end" }));
        ws.close();
      }
      ws = null;
    } catch (e) {
      console.error("Error during OpenAI WebSocket cleanup:", e);
      ws = null;
    }
  }

  // Close handset WebSocket connection only if we're exiting
  if (exitAfter && handsetWs) {
    try {
      if (handsetWs.readyState === WebSocket.OPEN) {
        handsetWs.close();
      }
      handsetWs = null;
    } catch (e) {
      console.error("Error closing handset WebSocket:", e);
    }
  }

  if (exitAfter) {
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

  // Add a small delay before starting new recording to let audio device reset
  setTimeout(() => {
    try {
      // Clear any existing audio chunks
      responseChunks = [];

      isRecording = true;

      // Emit recording state event to all clients
      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "recording_started"
          })
        );
      }

      const tempFile = `${tempAudioDirectory}/recording.wav`;

      // Record audio continuously to a WAV file with explicit format settings
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
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "input_audio_buffer.append",
                  audio: buffer.toString("base64")
                })
              );
            }

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
          console.error("Recording error/warning:", info);
          // If we get a critical error, try to restart recording
          if (
            info.includes("can't encode") ||
            info.includes("not applicable")
          ) {
            console.log(
              "Critical recording error detected, attempting to restart..."
            );
            clearInterval(checkInterval);
            if (recordingProcess) {
              recordingProcess.kill("SIGTERM");
              recordingProcess = null;
            }
            isRecording = false;
            // Emit recording stopped event
            if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
              handsetWs.send(
                JSON.stringify({
                  event: "open_ai_realtime_client_message",
                  message: "recording_stopped"
                })
              );
            }
            setTimeout(() => startRecording(ws), 1000);
          }
        } else {
          console.log("Audio info:", info);
        }
      });

      recordingProcess.on("error", (error) => {
        console.error("Recording process error:", error);
        clearInterval(checkInterval);
        isRecording = false;
        recordingProcess = null;
        // Emit recording stopped event
        if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
          handsetWs.send(
            JSON.stringify({
              event: "open_ai_realtime_client_message",
              message: "recording_stopped"
            })
          );
        }
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {}
        // Try to restart recording after error
        setTimeout(() => startRecording(ws), 1000);
      });

      recordingProcess.on("close", (code) => {
        console.log("Recording stopped with code:", code);
        clearInterval(checkInterval);
        isRecording = false;
        recordingProcess = null;
        // Emit recording stopped event
        if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
          handsetWs.send(
            JSON.stringify({
              event: "open_ai_realtime_client_message",
              message: "recording_stopped"
            })
          );
        }
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {}
      });
    } catch (error) {
      console.error("Error starting recording:", error);
      isRecording = false;
      // Emit recording stopped event
      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "recording_stopped"
          })
        );
      }
      // Try to restart recording after error
      setTimeout(() => startRecording(ws), 1000);
    }
  }, 500); // Add 500ms delay before starting new recording
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
    const audioData = Buffer.from(base64Audio, "base64");
    lastChunkTime = Date.now();

    // Ensure clean state before starting new playback
    if (!audioStream || !playbackProcess || playbackProcess.killed) {
      // Clean up any existing resources first
      await endAudioPlayback();

      audioStream = new PassThrough();
      playbackStartTime = Date.now();
      isPlaying = true;

      // Create WAV header for the stream
      const header = createWavHeader(50000000);
      audioStream.write(header);

      // Start sox process for streaming playback
      playbackProcess = spawn("sox", [
        "-t",
        "wav",
        "-",
        "-t",
        "alsa",
        "plughw:3,0",
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

      // Verify playback process started successfully
      if (!playbackProcess.pid) {
        throw new Error("Failed to start playback process");
      }

      // Handle errors on the audio stream
      audioStream.on("error", (error) => {
        if (error.code !== "EPIPE") {
          console.error("Audio stream error:", error);
        }
        cleanupAudio();
      });

      playbackProcess.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          console.error("Playback stdin error:", error);
        }
        cleanupAudio();
      });

      // Set up pipe with error handling
      try {
        audioStream.pipe(playbackProcess.stdin, { highWaterMark: 1024 * 1024 });
      } catch (error) {
        console.error("Error setting up audio pipe:", error);
        cleanupAudio();
        return;
      }

      playbackProcess.on("error", (error) => {
        console.error("Playback error:", error);
        cleanupAudio();
      });

      playbackProcess.stdin.on("drain", () => {
        if (audioStream && !audioStream.destroyed) {
          audioStream.resume();
        }
      });

      playbackProcess.on("close", (code) => {
        console.log(`Playback process closed with code ${code}`);
        cleanupAudio();
      });

      // Add a watchdog to ensure process is running
      setTimeout(() => {
        if (playbackProcess && !playbackProcess.killed && !isPlaying) {
          console.error("Playback process not playing after initialization");
          cleanupAudio();
        }
      }, 1000);
    }

    // Verify we have valid stream before writing
    if (
      !audioStream ||
      audioStream.destroyed ||
      !playbackProcess ||
      playbackProcess.killed
    ) {
      console.error("Invalid playback state, reinitializing...");
      await endAudioPlayback();
      return playAudioChunk(base64Audio); // Retry once
    }

    // Write chunk immediately
    try {
      const canWrite = audioStream.write(audioData);
      if (!canWrite) {
        await new Promise((resolve) =>
          playbackProcess.stdin.once("drain", resolve)
        );
        audioStream.resume();
      }
    } catch (error) {
      if (error.code !== "EPIPE") {
        console.error("Error writing to audio stream:", error);
      }
      cleanupAudio();
    }
  } catch (error) {
    console.error("Error playing audio chunk:", error);
    cleanupAudio();
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
    isResponseComplete = false;
    lastChunkTime = 0;

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
    // If this is the first chunk of a new response
    if (!isPlaying) {
      console.log("Starting to receive OpenAI response");
      isPlaying = true;
      // Emit response started event
      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "openai_response_started"
          })
        );
      }
    }

    const chunkSize = serverEvent.delta.length;
    console.log("Received audio chunk:", chunkSize, "bytes");

    // Emit chunk received event
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: `Received audio chunk: ${chunkSize} bytes`
        })
      );
    }

    playAudioChunk(serverEvent.delta);
  } else if (serverEvent.type === "response.content_part.done") {
    const responseText = serverEvent.part.transcript;
    console.log("Response:", responseText);
    isResponseComplete = true;

    // Emit response message
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: `Full response: ${responseText}`
        })
      );
    }

    // Start a check for playback completion
    const checkPlaybackComplete = setInterval(() => {
      // Consider playback complete if no new chunks received for chunkTimeout ms
      if (Date.now() - lastChunkTime > chunkTimeout) {
        clearInterval(checkPlaybackComplete);

        // Add a small delay to ensure last chunk is fully played
        setTimeout(async () => {
          await endAudioPlayback();
          console.log("Playback finished!");
          isResponseComplete = false;
          isPlaying = false;
          // Only start recording if handset is up and not already recording
          if (!isRecording && handsetState === "up") {
            startRecording(ws);
          }
        }, 500);
      }
    }, 100);
  } else if (serverEvent.event === "open_ai_realtime_client_message") {
    // Handle incoming client messages
    if (serverEvent.message === "recording_started") {
      console.log(`Client ${serverEvent.sender} started recording`);
    } else if (serverEvent.message === "recording_stopped") {
      console.log(`Client ${serverEvent.sender} stopped recording`);
    } else if (serverEvent.message === "openai_connecting") {
      console.log(`Client ${serverEvent.sender} is connecting to OpenAI...`);
    } else if (serverEvent.message === "openai_connected") {
      console.log(`Client ${serverEvent.sender} connected to OpenAI`);
    } else if (serverEvent.message === "openai_error") {
      console.log(
        `Client ${serverEvent.sender} encountered OpenAI error: ${
          serverEvent.error || "Unknown error"
        }`
      );
    } else if (serverEvent.message === "openai_disconnected") {
      console.log(`Client ${serverEvent.sender} disconnected from OpenAI`);
    } else if (
      serverEvent.message.startsWith("Received audio chunk:") ||
      serverEvent.message.startsWith("Response:")
    ) {
      // For chunk and response messages, just log them with the sender
      console.log(`Client ${serverEvent.sender}: ${serverEvent.message}`);
    } else {
      console.log(`Message from ${serverEvent.sender}: ${serverEvent.message}`);
    }
  }
}

console.log("Starting up...");
initHandsetWebSocket();

// Add SIGTERM handler
process.on("SIGTERM", () => {
  console.log("Received SIGTERM - Cleaning up...");
  cleanup(true);
});
