// ===== PixelBoost — Photo enhancement frontend =====
// 100% client-side: uses Pica (Lanczos resampling + unsharp mask)
// running in the visitor's browser. No backend, no API keys, no cost.

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

const $ = (id) => document.getElementById(id);

const dropzone     = $('dropzone');
const fileInput    = $('fileInput');
const browseBtn    = $('browseBtn');
const dzEmpty      = $('dzEmpty');
const dzPreview    = $('dzPreview');
const previewImg   = $('previewImg');
const removeBtn    = $('removeBtn');
const fileNameEl   = $('fileName');
const fileSizeEl   = $('fileSize');
const enhanceBtn   = $('enhanceBtn');
const progressBox  = $('progressBox');
const progressBar  = $('progressBar');
const progressPct  = $('progressPct');
const progressLbl  = $('progressLabel');
const errorBox     = $('errorBox');
const errorMsg     = $('errorMsg');
const resultCard   = $('resultCard');
const beforeImg    = $('beforeImg');
const afterImg     = $('afterImg');
const compare      = $('compare');
const clip         = $('clip');
const handle       = $('handle');
const newBtn       = $('newBtn');
const downloadBtn  = $('downloadBtn');
const yearEl       = $('year');
const topLink      = $('topLink');
const resInfo      = $('resInfo');

let currentFile = null;
let currentDataUrl = null;
let resultUrl = null;
let picaInstance = null;
let progressTimer = null;
let aiUpscaler = null;
let aiLoadPromise = null;
let aiTriedAndFailed = false;

yearEl.textContent = new Date().getFullYear();

topLink.addEventListener('click', (e) => {
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ===== Drag & drop =====
['dragenter', 'dragover'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add('is-drag');
  });
});
['dragleave', 'drop'].forEach((ev) => {
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove('is-drag');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

dropzone.addEventListener('click', (e) => {
  if (e.target.closest('.remove-btn')) return;
  if (e.target.closest('button')) return;
  if (!currentFile) fileInput.click();
});
browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});
fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
});

removeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  resetFile();
});

function handleFile(file) {
  hideError();
  if (!ACCEPTED.includes(file.type)) {
    showError('Formato no admitido. Usa JPG, PNG o WEBP.');
    return;
  }
  if (file.size > MAX_BYTES) {
    showError(`La imagen pesa ${formatSize(file.size)}. El máximo es 10 MB.`);
    return;
  }
  currentFile = file;
  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatSize(file.size);

  const reader = new FileReader();
  reader.onload = () => {
    currentDataUrl = reader.result;
    previewImg.src = currentDataUrl;
    dzEmpty.classList.add('hidden');
    dzPreview.classList.remove('hidden');
    enhanceBtn.disabled = false;
  };
  reader.onerror = () => showError('No se pudo leer el archivo.');
  reader.readAsDataURL(file);
}

function resetFile() {
  currentFile = null;
  currentDataUrl = null;
  resultUrl = null;
  fileInput.value = '';
  previewImg.src = '';
  dzPreview.classList.add('hidden');
  dzEmpty.classList.remove('hidden');
  enhanceBtn.disabled = true;
  resultCard.classList.add('hidden');
  resInfo.classList.add('hidden');
  hideProgress();
  hideError();
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorBox.classList.remove('hidden');
}
function hideError() {
  errorBox.classList.add('hidden');
}

function showProgress(pct, label) {
  progressBox.classList.remove('hidden');
  progressBar.style.width = `${pct}%`;
  progressPct.textContent = `${Math.round(pct)}%`;
  if (label) progressLbl.textContent = label;
}
function hideProgress() {
  progressBox.classList.add('hidden');
  progressBar.style.width = '0%';
  progressPct.textContent = '0%';
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function animateProgressTo(target, label) {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const current = parseFloat(progressBar.style.width) || 0;
    if (current >= target) {
      clearInterval(progressTimer);
      progressTimer = null;
      return;
    }
    const step = Math.max(0.4, (target - current) * 0.08);
    showProgress(Math.min(target, current + step), label);
  }, 120);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== Real AI (UpscalerJS + ESRGAN, lazy-loaded) =====
// First call downloads TF.js + UpscalerJS + ESRGAN model (~25 MB) via esm.sh.
// Browser caches it after the first run, so later uses are instant to start.
// If anything fails (slow network, low-memory device, esm.sh down), the
// caller catches the rejection and falls back to the Pica path.
async function loadAI() {
  if (aiUpscaler) return aiUpscaler;
  if (aiTriedAndFailed) throw new Error('La IA no está disponible.');
  if (aiLoadPromise) return aiLoadPromise;

  aiLoadPromise = (async () => {
    const tfMod = await import('https://esm.sh/@tensorflow/tfjs@4.10.0');
    const tf = tfMod.default || tfMod;
    globalThis.tf = tf;

    const [upMod, modelMod] = await Promise.all([
      import('https://esm.sh/upscaler@1.0.0-beta.19?deps=@tensorflow/tfjs@4.10.0'),
      import('https://esm.sh/@upscalerjs/esrgan-slim@1.0.0-beta.19/4x?deps=@tensorflow/tfjs@4.10.0'),
    ]);

    const Upscaler = upMod.default || upMod.Upscaler || upMod;
    const model = modelMod.default || modelMod;
    if (!Upscaler || typeof Upscaler !== 'function') {
      throw new Error('UpscalerJS no expuso un constructor válido.');
    }

    aiUpscaler = new Upscaler({ model });
    return aiUpscaler;
  })();

  try {
    return await aiLoadPromise;
  } catch (err) {
    aiTriedAndFailed = true;
    aiLoadPromise = null;
    throw err;
  }
}

// Cap a canvas to a max-pixel budget by downscaling. Prevents OOM on phones
// when feeding huge inputs to a 4x AI model.
function limitCanvasSize(canvas, maxPixels) {
  const pixels = canvas.width * canvas.height;
  if (pixels <= maxPixels) return canvas;
  const scale = Math.sqrt(maxPixels / pixels);
  const out = document.createElement('canvas');
  out.width  = Math.max(1, Math.floor(canvas.width * scale));
  out.height = Math.max(1, Math.floor(canvas.height * scale));
  out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

// Load a base64/PNG data URI back into a canvas.
async function dataUrlToCanvas(dataUrl) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo decodificar el resultado de la IA.'));
    img.src = dataUrl;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

// ===== Pica (high-quality image enhancement) =====
function getPica() {
  if (picaInstance) return picaInstance;
  if (typeof pica === 'undefined') {
    throw new Error('No se pudo cargar el motor de mejora. Revisa tu conexión.');
  }
  picaInstance = pica({ features: ['js', 'wasm', 'cib'] });
  return picaInstance;
}

async function ensureImageReady(img) {
  if (img.complete && img.naturalWidth > 0) return;
  await new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('No se pudo decodificar la imagen.'));
  });
}

// Decide upscale factor: aim for ~2x but keep total pixels under a safe limit
// so phones don't run out of memory on big photos.
function pickScale(width, height) {
  const MAX_PIXELS = 16_000_000;
  const want = 2;
  const wouldBe = width * height * want * want;
  if (wouldBe <= MAX_PIXELS) return want;
  return Math.max(1.2, Math.sqrt(MAX_PIXELS / (width * height)));
}

function imageToCanvas(img) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

// "Clarity" / local contrast: large-radius unsharp mask. Makes details pop
// (skin texture, edges, fabric) without affecting global exposure.
// This is the single biggest factor in making photos look "iPhone-like".
function applyLocalContrast(canvas, amount = 0.55, radius = 14) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const blurCanvas = document.createElement('canvas');
  blurCanvas.width = w;
  blurCanvas.height = h;
  const bctx = blurCanvas.getContext('2d');
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(canvas, 0, 0);

  const orig = ctx.getImageData(0, 0, w, h);
  const blur = bctx.getImageData(0, 0, w, h);
  const od = orig.data, bd = blur.data;

  for (let i = 0; i < od.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = od[i + c] + amount * (od[i + c] - bd[i + c]);
      od[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  ctx.putImageData(orig, 0, 0);
}

// Tonal + color grading pass: contrast, vibrance (skin-aware saturation),
// shadow lift, warm white-balance shift. Inspired by phone-camera ISPs.
function applyTonalBoost(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;

  const contrast   = 1.18;   // +18%
  const vibrance   = 0.45;   // 0–1, boosts unsaturated pixels more
  const shadowLift = 14;     // up to +14 on the darkest pixels
  const highlightP = 0.94;   // soft roll-off above 235
  const warmR      = 1.025;  // +2.5% red
  const warmB      = 0.985;  // -1.5% blue

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];

    // Shadow lift on dark pixels
    const lum = 0.2989 * r + 0.5870 * g + 0.1140 * b;
    if (lum < 100) {
      const lift = (1 - lum / 100) * shadowLift;
      r += lift; g += lift; b += lift;
    }

    // Warm white-balance shift (Apple-ish)
    r *= warmR;
    b *= warmB;

    // Contrast around 128
    r = (r - 128) * contrast + 128;
    g = (g - 128) * contrast + 128;
    b = (b - 128) * contrast + 128;

    // Vibrance: boost more on muted colors, protect warm tones (skin)
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = (max - min) / 255;            // 0–1 saturation
    const isSkin = (r > g && r > b) ? 0.5 : 1; // dampen on red-dominant
    const boost = vibrance * (1 - sat) * isSkin;
    const gray = 0.2989 * r + 0.5870 * g + 0.1140 * b;
    r = gray + (r - gray) * (1 + boost);
    g = gray + (g - gray) * (1 + boost);
    b = gray + (b - gray) * (1 + boost);

    // Soft highlight compression
    if (r > 235) r = 235 + (r - 235) * highlightP;
    if (g > 235) g = 235 + (g - 235) * highlightP;
    if (b > 235) b = 235 + (b - 235) * highlightP;

    d[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }

  ctx.putImageData(img, 0, 0);
}

async function canvasToDataUrl(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('No se pudo generar la imagen.'));
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('No se pudo leer el resultado.'));
      reader.readAsDataURL(blob);
    }, type, quality);
  });
}

// ===== Enhance flow =====
async function upscaleWithAI(srcCanvas) {
  // Cap input at 1 MP so phones don't OOM on a 4x model.
  const aiInput = limitCanvasSize(srcCanvas, 1_000_000);
  const upscaler = await loadAI();

  const dataUrl = await upscaler.upscale(aiInput, {
    output: 'base64',
    patchSize: 64,
    padding: 2,
    progress: (rate) => {
      const r = Math.max(0, Math.min(1, rate));
      showProgress(25 + r * 55, 'IA restaurando detalles…');
    },
  });
  return dataUrlToCanvas(dataUrl);
}

async function upscaleWithPica(srcCanvas) {
  const picaEngine = getPica();
  const scale = pickScale(srcCanvas.width, srcCanvas.height);
  const dst = document.createElement('canvas');
  dst.width  = Math.round(srcCanvas.width  * scale);
  dst.height = Math.round(srcCanvas.height * scale);

  animateProgressTo(80, 'Mejorando nitidez y resolución…');
  await picaEngine.resize(srcCanvas, dst, {
    quality: 3,
    alpha: true,
    unsharpAmount: 180,
    unsharpRadius: 0.9,
    unsharpThreshold: 1,
  });
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  return dst;
}

enhanceBtn.addEventListener('click', async () => {
  if (!currentDataUrl) return;
  hideError();
  resultCard.classList.add('hidden');

  enhanceBtn.classList.add('is-loading');
  enhanceBtn.disabled = true;

  try {
    showProgress(3, 'Preparando imagen…');
    await ensureImageReady(previewImg);
    const srcCanvas = imageToCanvas(previewImg);

    let dstCanvas;
    let usedAI = false;

    // Try AI first unless it has already failed this session.
    if (!aiTriedAndFailed) {
      try {
        const firstTime = !aiUpscaler;
        showProgress(8, firstTime
          ? 'Cargando IA (solo la primera vez, ~25 MB)…'
          : 'Iniciando IA…');
        animateProgressTo(22, 'Cargando IA…');

        dstCanvas = await upscaleWithAI(srcCanvas);
        usedAI = true;
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      } catch (aiErr) {
        console.warn('IA no disponible, usando mejora clásica:', aiErr);
        if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      }
    }

    // Fallback to Pica if AI didn't produce a result.
    if (!dstCanvas) {
      showProgress(15, 'Mejorando nitidez y resolución…');
      dstCanvas = await upscaleWithPica(srcCanvas);
    }

    showProgress(85, 'Dando profundidad a los detalles…');
    applyLocalContrast(dstCanvas, 0.55, 14);

    showProgress(92, 'Ajustando color y contraste…');
    applyTonalBoost(dstCanvas);

    showProgress(97, 'Guardando resultado…');
    const outType = currentFile?.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const outQuality = outType === 'image/jpeg' ? 0.95 : undefined;
    resultUrl = await canvasToDataUrl(dstCanvas, outType, outQuality);

    showProgress(100, '¡Listo!');
    await wait(300);
    hideProgress();

    const gainX = (dstCanvas.width * dstCanvas.height) / (srcCanvas.width * srcCanvas.height);
    resInfo.innerHTML =
      (usedAI ? '<span class="ai-badge">✨ Mejorado con IA</span>' : '') +
      `${srcCanvas.width}×${srcCanvas.height} ` +
      `<span class="arrow">→</span> ` +
      `${dstCanvas.width}×${dstCanvas.height}` +
      `<span class="gain">${gainX.toFixed(1)}× píxeles</span>`;
    resInfo.classList.remove('hidden');

    await showResult(currentDataUrl, resultUrl);
  } catch (err) {
    console.error(err);
    hideProgress();
    showError(err.message || 'Algo salió mal. Intenta de nuevo.');
  } finally {
    enhanceBtn.classList.remove('is-loading');
    enhanceBtn.disabled = !currentDataUrl;
  }
});

// ===== Compare slider =====
async function showResult(beforeSrc, afterSrc) {
  beforeImg.src = beforeSrc;
  afterImg.src = afterSrc;

  await Promise.all([
    waitForImage(beforeImg),
    waitForImage(afterImg),
  ]);

  syncBeforeSize();
  setSlider(50);

  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function waitForImage(img) {
  return new Promise((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    img.onload = () => resolve();
    img.onerror = () => resolve();
  });
}

function syncBeforeSize() {
  const rect = afterImg.getBoundingClientRect();
  beforeImg.style.width = `${rect.width}px`;
  beforeImg.style.height = `${rect.height}px`;
  beforeImg.style.objectFit = 'cover';
}

window.addEventListener('resize', () => {
  if (!resultCard.classList.contains('hidden')) syncBeforeSize();
});

function setSlider(pct) {
  pct = Math.max(0, Math.min(100, pct));
  clip.style.width = `${pct}%`;
  handle.style.left = `${pct}%`;
  handle.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function sliderFromEvent(e) {
  const rect = compare.getBoundingClientRect();
  const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
  return (x / rect.width) * 100;
}

let dragging = false;
function startDrag(e) {
  dragging = true;
  handle.focus();
  setSlider(sliderFromEvent(e));
  e.preventDefault();
}
function moveDrag(e) {
  if (!dragging) return;
  setSlider(sliderFromEvent(e));
}
function endDrag() {
  dragging = false;
}

handle.addEventListener('mousedown', startDrag);
handle.addEventListener('touchstart', startDrag, { passive: false });
compare.addEventListener('mousedown', startDrag);
compare.addEventListener('touchstart', startDrag, { passive: false });

window.addEventListener('mousemove', moveDrag);
window.addEventListener('touchmove', moveDrag, { passive: true });
window.addEventListener('mouseup', endDrag);
window.addEventListener('touchend', endDrag);

handle.addEventListener('keydown', (e) => {
  const current = parseFloat(handle.style.left) || 50;
  if (e.key === 'ArrowLeft') { setSlider(current - 3); e.preventDefault(); }
  if (e.key === 'ArrowRight') { setSlider(current + 3); e.preventDefault(); }
  if (e.key === 'Home') { setSlider(0); e.preventDefault(); }
  if (e.key === 'End') { setSlider(100); e.preventDefault(); }
});

// ===== Result actions =====
newBtn.addEventListener('click', () => {
  resetFile();
  document.querySelector('.upload-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

downloadBtn.addEventListener('click', async () => {
  if (!resultUrl) return;
  try {
    const res = await fetch(resultUrl);
    if (!res.ok) throw new Error('No se pudo descargar.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (currentFile?.name || 'imagen').replace(/\.[^.]+$/, '');
    a.href = url;
    a.download = `${base}-mejorada.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    showError(err.message || 'No se pudo descargar la imagen.');
  }
});
