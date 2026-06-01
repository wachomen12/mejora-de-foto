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

let currentFile = null;
let currentDataUrl = null;
let resultUrl = null;
let picaInstance = null;
let progressTimer = null;

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
enhanceBtn.addEventListener('click', async () => {
  if (!currentDataUrl) return;
  hideError();
  resultCard.classList.add('hidden');

  enhanceBtn.classList.add('is-loading');
  enhanceBtn.disabled = true;

  try {
    showProgress(4, 'Preparando imagen…');
    const picaEngine = getPica();
    await ensureImageReady(previewImg);

    const srcCanvas = imageToCanvas(previewImg);
    const scale = pickScale(srcCanvas.width, srcCanvas.height);

    const dstCanvas = document.createElement('canvas');
    dstCanvas.width  = Math.round(srcCanvas.width  * scale);
    dstCanvas.height = Math.round(srcCanvas.height * scale);

    showProgress(12, 'Mejorando nitidez y resolución…');
    animateProgressTo(85, 'Mejorando nitidez y resolución…');

    await picaEngine.resize(srcCanvas, dstCanvas, {
      quality: 3,            // Lanczos, highest quality
      alpha: true,
      unsharpAmount: 90,     // 0–500: how strong the sharpening is
      unsharpRadius: 0.6,    // 0.5–2.0: size of the sharpening kernel
      unsharpThreshold: 2,   // 0–100: avoids sharpening flat areas (denoise-like)
    });

    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    showProgress(95, 'Guardando resultado…');

    const outType = currentFile?.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const outQuality = outType === 'image/jpeg' ? 0.95 : undefined;
    resultUrl = await canvasToDataUrl(dstCanvas, outType, outQuality);

    showProgress(100, '¡Listo!');
    await wait(300);
    hideProgress();

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
