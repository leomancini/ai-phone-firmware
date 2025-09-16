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
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";
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
let ledSafetyCheckInterval = null;

function playWelcomeAudio() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
        if (handsetState === "up") {
          handsetWs.send(JSON.stringify({ event: "led_on" }));
        }

        handsetWs.send(
          JSON.stringify({
            event: "open_ai_realtime_client_message",
            message: "Started playing welcome message"
          })
        );
      }

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
              message: "Finished playing welcome message"
            })
          );

          if (handsetState === "up") {
            handsetWs.send(JSON.stringify({ event: "led_off" }));
            setTimeout(() => {
              handsetWs.send(JSON.stringify({ event: "led_on" }));
            }, 200);
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
          if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
            handsetWs.send(JSON.stringify({ event: "led_off" }));
          }

          if (ledSafetyCheckInterval) {
            clearInterval(ledSafetyCheckInterval);
          }

          ledSafetyCheckInterval = setInterval(() => {
            if (
              handsetState === "up" &&
              handsetWs &&
              handsetWs.readyState === WebSocket.OPEN
            ) {
              handsetWs.send(JSON.stringify({ event: "led_on" }));
            }
          }, 5000);

          playWelcomeAudio();
          initOpenAIWebSocket();
        } else if (event.state === "down") {
          if (ledSafetyCheckInterval) {
            clearInterval(ledSafetyCheckInterval);
            ledSafetyCheckInterval = null;
          }

          if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
            handsetWs.send(JSON.stringify({ event: "led_off" }));
            setTimeout(() => {
              handsetWs.send(JSON.stringify({ event: "led_on" }));
            }, 200);

            handsetWs.send(
              JSON.stringify({
                event: "open_ai_realtime_client_message",
                message: "Handset down"
              })
            );
          }

          exec("pkill -9 rec");
          stopRecording();

          const ensureRecordingStopped = async () => {
            if (isRecording || recordingProcess) {
              stopRecording();
              await new Promise((resolve) => setTimeout(resolve, 500));
              return ensureRecordingStopped();
            }

            if (playbackProcess && !playbackProcess.killed) {
              if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
                handsetWs.send(
                  JSON.stringify({
                    event: "open_ai_realtime_client_message",
                    message: "Stopping audio playback because handset is down"
                  })
                );
              }

              try {
                playbackProcess.kill("SIGKILL");
              } catch (err) {
                console.error("Error killing playback process:", err);
              }
              playbackProcess = null;
            }

            if (audioStream && !audioStream.destroyed) {
              try {
                audioStream.destroy();
              } catch (err) {
                console.error("Error destroying audio stream:", err);
              }
              audioStream = null;
            }

            isPlaying = false;

            if (ws && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: "session.end" }));
                ws.close();
              } catch (e) {
                console.error("Error closing OpenAI session:", e);
              }
            }

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
        message: "Connecting to OpenAI"
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
          message: "Connected to OpenAI"
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
          message: "OpenAI error",
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
          message: "Disconnected from OpenAI"
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

  if (ledSafetyCheckInterval) {
    clearInterval(ledSafetyCheckInterval);
    ledSafetyCheckInterval = null;
  }

  if (playbackProcess && !playbackProcess.killed) {
    try {
      playbackProcess.kill("SIGKILL");
    } catch (error) {
      console.error("Error killing playback process:", error);
    }
    playbackProcess = null;
  }

  if (audioStream && !audioStream.destroyed) {
    try {
      audioStream.destroy();
    } catch (error) {
      console.error("Error destroying audio stream:", error);
    }
    audioStream = null;
  }

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
            message: "Started recording"
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
                  message: "Stopped recording"
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
              message: "Stopped recording"
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
              message: "Stopped recording"
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
            message: "Stopped recording"
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
      if (playbackProcess) {
        try {
          playbackProcess.kill();
          playbackProcess = null;
        } catch (err) {
          console.error("Error killing existing playback process:", err);
        }
      }

      if (audioStream) {
        try {
          audioStream.end();
          audioStream = null;
        } catch (err) {
          console.error("Error ending existing audio stream:", err);
        }
      }

      audioStream = new PassThrough({ highWaterMark: 512 });
      playbackStartTime = Date.now();
      isPlaying = true;

      const header = createWavHeader(2000000);
      audioStream.write(header);

      playbackProcess = spawn("sox", [
        "-q",
        "--buffer",
        "64",
        "-t",
        "wav",
        "-",
        "-t",
        "alsa",
        "plughw:3,0",
        "rate",
        "24k",
        "vol",
        "5",
        "stat"
      ]);

      if (!playbackProcess.pid) {
        throw new Error("Failed to start playback process");
      }

      audioStream.on("error", (error) => {
        if (error.code !== "EPIPE") {
          console.error("Audio stream error:", error);
        }
      });

      playbackProcess.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          console.error("Playback stdin error:", error);
        }
      });

      try {
        audioStream.pipe(playbackProcess.stdin, { end: false });
      } catch (error) {
        console.error("Error setting up audio pipe:", error);
        return;
      }

      playbackProcess.stdin.on("drain", () => {
        if (audioStream && !audioStream.destroyed) {
          audioStream.resume();
        }
      });

      let stderrData = "";

      playbackProcess.stderr.on("data", (data) => {
        stderrData += data.toString();
      });

      playbackProcess.on("close", (code) => {
        if (isPlaying && handsetState === "up") {
          if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
            handsetWs.send(
              JSON.stringify({
                event: "open_ai_realtime_client_message",
                message: "Playback process completed"
              })
            );
          }
        }

        isPlaying = false;
        playbackProcess = null;
        audioStream = null;
      });
    }

    if (
      audioStream &&
      !audioStream.destroyed &&
      playbackProcess &&
      !playbackProcess.killed
    ) {
      try {
        const canWrite = audioStream.write(audioData);
        if (!canWrite) {
          setTimeout(() => {
            if (audioStream && !audioStream.destroyed) {
              audioStream.resume();
            }
          }, 5);
        }
      } catch (error) {
        console.error("Error writing audio data:", error);
      }
    } else {
      if (audioStream) audioStream.end();
      if (playbackProcess && !playbackProcess.killed) playbackProcess.kill();

      audioStream = null;
      playbackProcess = null;

      setTimeout(() => playAudioChunk(base64Audio), 10);
    }
  } catch (error) {
    console.error("Error playing audio chunk:", error);
  }
}

function cleanupAudio() {
  if (playbackProcess && !playbackProcess.killed) {
    if (!playbackProcess._naturalCompletionListenerAdded) {
      playbackProcess._naturalCompletionListenerAdded = true;

      playbackProcess.once("close", () => {
        audioStream = null;
        playbackProcess = null;
        isPlaying = false;
      });
    }
  } else {
    playbackProcess = null;
  }

  if (audioStream && !audioStream.destroyed) {
    audioStream.once("end", () => {
      audioStream = null;
    });
  } else {
    audioStream = null;
  }

  totalAudioLength = 0;
  playbackStartTime = 0;
  audioBuffer = [];
  isProcessingAudio = false;
  lastChunkTime = 0;
}

function endAudioPlayback() {
  return new Promise((resolve) => {
    if (!audioStream && !playbackProcess) {
      resolve();
      return;
    }

    if (playbackProcess && !playbackProcess.killed) {
      if (!playbackProcess._naturalCompletionListenerAdded) {
        playbackProcess._naturalCompletionListenerAdded = true;

        playbackProcess.once("close", () => {
          audioStream = null;
          playbackProcess = null;
          isPlaying = false;
          resolve();
        });
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
            "You are a helpful AI assistant for people visiting FCC Studio. Please provide clear and concise responses, under 50 words.",
          input_audio_format: "pcm16",
          turn_detection: {
            type: "server_vad",
            threshold: 0.25,
            prefix_padding_ms: 250,
            silence_duration_ms: 250,
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
          message: "User started talking"
        })
      );
    }
  } else if (serverEvent.type === "input_audio_buffer.speech_stopped") {
    if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
      handsetWs.send(
        JSON.stringify({
          event: "open_ai_realtime_client_message",
          message: "User stopped talking"
        })
      );
      if (handsetState === "up") {
        handsetWs.send(JSON.stringify({ event: "led_off" }));
        setTimeout(() => {
          handsetWs.send(JSON.stringify({ event: "led_on" }));
        }, 200);
      }
    }
  } else if (serverEvent.type === "response.audio.delta") {
    playAudioChunk(serverEvent.delta);
    lastChunkTime = Date.now();

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
        if (ledOffTimer) clearTimeout(ledOffTimer);
        ledOffTimer = setTimeout(() => {
          if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
            handsetWs.send(JSON.stringify({ event: "led_off" }));

            setTimeout(() => {
              if (handsetWs && handsetWs.readyState === WebSocket.OPEN) {
                handsetWs.send(JSON.stringify({ event: "led_on" }));
              }
            }, 50);
          }
        }, 50);
      }
    }
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

    const waitForNaturalCompletion = () => {
      if (Date.now() - lastChunkTime < chunkTimeout) {
        setTimeout(waitForNaturalCompletion, 100);
        return;
      }

      if (playbackProcess) {
        if (!playbackProcess._naturalCompletionListenerAdded) {
          playbackProcess._naturalCompletionListenerAdded = true;

          playbackProcess.once("close", () => {
            isResponseComplete = false;
            isPlaying = false;

            if (!isRecording && handsetState === "up") {
              startRecording(ws);
            }
          });
        }
      } else {
        isResponseComplete = false;
        isPlaying = false;

        if (!isRecording && handsetState === "up") {
          startRecording(ws);
        }
      }
    };

    setTimeout(waitForNaturalCompletion, 100);
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
  process.exit(0);
});

process.on("SIGINT", () => {
  cleanup(true);
  process.exit(0);
});
