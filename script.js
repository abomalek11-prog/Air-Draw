const videoEl = document.getElementById("inputVideo");
const drawCanvas = document.getElementById("drawCanvas");
const landmarkCanvas = document.getElementById("landmarkCanvas");
const drawCtx = drawCanvas.getContext("2d");
const landmarkCtx = landmarkCanvas.getContext("2d");

const cameraBtn = document.getElementById("cameraBtn");
const clearBtn = document.getElementById("clearBtn");
const saveBtn = document.getElementById("saveBtn");
const howToPlayBtn = document.getElementById("howToPlayBtn");
const modeIndicator = document.getElementById("modeIndicator");
const statusBadge = document.getElementById("statusBadge");
const cameraLiveBadge = document.getElementById("cameraLiveBadge");

const helpModal = document.getElementById("helpModal");
const startBtn = document.getElementById("startBtn");

const paletteEl = document.getElementById("palette");
const thicknessSlider = document.getElementById("thicknessSlider");
const glowSlider = document.getElementById("glowSlider");
const thicknessValue = document.getElementById("thicknessValue");
const glowValue = document.getElementById("glowValue");

const MODE = {
  IDLE: "IDLE",
  DRAWING: "DRAWING",
  GRAB: "GRAB",
  ERASING: "ERASING"
};

const MODE_META = {
  IDLE: { emoji: "✊", color: "#9db4ce" },
  DRAWING: { emoji: "☝️", color: "#5ef3ff" },
  GRAB: { emoji: "🤏", color: "#ffc270" },
  ERASING: { emoji: "✋", color: "#ff7da8" }
};

const GESTURE_CONFIG = {
  pinchThreshold: 0.24,
  openPalmThreshold: 4,
  historySize: 7,
  stableVotes: 4,
  eraseRadius: 64,
  grabSmoothing: 0.44
};

const state = {
  currentColor: "#00eaff",
  thickness: Number(thicknessSlider.value),
  glow: Number(glowSlider.value),
  cameraReady: false,
  cameraOn: false,
  currentMode: MODE.IDLE,
  drawingStroke: null,
  drawingPointsBuffer: [],
  strokes: [],
  grabbedStrokeIndex: -1,
  pinchWasActive: false,
  lastDrawPoint: null,
  filteredDrawPoint: null,
  lastGrabPoint: null,
  filteredGrabPoint: null,
  eraseCooldownMs: 120,
  lastEraseTime: 0,
  lastIndexPoint: null,
  lastPalmCenter: null,
  lastPinchActive: false,
  lastPinchPoint: null,
  particles: [],
  modeHistory: [],
  openPalmStreak: 0
};

let hands = null;
let camera = null;

function setCanvasSize() {
  const rect = drawCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  [drawCanvas, landmarkCanvas].forEach((canvas) => {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  });
}

function getCoverMapping() {
  const canvasW = drawCanvas.width;
  const canvasH = drawCanvas.height;
  const videoW = videoEl.videoWidth || canvasW;
  const videoH = videoEl.videoHeight || canvasH;

  const scale = Math.max(canvasW / videoW, canvasH / videoH);
  const renderW = videoW * scale;
  const renderH = videoH * scale;
  const offsetX = (canvasW - renderW) / 2;
  const offsetY = (canvasH - renderH) / 2;

  return { renderW, renderH, offsetX, offsetY };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function toCanvasPoint(normPoint) {
  const { renderW, renderH, offsetX, offsetY } = getCoverMapping();
  const x = (1 - normPoint.x) * renderW + offsetX;
  const y = normPoint.y * renderH + offsetY;
  return { x, y };
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function getHandMetrics(landmarks) {
  const palmWidth = Math.max(0.001, distance(landmarks[5], landmarks[17]));
  const palmHeight = Math.max(0.001, distance(landmarks[0], landmarks[9]));
  return { palmWidth, palmHeight };
}

function getPalmCenterCanvas(landmarks) {
  const palmIndices = [0, 1, 5, 9, 13, 17];
  let sumX = 0;
  let sumY = 0;

  for (const idx of palmIndices) {
    const p = toCanvasPoint(landmarks[idx]);
    sumX += p.x;
    sumY += p.y;
  }

  return {
    x: sumX / palmIndices.length,
    y: sumY / palmIndices.length
  };
}

function isFingerUp(landmarks, finger) {
  if (finger === "thumb") {
    return null;
  }

  const map = {
    index: { tip: 8, pip: 6 },
    middle: { tip: 12, pip: 10 },
    ring: { tip: 16, pip: 14 },
    pinky: { tip: 20, pip: 18 }
  };

  const node = map[finger];
  return landmarks[node.tip].y < landmarks[node.pip].y;
}

function isThumbUp(landmarks, handednessLabel) {
  const tip = landmarks[4];
  const ip = landmarks[3];
  if (handednessLabel === "Right") {
    return tip.x < ip.x;
  }
  return tip.x > ip.x;
}

function isFingerExtended(landmarks, tipId, pipId, mcpId, margin = 0.01) {
  const tip = landmarks[tipId];
  const pip = landmarks[pipId];
  const mcp = landmarks[mcpId];
  return tip.y < pip.y - margin && pip.y < mcp.y;
}

function getPinchRatio(landmarks) {
  const { palmWidth } = getHandMetrics(landmarks);
  const pinchDist = distance(landmarks[4], landmarks[8]);
  return pinchDist / palmWidth;
}

function stabilizeMode(rawMode) {
  state.modeHistory.push(rawMode);
  if (state.modeHistory.length > GESTURE_CONFIG.historySize) {
    state.modeHistory.shift();
  }

  const counts = new Map();
  for (const mode of state.modeHistory) {
    counts.set(mode, (counts.get(mode) || 0) + 1);
  }

  let bestMode = rawMode;
  let bestCount = 0;
  counts.forEach((count, mode) => {
    if (count > bestCount) {
      bestCount = count;
      bestMode = mode;
    }
  });

  if (bestCount >= GESTURE_CONFIG.stableVotes) {
    return bestMode;
  }
  return state.currentMode;
}

function detectGesture(landmarks, handednessLabel) {
  const thumbExtended = isThumbUp(landmarks, handednessLabel);
  const indexExtended = isFingerExtended(landmarks, 8, 6, 5, 0.008);
  const middleExtended = isFingerExtended(landmarks, 12, 10, 9, 0.008);
  const ringExtended = isFingerExtended(landmarks, 16, 14, 13, 0.008);
  const pinkyExtended = isFingerExtended(landmarks, 20, 18, 17, 0.008);

  const extendedCount = [thumbExtended, indexExtended, middleExtended, ringExtended, pinkyExtended].filter(Boolean).length;

  const pinchRatio = getPinchRatio(landmarks);
  const pinch = pinchRatio < GESTURE_CONFIG.pinchThreshold;
  const palmSpread =
    (distance(landmarks[8], landmarks[12]) +
      distance(landmarks[12], landmarks[16]) +
      distance(landmarks[16], landmarks[20])) /
    3;
  const { palmWidth } = getHandMetrics(landmarks);
  const spreadRatio = palmSpread / palmWidth;

  const openPalmCandidate =
    thumbExtended &&
    indexExtended &&
    middleExtended &&
    ringExtended &&
    pinkyExtended &&
    spreadRatio > 0.34 &&
    pinchRatio > 0.28;

  const openPalm = openPalmCandidate && !pinch;
  const indexOnly = indexExtended && !middleExtended && !ringExtended && !pinkyExtended && !pinch;
  const fist = extendedCount <= 1 && !pinch;

  let mode = MODE.IDLE;
  if (openPalm) {
    mode = MODE.ERASING;
  } else if (pinch) {
    mode = MODE.GRAB;
  } else if (indexOnly) {
    mode = MODE.DRAWING;
  } else if (fist) {
    mode = MODE.IDLE;
  }

  return {
    mode,
    pinch,
    pinchRatio,
    openPalmCandidate
  };
}

function updateMode(mode) {
  state.currentMode = mode;
  const meta = MODE_META[mode] || MODE_META.IDLE;
  modeIndicator.innerHTML = `<span class="mode-chip"><span class="mode-emoji">${meta.emoji}</span><span class="mode-text">${mode}</span></span>`;
  const chip = modeIndicator.querySelector(".mode-chip");
  if (chip) {
    chip.style.borderColor = `${meta.color}88`;
    chip.style.boxShadow = `0 0 22px ${meta.color}33, inset 0 0 26px ${meta.color}1f`;
  }
}

function newStroke(point) {
  return {
    color: state.currentColor,
    width: state.thickness,
    glow: state.glow,
    points: [point]
  };
}

function smoothPath(ctx, points) {
  if (!points.length) {
    return;
  }
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, 1.2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
  }

  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

function drawStroke(ctx, stroke) {
  if (!stroke || stroke.points.length === 0) {
    return;
  }

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Layered pass for strong neon halo.
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;

  ctx.globalAlpha = 0.16;
  ctx.lineWidth = stroke.width + stroke.glow * 1.15;
  ctx.shadowColor = stroke.color;
  ctx.shadowBlur = stroke.glow * 1.6;
  smoothPath(ctx, stroke.points);

  ctx.globalAlpha = 0.3;
  ctx.lineWidth = stroke.width + stroke.glow * 0.7;
  ctx.shadowBlur = stroke.glow * 1.02;
  smoothPath(ctx, stroke.points);

  ctx.globalAlpha = 1;
  ctx.lineWidth = stroke.width;
  ctx.shadowBlur = stroke.glow * 0.62;
  smoothPath(ctx, stroke.points);

  ctx.restore();
}

function spawnParticle(point, color) {
  for (let i = 0; i < 2; i += 1) {
    state.particles.push({
      x: point.x,
      y: point.y,
      vx: (Math.random() - 0.5) * 0.9,
      vy: (Math.random() - 0.5) * 0.9 - 0.1,
      life: 1,
      size: 1.5 + Math.random() * 2,
      color
    });
  }
}

function renderParticles() {
  const alive = [];
  state.particles.forEach((p) => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.005;
    p.life -= 0.04;
    if (p.life > 0) {
      drawCtx.save();
      drawCtx.globalAlpha = p.life * 0.85;
      drawCtx.fillStyle = p.color;
      drawCtx.shadowColor = p.color;
      drawCtx.shadowBlur = 16;
      drawCtx.beginPath();
      drawCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      drawCtx.fill();
      drawCtx.restore();
      alive.push(p);
    }
  });
  state.particles = alive;
}

function renderStrokes() {
  drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
  state.strokes.forEach((stroke, index) => {
    drawStroke(drawCtx, stroke);

    if (index === state.grabbedStrokeIndex && state.currentMode === MODE.GRAB) {
      drawCtx.save();
      drawCtx.strokeStyle = "rgba(255, 196, 92, 0.96)";
      drawCtx.lineWidth = Math.max(2, stroke.width * 0.42);
      drawCtx.shadowColor = "#ffbb55";
      drawCtx.shadowBlur = 28;
      drawCtx.globalAlpha = 0.82;
      smoothPath(drawCtx, stroke.points);
      drawCtx.restore();
    }
  });

  if (state.drawingStroke) {
    drawStroke(drawCtx, state.drawingStroke);
  }

  renderParticles();
}

function commitDrawingStroke() {
  if (state.drawingStroke && state.drawingStroke.points.length > 1) {
    state.strokes.push(state.drawingStroke);
  }
  state.drawingStroke = null;
  state.drawingPointsBuffer.length = 0;
  state.lastDrawPoint = null;
  state.filteredDrawPoint = null;
}

function drawModeTick(indexPoint) {
  const smoothingFactor = 0.26;
  if (!state.filteredDrawPoint) {
    state.filteredDrawPoint = indexPoint;
  }
  const smoothPoint = lerpPoint(state.filteredDrawPoint, indexPoint, smoothingFactor);
  state.filteredDrawPoint = smoothPoint;

  if (!state.lastDrawPoint) {
    state.lastDrawPoint = smoothPoint;
  }

  const segmentDistance = distance(state.lastDrawPoint, smoothPoint);
  if (segmentDistance < 0.35) {
    return;
  }

  if (!state.drawingStroke) {
    state.drawingStroke = newStroke(state.lastDrawPoint);
  }

  const steps = Math.max(1, Math.ceil(segmentDistance / 1.6));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const p = lerpPoint(state.lastDrawPoint, smoothPoint, t);
    state.drawingStroke.points.push(p);
    if (i % 2 === 0) {
      spawnParticle(p, state.currentColor);
    }
  }

  state.lastDrawPoint = smoothPoint;
}

function findNearestStroke(point, radius = 68) {
  let bestIndex = -1;
  let bestDistance = Infinity;

  state.strokes.forEach((stroke, index) => {
    for (let i = 0; i < stroke.points.length; i += 1) {
      const d = distance(point, stroke.points[i]);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = index;
      }
    }
  });

  if (bestDistance <= radius) {
    return bestIndex;
  }
  return -1;
}

function grabModeTick(indexPoint, pinchActive) {
  if (pinchActive && !state.pinchWasActive) {
    state.grabbedStrokeIndex = findNearestStroke(indexPoint);
    state.lastGrabPoint = indexPoint;
    state.filteredGrabPoint = indexPoint;
  }

  if (pinchActive && state.grabbedStrokeIndex >= 0 && state.lastGrabPoint) {
    state.filteredGrabPoint = lerpPoint(
      state.filteredGrabPoint || indexPoint,
      indexPoint,
      GESTURE_CONFIG.grabSmoothing
    );
    const dx = state.filteredGrabPoint.x - state.lastGrabPoint.x;
    const dy = state.filteredGrabPoint.y - state.lastGrabPoint.y;

    const stroke = state.strokes[state.grabbedStrokeIndex];
    if (stroke) {
      stroke.points.forEach((p) => {
        p.x += dx;
        p.y += dy;
      });
    }
    state.lastGrabPoint = state.filteredGrabPoint;
  }

  if (!pinchActive) {
    state.grabbedStrokeIndex = -1;
    state.lastGrabPoint = null;
    state.filteredGrabPoint = null;
  }

  state.pinchWasActive = pinchActive;
  state.lastPinchActive = pinchActive;
}

function eraseModeTick(indexPoint) {
  const now = performance.now();
  if (now - state.lastEraseTime < state.eraseCooldownMs) {
    return;
  }

  const eraseRadius = GESTURE_CONFIG.eraseRadius;
  const survivors = [];

  for (const stroke of state.strokes) {
    let nearest = Infinity;
    for (const p of stroke.points) {
      nearest = Math.min(nearest, distance(p, indexPoint));
    }
    if (nearest > eraseRadius) {
      survivors.push(stroke);
    }
  }
  state.strokes = survivors;

  state.lastEraseTime = now;
}

function clearLandmarks() {
  landmarkCtx.clearRect(0, 0, landmarkCanvas.width, landmarkCanvas.height);
}

function drawLine(a, b, color, width) {
  landmarkCtx.save();
  landmarkCtx.beginPath();
  landmarkCtx.moveTo(a.x, a.y);
  landmarkCtx.lineTo(b.x, b.y);
  landmarkCtx.strokeStyle = color;
  landmarkCtx.lineWidth = width;
  landmarkCtx.lineCap = "round";
  landmarkCtx.lineJoin = "round";
  landmarkCtx.shadowColor = color;
  landmarkCtx.shadowBlur = 5;
  landmarkCtx.stroke();
  landmarkCtx.restore();
}

function drawDot(p, radius, color, glow) {
  landmarkCtx.save();
  landmarkCtx.beginPath();
  landmarkCtx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  landmarkCtx.fillStyle = color;
  landmarkCtx.shadowColor = color;
  landmarkCtx.shadowBlur = glow;
  landmarkCtx.fill();
  landmarkCtx.restore();
}

function drawGrabFeedback(indexPoint) {
  if (!indexPoint || state.currentMode !== MODE.GRAB) {
    return;
  }

  const pulse = 1 + Math.sin(performance.now() * 0.012) * 0.1;
  const radius = state.lastPinchActive ? 20 * pulse : 12;
  const color = state.lastPinchActive ? "rgba(255, 188, 92, 0.92)" : "rgba(255, 171, 84, 0.62)";

  landmarkCtx.save();
  landmarkCtx.beginPath();
  landmarkCtx.arc(indexPoint.x, indexPoint.y, radius, 0, Math.PI * 2);
  landmarkCtx.strokeStyle = color;
  landmarkCtx.lineWidth = state.lastPinchActive ? 2.6 : 1.8;
  landmarkCtx.shadowColor = "#ffb75a";
  landmarkCtx.shadowBlur = 22;
  landmarkCtx.stroke();

  if (state.lastPinchPoint && state.lastPinchActive) {
    landmarkCtx.beginPath();
    landmarkCtx.arc(state.lastPinchPoint.x, state.lastPinchPoint.y, 4.6, 0, Math.PI * 2);
    landmarkCtx.fillStyle = "rgba(255, 204, 130, 0.95)";
    landmarkCtx.shadowColor = "#ffc16c";
    landmarkCtx.shadowBlur = 16;
    landmarkCtx.fill();
  }
  landmarkCtx.restore();
}

function drawEraseFeedback(indexPoint) {
  if (!indexPoint || state.currentMode !== MODE.ERASING) {
    return;
  }

  const radius = GESTURE_CONFIG.eraseRadius;
  landmarkCtx.save();
  landmarkCtx.beginPath();
  landmarkCtx.arc(indexPoint.x, indexPoint.y, radius, 0, Math.PI * 2);
  landmarkCtx.fillStyle = "rgba(255, 72, 102, 0.12)";
  landmarkCtx.strokeStyle = "rgba(255, 94, 122, 0.78)";
  landmarkCtx.lineWidth = 2.3;
  landmarkCtx.shadowColor = "rgba(255, 103, 132, 0.9)";
  landmarkCtx.shadowBlur = 16;
  landmarkCtx.fill();
  landmarkCtx.stroke();

  landmarkCtx.beginPath();
  landmarkCtx.arc(indexPoint.x, indexPoint.y, radius - 1, 0, Math.PI * 2);
  landmarkCtx.strokeStyle = "rgba(255, 255, 255, 0.52)";
  landmarkCtx.lineWidth = 1.1;
  landmarkCtx.shadowBlur = 0;
  landmarkCtx.stroke();
  landmarkCtx.restore();
}

function renderHandLandmarks(result) {
  clearLandmarks();
  if (!result.multiHandLandmarks || !result.multiHandLandmarks.length) {
    return;
  }

  result.multiHandLandmarks.forEach((landmarks) => {
    const points = landmarks.map((p) => toCanvasPoint(p));

    HAND_CONNECTIONS.forEach(([start, end]) => {
      drawLine(points[start], points[end], "rgba(145, 239, 255, 0.64)", 1.35);
    });

    points.forEach((p, idx) => {
      const isTip = [4, 8, 12, 16, 20].includes(idx);
      drawDot(p, isTip ? 3.2 : 2, "rgba(34, 250, 255, 0.85)", isTip ? 10 : 6);
    });
  });
}

function handleModeTransitions(mode) {
  if (mode !== MODE.DRAWING) {
    commitDrawingStroke();
  }
  if (mode !== MODE.GRAB) {
    state.grabbedStrokeIndex = -1;
    state.lastGrabPoint = null;
    state.filteredGrabPoint = null;
    state.pinchWasActive = false;
  }
}

function onResults(results) {
  if (!state.cameraOn) {
    return;
  }

  setCanvasSize();
  renderHandLandmarks(results);

  const handLandmarks = results.multiHandLandmarks && results.multiHandLandmarks[0];
  const handedness = results.multiHandedness && results.multiHandedness[0];

  if (!handLandmarks || !handedness) {
    state.modeHistory = [];
    updateMode(MODE.IDLE);
    handleModeTransitions(MODE.IDLE);
    renderStrokes();
    return;
  }

  const handednessLabel = handedness.label;
  const gesture = detectGesture(handLandmarks, handednessLabel);
  state.openPalmStreak = gesture.openPalmCandidate
    ? Math.min(state.openPalmStreak + 1, GESTURE_CONFIG.historySize)
    : Math.max(state.openPalmStreak - 1, 0);

  let candidateMode = gesture.mode;
  if (gesture.mode === MODE.ERASING && state.openPalmStreak < 2) {
    candidateMode = state.currentMode === MODE.ERASING ? MODE.ERASING : MODE.IDLE;
  }

  const mode = stabilizeMode(candidateMode);
  updateMode(mode);

  const indexPoint = toCanvasPoint(handLandmarks[8]);
  const palmCenter = getPalmCenterCanvas(handLandmarks);
  const thumbPoint = toCanvasPoint(handLandmarks[4]);
  state.lastPinchPoint = {
    x: (indexPoint.x + thumbPoint.x) / 2,
    y: (indexPoint.y + thumbPoint.y) / 2
  };
  state.lastIndexPoint = indexPoint;
  state.lastPalmCenter = palmCenter;
  const pinchActive = gesture.pinch;

  if (mode === MODE.DRAWING) {
    drawModeTick(indexPoint);
  } else if (mode === MODE.GRAB) {
    grabModeTick(indexPoint, pinchActive);
  } else if (mode === MODE.ERASING) {
    eraseModeTick(palmCenter);
  }

  if (mode !== MODE.DRAWING && state.drawingStroke) {
    commitDrawingStroke();
  }

  if (mode !== MODE.GRAB) {
    state.grabbedStrokeIndex = -1;
    state.lastGrabPoint = null;
    state.filteredGrabPoint = null;
    state.pinchWasActive = false;
    state.lastPinchActive = false;
  }

  drawEraseFeedback(state.lastPalmCenter);
  drawGrabFeedback(state.lastIndexPoint);
  renderStrokes();
}

function setupHands() {
  hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.65
  });

  hands.onResults(onResults);
}

async function startCamera() {
  if (!hands) {
    setupHands();
  }

  if (camera) {
    state.cameraOn = true;
    statusBadge.textContent = "Camera is active";
    return;
  }

  camera = new Camera(videoEl, {
    onFrame: async () => {
      if (!state.cameraOn) {
        return;
      }
      await hands.send({ image: videoEl });
    },
    width: 1280,
    height: 720
  });

  try {
    await camera.start();
    state.cameraOn = true;
    state.cameraReady = true;
    statusBadge.textContent = "Camera is active";
    cameraLiveBadge.classList.add("active");
  } catch (error) {
    statusBadge.textContent = "Camera permission denied";
    cameraLiveBadge.classList.remove("active");
    console.error(error);
  }
}

function stopCamera() {
  if (!state.cameraOn) {
    return;
  }
  state.cameraOn = false;
  updateMode(MODE.IDLE);
  commitDrawingStroke();
  clearLandmarks();
  statusBadge.textContent = "Camera is off";
  cameraLiveBadge.classList.remove("active");
}

function saveImage() {
  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = drawCanvas.width;
  exportCanvas.height = drawCanvas.height;
  const ctx = exportCanvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, exportCanvas.width, exportCanvas.height);
  gradient.addColorStop(0, "#030811");
  gradient.addColorStop(1, "#0b1f39");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);

  state.strokes.forEach((stroke) => drawStroke(ctx, stroke));
  if (state.drawingStroke) {
    drawStroke(ctx, state.drawingStroke);
  }

  const link = document.createElement("a");
  link.href = exportCanvas.toDataURL("image/png");
  link.download = `air-draw-${Date.now()}.png`;
  link.click();
}

function clearAll() {
  state.strokes = [];
  state.drawingStroke = null;
  state.particles = [];
  renderStrokes();
}

function bindUi() {
  cameraBtn.addEventListener("click", async () => {
    if (!state.cameraOn) {
      await startCamera();
      if (state.cameraOn) {
        cameraBtn.textContent = "Camera OFF";
        cameraBtn.classList.remove("btn-primary");
        cameraBtn.classList.add("btn-ghost");
      }
    } else {
      stopCamera();
      cameraBtn.textContent = "Camera ON";
      cameraBtn.classList.remove("btn-ghost");
      cameraBtn.classList.add("btn-primary");
    }
  });

  clearBtn.addEventListener("click", clearAll);
  saveBtn.addEventListener("click", saveImage);
  howToPlayBtn.addEventListener("click", () => {
    helpModal.classList.add("visible");
  });

  startBtn.addEventListener("click", async () => {
    helpModal.classList.remove("visible");
    if (!state.cameraOn) {
      await startCamera();
      if (state.cameraOn) {
        cameraBtn.textContent = "Camera OFF";
        cameraBtn.classList.remove("btn-primary");
        cameraBtn.classList.add("btn-ghost");
      }
    }
  });

  paletteEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".color-swatch");
    if (!btn) {
      return;
    }

    paletteEl.querySelectorAll(".color-swatch").forEach((swatch) => {
      swatch.classList.remove("active");
    });

    btn.classList.add("active");
    state.currentColor = btn.dataset.color;
  });

  thicknessSlider.addEventListener("input", (event) => {
    state.thickness = Number(event.target.value);
    thicknessValue.textContent = String(state.thickness);
  });

  glowSlider.addEventListener("input", (event) => {
    state.glow = Number(event.target.value);
    glowValue.textContent = String(state.glow);
  });

  window.addEventListener("resize", () => {
    setCanvasSize();
    renderStrokes();
  });
}

function init() {
  bindUi();
  setCanvasSize();
  renderStrokes();
  updateMode(MODE.IDLE);
}

init();
