/**
 * Math-to-Story — Backend Server
 * -------------------------------------------------------------
 * Express server that powers the Math-to-Story wizard/slider app.
 *
 *   POST /api/solve-story        -> safely evaluates a formula string
 *                                    against a set of variables using
 *                                    mathjs (no raw eval / new Function).
 *
 *   POST /api/upload-math-image  -> accepts an image (multer, in-memory),
 *                                    OCRs it with Tesseract.js, and
 *                                    extracts numeric parameters.
 *
 * Run:
 *   npm install
 *   npm start
 *   -> https://math-to-story.onrender.com 
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { create, all } = require('mathjs');
const { createWorker } = require('tesseract.js');

const math = create(all, {});

// Lock mathjs down to pure evaluation — no import/createUnit/etc,
// which keeps the endpoint from being used to reach outside the sandbox.
math.import(
  {
    import: function () {
      throw new Error('Function import is disabled');
    },
    createUnit: function () {
      throw new Error('Function createUnit is disabled');
    },
  },
  { override: true }
);

const app = express();
const PORT = process.env.PORT || 5500;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve the frontend (index.html + any static assets) from this folder.
app.use(express.static(path.join(__dirname), { extensions: ['html'] }));

// ---------------------------------------------------------------
// In-memory storage for uploaded images (never written to disk).
// ---------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB cap
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are accepted'));
    }
    cb(null, true);
  },
});

// Reuse a single Tesseract worker across requests instead of spinning
// one up per call — much faster after the first request.
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng');
  }
  return workerPromise;
}

// -----------------------------------------------------------------------
// POST /api/solve-story
// Body: { formula: string, variables: { [name: string]: number } }
// Returns: { success, result, formula, variables, steps? }
// -----------------------------------------------------------------------
app.post('/api/solve-story', (req, res) => {
  try {
    const { formula, variables } = req.body || {};

    if (typeof formula !== 'string' || !formula.trim()) {
      return res.status(400).json({ success: false, error: 'A formula string is required.' });
    }
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
      return res.status(400).json({ success: false, error: 'Variables must be an object.' });
    }

    // Sanitize the incoming scope: only allow finite numbers through,
    // and only allow safe identifier names as keys.
    const scope = {};
    for (const [key, value] of Object.entries(variables)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        return res.status(400).json({ success: false, error: `Invalid variable name: ${key}` });
      }
      const num = Number(value);
      if (!Number.isFinite(num)) {
        return res.status(400).json({ success: false, error: `Variable "${key}" must be a finite number.` });
      }
      scope[key] = num;
    }

    // mathjs.evaluate runs against an expression parser (not JS eval),
    // so it can't reach the filesystem, network, or process object.
    const node = math.parse(formula);
    const compiled = node.compile();
    const rawResult = compiled.evaluate(scope);

    const result = typeof rawResult === 'object' && rawResult !== null && 'toNumber' in rawResult
      ? rawResult.toNumber()
      : rawResult;

    if (typeof result !== 'number' || !Number.isFinite(result)) {
      return res.status(422).json({ success: false, error: 'Formula did not evaluate to a finite number.' });
    }

    return res.json({
      success: true,
      result: Math.round(result * 10000) / 10000,
      formula,
      variables: scope,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: 'Could not evaluate formula: ' + err.message });
  }
});

// -----------------------------------------------------------------------
// POST /api/upload-math-image
// Multipart form field name: "image"
// Returns: { success, text, numbers: number[] }
// -----------------------------------------------------------------------
app.post('/api/upload-math-image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file was uploaded (field name must be "image").' });
    }

    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(req.file.buffer);
      const text = (data && data.text) || '';

      // Pull every numeric token out of the recognized text (ints, decimals,
      // negatives) — these become candidate variable values on the client.
      const matches = text.match(/-?\d+(\.\d+)?/g) || [];
      const numbers = matches.map(Number).filter((n) => Number.isFinite(n));

      return res.json({
        success: true,
        text: text.trim(),
        numbers,
      });
    } catch (ocrErr) {
      return res.status(500).json({ success: false, error: 'OCR failed: ' + ocrErr.message });
    }
  });
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Fallback to index.html for any unmatched GET route (single page app).
app.get('*', (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Math-to-Story server running at http://localhost:${PORT}`);
});

// Clean up the Tesseract worker on shutdown.
process.on('SIGINT', async () => {
  if (workerPromise) {
    const worker = await workerPromise;
    await worker.terminate();
  }
  process.exit(0);
});

module.exports = app;