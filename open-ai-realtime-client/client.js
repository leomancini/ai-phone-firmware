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
let ledOffTimer = null;

function playWelcomeAudio() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "started_playing_welcome_message"
        })
      );
      const welcomeProcess = spawn("sox", [
        audioDirectory + "/alloy-welcome.wav",
        "-q",
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

      welcomeProcess.on("error", (error) => {
        console.error("Error playing welcome audio:", error);
        resolve();
      });

      welcomeProcess.on("close", (code) => {
        if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
          handsetWs.send(
            JSON.stringify({
              event: "open_ai_realtime_client_message",
              message: "finished_playing_welcome_message"
            })
          );

          if (handsetState === "up") {
            handsetWs.send(JSON.stringify({ event: "led_off" }));
          }
        }

        resolve();
      });
    }, 1000);
  });
}

function initHandsetWebSocket() {
  handsetWs = new WebSocket(HARDWARE_SOCKET_SERVER);

  handsetWs.on("message", function message(data) {
    try {
      const event = JSON.parse(data.toString());
      if (event.event === "handset_state") {
        handsetState = event.state;
        if (event.state === "up") {
          playWelcomeAudio();
          initOpenAIWebSocket();
        } else if (event.state === "down") {
          if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
            handsetWs.send(JSON.stringify({ event: "led_on" }));
          }

          exec("pkill -9 rec");
          stopRecording();

          const ensureRecordingStopped = async () => {
            if (isRecording || recordingProcess) {
              stopRecording();
              await new Promise((resolve) => setTimeout(resolve, 500));
              return ensureRecordingStopped();
            }

            await endAudioPlayback();
            cleanup(false);
            ws = null;
          };

          ensureRecordingStopped().catch((error) => {
            console.error("Error during recording cleanup:", error);
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
    setTimeout(initHandsetWebSocket, 5000);
  });

  handsetWs.on("close", function close() {
    setTimeout(initHandsetWebSocket, 5000);
  });
}

function initOpenAIWebSocket() {
  if (ws) {
    return;
  }

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
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "openai_error",
          error: err.message || "Unknown error"
        })
      );
    }
    cleanup(false);
  });

  ws.on("close", function close() {
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "openai_disconnected"
        })
      );
    }
    cleanup(false);
  });
}

function stopRecording() {
  if (recordingProcess) {
    try {
      const killProcess = () => {
        try {
          if (!recordingProcess || recordingProcess.killed) return;

          recordingProcess.kill("SIGTERM");

          setTimeout(() => {
            if (!recordingProcess || recordingProcess.killed) return;

            recordingProcess.kill("SIGKILL");

            setTimeout(() => {
              if (!recordingProcess || recordingProcess.killed) return;

              exec("pkill -9 rec", () => {
                recordingProcess = null;
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

  if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
    handsetWs.send(
      JSON.stringify({
        event: "recording_state",
        state: "stopped"
      })
    );
  }

  try {
    const tempFile = `${tempAudioDirectory}/recording.wav`;
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  } catch (error) {
    console.error("Error cleaning up temp recording file:", error);
  }
}

function cleanup(exitAfter = true) {
  if (cleanupInProgress) return;
  cleanupInProgress = true;

  stopRecording();
  endAudioPlayback();

  responseChunks = [];
  audioBuffer = [];
  isProcessingAudio = false;
  isPlaying = false;
  totalAudioLength = 0;
  playbackStartTime = 0;

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
  if (isRecording) {
    return;
  }

  isRecording = false;
  if (recordingProcess) {
    try {
      recordingProcess.kill("SIGTERM");
      recordingProcess = null;
    } catch (e) {
      console.error(e);
    }
  }

  setTimeout(() => {
    try {
      responseChunks = [];

      isRecording = true;

      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "recording_started"
          })
        );
      }

      const tempFile = `${tempAudioDirectory}/recording.wav`;

      recordingProcess = spawn("rec", [
        "-q",
        "-t",
        "alsa",
        "default",
        "-t",
        "wav",
        tempFile,
        "rate",
        "24k",
        "channels",
        "1",
        "trim",
        "0",
        "2",
        ":"
      ]);

      let lastSize = 44;

      const checkInterval = setInterval(() => {
        try {
          if (!fs.existsSync(tempFile)) return;

          const stats = fs.statSync(tempFile);
          if (stats.size > lastSize) {
            const fd = fs.openSync(tempFile, "r");
            const buffer = Buffer.alloc(stats.size - lastSize);

            fs.readSync(fd, buffer, 0, stats.size - lastSize, lastSize);
            fs.closeSync(fd);

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
          if (
            info.includes("can't encode") ||
            info.includes("not applicable")
          ) {
            clearInterval(checkInterval);
            if (recordingProcess) {
              recordingProcess.kill("SIGTERM");
              recordingProcess = null;
            }
            isRecording = false;
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
        }
      });

      recordingProcess.on("error", (error) => {
        console.error("Recording process error:", error);
        clearInterval(checkInterval);
        isRecording = false;
        recordingProcess = null;

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

        setTimeout(() => startRecording(ws), 1000);
      });

      recordingProcess.on("close", (code) => {
        clearInterval(checkInterval);
        isRecording = false;
        recordingProcess = null;
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
  }, 500);
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

    if (!audioStream || !playbackProcess || playbackProcess.killed) {
      await endAudioPlayback();

      audioStream = new PassThrough();
      playbackStartTime = Date.now();
      isPlaying = true;

      const header = createWavHeader(50000000);
      audioStream.write(header);

      playbackProcess = spawn("sox", [
        "-q",
        "--buffer",
        "512",
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

      if (!playbackProcess.pid) {
        throw new Error("Failed to start playback process");
      }

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
        cleanupAudio();
      });

      setTimeout(() => {
        if (playbackProcess && !playbackProcess.killed && !isPlaying) {
          console.error("Playback process not playing after initialization");
          cleanupAudio();
        }
      }, 1000);
    }

    if (
      !audioStream ||
      audioStream.destroyed ||
      !playbackProcess ||
      playbackProcess.killed
    ) {
      console.error("Invalid playback state, reinitializing...");
      await endAudioPlayback();
      return playAudioChunk(base64Audio);
    }

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
      playbackProcess.once("close", () => {
        cleanupAudio();
        resolve();
      });

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
            eagerness: "high",
            create_response: true,
            interrupt_response: true
          }
        }
      })
    );

    startRecording(ws);
  } else if (serverEvent.type === "input_audio_buffer.speech_started") {
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "user_input_started"
        })
      );
    }
  } else if (serverEvent.type === "input_audio_buffer.speech_stopped") {
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "user_input_stopped"
        })
      );
    }
  } else if (serverEvent.type === "response.audio.delta") {
    if (!isPlaying) {
      isPlaying = true;

      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        if (handsetState === "up") {
          handsetWs.send(JSON.stringify({ event: "led_off" }));
        }
        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "openai_response_started"
          })
        );
      }
    }

    const chunkSize = serverEvent.delta.length;

    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: `Received audio chunk: ${chunkSize} bytes`
        })
      );

      if (handsetState === "up") {
        handsetWs.send(JSON.stringify({ event: "led_on" }));
      }
      if (ledOffTimer) clearTimeout(ledOffTimer);
      ledOffTimer = setTimeout(() => {
        if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
          if (handsetState === "up") {
            handsetWs.send(JSON.stringify({ event: "led_off" }));
          }
        }
      }, 50);
    }

    playAudioChunk(serverEvent.delta);
  } else if (serverEvent.type === "response.content_part.done") {
    const responseText = serverEvent.part.transcript;

    isResponseComplete = true;
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      if (ledOffTimer) clearTimeout(ledOffTimer);
      ledOffTimer = null;
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: `Full response: ${responseText}`
        })
      );
    }

    const checkPlaybackComplete = setInterval(() => {
      if (Date.now() - lastChunkTime > chunkTimeout) {
        clearInterval(checkPlaybackComplete);

        setTimeout(async () => {
          await endAudioPlayback();
          if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
            if (handsetState === "up") {
              handsetWs.send(JSON.stringify({ event: "led_off" }));
            }
          }

          isResponseComplete = false;
          isPlaying = false;

          if (!isRecording && handsetState === "up") {
            startRecording(ws);
          }
        }, 1000);
      }
    }, 100);
  }
}

initHandsetWebSocket();

setTimeout(() => {
  if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
    handsetWs.send(JSON.stringify({ event: "led_on" }));
  }
}, 1000);

process.on("SIGTERM", () => {
  cleanup(true);
});
