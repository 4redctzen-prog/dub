import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import { getConfig, getCredentialDiagnostics } from './server/config.ts';
import { getVoiceProvider } from './server/providers/providerFactory.ts';
import {
  addLanguagesToJob,
  createDubbingJob,
  createZipArchiveForJob,
  deleteJob,
  getJob,
  initializeStorage,
  inspectUploadedAudio,
  retryJob,
  retryLanguageSubtitles,
  serializeJobForClient,
} from './server/services/jobManager.ts';
import type {
  DubbingSettings,
  DubbingWorkflowMode,
  SupportedLanguage,
  SystemCapabilitiesResponse,
} from './server/types.ts';

const ALLOWED_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a']);
const ALLOWED_MIME_PREFIXES = ['audio/', 'application/octet-stream'];

async function startServer() {
  const cfg = getConfig();
  await initializeStorage();

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  const upload = multer({
    dest: cfg.tempDir,
    limits: {
      fileSize: cfg.maxUploadMb * 1024 * 1024,
    },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const mimeOk = ALLOWED_MIME_PREFIXES.some((p) => file.mimetype.toLowerCase().startsWith(p));
      if (!ALLOWED_EXTENSIONS.has(ext) || !mimeOk) {
        cb(new Error('Unsupported file format. Please upload an MP3, WAV, or M4A audio file.'));
        return;
      }
      cb(null, true);
    },
  });

  // Health & sanitized provider capabilities (never exposes secrets)
  app.get('/api/capabilities', (_req, res) => {
    const diag = getCredentialDiagnostics();
    let supportedLanguages: SupportedLanguage[] = [];
    try {
      supportedLanguages = getVoiceProvider().getSupportedLanguages();
    } catch {
      supportedLanguages = [];
    }

    const payload: SystemCapabilitiesResponse = {
      ...diag,
      supportedLanguages,
    };
    res.json(payload);
  });

  // Pre-flight audio inspection (duration, format, real PCM waveform peaks)
  app.post('/api/audio/inspect', upload.single('audio'), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'No audio file uploaded.' });
      return;
    }

    try {
      const metadata = await inspectUploadedAudio(file.path, file.originalname, file.mimetype);
      res.json({ metadata });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid audio file.' });
    } finally {
      await fs.rm(file.path, { force: true }).catch(() => {});
    }
  });

  // Create asynchronous dubbing job
  app.post('/api/jobs', upload.single('audio'), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Please upload an MP3, WAV, or M4A audio file.' });
      return;
    }

    const diag = getCredentialDiagnostics();

    try {
      const rawTargets = typeof req.body.targetLanguages === 'string'
        ? JSON.parse(req.body.targetLanguages)
        : req.body.targetLanguages;

      const rawSettings = typeof req.body.settings === 'string'
        ? JSON.parse(req.body.settings)
        : req.body.settings ?? {};

      const workflowMode: DubbingWorkflowMode =
        rawSettings.workflowMode === 'clone_tts' ||
        rawSettings.workflowMode === 'native_dubbing' ||
        rawSettings.workflowMode === 'gemini_only'
          ? rawSettings.workflowMode
          : 'auto';

      const isGeminiWorkflow =
        workflowMode === 'gemini_only' ||
        diag.voiceProvider === 'gemini' ||
        diag.voiceProvider === 'gemini-only' ||
        diag.voiceProvider === 'gemini_only';

      if (isGeminiWorkflow) {
        if (!diag.geminiConfigured) {
          await fs.rm(file.path, { force: true }).catch(() => {});
          res.status(400).json({
            error: 'GEMINI_API_KEY is missing in Settings → Secrets for Gemini-only mode.',
          });
          return;
        }
      } else if (!diag.voiceProviderConfigured) {
        await fs.rm(file.path, { force: true }).catch(() => {});
        res.status(400).json({
          error: `Voice provider credentials missing: ${diag.voiceProviderMissingFields.join(', ')}. Configure backend environment variables before generating.`,
        });
        return;
      }

      if (workflowMode !== 'native_dubbing' && !isGeminiWorkflow && !diag.llmConfigured) {
        await fs.rm(file.path, { force: true }).catch(() => {});
        res.status(400).json({
          error: `External LLM credentials missing: ${diag.llmMissingFields.join(', ')}. Configure your external LLM environment variables before generating.`,
        });
        return;
      }

      const settings: DubbingSettings = {
        preserveSpeakerIdentity: rawSettings.preserveSpeakerIdentity !== false,
        preserveNarrationStyle: rawSettings.preserveNarrationStyle !== false,
        preserveEmotionalExpression: rawSettings.preserveEmotionalExpression !== false,
        preserveRhythmAndPacing: rawSettings.preserveRhythmAndPacing !== false,
        preserveVocalCharacteristics: rawSettings.preserveVocalCharacteristics !== false,
        workflowMode,
      };

      const voiceCloneAuthorized =
        req.body.voiceCloneAuthorized === true || req.body.voiceCloneAuthorized === 'true';

      const job = await createDubbingJob({
        tempFilePath: file.path,
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        sourceLanguage: String(req.body.sourceLanguage ?? 'auto'),
        targetLanguages: Array.isArray(rawTargets) ? rawTargets.map(String) : [],
        settings,
        voiceCloneAuthorized,
      });

      res.status(202).json({ job: serializeJobForClient(job) });
    } catch (err) {
      await fs.rm(file.path, { force: true }).catch(() => {});
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to start dubbing job.' });
    }
  });

  // Get job status and results
  app.get('/api/jobs/:jobId', (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Dubbing job not found.' });
      return;
    }
    res.json({ job: serializeJobForClient(job) });
  });

  // Retry failed job or single failed language
  app.post('/api/jobs/:jobId/retry', async (req, res) => {
    try {
      const targetLanguageCode =
        typeof req.body?.languageCode === 'string' ? req.body.languageCode : undefined;
      const job = await retryJob(req.params.jobId, targetLanguageCode);
      res.json({ job: serializeJobForClient(job) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to retry job.' });
    }
  });

  // Retry failed SRT subtitle generation independently
  app.post('/api/jobs/:jobId/languages/:langCode/retry-subtitles', async (req, res) => {
    try {
      const job = await retryLanguageSubtitles(req.params.jobId, req.params.langCode);
      res.json({ job: serializeJobForClient(job) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to regenerate subtitles.' });
    }
  });

  // Add new target languages to an existing project
  app.post('/api/jobs/:jobId/languages', async (req, res) => {
    try {
      const langs = Array.isArray(req.body?.targetLanguages) ? req.body.targetLanguages.map(String) : [];
      const job = await addLanguagesToJob(req.params.jobId, langs);
      res.json({ job: serializeJobForClient(job) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to add target language.' });
    }
  });

  // Stream original uploaded audio for playback
  app.get('/api/jobs/:jobId/audio/original', async (req, res) => {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }
    res.sendFile(path.resolve(job.originalAudioPath));
  });

  // Stream dubbed MP3 audio for inline player
  app.get('/api/jobs/:jobId/languages/:langCode/audio', async (req, res) => {
    const job = getJob(req.params.jobId);
    const langTask = job?.languages.find((l) => l.languageCode === req.params.langCode);
    if (!langTask?.mp3Path) {
      res.status(404).json({ error: 'Generated audio not found.' });
      return;
    }
    res.sendFile(path.resolve(langTask.mp3Path));
  });

  // Download MP3, WAV, or validated SRT with descriptive filenames
  app.get('/api/jobs/:jobId/languages/:langCode/download/:format', async (req, res) => {
    const job = getJob(req.params.jobId);
    const langTask = job?.languages.find((l) => l.languageCode === req.params.langCode);
    if (!langTask) {
      res.status(404).json({ error: 'Target language output not found.' });
      return;
    }

    const format = req.params.format.toLowerCase();
    if (format === 'mp3' && langTask.mp3Path && langTask.mp3Filename) {
      res.download(path.resolve(langTask.mp3Path), langTask.mp3Filename);
      return;
    }
    if (format === 'wav' && langTask.wavPath && langTask.wavFilename) {
      res.download(path.resolve(langTask.wavPath), langTask.wavFilename);
      return;
    }
    if (format === 'srt' && langTask.subtitle.srtPath && langTask.subtitle.srtFilename) {
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.download(path.resolve(langTask.subtitle.srtPath), langTask.subtitle.srtFilename);
      return;
    }

    res.status(404).json({ error: `Requested ${format.toUpperCase()} file is not available.` });
  });

  // Download all generated MP3, WAV, and SRT files in a single ZIP archive
  app.get('/api/jobs/:jobId/download-all', async (req, res) => {
    try {
      const { buffer, filename } = await createZipArchiveForJob(req.params.jobId);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buffer);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to build ZIP archive.' });
    }
  });

  // Secure project & file deletion
  app.delete('/api/jobs/:jobId', async (req, res) => {
    await deleteJob(req.params.jobId);
    res.json({ deleted: true });
  });

  // Multer & API error handler
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: `Uploaded file exceeds maximum allowed size (${cfg.maxUploadMb} MB).` });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: 'Unexpected server error.' });
  });

  // Never allow /api/* routes to fall through to SPA HTML fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Vite dev middleware or production static serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(cfg.port, '0.0.0.0', () => {
    console.log(`Resonance Dub server running on http://0.0.0.0:${cfg.port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
