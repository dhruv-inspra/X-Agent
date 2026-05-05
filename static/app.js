const WS_BASE_URL = "wss://api.x.ai/v1/realtime";
const SAMPLE_RATE = 24000;

const speakButton = document.getElementById("speakButton");
const buttonText = document.getElementById("buttonText");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const eventsEl = document.getElementById("events");
const clearButton = document.getElementById("clearButton");
const modelName = document.getElementById("modelName");
const voiceName = document.getElementById("voiceName");
const micState = document.getElementById("micState");

let socket;
let mediaStream;
let captureContext;
let playbackContext;
let processor;
let source;
let isRecording = false;
let playbackCursor = 0;
let activeAgentMessage;
let playbackNodes = [];

function setStatus(text, mode = "") {
  statusEl.textContent = text;
  statusEl.className = `status-pill ${mode}`.trim();
}

function logEvent(text) {
  const row = document.createElement("div");
  row.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  eventsEl.appendChild(row);
  eventsEl.scrollTop = eventsEl.scrollHeight;
}

function appendMessage(role, text = "") {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  message.innerHTML = `<span class="role">${role === "user" ? "You" : "Agent"}</span><span class="text"></span>`;
  message.querySelector(".text").textContent = text;
  transcriptEl.appendChild(message);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return message;
}

function addOrUpdateUserTranscript(text) {
  if (!text) return;
  appendMessage("user", text);
}

function addAgentDelta(text) {
  if (!text) return;
  if (!activeAgentMessage) {
    activeAgentMessage = appendMessage("agent", "");
  }
  const target = activeAgentMessage.querySelector(".text");
  target.textContent += text;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function finalizeAgentMessage() {
  activeAgentMessage = null;
}

function floatToPcm16(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function pcm16ToFloat32(buffer) {
  const view = new DataView(buffer);
  const samples = new Float32Array(buffer.byteLength / 2);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return samples;
}

function playPcmDelta(base64Audio) {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    playbackCursor = playbackContext.currentTime;
  }

  const samples = pcm16ToFloat32(base64ToArrayBuffer(base64Audio));
  const audioBuffer = playbackContext.createBuffer(1, samples.length, SAMPLE_RATE);
  audioBuffer.copyToChannel(samples, 0);

  const node = playbackContext.createBufferSource();
  node.buffer = audioBuffer;
  node.connect(playbackContext.destination);
  playbackNodes.push(node);
  node.onended = () => {
    playbackNodes = playbackNodes.filter((queuedNode) => queuedNode !== node);
  };

  const startAt = Math.max(playbackContext.currentTime, playbackCursor);
  node.start(startAt);
  playbackCursor = startAt + audioBuffer.duration;
}

async function loadConfig() {
  const response = await fetch("/config");
  const config = await response.json();
  modelName.textContent = config.model;
  voiceName.textContent = config.voice;
}

async function createSession() {
  const response = await fetch("/session", { method: "POST" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Could not create xAI realtime session.");
  }
  return response.json();
}

function connectRealtime(session) {
  const url = `${WS_BASE_URL}?model=${encodeURIComponent(session.model)}`;
  socket = new WebSocket(url, [`xai-client-secret.${session.token}`]);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: session.voice,
        instructions: session.instructions,
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 900,
          prefix_padding_ms: 333,
        },
        audio: {
          input: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
          output: { format: { type: "audio/pcm", rate: SAMPLE_RATE } },
        },
        tools: [
          {
            type: "function",
            name: "end_call",
            description: "End the current voice call silently when the conversation should be closed.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      },
    }));
    setStatus("Live", "live");
    logEvent("Connected to realtime voice API");
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    handleRealtimeEvent(data);
  });

  socket.addEventListener("close", () => {
    logEvent("Realtime connection closed");
    stopSession(false);
  });

  socket.addEventListener("error", () => {
    setStatus("Error", "error");
    logEvent("Realtime connection error");
  });
}

function handleRealtimeEvent(event) {
  if (event.type === "response.output_audio.delta" && event.delta) {
    playPcmDelta(event.delta);
    return;
  }

  if (
    (
      event.type === "response.text.delta"
      || event.type === "response.output_text.delta"
      || event.type === "response.output_audio_transcript.delta"
    )
    && event.delta
  ) {
    addAgentDelta(event.delta);
    return;
  }

  if (event.type === "response.output_audio_transcript.done" && event.transcript) {
    if (!activeAgentMessage) {
      appendMessage("agent", event.transcript);
    }
    finalizeAgentMessage();
    return;
  }

  if (event.type === "response.done") {
    finalizeAgentMessage();
    return;
  }

  if (event.type === "response.function_call_arguments.done") {
    handleFunctionCall(event);
    return;
  }

  if (event.type === "conversation.item.input_audio_transcription.completed") {
    addOrUpdateUserTranscript(event.transcript || event.text || "");
    return;
  }

  if (event.type === "input_audio_buffer.speech_started") {
    logEvent("Speech started");
    return;
  }

  if (event.type === "input_audio_buffer.speech_stopped") {
    logEvent("Speech stopped");
    return;
  }

  if (event.type === "error") {
    setStatus("Error", "error");
    logEvent(event.error?.message || "Realtime API error");
  }
}

function handleFunctionCall(event) {
  if (event.name !== "end_call") {
    logEvent(`Unhandled function call: ${event.name}`);
    return;
  }

  logEvent("Agent ended the call");
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify({ status: "ended" }),
      },
    }));
  }
  stopSession(true);
}

async function startMicrophone() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  captureContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  source = captureContext.createMediaStreamSource(mediaStream);
  processor = captureContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    socket.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(floatToPcm16(input)),
    }));
  };

  source.connect(processor);
  processor.connect(captureContext.destination);
  micState.textContent = "On";
}

async function startSession() {
  setStatus("Starting");
  speakButton.disabled = true;

  try {
    const session = await createSession();
    voiceName.textContent = session.voice;
    modelName.textContent = session.model;
    connectRealtime(session);
    await startMicrophone();

    isRecording = true;
    speakButton.classList.add("recording");
    buttonText.textContent = "End session";
    speakButton.disabled = false;
  } catch (error) {
    setStatus("Error", "error");
    logEvent(error.message);
    speakButton.disabled = false;
    stopSession(false);
  }
}

function stopSession(closeSocket = true) {
  isRecording = false;
  speakButton.classList.remove("recording");
  buttonText.textContent = "Speak now";
  speakButton.disabled = false;
  micState.textContent = "Off";

  if (processor) {
    processor.disconnect();
    processor.onaudioprocess = null;
    processor = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (captureContext) {
    captureContext.close();
    captureContext = null;
  }
  if (closeSocket && socket) {
    socket.close();
  }
  socket = null;
  playbackNodes.forEach((node) => {
    try {
      node.stop();
    } catch (error) {
      // Already stopped or not started.
    }
    node.disconnect();
  });
  playbackNodes = [];
  playbackCursor = 0;
  if (playbackContext) {
    playbackContext.close();
    playbackContext = null;
  }
  finalizeAgentMessage();
  if (!statusEl.classList.contains("error")) {
    setStatus("Idle");
  }
}

speakButton.addEventListener("click", () => {
  if (isRecording) {
    stopSession(true);
    return;
  }
  startSession();
});

clearButton.addEventListener("click", () => {
  transcriptEl.textContent = "";
  eventsEl.textContent = "";
  activeAgentMessage = null;
});

loadConfig().catch((error) => {
  setStatus("Error", "error");
  logEvent(error.message);
});
